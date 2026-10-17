// Task 26's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/26-audit-log-agent/tests/browser.test.mjs
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
const { APPROVAL_TOPIC } = await import(at("agent/dist/src/audit/report.js"));
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
const OTHER = "0x936564245B69f5a293b42cbd752E0eE3bb68b470";
const TRADER = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const POISONER = "0x2222222222222222222222222222222222222222";
const ROUTER = "0xc0ffee0000000000000000000000000000000001";
const HEAD = 5_000_000n;
const lower = (address) => address.toLowerCase();
const word = (hex) => `0x${hex.slice(2).padStart(64, "0")}`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 26 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  const world = (native, nonce, usdc) => ({ native: { [lower(PAYER)]: native }, nonces: { [lower(PAYER)]: nonce }, tokens: { [USDC]: { decimals: 6, balances: { [lower(PAYER)]: usdc } } } });
  // In the last hour the example address received 500 USDC from a trader and sent 200 back, in two
  // transactions; earlier, inside six hours, a transfer of nothing and an unlimited approval. Blocks are
  // one second apart.
  const fresh = () => {
    Object.assign(fake.state, { head: HEAD, headTime: 1_790_000_000n, failures: {} }, world(10n ** 18n, 12n, 1_300_000_000n));
    fake.state.transfers = [
      { token: USDC, from: lower(TRADER), to: lower(PAYER), amount: 500_000_000n, block: HEAD - 2000n },
      { token: USDC, from: lower(PAYER), to: lower(TRADER), amount: 200_000_000n, block: HEAD - 1000n },
      { token: USDC, from: POISONER, to: lower(PAYER), amount: 0n, block: HEAD - 10_000n },
    ];
    fake.state.logs = [{ address: USDC, topics: [APPROVAL_TOPIC, word(lower(PAYER)), word(ROUTER)], data: `0x${"f".repeat(64)}`, block: HEAD - 12_000n }];
    // As it was before the 500 came in, and between the two transfers.
    fake.state.past = { [String(HEAD - 2001n)]: world(11n * 10n ** 17n, 10n, 1_000_000_000n), [String(HEAD - 1001n)]: world(105n * 10n ** 16n, 11n, 1_500_000_000n) };
  };

  before(async () => {
    fake = await startFakeChain(defaultState({}));
    fresh();
    const port = await freePort();
    // No rate limit here: the suite makes more reports in a minute than the hosted endpoint allows one IP.
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

  const settled = () => document.getElementById("report").getAttribute("aria-busy") === "false";
  const settledAs = (word) => document.getElementById("report").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === word;

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
        said: shown("said-box") ? [...document.querySelectorAll("#said p")].map((p) => p.textContent) : null,
        balances: shown("balances-box") ? [...document.querySelectorAll("#balances > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]) : null,
        timeline: shown("timeline-box") ? [...document.querySelectorAll("#timeline .event")].map((row) => [row.querySelector(".event-text").textContent, row.querySelector(".event-meta").textContent.split(" · ").slice(0, 2).join(" · ")]) : null,
        timelineMeta: document.getElementById("timeline-meta").textContent,
      };
    });

  test("on load: the example address over the last hour, as sentences, balances and a timeline", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Active", "2 transactions, 2 transfers", "success"]);
    assert.deepEqual(seen.said, [
      "Activity of 0x912c…f647 in the last hour: blocks 4,996,401 to 5,000,000 (21 Sep 2026, 13:13:21 to 14:13:20 UTC).",
      "It sent 2 transactions (its nonce went from 10 to 12).",
      "It received 500 USDC in 1 transfer from 0x1F35…c85C and sent 200 USDC in 1 transfer to 0x1F35…c85C.",
      "Its PROS went from 1.1 to 1 (−0.1): gas, and any PROS it sent or received, which leave no logs.",
      "Its USDC went from 1,000 to 1,300, all of it in the logs above.",
    ]);
    assert.deepEqual(seen.balances, [["PROS", "1.1 → 1 −0.1"], ["USDC", "1,000 → 1,300 +300"]]);
    assert.deepEqual(seen.timeline, [["Sent 200 USDC to 0x1F35…c85C", "≈13:56 UTC · block 4,999,000"], ["Received 500 USDC from 0x1F35…c85C", "≈13:40 UTC · block 4,998,000"]]);
    assert.equal(seen.timelineMeta, "2 events");
    assert.equal(await page.textContent("#said-meta"), "0x912c…f647");
    assert.equal(await page.textContent("#change-meta"), "The last hour");
    assert.deepEqual(requests, [{ task: "26", address: PAYER, hours: "1" }]);
    assert.deepEqual(errors, []);
  });

  test("the last 6 hours: flagged for a transfer of nothing and an unlimited approval; cut to the newest 20,000 blocks, and said so", async () => {
    const { page } = await open();
    await page.click("#ex-six");
    await page.waitForFunction(() => document.getElementById("report").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Flagged");
    const seen = await view(page);
    assert.deepEqual([seen.detail, seen.tone], ["1 transfer of nothing, an unlimited approval", "warning"]);
    assert.equal(seen.said[1], "Only the newest 20,000 of the period's 21,600 blocks were read; a longer period needs the CLI, or several reports.");
    assert.ok(seen.said.includes("It approved 0xC0FF…0001 to spend unlimited USDC."));
    assert.equal(new URL(page.url()).searchParams.get("hours"), "6");
    assert.equal(await page.textContent("#change-meta"), "The last 6 hours");
  });

  test("another address, then a period between two times from the form; the address bar keeps it", async () => {
    const { page } = await open();
    await page.click("#ex-other");
    await page.waitForFunction(() => document.getElementById("report").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Quiet");
    assert.deepEqual(await view(page).then((v) => [v.detail, v.tone, v.timeline, v.said.slice(1)]), ["nothing happened", "neutral", null, ["Nothing happened: no transaction sent, no token moved, no approval given.", "Its PROS stayed at 0."]]);
    assert.deepEqual(requests.at(-1), { task: "26", address: OTHER, hours: "1" });
    await page.click("#change > summary");
    await page.fill("#f-address", PAYER);
    await page.selectOption("#f-period", "time");
    assert.equal(await page.isVisible("#f-since"), true);
    await page.fill("#f-since", "2026-09-21T13:30");
    await page.fill("#f-until", "2026-09-21T13:50");
    await page.click('#settings button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("report").getAttribute("aria-busy") === "false" && document.querySelector("#said p")?.textContent.includes("from 21 Sep 2026, 13:30 to 13:50 UTC"));
    assert.deepEqual(requests.at(-1), { task: "26", address: PAYER, since: "2026-09-21T13:30", until: "2026-09-21T13:50" });
    const seen = await view(page);
    assert.deepEqual(seen.said.slice(0, 3), [
      "Activity of 0x912c…f647 from 21 Sep 2026, 13:30 to 13:50 UTC: blocks 4,997,401 to 4,998,600 (21 Sep 2026, 13:30:01 to 13:50 UTC).",
      "It sent 1 transaction (its nonce went from 10 to 11).",
      "It received 500 USDC in 1 transfer from 0x1F35…c85C.",
    ]);
    assert.deepEqual(seen.timeline.map(([text]) => text), ["Received 500 USDC from 0x1F35…c85C"]);
    assert.equal(await page.textContent("#change-meta"), "2026-09-21 13:30 to 2026-09-21 13:50 UTC");
    // Reloading the address keeps the report.
    await page.reload();
    await page.waitForFunction(settled);
    assert.deepEqual([await page.inputValue("#f-period"), await page.inputValue("#f-since")], ["time", "2026-09-21T13:30"]);
  });

  test("a long timeline shows its newest ten, then all of it", async () => {
    for (let i = 0n; i < 14n; i += 1n) fake.state.transfers.push({ token: USDC, from: lower(TRADER), to: lower(PAYER), amount: 1_000_000n, block: HEAD - 3000n + i });
    const { page } = await open();
    assert.equal(await page.locator("#timeline .event").count(), 10);
    assert.equal(await page.textContent("#timeline-more"), "Show all 16");
    await page.click("#timeline-more");
    assert.equal(await page.locator("#timeline .event").count(), 16);
    assert.deepEqual([await page.textContent("#timeline-more"), await page.getAttribute("#timeline-more", "aria-expanded")], ["Show the newest 10", "true"]);
  });

  test("invalid input is marked at its field and never sent", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-address", "0x12");
    await page.click('#settings button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-address");
    assert.equal(await page.textContent("#h-address"), "Enter a 0x address of 40 hex characters.");
    await page.fill("#f-address", PAYER);
    await page.selectOption("#f-period", "time");
    await page.fill("#f-since", "2026-09-21T13:30");
    await page.fill("#f-until", "2026-09-21T13:00");
    await page.click('#settings button[type="submit"]');
    assert.equal(await page.textContent("#h-until"), "After the start.");
    assert.equal(requests.length, 1);
  });

  test("an unreachable Chain MCP is an error the page states", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["No report", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("the proof: each Chain MCP call, the raw result behind a toggle; the skip link lands on the report", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls.slice(0, 3), ["get_chain_info", "get_block_number", "get_block"]);
    assert.equal(calls.filter((call) => call === "get_logs").length, 8, "3,600 blocks: four pages of two queries");
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.sent], ["pharos-agent/audit-log/1", 2]);
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "report-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open(`/?address=${PAYER}&hours=6`, { viewport: { width, height }, colorScheme });
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
            rowsInside: [...document.querySelectorAll("#said p, .event, .rows > div, .calls > li")].every((row) => box(row).right <= window.innerWidth + 0.5),
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
