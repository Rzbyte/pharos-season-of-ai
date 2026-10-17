// Task 22's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/22-on-chain-alert-bot/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/alert.js");
const runner = shared("agent.js");

describe("the Task 22 page", () => {
  test("carries the shared shell, stamped for 22, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 22 -->\n${shellPart(shared("header.html"), "22")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 22 -->\n${shellPart(shared("footer.html"), "22")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "22", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/alert.css", "/assets/alert.js", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="22">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and every field has a label and a hint", () => {
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

  test("the page's example is the agent's alert preset, and its limits are the agent's", async () => {
    const { USDC_ALERT_DEFAULTS, usdcAlerts } = await import(new URL("../../../agent/dist/src/alert/presets.js", import.meta.url).href);
    const { MAX_ALERTS } = await import(new URL("../../../agent/dist/src/alert/run.js", import.meta.url).href);
    assert.match(script, new RegExp(`const EXAMPLE = Object\\.freeze\\(\\{ min: "${USDC_ALERT_DEFAULTS.min}", holder: "${USDC_ALERT_DEFAULTS.holder}", low: "${USDC_ALERT_DEFAULTS.low}" \\}\\);`));
    const preset = usdcAlerts();
    assert.equal(preset.lookback, 1000);
    assert.match(html, /A first run looks back 1,000 blocks\./);
    assert.match(script, new RegExp(`a run scans at most the newest ${preset.maxScan.toLocaleString("en-US")}\\.`));
    assert.equal(MAX_ALERTS, 100);
    assert.match(script, /one run reports at most 100\./);
    assert.match(html, /at most 1,000 blocks a call/);
  });

  test("the page says what it does not do: nothing is signed or sent from it", () => {
    assert.match(html, /Nothing is signed or sent from this page\./);
    assert.match(html, /Alerts are shown here; the CLI also posts them to a webhook\./);
    assert.match(html, /is kept in this browser with the alerts; each run sends it, and the agent reads only what is new through Chain MCP\./);
  });
});
