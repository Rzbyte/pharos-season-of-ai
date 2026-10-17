// Task 27's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/27-dapp-support-agent/tests/browser.test.mjs
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
const SAMPLE_SENDER = "0x0018b46177c611fc1efbca63c845c2a69045e28d";
const REAL = "0x968810950de8d8fa80d17a9e1d03b72e8806a0d11d89579459bceaee45ce510c";
const FAILED = `0x${"f1".repeat(32)}`;
const HEAD = 5_000_000n;
const lower = (address) => address.toLowerCase();
const hex = (n) => `0x${n.toString(16)}`;
const transfer = (to, amount) => `0xa9059cbb${lower(to).slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 27 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  /** A mined transaction the fake chain knows, with its receipt. */
  const mined = (hash, from, data, gas, status, gasUsed) => {
    fake.transactions.set(hash, { hash, from: lower(from), to: USDC, input: data, value: "0x0", gas: hex(gas), nonce: "0x7", blockNumber: hex(HEAD), type: "0x2" });
    fake.receipts.set(hash, { transactionHash: hash, blockNumber: hex(HEAD), status, gasUsed: hex(gasUsed), effectiveGasPrice: hex(10n ** 9n), from: lower(from), to: USDC, logs: [], cumulativeGasUsed: hex(gasUsed), type: "0x2" });
  };
  // The example sender holds 50 USDC. Two transactions in the newest block: a failed 100 USDC transfer
  // from it, and (standing in for the real one) a successful 600 USDC transfer.
  const fresh = () => {
    fake.state.head = HEAD;
    fake.state.headTime = 1_790_000_000n;
    fake.state.native = { [lower(PAYER)]: 10n ** 18n };
    fake.state.tokens[USDC] = { decimals: 6, balances: { [lower(PAYER)]: 50_000_000n } };
    fake.state.failures = {};
    fake.transactions.clear();
    fake.receipts.clear();
    mined(FAILED, PAYER, transfer(RECIPIENT, 100_000_000n), 100_000n, "0x0", 31_000n);
    mined(REAL, SAMPLE_SENDER, transfer(RECIPIENT, 600_000_000n), 100_000n, "0x1", 49_871n);
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

  const settled = () => document.getElementById("answer").getAttribute("aria-busy") === "false";

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
  /** Ask about `hash` in the box and wait for the answer. */
  const askHash = async (page, hash) => {
    await page.fill("#f-hash", hash);
    await page.click('#ask button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("answer").getAttribute("aria-busy") === "false");
  };

  const view = (page) =>
    page.evaluate(() => {
      const text = (id) => (document.getElementById(id).hidden ? null : document.getElementById(id).textContent);
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        pin: text("pin"),
        tx: text("tx"),
        why: text("why"),
        whyTone: document.getElementById("why").dataset.tone ?? "",
        fix: text("fix"),
        error: text("error"),
        findings: [...document.querySelectorAll(".finding")].map((row) => [row.querySelector(".finding-check").textContent, row.querySelector(".finding-seen").textContent, row.querySelector(".finding-tool").textContent, row.dataset.tone]),
        facts: document.getElementById("facts-box").hidden ? null : [...document.querySelectorAll("#facts > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
      };
    });

  test("on load: a transfer of more than the sender holds, described, explained as it would fail now", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Would fail", "it reverted", "warning"]);
    assert.equal(seen.tx, "Described, not sent: Send 5000000 USDC from 0x912c…f647 to 0xB274…9553");
    assert.deepEqual([seen.why, seen.whyTone], ['It stopped with the message "ERC20: transfer amount exceeds balance". The sender did not hold enough.', "warning"]);
    assert.equal(seen.fix, "What to do: Send no more than the sender holds, or fund it first.");
    assert.deepEqual(seen.findings.map(([check, , tool, tone]) => [check, tool, tone]), [["Simulated", "eth_call", "cause"], ["Sender's USDC", "eth_call", "note"], ["Funds for gas", "get_balance · estimate_gas", "note"]]);
    assert.deepEqual(seen.facts, [["Sent", "No: described, and dry-run at the newest block"], ["From", "0x912c…f647"], ["To", "0xC879…1815"]]);
    assert.deepEqual(requests, [{ task: "27", action: "transfer", asset: "USDC", from: PAYER, to: RECIPIENT, amount: "5000000" }]);
    assert.deepEqual(errors, []);
  });

  test("a failed transaction by its hash: why, what to do, every finding with its tool, and the transaction", async () => {
    const { page } = await open();
    await askHash(page, FAILED);
    assert.deepEqual(requests.at(-1), { task: "27", hash: FAILED });
    assert.equal(new URL(page.url()).search, `?hash=${FAILED}`);
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone, seen.whyTone], ["Failed", "it reverted", "error", "error"]);
    assert.equal(seen.tx, "Transfer 100 USDC to 0xB274…9553");
    assert.deepEqual(seen.findings, [
      ["Status", "failed in block 5,000,000", "get_transaction_receipt", "cause"],
      ["Gas", "31,000 of the 100,000 it was given (31%), 0.000031 PROS paid", "get_transaction · get_transaction_receipt", "note"],
      ["Replayed before its block", "reverts at block 4,999,999: Error", "eth_call", "cause"],
      ["Target", "0xC879…1815 is a contract (USDC)", "get_code", "note"],
      ["Sender's balance", "0x912c…f647 held 50 USDC, and it sends 100 USDC", "eth_call", "cause"],
    ]);
    assert.deepEqual(seen.facts, [["Hash", "0xf1f1f1f1…f1f1f1f1"], ["From", "0x912c…f647"], ["To", "0xC879…1815"], ["Gas", "31,000 used of 100,000"], ["Fee", "0.000031 PROS"], ["Nonce", "7"]]);
    assert.equal(await page.getAttribute("#facts a", "href"), `https://pharos.socialscan.io/tx/${FAILED}`);
  });

  test("the real example from Task 02 did not fail, and the page says so; an unknown hash too", async () => {
    const { page } = await open();
    await page.click("#ex-real");
    await page.waitForFunction(() => document.getElementById("answer").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent !== "Would fail");
    const ok = await view(page);
    assert.deepEqual([ok.word, ok.detail, ok.tone, ok.why, ok.fix], ["Succeeded", "it did not fail", "success", "It did not fail: it succeeded in block 5,000,000. Transfer 600 USDC to 0xB274…9553.", null]);
    assert.equal(await page.inputValue("#f-hash"), REAL);
    await askHash(page, `0x${"0".repeat(63)}9`);
    const unknown = await view(page);
    assert.deepEqual([unknown.word, unknown.pin, unknown.facts, unknown.tx], ["Not found", null, null, null], "no block, no transaction");
  });

  test("a malformed hash is marked at the field and never sent; the failing example returns", async () => {
    const { page } = await open();
    await page.fill("#f-hash", "0x12");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-hash");
    assert.equal(await page.textContent("#h-hash"), "That is not a transaction hash: 0x and 64 hex characters.");
    assert.equal(await page.getAttribute("#f-hash", "aria-invalid"), "true");
    assert.equal(requests.length, 1);
    await page.click("#ex-failing");
    await page.waitForFunction(() => document.getElementById("answer").getAttribute("aria-busy") === "false");
    assert.equal(requests.at(-1).amount, "5000000");
  });

  test("an unreachable Chain MCP is an error the page states", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open(`/?hash=${FAILED}`);
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["Not explained", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
      assert.deepEqual([seen.findings, seen.why, seen.fix], [[], null, null]);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("the proof: each Chain MCP call, the raw result behind a toggle; the skip link lands on the answer", async () => {
    const { page } = await open(`/?hash=${FAILED}`);
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls, ["get_chain_info", "get_transaction", "get_transaction_receipt", "get_block", "eth_call", "get_code", "eth_call"]);
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.readAt], ["pharos-agent/tx-explanation/1", "4999999"]);
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "answer-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open(`/?hash=${FAILED}`, { viewport: { width, height }, colorScheme });
        await page.click("#proof > summary");
        const layout = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const status = box(document.getElementById("status"));
          const again = box(document.getElementById("again"));
          const targets = [...document.querySelectorAll("button, summary, .btn, input")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className || el.tagName, Math.round(box(el).height)]);
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            beside: Math.abs(status.top - again.top) < 24 && status.right <= again.left + 1,
            small: targets.filter(([, h]) => h < 32),
            rowsInside: [...document.querySelectorAll(".finding, .rows > div, .calls > li, .ask")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Explain again share the top line`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Explain again is a 44 px target`);
      }
    }
  });
});
