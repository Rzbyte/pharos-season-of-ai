// Task 11's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/11-policy-gatekeeper/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/gate.js");
const runner = shared("agent.js");
const { NETWORKS } = await import(new URL("../../../agent/dist/src/core/networks.js", import.meta.url).href);

describe("the Task 11 page", () => {
  test("carries the shared shell, stamped for 11, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 11 -->\n${shellPart(shared("header.html"), "11")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 11 -->\n${shellPart(shared("footer.html"), "11")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "11", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/gate.css", "/assets/gate.js", "/assets/lab.css", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="11">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and every field has a label; every text field a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    // The hints that follow the action and the asset, looked up as `h-${key}`.
    for (const key of ["to", "amount"]) assert.ok(ids.has(`h-${key}`), `h-${key}`);
    for (const [, id] of html.matchAll(/<(?:input|select) class="input" id="([^"]+)"/g)) assert.match(html, new RegExp(`<label class="(?:field-label|sr)" for="${id}"`), id);
    for (const [, id] of html.matchAll(/<input class="input" id="([^"]+)"/g)) assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
    // The two hour fields are one group, named by its legend.
    assert.match(html, /<fieldset class="inputs-field inputs-group">\s*<legend class="field-label">Allowed hours, UTC<\/legend>/);
  });

  test("the assets are PROS and the official Pharos Mainnet tokens, with the agent's decimals, in one order", () => {
    const mainnet = NETWORKS["pharos-mainnet"];
    const official = [[mainnet.nativeSymbol, 18], ...mainnet.tokens.map((token) => [token.symbol, token.decimals])];
    const [, list] = /const ASSETS = Object\.freeze\(\{ ([^}]+) \}\);/.exec(script);
    assert.deepEqual(list.split(", ").map((pair) => pair.split(": ")).map(([symbol, decimals]) => [symbol, Number(decimals)]), official);
    assert.deepEqual([...html.matchAll(/<option value="([A-Z]+)">\1<\/option>/g)].map(([, symbol]) => symbol), official.map(([symbol]) => symbol));
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

  test("the page's example hours are the policy's, and its fixed rules are the ones the agent ships", async () => {
    const { treasuryPolicy, TREASURY_HOURS, TREASURY_ALLOWLIST } = await import(new URL("../../../agent/dist/src/policy/presets.js", import.meta.url).href);
    assert.match(script, new RegExp(`hoursFrom: "${TREASURY_HOURS.from}", hoursTo: "${TREASURY_HOURS.to}"`));
    const rules = Object.fromEntries(treasuryPolicy().rules.map((rule) => [rule.id, rule]));
    assert.deepEqual([rules.assets.assets, rules["per-action"].amount, rules.rolling.amount, rules.rolling.blocks, rules.gas.gwei, TREASURY_ALLOWLIST.length], [["USDC"], "100", "5000", 1000, "10", 3]);
    assert.match(html, /USDC only, to three addresses, at most 100 USDC per action and 5,000 USDC per 1,000 blocks, gas at most 10 gwei, and a dry run that succeeds\./);
  });

  test("the page says what it does not do: nothing is signed or sent from it", () => {
    assert.match(html, /Nothing is signed or sent from this page\./);
    assert.match(html, /Never from here: the hosted Chain MCP is read-only\./);
    assert.match(script, /The hosted Chain MCP is read-only; the CLI sends allowed requests on Atlantic\./);
    assert.match(script, /No\. A denied request is never signed\./);
  });
});
