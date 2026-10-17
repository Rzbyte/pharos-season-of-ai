// Task 25's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/25-wallet-risk-checker/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/risk.js");
const runner = shared("agent.js");

describe("the Task 25 page", () => {
  test("carries the shared shell, stamped for 25, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 25 -->\n${shellPart(shared("header.html"), "25")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 25 -->\n${shellPart(shared("footer.html"), "25")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "25", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/risk.css", "/assets/risk.js", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="25">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and every field has a label and a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-action", "f-asset", "f-from", "f-to", "f-amount"]);
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

  test("the examples: Task 08's transfer, a lookalike that copies only the ends of an address the sender trades with, an unused spender", async () => {
    // Until a check finds the sender's busiest partner, the lookalike copies the one Task 02's live proof saw.
    const { SAMPLE_ADDRESSES } = await import(new URL("../../../agent/dist/src/whale/presets.js", import.meta.url).href);
    const { EXAMPLE_PAYER, EXAMPLE_RECIPIENT } = await import(new URL("../../../agent/dist/src/guardian/presets.js", import.meta.url).href);
    const { NETWORKS } = await import(new URL("../../../agent/dist/src/core/networks.js", import.meta.url).href);
    const partner = script.match(/let partner = "(0x[0-9a-fA-F]{40})";/)[1];
    const lookalikeOf = new Function("address", `return ${script.match(/const lookalikeOf = \(address\) => (.+);/)[1]};`);
    const trader = SAMPLE_ADDRESSES.find((a) => a.label === "Trades with the busiest").address;
    assert.equal(partner, trader);
    assert.match(html, new RegExp(`id="ex-lookalike" type="button">A made-up lookalike of ${trader.slice(0, 6)}…${trader.slice(-4)}</button>`));
    const lookalike = lookalikeOf(partner);
    assert.match(lookalike, /^0x[0-9a-f]{40}$/);
    assert.equal(lookalike.slice(2, 6), trader.slice(2, 6).toLowerCase());
    assert.equal(lookalike.slice(-4), trader.slice(-4).toLowerCase());
    assert.notEqual(lookalike, trader.toLowerCase());
    assert.match(script, new RegExp(`from: "${EXAMPLE_PAYER}", to: "${EXAMPLE_RECIPIENT}", amount: "25"`));
    const assets = Object.fromEntries([["PROS", 18], ...NETWORKS["pharos-mainnet"].tokens.map((t) => [t.symbol, t.decimals])]);
    const listed = script.match(/const ASSETS = Object\.freeze\((\{[^}]+\})\);/)[1];
    assert.deepEqual(Object.fromEntries([...listed.matchAll(/(\w+): (\d+)/g)].map(([, symbol, decimals]) => [symbol, Number(decimals)])), assets, "PROS and the official tokens, as the agent has them");
  });

  test("the page says what it does not do: nothing is signed or sent, and which example is made up", () => {
    assert.match(html, /Nothing is signed or sent from this page\./);
    assert.match(html, /The lookalike example is made up: the first and last four characters of the address that sender moved USDC with most in the blocks read, around zeros, the way address poisoning copies an address\./);
  });
});
