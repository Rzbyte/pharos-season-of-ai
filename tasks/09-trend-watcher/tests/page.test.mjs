// Task 09's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/09-trend-watcher/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/trend.js");
const runner = shared("agent.js");
const { NETWORKS } = await import(new URL("../../../agent/dist/src/core/networks.js", import.meta.url).href);

describe("the Task 09 page", () => {
  test("carries the shared shell, stamped for 09, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 09 -->\n${shellPart(shared("header.html"), "09")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 09 -->\n${shellPart(shared("footer.html"), "09")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "09", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/theme.js", "/assets/trend.css", "/assets/trend.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="09">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and every field has a label; every text field a hint", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    for (const [, id] of html.matchAll(/<(?:input|select) class="input" id="([^"]+)"/g)) assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
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

  test("the page's example is the agent's watcher preset, and it sends no more observations than the API takes", async () => {
    const { OUTFLOW_DEFAULTS, outflowWatcher } = await import(new URL("../../../agent/dist/src/trend/presets.js", import.meta.url).href);
    const { WEB_SERIES } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    assert.match(script, new RegExp(`holder: "${OUTFLOW_DEFAULTS.holder}", trend: "${OUTFLOW_DEFAULTS.trend}", observations: "${OUTFLOW_DEFAULTS.observations}", every: "${OUTFLOW_DEFAULTS.everyBlocks}"`));
    const action = outflowWatcher().action;
    assert.match(script, new RegExp(`const TREASURY = "${action.from}";`));
    assert.equal(action.amount, "100");
    assert.match(script, new RegExp(`const SERIES = ${WEB_SERIES};`));
  });

  test("the page says what it does not do: nothing is signed or sent from it", () => {
    assert.match(html, /Nothing is signed or sent from this page\./);
    assert.match(html, /Never from here: the hosted Chain MCP is read-only\./);
    assert.match(script, /"No\. The hosted Chain MCP is read-only; the CLI sends the action on Atlantic with ", el\("span", "nowrap", "--execute"\), "\."/);
    assert.match(html, /The observations are kept in this browser; each run adds one, read through Chain MCP\./);
  });
});
