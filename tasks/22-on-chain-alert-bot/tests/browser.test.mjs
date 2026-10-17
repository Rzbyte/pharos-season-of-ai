// Task 22's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/22-on-chain-alert-bot/tests/browser.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { extname } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";

const at = (path) => new URL(`../../../${path}`, import.meta.url).href;
const { createHandler } = await import(at("agent/api/agent.js"));
const { defaultState, startFakeChain } = await import(at("agent/dist/tests/fake-chain.js"));
const { loadConfig } = await import(at("agent/dist/vendor/pharos-mcp/src/config.js"));
const { startHttpServer } = await import(at("agent/dist/vendor/pharos-mcp/src/http.js"));

let chromium = null;
let skip = false;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
  await (await chromium.launch()).close();
} catch (error) {
  skip = chromium ? `Chromium for Playwright is not available (${error.message.split("\n")[0]})` : "Playwright is not installed (set NODE_PATH to a global install)";
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };
const WIDTHS = [[320, 568], [360, 740], [390, 844], [768, 1024], [1024, 768], [1280, 860]];
const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const HOLDER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";
const STRANGER = "0x1111111111111111111111111111111111111111";
const KEY = "pharos-agent-lab:22:0x912c9ade24d44d8922f0866d8dcb079f1363f647:500:100";
const TITLE = "22 · On-Chain Alert Bot · Pharos Agent Lab";

