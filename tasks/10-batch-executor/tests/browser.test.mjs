// Task 10's page in Chromium, against the real /api/agent handler and the official Chain MCP server (its
// HTTP mode) on a fake chain with made-up values. One test shows a batch sent: a real run of the agent on
// a fake Atlantic chain, its result answered to the page in place of the API (the API itself never sends,
// on Pharos Mainnet). Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/10-batch-executor/tests/browser.test.mjs
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
const { DEFAULT_BATCH } = await import(at("agent/dist/src/web.js"));

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
const SENDER = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const STAFF = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

/** A batch sent: the agent's own run on a fake Atlantic chain, through the official server run locally. */
async function sentRun() {
  const { runBatch } = await import(at("agent/dist/src/batch/run.js"));
  const { ChainMcp } = await import(at("agent/dist/src/core/chain-mcp.js"));
  const { Chain } = await import(at("agent/dist/src/core/chain.js"));
  const { NETWORKS } = await import(at("agent/dist/src/core/networks.js"));
  const { signerFromEnv } = await import(at("agent/dist/src/core/execute.js"));
  // The well-known Hardhat/Anvil test key #1: public, only ever used here on a fake chain.
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
  const atlantic = NETWORKS["atlantic-testnet"];
  const tusdc = atlantic.tokens.find((t) => t.symbol === "USDC").address.toLowerCase();
  const me = signer.address.toLowerCase();
  const chain = await startFakeChain(defaultState({ chainId: 688689, mineOnPoll: true, native: { [me]: 10n ** 18n }, tokens: { [tusdc]: { decimals: 6, balances: { [me]: 30_000_000n } } } }));
  const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: chain.url }, broadcast: true }, { timeoutMs: 15_000, budget: 120 });
  try {
    return await runBatch(`send 1 USDC to ${RECIPIENT} # rent\nsend 0.5 USDC to ${STAFF}\nsend 0.001 PHRS to ${STAFF}`, { chain: new Chain(mcp, atlantic), signer, wait: { pollMs: 10 } });
  } finally {
    await mcp.close();
    await chain.close();
  }
}

