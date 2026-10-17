// Task 28's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/28-weekly-digest-agent/tests/browser.test.mjs
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
const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
const WALLET = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const TRADER = "0x1f3546a29eec2102c8d52e21a45114124014c85c";
const BUSY = "0x936564245b69f5a293b42cbd752e0ee3bb68b470";
const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 28 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  const t = (from, to, usdc, block) => ({ token: USDC, from: lower(from), to: lower(to), amount: BigInt(Math.round(usdc * 1e6)), block: BigInt(block) });
  // A block a second; the newest, 5,000,000, is Monday 21 Sep 2026, 14:13:20 UTC. USDC moves in each hour.
  const fresh = () => {
    Object.assign(fake.state, { head: 5_000_000n, headTime: 1_790_000_000n, failures: {} });
    fake.state.native = { [lower(WALLET)]: 10n ** 18n };
    fake.state.tokens = { [USDC]: { decimals: 6, balances: { [lower(WALLET)]: 1_300_000_000n, [TRADER]: 5_000_000_000n } }, [WPROS]: { decimals: 18, balances: {} } };
    fake.state.transfers = [
      t(TRADER, WALLET, 100, 4_988_500), t(BUSY, TRADER, 50, 4_989_000),
      t(TRADER, BUSY, 10, 4_992_100), t(TRADER, BUSY, 20, 4_993_000), t(WALLET, TRADER, 5, 4_994_000), t(ZERO, TRADER, 1000, 4_994_500),
      t(BUSY, WALLET, 7, 4_996_000), t(TRADER, ZERO, 3, 4_997_000),
      t(WALLET, BUSY, 1, 4_999_500),
    ];
  };

  before(async () => {
    fake = await startFakeChain(defaultState({}));
    fresh();
    const port = await freePort();
    // No rate limit here: the suite makes more digests in a minute than the hosted endpoint allows one IP.
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

  const settled = () => document.getElementById("digest").getAttribute("aria-busy") === "false";

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
  const view = (page) =>
    page.evaluate(() => {
      const shown = (id) => !document.getElementById(id).hidden;
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        error: shown("error") ? document.getElementById("error").textContent : null,
        leads: shown("periods-box") ? [...document.querySelectorAll(".period-lead")].map((p) => p.textContent) : null,
        bars: shown("side-box") ? [...document.querySelectorAll(".bar")].map((row) => `${row.querySelector(".bar-label").textContent} ${row.querySelector(".bar-n").textContent}`) : null,
        now: shown("side-box") ? [...document.querySelectorAll("#now > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]) : null,
      };
    });

  test("on load: USDC over the last 3 hours and the hour so far, newest first, against the hour before", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Quieter", "67% fewer transfers than the hour before", "success"]);
    assert.deepEqual(seen.leads, [
      "USDC, 21 Sep 2026, 14:00 to 15:00 UTC, so far: 1 transfer moved 1 USDC between 1 sender and 1 recipient.",
      "USDC, 21 Sep 2026, 13:00 to 14:00 UTC: 1 transfer moved 7 USDC between 1 sender and 1 recipient.",
      "USDC, 21 Sep 2026, 12:00 to 13:00 UTC: 3 transfers moved 35 USDC between 2 senders and 2 recipients.",
      "USDC, 21 Sep 2026, 11:00 to 12:00 UTC: 2 transfers moved 150 USDC between 2 senders and 2 recipients.",
    ]);
    assert.deepEqual(seen.bars, ["11:00 2", "12:00 3", "13:00 1", "14:00 so far 1"]);
    assert.deepEqual(seen.now, [["Total supply", "6,300 USDC"]]);
    assert.equal(await page.textContent("#change-meta"), "USDC, 3 hours");
    assert.deepEqual(requests, [{ task: "28", subject: "USDC", hours: "3" }]);
    assert.deepEqual(errors, []);
  });

  test("the example wallet: its own hours, and what it holds now; the address bar keeps it", async () => {
    const { page } = await open();
    await page.click("#ex-wallet");
    await page.waitForFunction(() => document.getElementById("digest").getAttribute("aria-busy") === "false" && document.querySelector(".period-lead")?.textContent.startsWith("0x912c"));
    const seen = await view(page);
    assert.equal(seen.leads[1], "0x912c…f647, 21 Sep 2026, 13:00 to 14:00 UTC: 1 token transfer.");
    assert.deepEqual(seen.now, [["PROS", "1"], ["USDC", "1,300"]]);
    assert.deepEqual(requests.at(-1), { task: "28", subject: WALLET, hours: "3" });
    await page.reload();
    await page.waitForFunction(settled);
    assert.deepEqual([await page.inputValue("#f-subject"), await page.inputValue("#f-wallet")], ["wallet", WALLET]);
  });

  test("the form: another token and fewer hours; a wallet's address is checked at its field and never sent", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.selectOption("#f-subject", "WPROS");
    await page.selectOption("#f-hours", "1");
    await page.click('#settings button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("digest").getAttribute("aria-busy") === "false" && document.querySelector(".period-lead")?.textContent.startsWith("WPROS"));
    assert.deepEqual(requests.at(-1), { task: "28", subject: "WPROS", hours: "1" });
    assert.deepEqual((await view(page)).word, "Quiet");
    await page.selectOption("#f-subject", "wallet");
    assert.equal(await page.isVisible("#f-wallet"), true);
    await page.fill("#f-wallet", "0x12");
    await page.click('#settings button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-wallet");
    assert.equal(await page.textContent("#h-wallet"), "Enter a 0x address of 40 hex characters.");
    assert.equal(requests.length, 2);
  });

  test("an unreachable Chain MCP is an error the page states", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["No digest", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("the proof: each Chain MCP call, the raw result behind a toggle; the skip link lands on the digest", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls.slice(0, 3), ["get_chain_info", "get_block_number", "get_block"]);
    assert.equal(calls.filter((call) => call === "get_logs").length, 13, "3 hours and the hour so far: 13 pages, one query each");
    assert.equal(calls.at(-1), "eth_call", "the supply, at the newest block");
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.digests.length], ["pharos-agent/digest-run/1", 3]);
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "digest-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open(`/?subject=${WALLET}&hours=5`, { viewport: { width, height }, colorScheme });
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
            rowsInside: [...document.querySelectorAll(".period, .bar, .rows > div, .calls > li")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Run again share the top line`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Run again is a 44 px target`);
      }
    }
  });
});
