// Task 23's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/23-whale-watching-agent/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/whale.js");
const runner = shared("agent.js");

describe("the Task 23 page", () => {
  test("carries the shared shell, stamped for 23, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 23 -->\n${shellPart(shared("header.html"), "23")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 23 -->\n${shellPart(shared("footer.html"), "23")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "23", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/theme.js", "/assets/whale.css", "/assets/whale.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="23">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and every field has a label and a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-addresses", "f-min", "f-native"]);
    for (const id of fields) {
      assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
      assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
    }
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

  test("the page's example is the agent's watchlist preset, and its limits are the agent's", async () => {
    const { SAMPLE_ADDRESSES, USDC_WHALE_DEFAULTS, usdcWhales } = await import(new URL("../../../agent/dist/src/whale/presets.js", import.meta.url).href);
    const { MAX_MOVES } = await import(new URL("../../../agent/dist/src/whale/run.js", import.meta.url).href);
    const { WEB_ADDRESSES } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    assert.match(script, new RegExp(`const SAMPLE = \\[${SAMPLE_ADDRESSES.map((a) => `"${a.address}"`).join(", ")}\\];`));
    assert.match(script, new RegExp(`min: "${USDC_WHALE_DEFAULTS.min}", native: "${USDC_WHALE_DEFAULTS.native}"`));
    assert.match(script, new RegExp(`const MAX_ADDRESSES = ${WEB_ADDRESSES};`));
    const preset = usdcWhales();
    assert.equal(preset.lookback, 1000);
    assert.match(html, /A first run looks back 1,000 blocks/);
    assert.match(script, new RegExp(`a run scans at most the newest ${preset.maxScan.toLocaleString("en-US")}\\.`));
    assert.equal(MAX_MOVES, 100);
    assert.match(script, /one run reports at most 100\./);
    assert.match(html, /4 addresses · 250 USDC · 100 PROS/);
  });

  test("the page says what it does not do: nothing is signed or sent, and the sample is not anyone in particular", () => {
    assert.match(html, /Nothing is signed or sent from this page\./);
    assert.match(html, /picked from real activity, not known to be anyone in particular\./);
    assert.match(html, /is kept in this browser with the moves; each run sends it, and the agent reads only what is new through Chain MCP\./);
  });
});