describe("the Task 10 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  const fresh = () => {
    fake.state.native = { [SENDER]: 10n ** 18n };
    fake.state.tokens = { [USDC]: { decimals: 6, balances: { [SENDER]: 100_000_000n } } };
    fake.state.nonces = { [SENDER]: 41n };
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

  async function open(path = "/", options = {}, setup = async () => undefined) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    contexts.push(context);
    await setup(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.waitForFunction(settled);
    return { page, context, errors };
  }
  const answered = (page, run) => Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agent"), run()]).then(() => page.waitForFunction(settled));

  const view = (page) =>
    page.evaluate(() => {
      const shown = (id) => !document.getElementById(id).hidden && !document.getElementById(id).closest("[hidden]");
      const text = (id) => (shown(id) ? document.getElementById(id).textContent : null);
      const rows = (id) => (shown(id) ? [...document.querySelectorAll(`#${id} > div`)].map((row) => `${row.querySelector("dt").textContent}: ${row.querySelector("dd").textContent}`) : null);
      const checks = (id) => (shown(id) ? [...document.querySelectorAll(`#${id} > li`)].map((li) => [li.dataset.state, li.querySelector(".check-label").firstChild.textContent]) : null);
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        asked: text("asked"),
        why: text("why"),
        txs: shown("batch-box") ? [...document.querySelectorAll("#txs > li")].map((li) => [li.dataset.state, li.querySelector(".item-head").textContent, li.querySelector(".note")?.textContent ?? null]) : null,
        planMeta: text("plan-meta"),
        checks: checks("checks"),
        savings: rows("savings"),
        compare: checks("compare"),
        sign: shown("sign-box") ? JSON.parse(document.getElementById("sign-json").textContent) : null,
        limits: shown("limits"),
        trail: shown("trail-box") ? document.querySelectorAll(".trail-step").length : null,
        links: [...document.querySelectorAll("#answer a.short")].map((a) => a.getAttribute("href")),
      };
    });

  test("on load: the example batch planned, two sends merged, independent, three transactions to sign in one nonce sequence; nothing sent", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Ready", "3 transactions, not sent", "success"]);
    assert.equal(seen.asked, "4 actions from 0x912c…f647 (the example's), 1 send merged");
    assert.match(seen.why, /^Ready: 4 actions in 3 transactions \(lines 1 and 3 merged\), independent, each dry-run at block 5,000,000, in one nonce sequence for about [\d.]+ PROS of gas\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.deepEqual(seen.txs, [["planned", "1 Send 30 USDC to 0xB274…9553 lines 1 and 3 In the plan", null], ["planned", "2 Send 10 USDC to 0x1F35…c85C line 2 In the plan", null], ["planned", "3 Send 0.01 PROS to 0x1F35…c85C line 4 In the plan", null]]);
    assert.equal(seen.planMeta, "3 transactions for 4 lines, nonces 41 to 43");
    assert.deepEqual(seen.checks, [["pass", "One sender"], ["pass", "Alone at the block"], ["pass", "USDC"], ["pass", "PROS"]]);
    assert.equal(seen.savings[0], "Calls: 21 Chain MCP callsits 3 dry runs, one by one, ask 36");
    assert.equal(seen.savings[1], "Transactions: 3 for 4 lines1 fewer by merging");
    assert.match(seen.savings[2], /^Fees: one quote for allat most [\d.]+ gwei a gas, [\d.]+ gwei of it priority; about [\d.]+ PROS, at most [\d.]+ PROS$/);
    assert.equal(seen.savings[3], "Sending: back to backnonces 41 to 43 in one sequence, the receipts awaited together: the CLI does this on Atlantic");
    assert.deepEqual(seen.sign.map((tx) => [tx.chainId, tx.nonce, tx.to]), [[1672, 41, "0xC879C018dB60520F4355C26eD1a6D572cdAC1815"], [1672, 42, "0xC879C018dB60520F4355C26eD1a6D572cdAC1815"], [1672, 43, STAFF]]);
    assert.deepEqual([seen.compare, seen.limits, seen.trail], [null, true, 12]);
    assert.ok(seen.links.length && seen.links.every((href) => href?.startsWith("https://pharos.socialscan.io/address/0x")), "mainnet addresses link to its explorer");
    assert.deepEqual(requests, [{ task: "10", batch: DEFAULT_BATCH }]);
    assert.deepEqual(errors, []);
  });

  test("one too big is left out and the rest still go; order matters: not a batch, its lines shown", async () => {
    const { page } = await open();
    await answered(page, () => page.click("#ex-big"));
    const big = await view(page);
    assert.deepEqual([big.word, big.detail, big.tone], ["Partly ready", "2 of 3, not sent", "warning"]);
    assert.deepEqual(big.txs.map(([state, , note]) => [state, note]), [["planned", null], ["left-out", "It reverts: ERC20: transfer amount exceeds balance."], ["planned", null]]);
    assert.deepEqual(big.sign.map((tx) => tx.nonce), [41, 42]);
    assert.equal(big.savings[1], "Transactions: 2 for 3 lines1 left out");
    await answered(page, () => page.click("#ex-order"));
    const order = await view(page);
    assert.deepEqual([order.word, order.detail, order.tone], ["Not a batch", "their order matters", "warning"]);
    assert.deepEqual(order.txs, [["dependent", "1 approve 100 USDC for 0x3333…3333", null], ["dependent", "2 revoke USDC for 0x3333…3333", null]]);
    assert.equal(order.planMeta, "2 lines, not planned");
    assert.deepEqual(order.checks, [["fail", "Allowances"]]);
    assert.deepEqual([order.savings, order.sign], [null, null]);
  });

  test("a batch of your own, its sends kept apart, kept in the address bar; Ctrl+Enter plans it", async () => {
    const { page } = await open();
    await page.fill("#f-batch", `send 1 USDC to ${RECIPIENT}\nsend 2 USDC to ${RECIPIENT}`);
    await page.selectOption("#f-merge", "0");
    await answered(page, () => page.press("#f-batch", "Control+Enter"));
    assert.deepEqual(requests.at(-1), { task: "10", batch: `send 1 USDC to ${RECIPIENT}\nsend 2 USDC to ${RECIPIENT}`, merge: "0" });
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.txs.length, seen.asked], ["Ready", 2, "2 actions from 0x912c…f647 (the example's)"]);
    assert.equal(await page.evaluate(() => location.search), `?${new URLSearchParams({ batch: `send 1 USDC to ${RECIPIENT}\nsend 2 USDC to ${RECIPIENT}`, merge: "0" })}`);
    const again = await open(`/?${new URLSearchParams({ batch: `send 1 USDC to ${RECIPIENT}`, merge: "0" })}`);
    assert.deepEqual([await again.page.inputValue("#f-merge"), (await view(again.page)).txs.length], ["0", 1]);
  });

  test("a batch sent: each transaction's receipt, every value checked, the blocks it took; nothing linked off its network", async () => {
    const done = await sentRun();
    assert.equal(done.verdict, "sent");
    const { page, errors } = await open("/", {}, (ctx) => ctx.route((url) => url.pathname === "/api/agent", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: done, inputs: {}, calls: [] }) })));
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Sent", "back to back", "success"]);
    assert.deepEqual(seen.txs.map(([state, head]) => [state, head]), [["sent", "1 Send 1 USDC to 0xB274…9553 line 1 sent, succeeded"], ["sent", "2 Send 0.5 USDC to 0x1F35…c85C line 2 sent, succeeded"], ["sent", "3 Send 0.001 PHRS to 0x1F35…c85C line 3 sent, succeeded"]]);
    assert.deepEqual(seen.compare.map(([state]) => state), ["pass", "pass", "pass", "pass", "pass"]);
    assert.equal(seen.savings[3], "Sending: 3 back to backall in block 5,000,001; one by one they take at least 3 blocks");
    assert.deepEqual([seen.sign, seen.limits, seen.links], [null, false, []]);
    assert.deepEqual(errors, []);
  });

  test("bad fields are marked where they are and never sent", async () => {
    const { page } = await open();
    const sent = requests.length;
    for (const [field, value, focus, hint] of [
      ["#f-batch", "", "f-batch", "Write a batch first: one action a line."],
      ["#f-batch", `send 1 USDC to ${RECIPIENT}\nswap 1 USDC for WETH`, "f-batch", 'Line 2 starts with "swap": a batch takes send, approve, revoke and wrap.'],
      ["#f-batch", Array.from({ length: 7 }, () => `send 1 USDC to ${RECIPIENT}`).join("\n"), "f-batch", "A batch is at most 6 actions here (the CLI takes 10); this one has 7."],
      ["#f-from", "nobody", "f-from", "Enter a 0x address of 40 hex characters, or leave it empty."],
    ]) {
      await page.fill("#f-batch", DEFAULT_BATCH);
      await page.fill("#f-from", "");
      await page.fill(field, value);
      await page.click('#ask button[type="submit"]');
      assert.equal(await page.evaluate(() => document.activeElement.id), focus, value);
      assert.equal(await page.textContent(`#h-${focus.slice(2)}`), hint);
    }
    assert.equal(requests.length, sent);
  });

  test("a line the API cannot read: its own message, nothing shown as planned", async () => {
    const { page } = await open();
    await page.fill("#f-batch", "send 1 USDC");
    await answered(page, () => page.click('#ask button[type="submit"]'));
    const seen = await view(page);
    assert.equal(seen.word, "Not planned");
    assert.match(await page.textContent("#error"), /Line 1 cannot be read: "send 1 USDC"\. It looks like "send 25 USDC to 0x…"\./);
    assert.deepEqual([seen.txs, seen.asked, seen.trail], [null, null, null]);
  });

  test("the proof: each Chain MCP call, nothing sent, the raw result behind a toggle; the skip link lands on the answer", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls.slice(0, 4), ["get_chain_info", "get_block_number", "get_block", "get_transaction_count"]);
    assert.equal(calls.length, 21);
    assert.ok(!calls.includes("send_raw_transaction"));
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.verdict, json.result.execution], ["pharos-agent/batch/1", "ready", null]);
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "answer-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open("/", { viewport: { width, height }, colorScheme });
        await page.click("#proof > summary");
        const layout = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const status = box(document.getElementById("status"));
          const again = box(document.getElementById("again"));
          const targets = [...document.querySelectorAll("button, summary, .btn, input, select, textarea")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className || el.tagName, Math.round(box(el).height)]);
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            beside: Math.abs(status.top - again.top) < 24 && status.right <= again.left + 1,
            trailOpen: document.getElementById("trail-box").open,
            small: targets.filter(([, h]) => h < 32),
            rowsInside: [...document.querySelectorAll(".item, .check, .rows > div, .cmd, .trail-step, .calls > li, .ask")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Plan it again share the top line`);
        assert.equal(layout.trailOpen, width >= 1000, `${where}: the steps open beside the plan only where there is room`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Plan it again is a 44 px target`);
      }
    }
  });
});
