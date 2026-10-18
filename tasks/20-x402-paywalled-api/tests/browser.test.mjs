// Task 20's page in Chromium, against the real /api/agent handler and the official Chain MCP server (its
// HTTP mode) on a fake chain with made-up values. One test shows a payment settled: a real run of the
// agent on a fake Atlantic chain, its result answered to the page in place of the API (the API itself only
// verifies, on Pharos Mainnet). Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/20-x402-paywalled-api/tests/browser.test.mjs
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
const { DEFAULT_X402_PRICE } = await import(at("agent/dist/src/web.js"));

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
const STRANGER = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const now = () => BigInt(Math.floor(Date.now() / 1000));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

/** A payment paid and settled: the agent's own run on a fake Atlantic chain, through the official server run locally. */
async function settledRun() {
  const { runX402 } = await import(at("agent/dist/src/x402/run.js"));
  const { ChainMcp } = await import(at("agent/dist/src/core/chain-mcp.js"));
  const { Chain } = await import(at("agent/dist/src/core/chain.js"));
  const { NETWORKS } = await import(at("agent/dist/src/core/networks.js"));
  const { accountFromEnv, signerFromEnv } = await import(at("agent/dist/src/core/execute.js"));
  // The well-known Hardhat/Anvil test keys #1 and #2: public, only ever used here on a fake chain.
  const payer = accountFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
  const facilitator = signerFromEnv({ PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" });
  const atlantic = NETWORKS["atlantic-testnet"];
  const tusdc = atlantic.tokens.find((t) => t.symbol === "USDC").address.toLowerCase();
  const chain = await startFakeChain(defaultState({ chainId: 688689, headTime: now(), native: { [facilitator.address.toLowerCase()]: 10n ** 18n }, tokens: { [tusdc]: { decimals: 6, name: "USD Coin", symbol: "USDC", eip3009: { version: "2" }, balances: { [payer.address.toLowerCase()]: 5_000_000n } } } }));
  const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: chain.url }, broadcast: true }, { timeoutMs: 15_000, budget: 120 });
  try {
    return await runX402({ chain: new Chain(mcp, atlantic), payer, facilitator, payTo: RECIPIENT, price: "0.003", wait: { pollMs: 10 } });
  } finally {
    await mcp.close();
    await chain.close();
  }
}

