// Browser tests for the Task 02 page, in Chromium: monitoring, dedup across checks, Stop/Start,
// errors, removed logs, explorer links and layout.
//   NODE_PATH="$(npm root -g)" node --test tests/demo-browser.test.mjs
// Playwright with Chromium is used where it is installed globally; it is not a dependency of this
// project, and without it the suite is skipped and says why. Needs dist/ (built by `npm ci`).
// Nothing reaches the network: the real api/events.js runs against the in-process fake Pharos Chain
// MCP, and every value is made up.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { createHandler } from "../api/events.js";
import { startFakePharosMcp } from "../dist/tests/fake-pharos-mcp.js";
import { makeLog, ZERO } from "../dist/tests/fixtures.js";

let chromium = null;
let skip = false;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
  await (await chromium.launch()).close();
} catch (error) {
  skip = chromium ? `Chromium for Playwright is not available (${error.message.split("\n")[0]})` : "Playwright is not installed (set NODE_PATH to a global install)";
}

const START = 20_248_479n;
const EXPLORER = "https://pharos.socialscan.io";
const WIDTHS = [[320, 568], [360, 640], [390, 844], [430, 932], [768, 1024], [1280, 860]];
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };

describe("the Task 02 page in a browser", { skip }, () => {
  let fake;
  let server;
  let browser;
  let base;
  /** The fake chain: `mine` adds blocks (and a Transfer every block) whenever the head is read. */
  const chain = { head: START, logs: [], beforeBlockNumber: () => mine(chain.minePerRead ?? 0), minePerRead: 0 };
  const mode = { fail: false };
  let apiCalls = 0;

  function mine(blocks) {
    for (let i = 0; i < blocks; i += 1) {
      chain.head += 1n;
      chain.logs.push(makeLog({ block: chain.head, index: Number(chain.head % 4n), amount: chain.head % 1000n * 10_000n }));
    }
  }

  before(async () => {
    fake = await startFakePharosMcp(chain);
    const api = createHandler(fake.url);
    const root = new URL("../public/", import.meta.url);
    server = createServer(async (req, res) => {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/api/events") {
        apiCalls += 1;
        if (mode.fail) return void res.writeHead(502, { "content-type": "application/json" }).end('{"ok":false,"error":{"kind":"MCP_CONNECTION","message":"Rate limited by the MCP server (HTTP 429).","hint":null}}');
        return api(req, res);
      }
      try {
        let body = await readFile(new URL(path === "/" ? "index.html" : path.slice(1), root));
        // A short interval so a test sees several checks in about a second; the page itself says 5 s.
        if (path === "/") body = Buffer.from(String(body).replace('data-interval="5"', 'data-interval="0.25"'));
        res.writeHead(200, { "content-type": TYPES[extname(path === "/" ? "index.html" : path)] ?? "application/octet-stream" }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    server?.close();
    await fake?.close();
  });

  beforeEach(() => {
    chain.head = START;
    chain.logs = [makeLog({ block: START - 50n, index: 1 }), makeLog({ block: START - 10n, from: ZERO, amount: 5_000_000n })];
    chain.minePerRead = 0;
    mode.fail = false;
    apiCalls = 0;
  });

  /** Every context a test opens is closed after it, pass or fail, so no page keeps polling into the next test. */
  const contexts = [];
  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  async function open(options = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
    contexts.push(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    return { page, context, errors };
  }
  const keys = (page) => page.$$eval("#feed > li", (items) => items.map((item) => item.dataset.key));
  const statusWord = (page) => page.locator("#status-word").innerText();

  test("starts by itself, shows the last checked block and the events already in the first window", async () => {
    const { page, context, errors } = await open();
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    assert.equal(await statusWord(page), "Monitoring");
    assert.equal(await page.locator("#last-block").innerText(), "20,248,479");
    assert.equal(await page.locator("#window").innerText(), "20,248,280–20,248,479");
    assert.equal(await page.locator("#feed > li").count(), 2);
    assert.deepEqual(await page.$$eval("#feed .event-badge", (badges) => badges.map((badge) => badge.textContent)), ["At start", "At start"]);
    assert.deepEqual(await page.$$eval("#feed .event-kind", (kinds) => kinds.map((kind) => kind.textContent)), ["Mint", "Transfer"]);
    assert.equal(await page.locator("#feed > li").first().locator(".event-num").innerText(), "5");
    assert.equal(await page.locator("#feed-empty").isHidden(), true);
    assert.equal(await page.locator("#start").isDisabled(), true);
    assert.equal(await page.locator("#stop").isDisabled(), false);
    assert.equal(await page.locator("#t-from").textContent(), "0x134f6d8 (20,248,280)");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("new events appear once each, marked New, across many overlapping checks", async () => {
    const { page, context } = await open();
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    chain.minePerRead = 2;
    await page.waitForFunction(() => document.querySelectorAll("#feed > li[data-fresh]").length >= 8, null, { timeout: 15_000 });
    const shown = await keys(page);
    assert.equal(new Set(shown).size, shown.length, "no duplicates in the feed");
    assert.equal(await page.locator("#feed > li").first().locator(".event-badge").innerText(), "New");
    const newest = await page.locator("#feed > li").first().getAttribute("data-key");
    const blocks = await page.$$eval("#feed .event-block", (cells) => cells.map((cell) => Number(cell.textContent.replace(/,/g, ""))));
    assert.deepEqual(blocks.slice(0, 5), [...blocks.slice(0, 5)].sort((a, b) => b - a), "newest first");
    assert.ok(Number(await page.$eval("#proof-dups", (cell) => cell.textContent.replace(/,/g, ""))) > 0, "overlap counted as duplicates");
    assert.match(await page.locator("#count-new").innerText(), /^\d+$/);
    assert.ok(newest);
    await context.close();
  });

  test("Stop pauses checking, Start resumes it, and the buttons follow the state", async () => {
    const { page, context } = await open();
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    await page.click("#stop");
    assert.equal(await statusWord(page), "Paused");
    assert.equal(await page.locator("#status-detail").innerText(), "Start monitoring to resume");
    assert.equal(await page.locator("#start").isDisabled(), false);
    assert.equal(await page.locator("#stop").isDisabled(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "start");
    const calls = apiCalls;
    await page.waitForTimeout(1_000);
    assert.equal(apiCalls, calls, "no checks while paused");

    chain.minePerRead = 0;
    mine(3);
    await page.click("#start");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "stop");
    await page.waitForFunction(() => document.querySelectorAll("#feed > li[data-fresh]").length === 3);
    assert.equal(await statusWord(page), "Monitoring");
    await context.close();
  });

  test("a long pause is said out loud: the blocks it skipped are named", async () => {
    const { page, context } = await open();
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    await page.click("#stop");
    chain.head += 500n;
    await page.click("#start");
    await page.waitForFunction(() => !document.getElementById("gap-note").hidden);
    assert.equal(await page.locator("#gap-note").innerText(), "Blocks 20,248,480–20,248,779 were not checked while the monitor was paused.");
    await context.close();
  });

  test("a hidden tab pauses, and coming back resumes", async () => {
    const { page, context } = await open();
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    const setHidden = (hidden) =>
      page.evaluate((value) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await setHidden(true);
    assert.equal(await statusWord(page), "Paused");
    assert.match(await page.locator("#status-detail").innerText(), /background/);
    await setHidden(false);
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    await context.close();
  });

  test("a failed check says so, keeps the last checked block, and the next check recovers", async () => {
    const { page, context } = await open();
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    mode.fail = true;
    await page.waitForFunction(() => document.body.dataset.state === "error");
    assert.equal(await statusWord(page), "Check failed");
    assert.match(await page.locator("#status-note").innerText(), /HTTP 429.*The last checked block is kept, so nothing is skipped\./);
    assert.equal(await page.locator("#last-block").innerText(), "20,248,479");
    mode.fail = false;
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    assert.equal(await page.locator("#status-note").isHidden(), true);
    await context.close();
  });

  test("an event that comes back removed is marked Removed, not shown again", async () => {
    const { page, context } = await open();
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    const [first] = chain.logs;
    chain.logs[0] = { ...first, removed: true };
    await page.waitForFunction(() => document.querySelector("#feed > li[data-removed]"));
    assert.equal(await page.locator("#feed > li[data-removed] .event-badge").innerText(), "Removed");
    assert.equal(await page.locator("#feed > li").count(), 2);
    await context.close();
  });

  test("each event links its transaction on the explorer, in a new tab", async () => {
    const { page, context } = await open();
    await page.waitForFunction(() => document.body.dataset.state === "monitoring");
    const link = page.locator("#feed > li").first().locator(".event-tx a");
    const hash = String(chain.logs[1].transactionHash);
    assert.equal(await link.getAttribute("href"), `${EXPLORER}/tx/${hash}`);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    assert.equal(await link.innerText(), "View in Explorer");
    assert.equal(await page.locator("#contract-explorer").getAttribute("href"), `${EXPLORER}/address/0xC879C018dB60520F4355C26eD1a6D572cdAC1815`);
    await context.close();
  });

  for (const scheme of ["dark", "light"]) {
    test(`no horizontal overflow at any width, ${scheme} theme`, async () => {
      chain.logs.push(makeLog({ block: START - 1n, index: 9, amount: 123_456_789_012_345_678n }));
      for (const [width, height] of WIDTHS) {
        const { page, context } = await open({ viewport: { width, height }, colorScheme: scheme });
        await page.waitForFunction(() => document.querySelectorAll("#feed > li").length === 3);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(overflow, 0, `${width}px overflows by ${overflow}px`);
        const outside = await page.$$eval("#feed > li, #monitor, .controls .btn", (elements) =>
          elements.filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).length,
        );
        assert.equal(outside, 0, `${width}px: an element sticks out`);
        await context.close();
      }
    });
  }
});
