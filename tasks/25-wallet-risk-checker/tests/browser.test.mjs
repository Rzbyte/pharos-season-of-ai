// Task 25's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/25-wallet-risk-checker/tests/browser.test.mjs
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
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const TRADER = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const LOOKALIKE = "0x1f3500000000000000000000000000000000c85c";
const UNUSED = "0x3333333333333333333333333333333333333333";
const HEAD = 5_000_000n;
const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 25 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  // The example sender holds 1,000 USDC and traded with TRADER three times in the last 2,000 blocks; the
  // example recipient has never been used.
  const fresh = () => {
    fake.state.head = HEAD;
    fake.state.headTime = 1_790_000_000n;
    fake.state.native = { [lower(PAYER)]: 10n ** 18n, [lower(TRADER)]: 5n * 10n ** 17n };
    fake.state.nonces = { [lower(PAYER)]: 50n, [lower(TRADER)]: 12n };
    fake.state.tokens[USDC] = { decimals: 6, balances: { [lower(PAYER)]: 1_000_000_000n } };
    fake.state.transfers = [
      { token: USDC, from: lower(PAYER), to: lower(TRADER), amount: 58_410_000n, block: HEAD - 1500n },
      { token: USDC, from: lower(TRADER), to: lower(PAYER), amount: 58_400_000n, block: HEAD - 900n },
      { token: USDC, from: lower(TRADER), to: lower(PAYER), amount: 58_380_000n, block: HEAD - 20n },
    ];
    fake.state.failures = {};
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

  const settled = () => document.getElementById("check").getAttribute("aria-busy") === "false";

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
      const text = (id) => (document.getElementById(id).hidden ? null : document.getElementById(id).textContent);
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        tx: text("tx"),
        error: text("error"),
        meta: document.getElementById("signals-meta").textContent,
        signals: [...document.querySelectorAll(".signal")].map((row) => [row.querySelector(".signal-level").textContent, row.querySelector(".signal-title").textContent, row.querySelector(".signal-tool").textContent]),
        who: document.getElementById("who-box").hidden ? null : [...document.querySelectorAll("#who > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
      };
    });

  test("on load: Task 08's example, a recipient never used, so check first; every signal with its source", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    // The status gives the verdict and the top signal; the list says what each one saw, once.
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Check first", "never used", "warning"]);
    assert.equal(seen.tx, "Send 25 USDC from 0x912c…f647 to 0xB274…9553");
    assert.deepEqual(seen.signals, [["medium", "Never used", "get_transaction_count · get_balance · get_logs"]]);
    assert.match(await page.textContent(".signal-detail"), /^0xB274…9553 has sent no transaction, holds no PROS, and moved no USDC in the last 2,000 blocks\./);
    assert.deepEqual(seen.who, [["Address", "0xB274…9553"], ["Role", "The recipient"], ["Code", "None: a wallet"], ["Sent", "No transaction yet"], ["Holds", "0 PROS"], ["History", "0 USDC transfers with the sender in blocks 4,998,001–5,000,000"]]);
    assert.deepEqual(requests, [{ task: "25", action: "transfer", asset: "USDC", from: PAYER, to: RECIPIENT, amount: "25" }]);
    assert.deepEqual(errors, []);
  });

  test("the made-up lookalike of an address the sender trades with: do not send", async () => {
    const { page } = await open();
    await page.click("#ex-lookalike");
    await page.waitForFunction(() => document.getElementById("check").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Do not send");
    const seen = await view(page);
    assert.deepEqual([seen.detail, seen.tone], ["looks like an address the sender uses", "error"]);
    assert.equal(await page.textContent(".signal-detail"), "0x1f35…c85c starts and ends like 0x1F35…c85C, which the sender dealt with 3 times in the last 2,000 blocks, but it is a different address. Address poisoning copies the start and end of an address its victim uses.");
    assert.deepEqual(seen.signals.map(([level, title]) => [level, title]), [["high", "Looks like an address the sender uses"], ["medium", "Never used"]]);
    assert.equal(new URL(page.url()).searchParams.get("to"), LOOKALIKE);
    assert.equal(await page.textContent("#ex-lookalike"), "A made-up lookalike of 0x1F35…c85C");
  });

  test("the lookalike example copies the address the sender moved USDC with most in the blocks read", async () => {
    const BUSIER = "0x936564245B69f5a293b42cbd752E0eE3bb68b470";
    for (const block of [HEAD - 300n, HEAD - 200n, HEAD - 100n, HEAD - 50n]) fake.state.transfers.push({ token: USDC, from: lower(BUSIER), to: lower(PAYER), amount: 1_000_000n, block });
    const { page } = await open();
    assert.equal(await page.textContent("#ex-lookalike"), "A made-up lookalike of 0x9365…b470");
    await page.click("#ex-lookalike");
    await page.waitForFunction(() => document.getElementById("check").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Do not send");
    assert.equal(new URL(page.url()).searchParams.get("to"), `0x9365${"0".repeat(32)}b470`);
    // At a glance the two are the same, which is the point; the checksum's letter case may differ.
    assert.match(await page.textContent(".signal-detail"), /^0x9365…b470 starts and ends like 0x9365…b470, which the sender dealt with 4 times in the last 2,000 blocks/i);
  });

  test("an unlimited approval to an unused wallet: do not send; the spender is the one checked", async () => {
    const { page } = await open();
    await page.click("#ex-approval");
    await page.waitForFunction(() => document.getElementById("check").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Do not send");
    const seen = await view(page);
    assert.equal(seen.tx, "Approve 0x3333…3333 to spend unlimited USDC of 0x912c…f647");
    assert.equal(seen.detail, "an approval to a wallet");
    assert.deepEqual(seen.signals.map(([level, title]) => [level, title]), [["high", "An approval to a wallet"], ["medium", "Never used"], ["medium", "An unlimited approval"]]);
    assert.deepEqual(seen.who.slice(0, 2), [["Address", "0x3333…3333"], ["Role", "The spender"]]);
    assert.equal(await page.textContent("#change-meta"), "Approve unlimited USDC");
  });

  test("an address the sender already deals with: looks fine, the dealings shown for information", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-to", TRADER);
    await page.click('#settings button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("check").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Looks fine");
    const seen = await view(page);
    assert.deepEqual([seen.detail, seen.tone, seen.meta], ["nothing suspicious found", "success", "0 to weigh, 1 for information"]);
    assert.deepEqual(seen.signals, [["info", "The sender has dealt with it before", "get_logs"]]);
    assert.equal(seen.who.at(-1)[1], "3 USDC transfers with the sender in blocks 4,998,001–5,000,000");
  });

  test("invalid input is marked at its field and never sent", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-to", "0x12");
    await page.fill("#f-amount", "0");
    await page.click('#settings button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-to");
    assert.equal(await page.textContent("#h-to"), "Enter a 0x address of 40 hex characters.");
    assert.equal(requests.length, 1);
  });

  test("an unreachable Chain MCP is an error the page states", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["Not checked", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
      assert.deepEqual([seen.signals, seen.who], [[], null]);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("the proof: each Chain MCP call, the raw result behind a toggle; the skip link lands on the verdict", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls.slice(0, 6), ["get_chain_info", "get_block_number", "get_block", "get_code", "get_transaction_count", "get_balance"]);
    assert.equal(calls.filter((call) => call === "get_logs").length, 4, "two queries a page, two pages");
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.verdict], ["pharos-agent/risk-check/1", "check-first"]);
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "risk-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open(`/?action=approve&asset=USDC&from=${PAYER}&to=${UNUSED}&amount=max`, { viewport: { width, height }, colorScheme });
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
            rowsInside: [...document.querySelectorAll(".signal, .rows > div, .calls > li")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Check again share the top line`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Check again is a 44 px target`);
      }
    }
  });
});
