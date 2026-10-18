// Task 20's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/20-x402-paywalled-api/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/x402.js");
const runner = shared("agent.js");

describe("the Task 20 page", () => {
  test("carries the shared shell, stamped for 20, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 20 -->\n${shellPart(shared("header.html"), "20")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 20 -->\n${shellPart(shared("footer.html"), "20")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "20", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/theme.js", "/assets/x402.css", "/assets/x402.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="20">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and each field has a label and a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    // Looked up by key: the fields, their hints, and the examples.
    for (const id of ["f-price", "h-price", "f-cap", "h-cap", "f-to", "h-to", "ex-one", "ex-capped", "ex-dear"]) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-price", "f-cap", "f-to"]);
    for (const id of fields) {
      assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
      assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
    }
    assert.match(html, /id="f-price" name="price" inputmode="decimal"/);
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
  });

  test("the first request is the API's own default, and the CLI's runs shown are its commands", async () => {
    const { DEFAULT_X402_PRICE } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    assert.equal(/one: \{ price: "([\d.]+)" \}/.exec(script)[1], DEFAULT_X402_PRICE);
    for (const command of ["node dist/src/cli.js x402 --proof x402-mainnet.json", "node dist/src/cli.js verify x402-mainnet.json", "node dist/src/cli.js x402 --network atlantic-testnet --execute --proof x402-atlantic.json", "node dist/src/cli.js x402 serve --network atlantic-testnet --execute", "node dist/src/cli.js x402 pay http://127.0.0.1:4020/data --network atlantic-testnet"]) assert.ok(html.includes(command), command);
  });

  test("the page says what it does and does not do: nothing settled from here, a key made for each request that holds nothing", () => {
    assert.match(html, /Nothing can be settled from this page: it holds no key, and the hosted Chain MCP is read-only\. Each request pays with a key made for it that holds nothing and is never kept\./);
    assert.doesNotMatch(script, /fetch\(/, "the page asks only through the shared runner");
    assert.doesNotMatch(script, /private[_ ]?key/i, "the page never handles a key");
  });
});
