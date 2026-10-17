// Task 17's page in Chromium, against the real /api/agent handler and the official Chain MCP server (its
// HTTP mode) on a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/17-natural-language-payment/tests/browser.test.mjs
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
const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const ALICE = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const BOB = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const STRANGER = "0x3333333333333333333333333333333333333333";
const CONTACTS = `alice = ${ALICE}\nbob = ${BOB}`;
const TWO = "Pay alice 25 USDC and send 0.01 PROS to bob for lunch";
const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 17 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  const fresh = () => {
    fake.state.native = { [lower(PAYER)]: 10n ** 18n };
    fake.state.nonces = { [lower(PAYER)]: 41n };
    fake.state.tokens = { [lower(USDC)]: { decimals: 6, balances: { [lower(PAYER)]: 100_000_000n } } };
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
        sender: text("sender"),
        payments: shown("flow-box") ? [...document.querySelectorAll(".payment")].map((li) => ({ state: li.dataset.state, head: li.querySelector(".payment-head").textContent, meta: li.querySelector(".payment-meta").textContent, memo: li.querySelector(".payment-memo")?.textContent ?? null, command: li.querySelector("pre").textContent, note: li.querySelector(".note")?.textContent ?? null })) : null,
        totals: shown("flow-box") ? [...document.querySelectorAll(".total")].map((li) => [li.dataset.state, li.querySelector(".total-label").firstChild.textContent, li.querySelector(".total-figures").textContent]) : null,
        sign: shown("sign-box") ? JSON.parse(document.getElementById("sign-json").textContent) : null,
        signMeta: text("sign-meta"),
        trail: shown("trail-box") ? document.querySelectorAll(".trail-step").length : null,
      };
    });

  test("on load: two payments read from words, each dry-run at one block, the totals covered, the transactions to sign", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Ready", "2 payments, dry-run, not sent", "success"]);
    assert.equal(seen.asked, `Asked: ${TWO}`);
    assert.match(seen.why, /^The 2 payments, 25 USDC and 0\.01 PROS in all, ready: each dry-runs at block 5,000,000, for about [\d.]+ PROS in gas together\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.equal(seen.sender, "from 0x912c…f647 · the example's");
    assert.deepEqual(seen.payments.map((p) => [p.state, p.head, p.memo]), [["ok", "25 USDC to alice 0xB274…9553", null], ["ok", "0.01 PROS to bob 0x1F35…c85C", "For lunch. Kept here: a transfer carries no note on chain."]]);
    assert.match(seen.payments[0].meta, /^Would succeed · [\d,]+ gas, about [\d.]+ PROS at [\d.]+ gwei · nonce 41$/);
    assert.match(seen.payments[1].meta, / · nonce 42$/);
    assert.deepEqual(seen.payments.map((p) => p.command), [`cast send ${USDC} "transfer(address,uint256)" ${ALICE} 25000000 --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`, `cast send ${BOB} --value 0.01ether --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`]);
    assert.deepEqual(seen.totals.map(([state, label]) => [state, label]), [["ok", "USDC"], ["ok", "PROS"]]);
    assert.equal(seen.totals[0][2], "25 USDC in all. Holds 100 USDC.");
    assert.match(seen.totals[1][2], /^0\.01 PROS in all, and up to [\d.]+ PROS of gas\. Holds 1 PROS\.$/);
    assert.deepEqual(seen.sign.map((tx) => [tx.chainId, tx.nonce, tx.to, tx.value]), [[1672, 41, USDC, "0"], [1672, 42, BOB, "10000000000000000"]]);
    assert.equal(seen.signMeta, `2 EIP-1559 transactions for chain 1672, nonces 41 to 42, with the dry run's gas limits and fee caps. Sign them in order, from ${PAYER}.`);
    assert.equal(seen.trail, 7);
    assert.deepEqual(requests, [{ task: "17", request: TWO, contacts: CONTACTS }]);
    assert.deepEqual(errors, []);
  });

  test("the examples, a request typed with Enter, your address; Copy puts the transactions on the clipboard", async () => {
    const { page, context } = await open();
    await answered(page, () => page.click("#ex-split"));
    const split = await view(page);
    assert.deepEqual(split.payments.map((p) => [p.head, p.meta.split(" · ").at(-1)]), [["15 USDC to alice 0xB274…9553", "a share of the split"], ["15 USDC to bob 0x1F35…c85C", "a share of the split"]]);
    await page.fill("#f-request", `Send 1 USDC to ${STRANGER}`);
    await page.fill("#f-from", PAYER);
    await answered(page, () => page.press("#f-request", "Enter"));
    assert.deepEqual(requests.at(-1), { task: "17", request: `Send 1 USDC to ${STRANGER}`, contacts: CONTACTS, from: PAYER });
    assert.equal((await view(page)).sender, "from 0x912c…f647 · given");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.click("#sign-copy");
    await page.waitForFunction(() => document.getElementById("sign-copy").dataset.copy === "copied");
    assert.deepEqual(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).map((tx) => tx.nonce), [41]);
  });

  test("a flow the sender cannot cover, though each payment can; one that would not go through; neither has anything to sign", async () => {
    const { page } = await open();
    await page.fill("#f-request", "Split 150 USDC between alice and bob");
    await answered(page, () => page.click('#ask button[type="submit"]'));
    const short = await view(page);
    assert.deepEqual([short.word, short.tone, short.whyTone, short.sign], ["Short", "warning", "warning", null]);
    assert.deepEqual(short.totals[0], ["short", "USDC", "150 USDC in all. Holds 100 USDC: 150 USDC needed."]);
    await page.fill("#f-request", "Pay alice 500 USDC");
    await answered(page, () => page.click('#ask button[type="submit"]'));
    const fail = await view(page);
    assert.deepEqual([fail.word, fail.tone, fail.payments[0].state, fail.sign], ["Would fail", "error", "fail", null]);
    assert.match(fail.payments[0].note, /^It reverts: /);
  });

  test("a request the agent cannot read whole is refused with the words it did not read; bad fields are never sent", async () => {
    const { page } = await open();
    await page.fill("#f-request", "Pay carol 5 USDC");
    await answered(page, () => page.click('#ask button[type="submit"]'));
    const refused = await view(page);
    assert.deepEqual([refused.word, refused.tone, refused.payments, refused.why], ["Not prepared", "error", null, null]);
    assert.equal(refused.error, 'Who is "carol"? Name an address (0x…), or a name in the address book (alice, bob).');
    const sent = requests.length;
    await page.fill("#f-request", TWO);
    await page.fill("#f-contacts", "alice = 0x12");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-contacts");
    assert.equal(await page.textContent("#h-contacts"), "Each line reads name = 0x… (40 hex characters).");
    await page.fill("#f-contacts", CONTACTS);
    await page.fill("#f-from", "0x12");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-from");
    assert.equal(requests.length, sent);
  });

  test("the proof: each Chain MCP call, the raw result behind a toggle; the skip link lands on the flow", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls.slice(0, 4), ["get_chain_info", "get_block_number", "get_block", "get_transaction_count"]);
    assert.ok(!calls.includes("send_raw_transaction"));
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.verdict, json.result.nonce], ["pharos-agent/payment-flow/1", "ready", 41]);
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
          const targets = [...document.querySelectorAll("button, summary, .btn, input, textarea")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className || el.tagName, Math.round(box(el).height)]);
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            beside: Math.abs(status.top - again.top) < 24 && status.right <= again.left + 1,
            trailOpen: document.getElementById("trail-box").open,
            small: targets.filter(([, h]) => h < 32),
            rowsInside: [...document.querySelectorAll(".payment, .total, .cmd, .trail-step, .calls > li, .ask")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Prepare again share the top line`);
        assert.equal(layout.trailOpen, width >= 1000, `${where}: the steps open beside the flow only where there is room`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Prepare again is a 44 px target`);
      }
    }
  });
});
