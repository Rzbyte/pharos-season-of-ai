// Task 21's page in Chromium, against the real /api/agent handler and the official Chain MCP server (its
// HTTP mode) on a fake chain with made-up values. One test shows a job finished: a real run of the agent
// on a fake Atlantic chain, its result answered to the page in place of the API (the API itself cannot
// settle, on Pharos Mainnet). Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/21-x402-agent-buyer/tests/browser.test.mjs
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
const { DEFAULT_BUYER_BUDGET } = await import(at("agent/dist/src/web.js"));

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
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const TRADER = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const now = () => BigInt(Math.floor(Date.now() / 1000));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

/** A job finished: the agent's own run on a fake Atlantic chain, its API settling through the official server run locally. */
async function finishedRun() {
  const { runBuyer } = await import(at("agent/dist/src/buyer/run.js"));
  const { transferIntent } = await import(at("agent/dist/src/x402/products.js"));
  const { ChainMcp } = await import(at("agent/dist/src/core/chain-mcp.js"));
  const { Chain } = await import(at("agent/dist/src/core/chain.js"));
  const { NETWORKS } = await import(at("agent/dist/src/core/networks.js"));
  const { accountFromEnv, signerFromEnv } = await import(at("agent/dist/src/core/execute.js"));
  // The well-known Hardhat/Anvil test keys #1 and #2: public, only ever used here on a fake chain.
  const payer = accountFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
  const facilitator = signerFromEnv({ PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" });
  const atlantic = NETWORKS["atlantic-testnet"];
  const tusdc = atlantic.tokens.find((t) => t.symbol === "USDC").address.toLowerCase();
  const me = payer.address.toLowerCase();
  const chain = await startFakeChain(defaultState({ chainId: 688689, headTime: now(), native: { [facilitator.address.toLowerCase()]: 10n ** 18n, [me]: 10n ** 18n }, tokens: { [tusdc]: { decimals: 6, name: "USD Coin", symbol: "USDC", eip3009: { version: "2" }, balances: { [me]: 30_000_000n } } }, transfers: [{ token: tusdc, from: me, to: TRADER.toLowerCase(), amount: 5_000_000n, block: 4_999_000n }] }));
  const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: chain.url }, broadcast: true }, { timeoutMs: 15_000, budget: 240 });
  try {
    return await runBuyer({ chain: new Chain(mcp, atlantic), job: transferIntent(new URLSearchParams({ asset: "USDC", from: payer.address, to: TRADER, amount: "25" }), atlantic), budget: "0.01", payer, facilitator, wait: { pollMs: 10 } });
  } finally {
    await mcp.close();
    await chain.close();
  }
}

