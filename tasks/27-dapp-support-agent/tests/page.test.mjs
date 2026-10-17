// Task 27's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/27-dapp-support-agent/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/support.js");
const runner = shared("agent.js");

describe("the Task 27 page", () => {
  test("carries the shared shell, stamped for 27, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 27 -->\n${shellPart(shared("header.html"), "27")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 27 -->\n${shellPart(shared("footer.html"), "27")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "27", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/support.css", "/assets/support.js", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="27">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and every field has a label and a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-hash"]);
    for (const id of fields) assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
    for (const [, id] of html.matchAll(/<input class="input" id="([^"]+)"/g)) assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
  });

  test("the result is set as text: the scripts never write markup", () => {
    for (const source of [script, runner]) assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  test("every link that leaves the site opens a new tab with no opener and says so", () => {
    for (const [anchor] of html.matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
      assert.match(anchor, /target="_blank" rel="noopener noreferrer"/, anchor);
      assert.ok(/opens in a new tab/.test(anchor), anchor);
    }
  });

  test("the real example is the 600 USDC transfer in Task 02's live proof; the failing one is the agent's example sender", async () => {
    const transcript = JSON.parse(readFileSync(new URL("../../02-event-log-monitor/proof/mcp-transcript.json", import.meta.url), "utf8"));
    const logs = transcript.messages.flatMap((m) => (m.message?.result?.content ?? []).flatMap((c) => {
      try {
        const parsed = JSON.parse(c.text);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }));
    const real = script.match(/const REAL = "(0x[0-9a-f]{64})";/)[1];
    const log = logs.find((l) => l.transactionHash === real);
    assert.ok(log, "the hash is in Task 02's proof");
    assert.deepEqual([BigInt(log.data), BigInt(log.blockNumber)], [600_000_000n, 20_250_972n]);
    const { EXAMPLE_PAYER, EXAMPLE_RECIPIENT } = await import(new URL("../../../agent/dist/src/guardian/presets.js", import.meta.url).href);
    assert.match(script, new RegExp(`from: "${EXAMPLE_PAYER}", to: "${EXAMPLE_RECIPIENT}", amount: "5000000"`));
  });

  test("the page says what it does not do: nothing is signed or sent, and no language model writes the answer", () => {
    assert.match(html, /No language model is involved: every sentence comes from a decoded value\./);
    assert.doesNotMatch(script, /fetch\(/, "the page asks only through the shared runner");
  });
});
