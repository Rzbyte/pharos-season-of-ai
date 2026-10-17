// Task 23's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/23-whale-watching-agent/tests/browser.test.mjs
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
const SAMPLE = ["0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", "0x936564245B69f5a293b42cbd752E0eE3bb68b470", "0x1F3546a29EeC2102c8d52E21a45114124014c85C", "0x0018b46177c611fc1EfBca63c845c2a69045E28D"];
const [BUSIEST, SENDER, TRADER, LARGEST] = SAMPLE;
const OTHER = "0x1111111111111111111111111111111111111111";
const KEY = `pharos-agent-lab:23:${SAMPLE.map((a) => a.toLowerCase()).sort().join(",")}:250:100`;
const TITLE = "23 · Whale-Watching Agent · Pharos Agent Lab";
const PROS = 10n ** 18n;

const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 23 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  // The busiest holds 1,000 USDC and 500 PROS; the trader is a contract. In the first run's 1,000
  // blocks: one significant transfer (698.77 USDC sent), one only counted (20 USDC received).
  const fresh = () => {
    fake.state.head = 5_000_000n;
    fake.state.headTime = 1_790_000_000n;
    fake.state.native = { [lower(BUSIEST)]: 500n * PROS };
    fake.state.nonces = { [lower(BUSIEST)]: 7n };
    fake.state.code = { [lower(TRADER)]: "0x6080604052" };
    fake.state.tokens[USDC] = { decimals: 6, balances: { [lower(BUSIEST)]: 1_000_000_000n, [lower(SENDER)]: 50_000_000n, [lower(TRADER)]: 98_765_430_000n } };
    fake.state.transfers = [
      { token: USDC, from: lower(SENDER), to: OTHER, amount: 698_770_000n, block: 4_999_950n },
      { token: USDC, from: OTHER, to: lower(BUSIEST), amount: 20_000_000n, block: 4_999_960n },
    ];
    fake.state.failures = {};
  };
  /** The chain moves on `blocks`. */
  const step = (blocks, transfers = []) => {
    fake.state.head += blocks;
    fake.state.headTime += blocks;
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

  async function open(path = "/", options = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    contexts.push(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.waitForFunction(settled);
    return { page, context, errors };
  }
  /** "Check now", then wait for the run: the click marks the panel busy before the request starts. */
  const again = async (page) => {
    // Wait for the new answer itself: the panel is already settled from the last run when the click lands.
    await Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agent"), page.click("#again")]);
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
        meta: text("moves-box") === null ? null : document.getElementById("moves-meta").textContent,
        empty: text("moves-empty"),
        moves: [...document.querySelectorAll(".move")].map((row) => [row.querySelector(".move-kind").textContent, row.querySelector(".move-head").textContent.slice(row.querySelector(".move-kind").textContent.length), row.querySelector(".move-body").textContent, row.querySelector(".move-meta").textContent, row.dataset.new]),
        tracked: [...document.querySelectorAll(".whale")].map((row) => [row.querySelector(".whale-head").textContent, [...row.querySelectorAll(".whale-line")].map((line) => `${line.querySelector(".whale-amount").textContent} | ${line.querySelector(".whale-change").textContent}`), row.querySelector(".whale-activity").textContent]),
      };
    });
  const stored = (page, key = KEY) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);
  const FIRST = ["Sent", "Sent the most", "698.77 USDC to 0x1111…1111", "Block 4,999,950 · transaction"];

  test("the first run: every address with its holdings, the last 1,000 blocks scanned, the one significant move surfaced", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Spotted", "1 significant move", "warning"]);
    assert.equal(seen.scan, "Blocks 4,999,001–5,000,000 scanned: 2 USDC transfers by the 4 tracked addresses.");
    assert.equal(seen.meta, "1 kept in this browser");
    assert.deepEqual(seen.moves, [[...FIRST, "true"]]);
    assert.deepEqual(seen.tracked, [
      ["Busiest in the sample", ["1,000 USDC | first check", "500 PROS | first check"], "1 in, 0 out this run"],
      ["Sent the most1 move", ["50 USDC | first check", "0 PROS | first check"], "0 in, 1 out this run"],
      ["Trades with the busiestcontract", ["98,765.43 USDC | first check", "0 PROS | first check"], "0 in, 0 out this run"],
      ["Sent the largest transfer", ["0 USDC | first check", "0 PROS | first check"], "0 in, 0 out this run"],
    ]);
    assert.equal(await page.getAttribute(".whale a.who", "href"), `https://pharos.socialscan.io/address/${BUSIEST}`);
    assert.equal(await page.getAttribute(".whale a.who", "title"), BUSIEST);
    assert.deepEqual(requests, [{ task: "23", addresses: SAMPLE.join(","), min: "250", native: "100" }]);
    const kept = await stored(page);
    assert.deepEqual([kept.cursor, Object.keys(kept.snapshots).length, kept.feed.length], ["5000000", 4, 1]);
    assert.deepEqual(errors, []);
  });

  test("run after run: what changed since the last check, a transfer between two tracked addresses, a PROS balance that fell; nothing twice", async () => {
    const { page, context } = await open();
    step(10n, [{ token: USDC, from: lower(BUSIEST), to: lower(TRADER), amount: 300_000_000n, block: 5_000_004n }]);
    fake.state.tokens[USDC].balances[lower(BUSIEST)] = 700_000_000n;
    fake.state.tokens[USDC].balances[lower(TRADER)] = 99_065_430_000n;
    fake.state.native[lower(BUSIEST)] = 380n * PROS;
    fake.state.nonces[lower(BUSIEST)] = 9n;
    await again(page);
    const sent = JSON.parse(requests.at(-1).store);
    assert.deepEqual([sent.cursor, Object.keys(sent.snapshots).length], ["5000000", 4]);
    const second = await view(page);
    assert.deepEqual([second.word, second.detail], ["Spotted", "2 significant moves"]);
    assert.equal(second.scan, "Blocks 5,000,001–5,000,010 scanned: 1 USDC transfer by the 4 tracked addresses.");
    assert.deepEqual(second.moves, [
      ["PROS out", "Busiest in the sample", "Balance fell by 120 PROS", "Block 5,000,010 · since the last check", "true"],
      ["Sent", "Busiest in the sample", "300 USDC to Trades with the busiest", "Block 5,000,004 · transaction", "true"],
      [...FIRST, "false"],
    ]);
    assert.deepEqual(second.tracked[0], ["Busiest in the sample2 moves", ["700 USDC | −300 USDC", "380 PROS | −120 PROS"], "0 in, 1 out this run · 2 transactions sent"]);
    assert.deepEqual(second.tracked[2], ["Trades with the busiestcontract", ["99,065.43 USDC | +300 USDC", "0 PROS | ±0 PROS"], "1 in, 0 out this run · 0 transactions sent"]);
    // The same block again: nothing new, nothing surfaced twice.
    await again(page);
    const same = await view(page);
    assert.deepEqual([same.word, same.detail, same.scan], ["Watching", "no significant moves; 0 transfers", "No new blocks since the last check."]);
    assert.deepEqual(same.moves.map((row) => row[4]), ["false", "false", "false"]);
    // A reload is the same watcher: it carries on from what it saw.
    step(10n);
    const reloaded = await context.newPage();
    await reloaded.goto(base);
    await reloaded.waitForFunction(settled);
    assert.equal(JSON.parse(requests.at(-1).store).cursor, "5000010");
    const after = await view(reloaded);
    assert.deepEqual([after.word, after.meta, after.moves.length], ["Watching", "3 kept in this browser", 3]);
  });

  test("a move while the tab is in the background shows in its title until the tab is seen", async () => {
    const { page } = await open();
    assert.equal(await page.title(), TITLE, "a visible tab's title is left alone");
    await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
    step(10n, [{ token: USDC, from: OTHER, to: lower(LARGEST), amount: 5_000_000_000n, block: 5_000_002n }]);
    await again(page);
    assert.equal(await page.title(), `(1) ${TITLE}`);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await page.title(), TITLE);
  });

  test("the watchlist, from the form: its own watcher, kept in the address bar; forgetting starts over", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-addresses", `${BUSIEST}\n`);
    await page.fill("#f-min", "10");
    await page.click('#settings button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("watch").getAttribute("aria-busy") === "false" && document.querySelectorAll(".whale").length === 1);
    assert.deepEqual(requests.at(-1), { task: "23", addresses: BUSIEST, min: "10", native: "100" }, "a new watcher: a first run");
    assert.equal(new URL(page.url()).search, `?addresses=${BUSIEST}&min=10&native=100`);
    assert.equal(await page.textContent("#change-meta"), "1 address · 10 USDC · 100 PROS");
    const seen = await view(page);
    assert.deepEqual(seen.moves.map((row) => row.slice(0, 3)), [["Received", "Busiest in the sample", "20 USDC from 0x1111…1111"]]);
    assert.equal(seen.scan, "Blocks 4,999,001–5,000,000 scanned: 1 USDC transfer by the tracked address.");
    assert.equal((await stored(page)).feed.length, 1, "the example watcher's memory is kept apart");
    await page.click("#forget");
    await page.waitForFunction(settled);
    assert.equal(requests.at(-1).store, undefined, "nothing earlier is sent after forgetting");
  });

  test("invalid settings are marked at their fields and never sent", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-addresses", `${BUSIEST}\n0x12`);
    await page.fill("#f-native", "lots");
    await page.click('#settings button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-addresses");
    assert.equal(await page.textContent("#h-addresses"), "0x12 is not a 0x address of 40 hex characters.");
    assert.equal(await page.textContent("#h-native"), "An amount of PROS, up to 6 decimals.");
    assert.equal(await page.textContent("#h-min"), "In USDC. A transfer of at least this much, sent or received.");
    await page.fill("#f-addresses", [...SAMPLE, OTHER, "0x2222222222222222222222222222222222222222"].join("\n"));
    await page.click('#settings button[type="submit"]');
    assert.equal(await page.textContent("#h-addresses"), "Enter 1 to 5 addresses, one per line.");
    assert.equal(requests.length, 1);
  });

  test("checking every 30 s while it is on", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(base);
    await page.waitForFunction(settled);
    await page.click("#auto");
    assert.deepEqual([await page.getAttribute("#auto", "aria-pressed"), await page.textContent("#auto")], ["true", "Stop checking every 30 s"]);
    step(10n, [{ token: USDC, from: lower(TRADER), to: OTHER, amount: 800_000_000n, block: 5_000_006n }]);
    await page.clock.runFor(30_000);
    await page.waitForFunction(() => document.querySelectorAll(".move").length === 2);
    assert.equal(JSON.parse(requests.at(-1).store).cursor, "5000000");
    await page.click("#auto");
    const before = requests.length;
    await page.clock.runFor(60_000);
    assert.equal(requests.length, before, "stopped");
  });

  test("an unreachable Chain MCP is an error the page states, and the store is left as it was", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["Not checked", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
      assert.deepEqual([seen.moves, seen.tracked, seen.scan, seen.meta], [[], [], null, null]);
      assert.equal(await stored(page), null);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("the proof: each Chain MCP call with its address or blocks, the raw result behind a toggle; the skip link lands on the moves", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent));
    assert.deepEqual(calls.slice(0, 4), ["get_chain_info ", "get_block_number ", "get_block @ 5,000,000", "get_code 0x912c…f647 @ 5,000,000"]);
    assert.deepEqual(calls.filter((call) => call.startsWith("get_logs")), ["get_logs 0xC879…1815 blocks 4,999,001–5,000,000", "get_logs 0xC879…1815 blocks 4,999,001–5,000,000"]);
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.equal(json.result.schema, "pharos-agent/whale-run/1");
    assert.equal(json.result.store.cursor, "5000000");
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "moves-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open("/", { viewport: { width, height }, colorScheme });
        step(10n, [{ token: USDC, from: lower(BUSIEST), to: lower(TRADER), amount: 123_456_789_000n, block: 5_000_004n }]);
        fake.state.native[lower(BUSIEST)] = 12_345n * PROS;
        await again(page);
        await page.click("#change > summary");
        await page.click("#proof > summary");
        const layout = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const status = box(document.getElementById("status"));
          const again = box(document.getElementById("again"));
          const targets = [...document.querySelectorAll("button, summary, .btn, input, select, textarea")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className || el.tagName, Math.round(box(el).height)]);
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            beside: Math.abs(status.top - again.top) < 24 && status.right <= again.left + 1,
            small: targets.filter(([, h]) => h < 32),
            rowsInside: [...document.querySelectorAll(".move, .whale, .calls > li, textarea")].every((row) => box(row).right <= window.innerWidth + 0.5),
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
