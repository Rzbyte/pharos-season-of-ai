// Task 24's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/24-gas-fee-optimizer/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/gas.js");
const runner = shared("agent.js");

describe("the Task 24 page", () => {
  test("carries the shared shell, stamped for 24, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 24 -->\n${shellPart(shared("header.html"), "24")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 24 -->\n${shellPart(shared("footer.html"), "24")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "24", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/gas.css", "/assets/gas.js", "/assets/lab.css", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="24">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and every field has a label and a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-asset", "f-amount", "f-from", "f-to", "f-percentile"]);
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

  test("the page's example is the agent's gas plan, and its window is the API's", async () => {
    const { USDC_GAS_DEFAULTS, usdcGasPlan } = await import(new URL("../../../agent/dist/src/gas/presets.js", import.meta.url).href);
    const { WEB_GAS_SERIES } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    assert.match(script, new RegExp(`const EXAMPLE = Object\\.freeze\\(\\{ asset: "USDC", amount: "${USDC_GAS_DEFAULTS.amount}", from: "${USDC_GAS_DEFAULTS.from}", to: "${USDC_GAS_DEFAULTS.to}", percentile: "${USDC_GAS_DEFAULTS.percentile}" \\}\\);`));
    assert.match(script, new RegExp(`const SERIES = ${WEB_GAS_SERIES};`));
    const plan = usdcGasPlan();
    assert.deepEqual(plan.backfill, { samples: 5, spacing: 200 });
    assert.match(html, /five earlier blocks, 200 apart/);
    assert.match(html, /a percentile of the last 12 observations/);
    const options = [...html.matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)].map(([, value, label]) => [value, label]);
    assert.deepEqual(options, [["10", "Lowest 10%"], ["25", "Lowest 25%"], ["50", "Lowest half"], ["75", "Lowest 75%"]], "the API's percentiles");
  });

  test("the page says what it does not do: nothing is signed or sent from it", () => {
    assert.match(html, /Nothing is signed or sent from this page\./);
    assert.match(html, /Never from here: the hosted Chain MCP is read-only\./);
    assert.match(script, /"No\. The hosted Chain MCP is read-only; the CLI sends it on Atlantic with ", el\("span", "nowrap", "--execute"\), "\."/);
  });
});
