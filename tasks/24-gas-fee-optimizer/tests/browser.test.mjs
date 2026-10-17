// Task 24's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/24-gas-fee-optimizer/tests/browser.test.mjs
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
const GWEI = 10n ** 9n;
const gwei = (tenths) => (BigInt(tenths) * GWEI) / 10n;
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

describe("the Task 24 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  // Five earlier base fees, 200 blocks apart, and the head's: 1.0, 1.1, 1.4, 0.9, 1.2, then 1.3 gwei now.
  const fresh = () => {
    fake.state.head = HEAD;
    fake.state.headTime = 1_790_000_000n;
    fake.state.baseFee = GWEI;
    fake.state.priorityFee = gwei(1);
    fake.state.baseFees = { [String(HEAD - 1000n)]: gwei(10), [String(HEAD - 800n)]: gwei(11), [String(HEAD - 600n)]: gwei(14), [String(HEAD - 400n)]: gwei(9), [String(HEAD - 200n)]: gwei(12), [String(HEAD)]: gwei(13) };
    fake.state.native = { [lower(PAYER)]: 10n ** 18n };
    fake.state.tokens[USDC] = { decimals: 6, balances: { [lower(PAYER)]: 1_000_000_000n } };
    fake.state.failures = {};
  };
  /** The chain moves on `blocks`, its head's base fee `fee`. */
  const step = (blocks, fee) => {
    fake.state.head += blocks;
    fake.state.headTime += blocks;
    fake.state.baseFees[String(fake.state.head)] = fee;
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

  const settled = () => document.getElementById("gas").getAttribute("aria-busy") === "false";

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
        tx: text("tx"),
        why: text("why"),
        whyTone: document.getElementById("why").dataset.tone ?? "",
        error: text("error"),
        meta: text("fees-box") === null ? null : document.getElementById("fees-meta").textContent,
        range: document.getElementById("fee-range").textContent,
        fees: [...document.querySelectorAll(".fee")].map((row) => [row.querySelector(".fee-when").textContent.replace(/\d\d:\d\d:\d\d/, "HH:MM:SS"), row.querySelector(".fee-value").textContent, row.dataset.below]),
        costs: document.getElementById("cost-box").hidden ? null : [...document.querySelectorAll("#cost-box .rows > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
      };
    });
  const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("pharos-agent-lab:24") ?? "null"));
  const SENT = "No. The hosted Chain MCP is read-only; the CLI sends it on Atlantic with --execute.";

  test("the first run: five earlier blocks read, the fee over the cheapest quarter, so wait, with the cap at the target and the costs", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Wait", "1.3 gwei, over 1 gwei", "warning"]);
    assert.equal(seen.tx, "Send 25 USDC from 0x912c…f647 to 0xB274…9553");
    assert.deepEqual([seen.why, seen.whyTone], ["The base fee, 1.3 gwei, is above the target, 1 gwei (the 25th percentile of the last 12 observations). Waiting for it would save about 0.00001537 PROS on this transaction.", "warning"]);
    assert.equal(seen.meta, "6 kept in this browser");
    assert.equal(seen.range, "Lowest 0.9 gwei · median 1.1 gwei · highest 1.4 gwei. Target 1 gwei: the 25th percentile of the last 12 observations.");
    assert.deepEqual(seen.fees, [
      ["Block 5,000,000 · HH:MM:SSnow", "1.3 gwei", "false"],
      ["Block 4,999,800 · HH:MM:SSread now", "1.2 gwei", "false"],
      ["Block 4,999,600 · HH:MM:SSread now", "0.9 gwei", "true"],
      ["Block 4,999,400 · HH:MM:SSread now", "1.4 gwei", "false"],
      ["Block 4,999,200 · HH:MM:SSread now", "1.1 gwei", "false"],
      ["Block 4,999,000 · HH:MM:SSread now", "1 gwei", "true"],
    ]);
    assert.deepEqual(seen.costs, [
      ["Target", "1 gwei, the 25th percentile of the last 12 observations"],
      ["Settings", "maxFeePerGas 1.1 gwei · maxPriorityFeePerGas 0.1 gwei"],
      ["Cost now", "0.00007172 PROS, at 1.3 gwei plus a 0.1 gwei priority fee"],
      ["At target", "0.00005635 PROS, 0.00001537 PROS less"],
      ["At most", "0.00006762 PROS with this cap, against 0.00016599 PROS with the usual one"],
      ["Sent", SENT],
    ]);
    assert.deepEqual(requests, [{ task: "24", action: "transfer", asset: "USDC", amount: "25", from: PAYER, to: RECIPIENT, percentile: "25" }]);
    const kept = await stored(page);
    assert.deepEqual([kept.observations.length, kept.waitingSince, kept.for], [6, "5000000", `USDC:25:${lower(PAYER)}:${lower(RECIPIENT)}:25`]);
    assert.deepEqual(errors, []);
  });

  test("run after run: the observations persist; the fee comes down to the target, so send now; a reload carries on", async () => {
    const { page, context } = await open();
    step(10n, 95n * GWEI / 100n);
    await again(page);
    const sent = requests.at(-1);
    assert.equal(sent.series.split(",").length, 6);
    assert.match(sent.series, /^4999000:1000000000:21000:30000000:1789999000:b,/);
    assert.equal(sent.waitingSince, "5000000");
    const second = await view(page);
    assert.deepEqual([second.word, second.detail, second.tone], ["Send now", "0.95 gwei, at or under 0.95 gwei", "success"]);
    assert.deepEqual([second.fees.length, second.fees[0], second.whyTone], [7, ["Block 5,000,010 · HH:MM:SSnow", "0.95 gwei", "true"], ""]);
    assert.equal(second.costs[1][1], "maxFeePerGas 1.05 gwei · maxPriorityFeePerGas 0.1 gwei");
    assert.equal((await stored(page)).waitingSince, null);
    const reloaded = await context.newPage();
    await reloaded.goto(base);
    await reloaded.waitForFunction(settled);
    assert.equal(requests.at(-1).series.split(",").length, 7, "a reload sends what was kept");
    assert.equal((await view(reloaded)).meta, "7 kept in this browser");
  });

  test("another transaction or target: the observations are shared, the waiting is not; kept in the address bar", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.selectOption("#f-percentile", "75");
    await page.click('#settings button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("gas").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Send now");
    assert.equal(requests.at(-1).series.split(",").length, 6, "the same observations");
    assert.equal(requests.at(-1).waitingSince, undefined, "another plan has not been waiting");
    assert.equal(new URL(page.url()).search, `?asset=USDC&amount=25&from=${PAYER}&to=${RECIPIENT}&percentile=75`);
    assert.equal(await page.textContent("#change-meta"), "25 USDC · lowest 75%");
    assert.equal((await view(page)).detail, "1.3 gwei, at or under 1.3 gwei");
  });

  test("a transaction that would revert is not sendable at any fee", async () => {
    const { page } = await open(`/?asset=USDC&amount=5000&from=${PAYER}&to=${RECIPIENT}&percentile=25`);
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone, seen.whyTone], ["Not sendable", "it would revert", "error", "error"]);
    assert.match(seen.why, /^The transaction would revert: .*\. It is not sent at any fee\.$/);
    assert.equal(seen.costs[1][1], "None: it is not to be sent.");
  });

  test("invalid settings are marked at their fields and never sent", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.selectOption("#f-asset", "WETH");
    await page.fill("#f-amount", "0.1234567890123456789");
    await page.fill("#f-to", "0x12");
    await page.click('#settings button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-amount");
    assert.equal(await page.textContent("#h-amount"), "At most 18 decimals for WETH.");
    assert.equal(await page.textContent("#h-to"), "Enter a 0x address of 40 hex characters.");
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
    step(10n, gwei(8));
    await page.clock.runFor(30_000);
    await page.waitForFunction(() => document.querySelectorAll(".fee").length === 7);
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
      assert.deepEqual([seen.fees, seen.costs, seen.tx, seen.why], [[], null, null, null]);
      assert.equal(await stored(page), null);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("the proof: each Chain MCP call with its block, the raw result behind a toggle; the skip link lands on the decision", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent));
    assert.deepEqual(calls.slice(0, 5), ["get_chain_info ", "get_block_number ", "get_block @ 5,000,000", "get_gas_price ", "get_block @ 4,999,000"]);
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.equal(json.result.schema, "pharos-agent/gas-run/1");
    assert.equal(json.result.decision, "wait");
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "gas-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open("/", { viewport: { width, height }, colorScheme });
        step(10n, 123_456_789_012n);
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
            rowsInside: [...document.querySelectorAll(".fee, .rows > div, .calls > li")].every((row) => box(row).right <= window.innerWidth + 0.5),
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
