// Task 28's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/28-weekly-digest-agent/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/digest.js");
const runner = shared("agent.js");

describe("the Task 28 page", () => {
  test("carries the shared shell, stamped for 28, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 28 -->\n${shellPart(shared("header.html"), "28")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 28 -->\n${shellPart(shared("footer.html"), "28")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "28", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/digest.css", "/assets/digest.js", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="28">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and every field has a label, and every input a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-subject", "f-hours", "f-wallet"]);
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

  test("the tokens are the agent's official ones; the example wallet moved the most USDC in Task 02's live proof", async () => {
    const { NETWORKS } = await import(new URL("../../../agent/dist/src/core/networks.js", import.meta.url).href);
    const { EXAMPLE_PAYER } = await import(new URL("../../../agent/dist/src/guardian/presets.js", import.meta.url).href);
    const tokens = JSON.parse(script.match(/const TOKENS = Object\.freeze\((\[[^\]]+\])\);/)[1]);
    assert.deepEqual(tokens, NETWORKS["pharos-mainnet"].tokens.map((t) => t.symbol));
    const options = [...html.matchAll(/<option value="([^"]+)">/g)].map(([, value]) => value);
    for (const symbol of tokens) assert.ok(options.includes(symbol), symbol);
    assert.match(script, new RegExp(`const WALLET = "${EXAMPLE_PAYER}";`));
    assert.match(html, new RegExp(`id="ex-wallet" type="button">A wallet, ${EXAMPLE_PAYER.slice(0, 6)}…${EXAMPLE_PAYER.slice(-4)}</button>`));
  });

  test("the page says what it reads and what it does not do, with the agent's own limits", async () => {
    const { WEB_DIGEST_BLOCKS, WEB_DIGEST_HOURS } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    assert.match(html, /Nothing is signed or sent from this page\./);
    assert.ok(html.includes(`The page reads at most ${WEB_DIGEST_BLOCKS.toLocaleString("en-US")} blocks, so it goes no further than ${WEB_DIGEST_HOURS} hours`));
    assert.deepEqual([...html.matchAll(/<option value="(\d)">/g)].map(([, n]) => Number(n)), Array.from({ length: WEB_DIGEST_HOURS }, (_, i) => i + 1));
  });
});