describe("the Task 21 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  const fresh = () => {
    fake.state.headTime = now();
    fake.state.tokens = { [USDC]: { decimals: 6, name: "USD Coin", symbol: "USDC", eip3009: { version: "2" }, balances: {} } };
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
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        asked: text("asked"),
        why: text("why"),
        plan: shown("job-box") ? [...document.querySelectorAll("#plan > li")].map((li) => [li.dataset.state, li.querySelector(".item-head").textContent, li.querySelector(".item-meta").textContent]) : null,
        planMeta: text("plan-meta"),
        ledger: rows("ledger"),
        meter: document.getElementById("meter-signed").style.width,
        bought: rows("bought"),
        sign: shown("sign-box") ? JSON.parse(document.getElementById("sign-json").textContent) : null,
        limits: shown("limits"),
        trail: shown("trail-box") ? document.querySelectorAll(".trail-step").length : null,
        links: [...document.querySelectorAll("#answer a.short")].map((a) => a.getAttribute("href")),
      };
    });

  test("on load: the example job, the prices asked, the first purchase signed with a key made for the run and refused on chain; not done", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Not done", "a payment refused", "warning"]);
    assert.equal(seen.asked, "Send 25 USDC from 0x912c…f647 to 0xB274…9553, with 0.01 USDC to spend");
    assert.equal(seen.why, "Not done: Send 25 USDC from 0x912c…f647 to 0xB274…9553: the API refused the payment for the risk check: the payer does not hold the amount. Nothing bought; 0.005 USDC signed for of the 0.01 USDC budget, 0 USDC settled.");
    assert.deepEqual(seen.plan, [["refused", "The risk check /risk 0.005 USDC Refused", "the payer does not hold the amount"], ["over-budget", "The dry run /dryrun 0.003 USDC Not bought", "the API refused the payment for the risk check: the payer does not hold the amount"]]);
    assert.equal(seen.planMeta, "0 of 2 bought");
    assert.deepEqual(seen.ledger, ["Budget: 0.01 USDCpaid by a key made for this run, holding nothing", "Signed for: 0.005 USDC1 authorization", "Settled: 0 USDCnothing paid on chain", "Left: 0.005 USDC"]);
    assert.equal(seen.meter, "50%");
    assert.deepEqual([seen.bought, seen.sign, seen.limits, seen.trail], [null, null, true, 2]);
    assert.ok(seen.links.every((href) => href?.startsWith("https://pharos.socialscan.io/address/0x")), "mainnet addresses link to its explorer");
    assert.deepEqual(requests, [{ task: "21", amount: "25", asset: "USDC", to: RECIPIENT, budget: DEFAULT_BUYER_BUDGET }]);
    assert.deepEqual(errors, []);
  });

  test("a budget too small for anything: nothing signed; a job of your own, kept in the address bar", async () => {
    const { page } = await open();
    await answered(page, () => page.click("#ex-short"));
    assert.deepEqual(requests.at(-1), { task: "21", amount: "25", asset: "USDC", to: RECIPIENT, budget: "0.001" });
    const short = await view(page);
    assert.deepEqual([short.word, short.detail, short.meter], ["Not done", "within the budget, nothing to buy", "0%"]);
    assert.deepEqual(short.plan.map(([state, , meta]) => [state, meta]), [["over-budget", "over the budget: 0.001 USDC left"], ["over-budget", "the risk check costs 0.005 USDC, more than the 0.001 USDC left of the budget"]]);
    assert.equal(short.ledger[1], "Signed for: 0 USDCnothing signed");
    await page.fill("#f-amount", "0.5");
    await page.selectOption("#f-asset", "PROS");
    await page.fill("#f-to", TRADER);
    await page.fill("#f-budget", "0.02");
    await answered(page, () => page.click('#ask button[type="submit"]'));
    assert.deepEqual(requests.at(-1), { task: "21", amount: "0.5", asset: "PROS", to: TRADER, budget: "0.02" });
    assert.equal((await view(page)).asked, "Send 0.5 PROS from 0x912c…f647 to 0x1F35…c85C, with 0.02 USDC to spend");
    assert.equal(await page.evaluate(() => location.search), `?amount=0.5&asset=PROS&to=${TRADER}&budget=0.02`);
  });

  test("a job finished: both answers bought and settled, what they said, the transaction to sign; nothing linked off its network", async () => {
    const done = await finishedRun();
    assert.equal(done.verdict, "ready");
    const { page, context, errors } = await open("/?budget=0.03", {}, (ctx) => ctx.route((url) => url.pathname === "/api/agent", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: done, inputs: {}, calls: [] }) })));
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Ready", "to sign", "success"]);
    assert.deepEqual(seen.plan.map(([state, head]) => [state, head]), [["bought", "The risk check /risk 0.005 USDC Bought"], ["bought", "The dry run /dryrun 0.003 USDC Bought"]]);
    assert.ok(seen.plan.every(([, , meta]) => /^settled in 0x[0-9a-f]{8}…[0-9a-f]{8}$/.test(meta)));
    assert.match(seen.bought[0], /^Risk: Looks finenothing suspicious found$/);
    assert.match(seen.bought[1], /^Dry run: Would succeedabout [\d.]+ PHRS of gas$/);
    assert.deepEqual(seen.sign, done.tx);
    assert.deepEqual([seen.limits, seen.links, seen.meter], [false, [], "80%"]);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.click("#sign-copy");
    await page.waitForFunction(() => document.getElementById("sign-copy").dataset.copy === "copied");
    assert.deepEqual(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())), done.tx);
    assert.deepEqual(errors, []);
  });

  test("bad fields are marked where they are and never sent", async () => {
    const { page } = await open();
    const sent = requests.length;
    for (const [field, value, focus, hint] of [
      ["#f-amount", "0", "f-amount", "Give an amount more than zero, like 25."],
      ["#f-to", "0x12", "f-to", "Enter a 0x address of 40 hex characters."],
      ["#f-from", "nobody", "f-from", "Enter a 0x address of 40 hex characters, or leave it empty."],
      ["#f-budget", "0.0000001", "f-budget", "A budget is a number of USDC with at most 6 decimals, like 0.01."],
      ["#f-budget", "2000000", "f-budget", "A budget is at most 1,000,000 USDC here."],
    ]) {
      await page.fill("#f-amount", "25");
      await page.fill("#f-to", RECIPIENT);
      await page.fill("#f-from", "");
      await page.fill("#f-budget", "0.01");
      await page.fill(field, value);
      await page.click('#ask button[type="submit"]');
      assert.equal(await page.evaluate(() => document.activeElement.id), focus, value);
      assert.equal(await page.textContent(`#h-${focus.slice(2)}`), hint);
    }
    assert.equal(requests.length, sent);
  });

  test("the proof: each Chain MCP call, nothing sent, the raw result behind a toggle; the skip link lands on the answer", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls.slice(0, 4), ["get_chain_info", "get_block_number", "get_block", "eth_call"]);
    assert.ok(!calls.includes("send_raw_transaction"));
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.verdict, json.result.api.settles], ["pharos-agent/x402-buyer/1", "not-done", false]);
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
          const targets = [...document.querySelectorAll("button, summary, .btn, input, select")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className || el.tagName, Math.round(box(el).height)]);
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            beside: Math.abs(status.top - again.top) < 24 && status.right <= again.left + 1,
            trailOpen: document.getElementById("trail-box").open,
            small: targets.filter(([, h]) => h < 32),
            rowsInside: [...document.querySelectorAll(".item, .rows > div, .cmd, .trail-step, .calls > li, .ask, .meter")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Run it again share the top line`);
        assert.equal(layout.trailOpen, width >= 1000, `${where}: the steps open beside the job only where there is room`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Run it again is a 44 px target`);
      }
    }
  });
});