const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 22 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  // The holder starts with 1,000 USDC. In the first run's 1,000 blocks: one transfer of 500 or more, one smaller.
  const fresh = () => {
    fake.state.head = 5_000_000n;
    fake.state.headTime = 1_790_000_000n;
    fake.state.tokens[USDC] = { decimals: 6, balances: { [lower(HOLDER)]: 1_000_000_000n } };
    fake.state.transfers = [
      { token: USDC, from: STRANGER, to: RECIPIENT, amount: 750_000_000n, block: 4_999_995n },
      { token: USDC, from: STRANGER, to: RECIPIENT, amount: 10_000_000n, block: 4_999_996n },
    ];
    fake.state.failures = {};
  };
  /** The chain moves on `blocks`; the holder holds `usdc` (base units), and any `transfers` land. */
  const step = (blocks, usdc, transfers = []) => {
    fake.state.head += blocks;
    fake.state.headTime += blocks;
    fake.state.tokens[USDC].balances[lower(HOLDER)] = usdc;
    fake.state.transfers.push(...transfers);
  };

  before(async () => {
    fake = await startFakeChain(defaultState({}));
    fresh();
    const port = await freePort();
    // No rate limit here: the suite runs more checks in a minute than the hosted endpoint allows one IP.
    official = await startHttpServer(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: String(port), PHAROS_RPC_URL: fake.url, PHAROS_CHAIN_ID: "1672", RATE_LIMIT_PER_MINUTE: "0" }));
    api = createHandler({ chainMcpUrl: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000 });
    const root = new URL("../public/", import.meta.url);
    server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/agent") {
        requests.push(Object.fromEntries(url.searchParams));
        return api(req, res);
      }
      try {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(await readFile(new URL(file, root)));
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
    official?.closeAllConnections?.();
    await new Promise((resolve) => (official ? official.close(resolve) : resolve()));
    await fake?.close();
  });
  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
    requests.length = 0;
    fresh();
  });

  const settled = () => document.getElementById("watch").getAttribute("aria-busy") === "false";

  async function open(path = "/", options = {}, init = null) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    contexts.push(context);
    if (init) await context.addInitScript(init.script, init.arg);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.waitForFunction(settled);
    return { page, context, errors };
  }
  /** "Check now", then wait for the run: the click marks the panel busy before the request starts. */
  const again = async (page) => {
    await page.click("#again");
    await page.waitForFunction(settled);
  };

  const view = (page) =>
    page.evaluate(() => {
      const text = (id) => (document.getElementById(id).hidden ? null : document.getElementById(id).textContent);
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        scan: text("scan"),
        gap: text("gap"),
        error: text("error"),
        meta: text("feed-box") === null ? null : document.getElementById("feed-meta").textContent,
        empty: text("feed-empty"),
        feed: [...document.querySelectorAll(".alert")].map((row) => [row.querySelector(".alert-kind").textContent, row.querySelector(".alert-label").textContent, row.querySelector(".alert-body").textContent, row.querySelector(".alert-meta").textContent, row.dataset.new]),
        rules: [...document.querySelectorAll(".rule")].map((row) => [row.querySelector(".rule-label").textContent, row.querySelector(".rule-state").textContent, row.querySelector(".rule-evidence").textContent, row.dataset.state]),
      };
    });
  const stored = (page, key = KEY) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);
  const FIRST = ["Transfer", "A USDC transfer of 500 or more", "750 USDC from 0x1111…1111 to 0xB274…9553", "Block 4,999,995 · transaction"];

  test("the first run: the last 1,000 blocks scanned, one large transfer alerted, every rule's state, kept in this browser", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Alert", "1 new", "warning"]);
    assert.equal(seen.scan, "Blocks 4,999,001–5,000,000 scanned for USDC transfers of 500 or more.");
    assert.equal(seen.meta, "1 kept in this browser");
    assert.deepEqual(seen.feed, [[...FIRST, "true"]]);
    assert.equal(seen.empty, null);
    assert.deepEqual(seen.rules, [
      ["A USDC transfer of 500 or more", "1 new", "blocks 4,999,001–5,000,000get_logs", "alerting"],
      ["0x912c…f647 holds less than 100 USDC", "clear", "1,000 USDCeth_call", "clear"],
      ["USDC is paused", "clear", "paused() = falseeth_call", "clear"],
      ["Gas costs more than 5 gwei", "clear", "1.2 gweiget_gas_price", "clear"],
    ]);
    assert.equal(await page.getAttribute(".alert-tx", "href"), "https://pharos.socialscan.io/tx/0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6");
    assert.deepEqual(requests, [{ task: "22", min: "500", low: "100", holder: HOLDER }]);
    const kept = await stored(page);
    assert.deepEqual([kept.cursor, kept.states, kept.feed.length], ["5000000", { "holder-low": false, "usdc-paused": false, "gas-high": false }, 1]);
    assert.deepEqual(errors, []);
  });

  test("run after run: only new blocks are scanned, each transfer alerts once, a condition alerts when it starts and when it stops", async () => {
    const { page, context } = await open();
    step(10n, 50_000_000n, [{ token: USDC, from: lower(HOLDER), to: STRANGER, amount: 950_000_000n, block: 5_000_004n }]);
    await again(page);
    assert.deepEqual(requests.at(-1), { task: "22", min: "500", low: "100", holder: HOLDER, cursor: "5000000", states: "holder-low:0,usdc-paused:0,gas-high:0" });
    const second = await view(page);
    assert.deepEqual([second.word, second.detail], ["Alert", "2 new; 1 condition holds"]);
    assert.equal(second.scan, "Blocks 5,000,001–5,000,010 scanned for USDC transfers of 500 or more.");
    assert.deepEqual(second.feed, [
      ["Started", "0x912c…f647 holds less than 100 USDC", "Holds now: 50 USDC", "Block 5,000,010", "true"],
      ["Transfer", "A USDC transfer of 500 or more", "950 USDC from 0x912c…f647 to 0x1111…1111", "Block 5,000,004 · transaction", "true"],
      [...FIRST, "false"],
    ]);
    assert.deepEqual(second.rules[1].slice(1), ["holds", "50 USDCeth_call", "alerting"]);
    // The same block again: nothing new, and the low balance is not alerted twice.
    await again(page);
    const same = await view(page);
    assert.deepEqual([same.word, same.detail, same.scan], ["Watching", "no new alerts; 1 condition holds", "No new blocks since the last check."]);
    assert.deepEqual(same.feed.map((row) => row[4]), ["false", "false", "false"]);
    // A reload is the same bot: it carries on from the stored block and states.
    step(10n, 300_000_000n);
    const reloaded = await context.newPage();
    await reloaded.goto(base);
    await reloaded.waitForFunction(settled);
    assert.deepEqual([requests.at(-1).cursor, requests.at(-1).states], ["5000010", "holder-low:1,usdc-paused:0,gas-high:0"]);
    const after = await view(reloaded);
    assert.deepEqual([after.word, after.detail], ["Alert", "1 new"]);
    assert.deepEqual(after.feed[0], ["Stopped", "0x912c…f647 holds less than 100 USDC", "No longer holds: 300 USDC", "Block 5,000,020", "true"]);
    assert.equal(after.feed.length, 4);
    assert.equal(after.meta, "4 kept in this browser");
  });

  test("an alert while the tab is in the background shows in its title until the tab is seen", async () => {
    const { page } = await open();
    assert.equal(await page.title(), TITLE, "a visible tab's title is left alone");
    await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
    step(10n, 1_000_000_000n, [{ token: USDC, from: STRANGER, to: RECIPIENT, amount: 600_000_000n, block: 5_000_002n }, { token: USDC, from: STRANGER, to: RECIPIENT, amount: 700_000_000n, block: 5_000_003n }]);
    await again(page);
    assert.equal(await page.title(), `(2) ${TITLE}`);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await page.title(), TITLE);
  });

  test("far behind: the newest 2,000 blocks are scanned, and the page says which were not", async () => {
    const init = { script: ([key]) => localStorage.setItem(key, JSON.stringify({ cursor: "4990000", states: {}, feed: [] })), arg: [KEY] };
    const { page } = await open("/", {}, init);
    assert.equal(requests[0].cursor, "4990000");
    const seen = await view(page);
    assert.equal(seen.scan, "Blocks 4,998,001–5,000,000 scanned for USDC transfers of 500 or more.");
    assert.equal(seen.gap, "Too far behind: blocks 4,990,001–4,998,000 were not scanned; a run scans at most the newest 2,000.");
  });

  test("the settings, from the form: their own bot, kept in the address bar; forgetting starts over", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-min", "5");
    await page.click('#settings button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("watch").getAttribute("aria-busy") === "false" && document.querySelectorAll(".alert").length === 2);
    assert.deepEqual(requests.at(-1), { task: "22", min: "5", low: "100", holder: HOLDER }, "a new bot: a first run");
    assert.equal(new URL(page.url()).search, `?min=5&low=100&holder=${HOLDER}`);
    assert.equal(await page.textContent("#change-meta"), "5 USDC · 0x912c…f647 below 100");
    assert.deepEqual((await view(page)).feed.map((row) => row[2]), ["10 USDC from 0x1111…1111 to 0xB274…9553", "750 USDC from 0x1111…1111 to 0xB274…9553"]);
    assert.equal((await stored(page)).feed.length, 1, "the example bot's alerts are kept apart");
    await page.click("#forget");
    await page.waitForFunction(settled);
    assert.equal(requests.at(-1).cursor, undefined, "nothing earlier is sent after forgetting");
    assert.equal((await view(page)).meta, "2 kept in this browser");
  });

  test("invalid settings are marked at their fields and never sent", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-min", "lots");
    await page.fill("#f-holder", "0x12");
    await page.click('#settings button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-min");
    assert.equal(await page.textContent("#h-min"), "An amount of USDC, up to 6 decimals.");
    assert.equal(await page.textContent("#h-holder"), "Enter a 0x address of 40 hex characters.");
    assert.equal(await page.textContent("#h-low"), "In USDC. Alerts when the holder's balance drops below this.");
    assert.equal(requests.length, 1);
  });

  test("checking every 15 s while it is on", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(base);
    await page.waitForFunction(settled);
    await page.click("#auto");
    assert.deepEqual([await page.getAttribute("#auto", "aria-pressed"), await page.textContent("#auto")], ["true", "Stop checking every 15 s"]);
    step(10n, 1_000_000_000n, [{ token: USDC, from: STRANGER, to: RECIPIENT, amount: 800_000_000n, block: 5_000_006n }]);
    await page.clock.runFor(15_000);
    await page.waitForFunction(() => document.querySelectorAll(".alert").length === 2);
    assert.equal(requests.at(-1).cursor, "5000000");
    await page.click("#auto");
    const before = requests.length;
    await page.clock.runFor(30_000);
    assert.equal(requests.length, before, "stopped");
  });

  test("an unreachable Chain MCP is an error the page states, and the store is left as it was", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["Not checked", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
      assert.deepEqual([seen.feed, seen.rules, seen.scan, seen.meta], [[], [], null, null]);
      assert.equal(await stored(page), null);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("the proof: each Chain MCP call with the blocks it covers, the raw result behind a toggle; the skip link lands on the alerts", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent));
    assert.deepEqual(calls.slice(0, 3), ["get_chain_info ", "get_block_number ", "get_block @ 5,000,000"]);
    assert.deepEqual(calls.filter((call) => call.startsWith("get_logs")), ["get_logs 0xC879…1815 blocks 4,999,001–5,000,000"]);
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.equal(json.result.schema, "pharos-agent/alert-run/1");
    assert.equal(json.result.store.cursor, "5000000");
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "alerts-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open("/", { viewport: { width, height }, colorScheme });
        step(10n, 50_000_000n, [{ token: USDC, from: lower(HOLDER), to: STRANGER, amount: 123_456_789_000n, block: 5_000_004n }]);
        await again(page);
        await page.click("#change > summary");
        await page.click("#proof > summary");
        const layout = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const status = box(document.getElementById("status"));
          const again = box(document.getElementById("again"));
          const targets = [...document.querySelectorAll("button, summary, .btn, input, select")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className || el.tagName, Math.round(box(el).height)]);
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            beside: Math.abs(status.top - again.top) < 24 && status.right <= again.left + 1,
            small: targets.filter(([, h]) => h < 32),
            rowsInside: [...document.querySelectorAll(".alert, .rule, .calls > li")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Check now share the top line`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Check now is a 44 px target`);
        fresh();
      }
    }
  });
});
