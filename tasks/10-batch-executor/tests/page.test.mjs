// Task 10's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/10-batch-executor/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/batch.js");
const runner = shared("agent.js");

describe("the Task 10 page", () => {
  test("carries the shared shell, stamped for 10, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 10 -->\n${shellPart(shared("header.html"), "10")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 10 -->\n${shellPart(shared("footer.html"), "10")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "10", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/batch.css", "/assets/batch.js", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="10">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and each field has a label and a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    // Looked up by key: the fields, their hints, and the examples.
    for (const id of ["f-batch", "h-batch", "f-from", "h-from", "f-merge", "ex-example", "ex-big", "ex-order"]) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-batch", "f-from", "f-merge"]);
    for (const id of fields) assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
    for (const id of fields) assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
    assert.deepEqual([...html.matchAll(/<option value="([01])">/g)].map(([, value]) => value), ["1", "0"], "merging is on unless asked");
  });

  test("the result is set as text: the scripts never write markup", () => {
    for (const source of [script, runner]) assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  test("every link that leaves the site opens a new tab with no opener and says so; the sources are the official ones", () => {
    for (const [anchor] of html.matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
      assert.match(anchor, /target="_blank" rel="noopener noreferrer"/, anchor);
      assert.ok(/opens in a new tab/.test(anchor), anchor);
    }
    assert.ok(html.includes('href="https://github.com/PharosNetwork/pharos-mcp"'), "the official Chain MCP server");
    assert.ok(html.includes('href="https://github.com/PharosNetwork/pharos-skill-engine/blob/a873387c9e34e9ae8e71360d43dc33329a335a24/references/transaction.md#batch-transfer--airdrop"'), "the Skill Engine's batch transfer, at the commit read");
    assert.ok(html.includes('<a href="/tasks/08">'), "the dry run each transaction gets, Task 08's");
  });

  test("the first batch is the API's own default, the limits are the API's, and the CLI's runs shown are its commands", async () => {
    const { DEFAULT_BATCH, WEB_MAX_BATCH } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    const { MAX_BATCH, MAX_BATCH_TEXT } = await import(new URL("../../../agent/dist/src/batch/read.js", import.meta.url).href);
    const { EXAMPLE_RECIPIENT } = await import(new URL("../../../agent/dist/src/guardian/presets.js", import.meta.url).href);
    const batch = /const BATCH = `([^`]+)`;/.exec(script)[1].replaceAll("${RECIPIENT}", /const RECIPIENT = "(0x[0-9a-fA-F]{40})";/.exec(script)[1]).replaceAll("${STAFF}", /const STAFF = "(0x[0-9a-fA-F]{40})";/.exec(script)[1]);
    assert.equal(batch, DEFAULT_BATCH);
    assert.equal(/const RECIPIENT = "(0x[0-9a-fA-F]{40})";/.exec(script)[1], EXAMPLE_RECIPIENT);
    assert.equal(Number(/const MAX_ACTIONS = (\d+);/.exec(script)[1]), WEB_MAX_BATCH);
    assert.equal(Number(/const MAX = (\d+);/.exec(script)[1]), MAX_BATCH_TEXT);
    assert.match(script, new RegExp(`the CLI takes ${MAX_BATCH}\\)`));
    assert.match(html, new RegExp(`maxlength="${MAX_BATCH_TEXT}"`));
    assert.match(html, new RegExp(`At most ${WEB_MAX_BATCH} here\\.`));
    for (const command of ["node dist/src/cli.js batch --proof batch-mainnet.json", "node dist/src/cli.js verify batch-mainnet.json", "node dist/src/cli.js batch batch.txt --from 0x...", "node dist/src/cli.js batch batch.txt --network atlantic-testnet --execute --proof batch-atlantic.json"]) assert.ok(html.includes(command), command);
  });

  test("the page says what it does and does not do: nothing is sent from here, the CLI sends on Atlantic", () => {
    assert.match(html, /Nothing is sent from this page: it holds no key, and the hosted Chain MCP is read-only\. The CLI sends a batch on Atlantic, back to back, then checks every balance and allowance it changed against the plan\./);
    assert.doesNotMatch(script, /fetch\(/, "the page asks only through the shared runner");
    assert.doesNotMatch(script, /private[_ ]?key/i, "the page never handles a key");
  });
});
