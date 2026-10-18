// Task 21's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/21-x402-agent-buyer/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/buyer.js");
const runner = shared("agent.js");

describe("the Task 21 page", () => {
  test("carries the shared shell, stamped for 21, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 21 -->\n${shellPart(shared("header.html"), "21")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 21 -->\n${shellPart(shared("footer.html"), "21")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "21", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/buyer.css", "/assets/buyer.js", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="21">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and each field has a label and a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    // Looked up by key: the fields, their hints, and the examples.
    for (const id of ["f-amount", "h-amount", "f-asset", "f-to", "h-to", "f-from", "h-from", "f-budget", "h-budget", "ex-example", "ex-check", "ex-short"]) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-amount", "f-asset", "f-to", "f-from", "f-budget"]);
    for (const id of fields) assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
    for (const id of fields.filter((f) => f !== "f-asset")) assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
    // The assets offered are PROS and the official Pharos Mainnet tokens, as the API reads them.
    assert.deepEqual([...html.matchAll(/<option>([A-Z]+)<\/option>/g)].map(([, symbol]) => symbol).sort(), ["LINK", "PROS", "USDC", "WETH", "WPROS"]);
  });

  test("the result is set as text: the scripts never write markup", () => {
    for (const source of [script, runner]) assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  test("every link that leaves the site opens a new tab with no opener and says so; the sources are the official ones", () => {
    for (const [anchor] of html.matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
      assert.match(anchor, /target="_blank" rel="noopener noreferrer"/, anchor);
      assert.ok(/opens in a new tab/.test(anchor), anchor);
    }
    assert.ok(html.includes('href="https://github.com/PharosNetwork/examples/tree/f08e921b7643f3ecfa5f388b8508778daa93b97a/skills/x402-pharos"'), "the Pharos x402 skill, at the commit read");
    assert.ok(html.includes('href="https://github.com/x402-foundation/x402"'), "x402, as its packages name their repository");
    assert.ok(html.includes('<a href="/tasks/20">'), "the API it buys from, Task 20's");
  });

  test("the first job is the API's own default, and the CLI's runs shown are its commands", async () => {
    const { DEFAULT_BUYER_BUDGET } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    const { EXAMPLE_RECIPIENT } = await import(new URL("../../../agent/dist/src/guardian/presets.js", import.meta.url).href);
    assert.equal(/budget: "([\d.]+)" \}\);/.exec(script)[1], DEFAULT_BUYER_BUDGET);
    assert.equal(/const RECIPIENT = "(0x[0-9a-fA-F]{40})";/.exec(script)[1], EXAMPLE_RECIPIENT);
    for (const command of ["node dist/src/cli.js buy --proof buyer-mainnet.json", "node dist/src/cli.js verify buyer-mainnet.json", "node dist/src/cli.js buy --network atlantic-testnet --execute --to 0x... --proof buyer-atlantic.json", "node dist/src/cli.js buy --network atlantic-testnet --execute --to 0x... --api http://127.0.0.1:4020"]) assert.ok(html.includes(command), command);
  });

  test("the page says what it does and does not do: nothing settles from here, a key made for each run that holds nothing, the budget counted when signed", () => {
    assert.match(html, /Nothing settles from this page: it holds no key, and the hosted Chain MCP is read-only\. Each run pays with a key made for it that holds nothing, so the API's facilitator refuses the first payment on chain and the job is not done\. The CLI finishes it on Atlantic\./);
    assert.match(html, /An authorization counts against the budget once it is signed, settled or not: whoever holds it could settle it until it expires\./);
    assert.doesNotMatch(script, /fetch\(/, "the page asks only through the shared runner");
    assert.doesNotMatch(script, /private[_ ]?key/i, "the page never handles a key");
  });
});
