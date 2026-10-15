// Browser tests for the Task 02 page, in Chromium: monitoring, dedup across checks, the bounded
// session feed and its New/Latest rules, initial history, Stop/Start, errors, removed logs,
// explorer links, keyboard, touch targets and layout in both themes.
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
const WIDTHS = [[320, 568], [360, 640], [390, 844], [768, 1024], [1024, 768], [1280, 860]];
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };

describe("the Task 02 page in a browser", { skip }, () => {
  let fake;
  let server;
  let browser;
  let base;
  /** The fake chain: `mine` adds blocks (and a Transfer every block) whenever the head is read. */
  const chain = { head: START, logs: [], beforeBlockNumber: () => mine(chain.minePerRead ?? 0), minePerRead: 0, logsPerBlock: 1 };
  const mode = { fail: false };
  let apiCalls = 0;

  function mine(blocks) {
    for (let i = 0; i < blocks; i += 1) {
      chain.head += 1n;
      for (let index = 0; index < chain.logsPerBlock; index += 1) {
        chain.logs.push(makeLog({ block: chain.head, index, amount: (chain.head % 1000n) * 10_000n + BigInt(index) }));
      }
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
    chain.logsPerBlock = 1;
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
  const keys = (page, list = "#feed") => page.$$eval(`${list} > li`, (items) => items.map((item) => item.dataset.key));
  const statusWord = (page) => page.locator("#status-word").innerText();
  const count = (page, selector) => page.locator(selector).count();
  const monitoring = (page) => page.waitForFunction(() => document.body.dataset.state === "monitoring");
  /** Wait until the session count says `n` events. */
  const sessionTotal = (page, n) => page.waitForFunction((want) => document.getElementById("session-count").textContent.startsWith(`${want.toLocaleString("en-US")} event`), n);

  test("starts by itself: status, last checked block, and the first window kept apart as initial history", async () => {
    const { page, errors } = await open();
    await monitoring(page);
    assert.equal(await statusWord(page), "Monitoring");
    assert.equal(await page.locator("#status-detail").innerText(), "checks every 0.25 s");
    assert.equal(await page.locator("#last-block").innerText(), "20,248,479");
    assert.equal(await page.locator("#toggle").innerText(), "Stop monitoring");
    assert.equal(await page.locator("#address").innerText(), "0xC879…1815");
    // Nothing new yet: the session is empty, the first window is initial history.
    assert.equal(await count(page, "#feed > li"), 0);
    assert.match(await page.locator("#session-count").innerText(), /^None yet\. Monitoring since \d\d:\d\d:\d\d\.$/);
    assert.equal(await page.locator("#feed-empty").isVisible(), true);
    assert.equal(await page.locator("#initial").isVisible(), true);
    assert.equal(await page.locator("#initial-count").innerText(), "2 events in the 200 blocks before monitoring started");
    assert.equal(await page.locator("#t-from").textContent(), "0x134f6d8 (20,248,280)");
    assert.deepEqual(errors, []);
  });

  test("new events appear once each, newest first, at most six rendered, across overlapping checks", async () => {
    const { page } = await open();
    await monitoring(page);
    chain.minePerRead = 2;
    await page.waitForFunction(() => Number.parseInt(document.getElementById("session-count").textContent, 10) >= 10, null, { timeout: 15_000 });
    chain.minePerRead = 0;
    const shown = await keys(page);
    assert.equal(shown.length, 6, "six rendered by default");
    assert.equal(new Set(shown).size, shown.length, "no duplicate cards");
    const blocks = await page.$$eval("#feed .event-block", (cells) => cells.map((cell) => Number(cell.firstChild.textContent.replace(/\D/g, ""))));
    assert.deepEqual(blocks, [...blocks].sort((a, b) => b - a), "newest first");
    assert.deepEqual(await page.$$eval("#feed > li", (items) => items.map((item) => item.hasAttribute("data-latest"))), [true, false, false, false, false, false]);
    assert.equal(await page.locator("#feed > li[data-latest] .event-latest").innerText(), "LATEST");
    assert.ok(Number(await page.$eval("#proof-dups", (cell) => cell.textContent.replace(/,/g, ""))) > 0, "overlap counted as duplicates");
    // The session and the initial history never share an event.
    await page.click("#initial-toggle");
    const initialKeys = await keys(page, "#initial-feed");
    assert.equal(shown.some((key) => initialKeys.includes(key)), false);
  });

  test("New marks only what the most recent check found; a later check takes it away", async () => {
    const { page } = await open();
    await monitoring(page);
    mine(2);
    await page.waitForFunction(() => document.querySelectorAll("#feed > li[data-new]").length === 2);
    assert.deepEqual(await page.$$eval("#feed .event-badge", (badges) => badges.map((badge) => badge.textContent)), ["New", "New"]);
    // The next check finds nothing: no event is "found by the last check" any more.
    await page.waitForFunction(() => document.querySelectorAll("#feed > li[data-new]").length === 0);
    mine(1);
    await page.waitForFunction(() => document.querySelectorAll("#feed > li").length === 3 && document.querySelectorAll("#feed > li[data-new]").length === 1);
    assert.deepEqual(await page.$$eval("#feed > li", (items) => items.map((item) => item.hasAttribute("data-new"))), [true, false, false]);
    assert.match(await page.locator("#feed > li[data-latest] .event-found").innerText(), /^found (just now|\d+ s ago)$/);
  });

  test("a large session keeps the DOM bounded; Show older and Show newest only page through it", async () => {
    const { page } = await open();
    await monitoring(page);
    chain.logsPerBlock = 10;
    mine(30);
    await sessionTotal(page, 300);
    assert.equal(await count(page, "li.event"), 6, "six cards in the whole page; initial history not rendered");
    assert.equal(await page.locator("#session-count").innerText().then((text) => text.startsWith("300 events detected since")), true);
    const older = page.locator("#session-older");
    assert.equal(await older.innerText(), "Show older events (294)");
    assert.equal(await page.locator("#session-newest").isHidden(), true);
    await older.click();
    assert.equal(await count(page, "#feed > li"), 18);
    assert.equal(await older.innerText(), "Show older events (282)");
    await older.click();
    assert.equal(await count(page, "#feed > li"), 30);
    // New events arriving while expanded keep the older ones in view.
    chain.logsPerBlock = 1;
    mine(2);
    await sessionTotal(page, 302);
    assert.equal(await count(page, "#feed > li"), 32);
    const first = await keys(page);
    assert.equal(new Set(first).size, first.length);
    await page.click("#session-newest");
    assert.equal(await count(page, "#feed > li"), 6);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "session-h");
    assert.equal(await page.locator("#session-newest").isHidden(), true);
    assert.match(await page.locator("#session-count").innerText(), /^302 events detected since/);
  });

  test("initial history is collapsed and unrendered by default, then opens six at a time", async () => {
    chain.logs = Array.from({ length: 20 }, (_, i) => makeLog({ block: START - 100n + BigInt(i), index: 0 }));
    const { page } = await open();
    await monitoring(page);
    const toggle = page.locator("#initial-toggle");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await toggle.getAttribute("aria-controls"), "initial-feed");
    assert.equal(await page.locator("#initial-feed").isHidden(), true);
    assert.equal(await count(page, "#initial-feed > li"), 0, "nothing in the DOM while collapsed");
    assert.equal(await page.locator("#initial-count").innerText(), "20 events in the 200 blocks before monitoring started");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await toggle.innerText(), "Hide initial events");
    assert.equal(await count(page, "#initial-feed > li"), 6);
    assert.equal(await page.locator("#initial-older").innerText(), "Show more initial events (14)");
    await page.click("#initial-older");
    assert.equal(await count(page, "#initial-feed > li"), 18);
    await page.click("#initial-older");
    assert.equal(await count(page, "#initial-feed > li"), 20);
    assert.equal(await page.locator("#initial-more").isHidden(), true);
    assert.equal(await count(page, "#initial-feed > li[data-new], #initial-feed > li[data-latest]"), 0, "initial events are never New or Latest");
    assert.equal(await count(page, "#feed > li"), 0, "and never in the session feed");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await count(page, "#initial-feed > li"), 0);
  });

  test("a focused link keeps focus when new events arrive", async () => {
    const { page } = await open();
    await monitoring(page);
    mine(2);
    await page.waitForFunction(() => document.querySelectorAll("#feed > li").length === 2);
    const key = await page.locator("#feed > li").nth(1).getAttribute("data-key");
    await page.locator("#feed > li").nth(1).locator(".event-link").focus();
    mine(1);
    await page.waitForFunction(() => document.querySelectorAll("#feed > li").length === 3);
    assert.equal(await page.evaluate(() => document.activeElement?.closest("li")?.dataset.key), key);
  });

  test("the last 'show more' moves focus to its heading instead of losing it", async () => {
    const { page } = await open();
    await monitoring(page);
    mine(8);
    await sessionTotal(page, 8);
    await page.focus("#session-older");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#session-older").isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "session-h");
  });

  test("the full contract address is available to assistive technology", async () => {
    const { page } = await open();
    await monitoring(page);
    assert.equal(await page.locator("#address-sr").textContent(), "Contract address 0xC879C018dB60520F4355C26eD1a6D572cdAC1815");
    assert.equal(await page.locator("#address").getAttribute("aria-hidden"), "true");
  });

  test("Stop and Start keep the button the same height, so nothing below it moves", async () => {
    const { page } = await open();
    await monitoring(page);
    const before = await page.locator("#toggle").boundingBox();
    await page.click("#toggle");
    const after = await page.locator("#toggle").boundingBox();
    assert.equal(after.height, before.height);
  });

  test("with no event in the first window, the initial history is not shown", async () => {
    chain.logs = [];
    const { page } = await open();
    await monitoring(page);
    assert.equal(await page.locator("#initial").isHidden(), true);
    assert.equal(await page.locator("#feed-empty").isVisible(), true);
  });

  test("Stop pauses checking and Start resumes it, from one button", async () => {
    const { page } = await open();
    await monitoring(page);
    const toggle = page.locator("#toggle");
    await toggle.click();
    assert.equal(await statusWord(page), "Paused");
    assert.equal(await page.locator("#status-detail").innerText(), "checks stopped");
    assert.equal(await toggle.innerText(), "Start monitoring");
    assert.equal(await toggle.evaluate((button) => button.classList.contains("btn-primary")), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "toggle", "focus stays on the control");
    const calls = apiCalls;
    await page.waitForTimeout(1_000);
    assert.equal(apiCalls, calls, "no checks while paused");
    mine(3);
    await toggle.click();
    await page.waitForFunction(() => document.querySelectorAll("#feed > li").length === 3);
    assert.equal(await statusWord(page), "Monitoring");
    assert.equal(await toggle.innerText(), "Stop monitoring");
  });

  test("the keyboard alone can stop, start and open the initial history", async () => {
    const { page } = await open();
    await monitoring(page);
    await page.focus("#toggle");
    await page.keyboard.press("Enter");
    assert.equal(await statusWord(page), "Paused");
    await page.keyboard.press("Space");
    await monitoring(page);
    await page.focus("#initial-toggle");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#initial-toggle").getAttribute("aria-expanded"), "true");
    const outline = await page.$eval("#initial-toggle", (button) => getComputedStyle(button).outlineStyle);
    assert.notEqual(outline, "none", "visible focus");
  });

  test("a long pause is said out loud: the blocks it skipped are named", async () => {
    const { page } = await open();
    await monitoring(page);
    await page.click("#toggle");
    chain.head += 500n;
    await page.click("#toggle");
    await page.waitForFunction(() => !document.getElementById("gap-note").hidden);
    assert.equal(await page.locator("#gap-note").innerText(), "Blocks 20,248,480–20,248,779 were not checked while the monitor was paused.");
  });

  test("a hidden tab pauses, and coming back resumes", async () => {
    const { page } = await open();
    await monitoring(page);
    const setHidden = (hidden) =>
      page.evaluate((value) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await setHidden(true);
    assert.equal(await statusWord(page), "Paused");
    assert.match(await page.locator("#status-detail").innerText(), /hidden/);
    await setHidden(false);
    await monitoring(page);
  });

  test("a failed check says so, keeps the last checked block, and the next check recovers", async () => {
    const { page } = await open();
    await monitoring(page);
    mode.fail = true;
    await page.waitForFunction(() => document.body.dataset.state === "error");
    assert.equal(await statusWord(page), "Check failed");
    assert.match(await page.locator("#status-note").innerText(), /HTTP 429.*The last checked block is kept, so nothing is skipped\./);
    assert.equal(await page.locator("#last-block").innerText(), "20,248,479");
    mode.fail = false;
    await monitoring(page);
    assert.equal(await page.locator("#status-note").isHidden(), true);
  });

  test("an event that comes back removed is marked Removed, not shown again", async () => {
    const { page } = await open();
    await monitoring(page);
    mine(1);
    await page.waitForFunction(() => document.querySelectorAll("#feed > li").length === 1);
    const index = chain.logs.length - 1;
    chain.logs[index] = { ...chain.logs[index], removed: true };
    await page.waitForFunction(() => document.querySelector("#feed > li[data-removed]"));
    assert.equal(await page.locator("#feed > li[data-removed] .event-badge").textContent(), "Removed");
    assert.equal(await count(page, "#feed > li"), 1);
  });

  test("Mint and Burn name only the side that is an account", async () => {
    const { page } = await open();
    await monitoring(page);
    chain.head += 1n;
    chain.logs.push(makeLog({ block: chain.head, index: 0, from: ZERO }), makeLog({ block: chain.head, index: 1, to: ZERO }));
    await page.waitForFunction(() => document.querySelectorAll("#feed > li").length === 2);
    const paths = await page.$$eval("#feed > li", (items) => items.map((item) => [item.dataset.kind, item.querySelector(".event-path").textContent]));
    assert.deepEqual(paths.map(([kind]) => kind).sort(), ["Burn", "Mint"]);
    for (const [kind, path] of paths) assert.match(path, kind === "Mint" ? /^to 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/ : /^from 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/);
  });

  test("each event links its transaction on the explorer, in a new tab", async () => {
    const { page } = await open();
    await monitoring(page);
    mine(1);
    await page.waitForFunction(() => document.querySelectorAll("#feed > li").length === 1);
    const link = page.locator("#feed > li").first().locator(".event-link");
    const hash = String(chain.logs.at(-1).transactionHash);
    assert.equal(await link.getAttribute("href"), `${EXPLORER}/tx/${hash}`);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    assert.equal((await link.textContent()).trim(), "View transaction");
    assert.match(await link.getAttribute("aria-label"), /^View transaction: transaction 0x/);
    assert.equal(await page.locator("#contract-explorer").getAttribute("href"), `${EXPLORER}/address/0xC879C018dB60520F4355C26eD1a6D572cdAC1815`);
  });

  test("proof and source links point where they should", async () => {
    const { page } = await open();
    await monitoring(page);
    const hrefs = await page.$$eval(".links a", (links) => links.map((link) => link.getAttribute("href")));
    assert.deepEqual(hrefs, [
      "https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/02-event-log-monitor",
      "https://github.com/Rzbyte/pharos-season-of-ai/blob/main/tasks/02-event-log-monitor/proof/mcp-transcript.json",
      "/api/events",
    ]);
    const api = await page.evaluate(() => fetch("/api/events").then((response) => response.json()));
    assert.equal(api.ok, true);
    await page.click("#proof > summary");
    assert.equal(await page.locator("#proof").evaluate((details) => details.open), true);
  });

  for (const scheme of ["dark", "light"]) {
    test(`layout at every width, ${scheme} theme: no overflow, 44px targets, readable text`, async () => {
      chain.logs.push(makeLog({ block: START - 1n, index: 9, amount: 123_456_789_012_345_678n }));
      for (const [width, height] of WIDTHS) {
        const { page, context } = await open({ viewport: { width, height }, colorScheme: scheme });
        await monitoring(page);
        mine(1);
        await page.waitForFunction(() => document.querySelectorAll("#feed > li").length >= 1);
        await page.click("#initial-toggle");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(overflow, 0, `${width}px overflows by ${overflow}px`);
        const outside = await page.$$eval("li.event, #monitor, #toggle, #initial-toggle, .event-link", (elements) =>
          elements.filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).length,
        );
        assert.equal(outside, 0, `${width}px: an element sticks out`);
        // Buttons are at least 44px tall; an explorer link's hit area reaches 44px through its ::after.
        const buttons = await page.$$eval("#toggle, #initial-toggle", (elements) => elements.map((element) => element.getBoundingClientRect().height));
        assert.ok(buttons.every((h) => h >= 44), `${width}px: button heights ${buttons}`);
        const hit = await page.$eval(".event-link", (link) => {
          const box = link.getBoundingClientRect();
          const after = getComputedStyle(link, "::after");
          return box.height - parseFloat(after.top) - parseFloat(after.bottom);
        });
        assert.ok(hit >= 44, `${width}px: explorer link hit area ${hit}px`);
        // Event text stays readable at every width.
        const sizes = await page.$$eval(".event-path, .event-block, .event-kind, .block-count", (elements) => elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
        assert.ok(Math.min(...sizes) >= 12, `${width}px: smallest event text ${Math.min(...sizes)}px`);
        if (width >= 960) {
          const [monitor, feed] = await page.$$eval("#monitor, #session", (elements) => elements.map((element) => element.getBoundingClientRect()));
          assert.ok(feed.left > monitor.right, "desktop: the feed sits beside the monitor");
          assert.ok(feed.top < 200, "desktop: the session starts on the first screen");
        }
        await context.close();
      }
    });
  }
});