describe("the Task 20 page in a browser", { skip }, () => {
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
  /** Wait for the answer to an action that asks again. */
  const answered = (page, run) => Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agent"), run()]).then(() => page.waitForFunction(settled));

  const view = (page) =>
    page.evaluate(() => {
      const shown = (id) => !document.getElementById(id).hidden && !document.getElementById(id).closest("[hidden]");
      const text = (id) => (shown(id) ? document.getElementById(id).textContent : null);
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        asked: text("asked"),
        why: text("why"),
        whyTone: document.getElementById("why").dataset.tone ?? "",
        error: text("error"),
        stages: shown("flow-box") ? [...document.querySelectorAll(".stage")].map((li) => [li.dataset.state, li.querySelector(".stage-party").textContent, li.querySelector(".stage-title").textContent]) : null,
        rows: shown("flow-box") ? [...document.querySelectorAll(".stage")].map((li) => [...li.querySelectorAll(".rows > div")].map((row) => `${row.querySelector("dt").textContent}: ${row.querySelector("dd").textContent}`)) : null,
        notes: shown("flow-box") ? [...document.querySelectorAll(".stage .note")].map((p) => p.textContent) : null,
        data: shown("flow-box") ? (document.querySelector(".data-json")?.textContent ?? null) : null,
        asset: shown("flow-box") ? [...document.querySelectorAll("#asset > div")].map((row) => `${row.querySelector("dt").textContent}: ${row.querySelector("dd").textContent}`) : null,
        permit2: text("permit2"),
        meta: text("flow-meta"),
        trail: shown("trail-box") ? document.querySelectorAll(".trail-step").length : null,
        links: [...document.querySelectorAll("#answer a.short")].map((a) => a.getAttribute("href")),
      };
    });
  const submit = (page) => answered(page, () => page.click('#ask button[type="submit"]'));

  test("on load: GET /data's 402 terms, an authorization signed by a key made for the request, refused at verify; the data locked", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone, seen.whyTone], ["Refused", "the payer holds too little, the data locked", "warning", "warning"]);
    assert.equal(seen.asked, "GET /data at 0.001 USDC a request, paid to 0xB274…9553; the client pays at most 0.001 USDC");
    assert.match(seen.why, /^The endpoint asked 0\.001 USDC; a key made for this run, holding nothing \(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}\), signed for it, and the facilitator refused it on Pharos Mainnet: the payer does not hold the amount\. The data stayed locked\.$/);
    assert.deepEqual(seen.stages, [["ok", "Endpoint", "402 Payment Required"], ["ok", "Client", "Signed an EIP-3009 authorization"], ["fail", "Facilitator", "Refused the payment"], ["skip", "Data", "Locked"]]);
    assert.deepEqual(seen.rows[0], ["Asks: 0.001 USDC1,000 base units, for GET /data", "To: 0xB274…9553", "In: 0xC879…1815EIP-712: USD Coin, version 2", "By: exact on eip155:1672an authorization valid for 300 s"]);
    assert.match(seen.rows[1][0], /^From: 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}a key made for this request, holding nothing$/);
    assert.equal(seen.rows[1][1], "Pays: 0.001 USDCto 0xB274…9553, at most 0.001 USDC a request");
    assert.deepEqual(seen.rows[2], ["Verify: Refused: the payer does not hold the amountinvalid_exact_evm_insufficient_balance", "Settle: Not reached: it holds no key herethe hosted Chain MCP is read-only"]);
    assert.deepEqual(seen.rows[3], ["Status: 402released only once a payment is settled"]);
    assert.deepEqual(seen.asset, ["Token: 0xC879…1815USD Coin (USDC)", "Signs as: USD Coin, version 2the EIP-712 domain an authorization signs", "EIP-3009: Yes: it answers authorizationStatethe exact scheme settles by transferWithAuthorization", "Decimals: 6"]);
    assert.equal(seen.permit2, null);
    assert.equal(await page.isVisible("#limits"), true);
    assert.match(seen.meta, /^eip155:1672 · \d+ Chain MCP calls$/);
    assert.equal(seen.trail, 4);
    assert.ok(seen.links.every((href) => href?.startsWith("https://pharos.socialscan.io/address/0x")), "mainnet addresses link to its explorer");
    assert.deepEqual(requests, [{ task: "20", price: DEFAULT_X402_PRICE }]);
    assert.deepEqual(errors, []);
  });

  test("over the client's cap: nothing signed, nothing asked of the facilitator; a recipient of your own", async () => {
    const { page } = await open();
    await answered(page, () => page.click("#ex-capped"));
    assert.deepEqual(requests.at(-1), { task: "20", price: "0.01", cap: "0.001" });
    const capped = await view(page);
    assert.deepEqual([capped.word, capped.detail, capped.tone], ["Not paid", "the client did not sign", "warning"]);
    assert.deepEqual(capped.stages.map(([state, , title]) => [state, title]), [["ok", "402 Payment Required"], ["fail", "Did not sign"], ["skip", "Not asked"], ["skip", "Locked"]]);
    assert.deepEqual(capped.notes, ["Did not pay: the endpoint asks 0.01 USDC, more than the client's cap of 0.001 USDC a request."]);
    assert.equal(capped.why, "Nothing was paid: the endpoint asks 0.01 USDC, more than the client's cap of 0.001 USDC a request. The data stayed locked.");
    await page.fill("#f-to", STRANGER);
    await page.fill("#f-cap", "");
    await page.fill("#f-price", "0.25");
    await submit(page);
    assert.deepEqual(requests.at(-1), { task: "20", price: "0.25", to: STRANGER });
    const mine = await view(page);
    assert.deepEqual([mine.word, mine.asked], ["Refused", "GET /data at 0.25 USDC a request, paid to 0x1F35…c85C; the client pays at most 0.25 USDC"]);
    assert.equal(await page.evaluate(() => location.search), `?price=0.25&to=${STRANGER}`);
  });

  test("an asset that is not EIP-3009: nothing to sign, and x402's Permit2 contracts looked for", async () => {
    delete fake.state.tokens[USDC].eip3009;
    // A price not asked yet, so this is not an answer the browser may still hold.
    const { page } = await open("/?price=0.002");
    const plain = await view(page);
    assert.deepEqual([plain.word, plain.detail], ["Not paid", "the client did not sign"]);
    assert.deepEqual(plain.notes, ["Did not pay: the asset answers no EIP-712 version(), so there is no domain for an authorization to sign."]);
    assert.ok(plain.asset.includes("EIP-3009: No: it does not answer authorizationStatethe exact scheme cannot settle in it"));
    assert.equal(plain.permit2, "x402's other way to settle, Permit2, needs Permit2 (0x0000…8BA3) and x402's proxy (0x4020…0001) deployed: Permit2 has no code on Pharos Mainnet, the proxy has none.");
  });

  test("a payment settled: the four stages done, the settlement and the data shown, nothing linked off its network", async () => {
    const paid = await settledRun();
    assert.equal(paid.verdict, "paid");
    const { page, errors } = await open("/?price=0.003", {}, (context) =>
      context.route(
        (url) => url.pathname === "/api/agent",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: paid, inputs: { price: "0.003" }, calls: [] }) }),
      ),
    );
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone, seen.whyTone], ["Paid", "the data released", "success", ""]);
    assert.deepEqual(seen.stages, [["ok", "Endpoint", "402 Payment Required"], ["ok", "Client", "Signed an EIP-3009 authorization"], ["ok", "Facilitator", "Verified and settled"], ["ok", "Client", "200 OK: the data"]]);
    assert.equal(seen.rows[2][0], "Verify: Valid: the signature checks, and the transfer succeeds when simulated on chain");
    assert.match(seen.rows[2][1], /^Settle: 0x[0-9a-f]{8}…[0-9a-f]{8}block 5,000,001, success$/);
    assert.deepEqual(JSON.parse(seen.data), paid.data);
    assert.match(seen.why, /^Paid and served: 0\.003 USDC from 0x7099…79C8 to 0xB274…9553, settled in 0x[0-9a-f]{64}, and the data released for it\.$/);
    assert.deepEqual(seen.links, [], "an Atlantic result links nothing to the mainnet explorer");
    assert.equal(await page.isHidden("#limits"), true, "the note about this page's runs is not said of a run that settled");
    assert.deepEqual(errors, []);
  });

  test("bad fields are marked where they are and never sent", async () => {
    const { page } = await open();
    const sent = requests.length;
    for (const [field, value, hint] of [
      ["#f-price", "", "Give a price first, like 0.001."],
      ["#f-price", "1.0000001", "A price is a number of USDC with at most 6 decimals, like 0.001."],
      ["#f-price", "0", "A price must be more than zero."],
      ["#f-price", "2000000", "A price is at most 1,000,000 USDC here."],
    ]) {
      await page.fill(field, value);
      await page.click('#ask button[type="submit"]');
      assert.equal(await page.evaluate(() => document.activeElement.id), "f-price");
      assert.equal(await page.textContent("#h-price"), hint);
    }
    await page.fill("#f-price", "0.001");
    await page.fill("#f-cap", "abc");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-cap");
    await page.fill("#f-cap", "");
    await page.fill("#f-to", "0x12");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-to");
    assert.equal(await page.textContent("#h-to"), "Enter a 0x address of 40 hex characters, or leave it empty.");
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
    assert.deepEqual([json.result.schema, json.result.verdict, json.result.facilitator.settles, json.result.data], ["pharos-agent/x402-run/1", "refused", false, null]);
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
          const targets = [...document.querySelectorAll("button, summary, .btn, input")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className || el.tagName, Math.round(box(el).height)]);
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            beside: Math.abs(status.top - again.top) < 24 && status.right <= again.left + 1,
            trailOpen: document.getElementById("trail-box").open,
            small: targets.filter(([, h]) => h < 32),
            rowsInside: [...document.querySelectorAll(".stage, .rows > div, .cmd, .trail-step, .calls > li, .ask")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Request again share the top line`);
        assert.equal(layout.trailOpen, width >= 1000, `${where}: the steps open beside the exchange only where there is room`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Request again is a 44 px target`);
      }
    }
  });
});
