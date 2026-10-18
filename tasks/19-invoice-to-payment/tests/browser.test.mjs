// Task 19's page in Chromium, against the real /api/agent handler and the official Chain MCP server (its
// HTTP mode) on a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/19-invoice-to-payment/tests/browser.test.mjs
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
const STUDIO = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const PAYEES = `Example Studio = ${STUDIO}`;
const { DEFAULT_INVOICE: INVOICE } = await import(at("agent/dist/src/web.js"));
const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 19 page in a browser", { skip }, () => {
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
        payer: text("payer"),
        facts: shown("pay-box") ? [...document.querySelectorAll(".fact")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]) : null,
        off: shown("pay-box") ? [...document.querySelectorAll(".fact-book.is-off")].map((n) => n.textContent) : null,
        unread: shown("unread-box") ? [...document.querySelectorAll("#unread li")].map((li) => li.textContent) : null,
        checks: shown("pay-box") ? [...document.querySelectorAll(".check")].map((li) => [li.dataset.id, li.dataset.state, li.querySelector(".check-label").firstChild.textContent]) : null,
        payment: shown("pay-box") ? { state: document.getElementById("payment").dataset.state, head: document.querySelector(".payment-head").textContent, meta: document.querySelector(".payment-meta").textContent, memo: document.querySelector(".payment-memo")?.textContent ?? null, command: document.querySelector("#payment pre").textContent, note: document.querySelector("#payment .note")?.textContent ?? null } : null,
        sign: shown("sign-box") ? JSON.parse(document.getElementById("sign-json").textContent) : null,
        signMeta: text("sign-meta"),
        link: text("link"),
        trail: shown("trail-box") ? document.querySelectorAll(".trail-step").length : null,
      };
    });
  const submit = (page) => answered(page, () => page.click('#ask button[type="submit"]'));

  test("on load: the example invoice read, every check, the payment dry-run, the transaction to sign and its link", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Ready", "dry-run, not sent", "success"]);
    assert.equal(seen.asked, "Invoice INV-1042 from Example Studio, billed to Example Shop");
    assert.match(seen.why, /^Invoice INV-1042 from Example Studio: 20 USDC to 0xB274…9553, due in 54 days, ready to sign\. It dry-runs at block 5,000,000 for about [\d.]+ PROS of gas\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.deepEqual(seen.facts, [["Amount due", "20 USDC"], ["Pay to", "0xB274…9553Example Studio, as in your payees"], ["Due", "2026-11-14 · due in 54 days (Net 30 from 2026-10-15)"], ["Network", "Pharos Mainnet"], ["Lines", "Design work (10 h)15 USDCHosting, October5 USDC"], ["Figures", "Subtotal 20 USDC · Total 20 USDC"]]);
    assert.deepEqual([seen.off, seen.unread], [[], null]);
    assert.deepEqual(seen.checks, [["figures", "ok", "The figures add up"], ["network", "ok", "On Pharos Mainnet, as the invoice says"], ["duplicate", "ok", "Not paid in the last 2,000 blocks"], ["payee", "ok", "Example Studio, as in your payees"], ["due", "info", "Due in 54 days"], ["dry-run", "ok", "The payment would succeed"], ["funds", "ok", "Enough to pay"]]);
    assert.equal(seen.payer, "from 0x912c…f647 · the example's");
    assert.deepEqual([seen.payment.state, seen.payment.head, seen.payment.memo], ["ok", "20 USDC to Example Studio 0xB274…9553", "For invoice INV-1042. Kept here: a transfer carries no note on chain."]);
    assert.match(seen.payment.meta, /^Would succeed · [\d,]+ gas, about [\d.]+ PROS at [\d.]+ gwei · nonce 41$/);
    assert.equal(seen.payment.command, `cast send ${USDC} "transfer(address,uint256)" ${STUDIO} 20000000 --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`);
    assert.deepEqual([seen.sign.chainId, seen.sign.nonce, seen.sign.to, seen.sign.value], [1672, 41, USDC, "0"]);
    assert.equal(seen.signMeta, `One EIP-1559 transaction for chain 1672, nonce 41, with the dry run's gas limit and fee caps. Sign it from ${PAYER}.`);
    assert.equal(seen.link, `ethereum:${USDC}@1672/transfer?address=${STUDIO}&uint256=20000000`);
    assert.equal(seen.trail, 9);
    assert.deepEqual(requests, [{ task: "19", invoice: INVOICE, payees: PAYEES }]);
    assert.deepEqual(errors, []);
  });

  test("a payment link, an invoice typed and sent with Ctrl+Enter, your address; Copy puts the transaction and the link on the clipboard", async () => {
    const { page, context } = await open();
    await answered(page, () => page.click("#ex-link"));
    const link = await view(page);
    assert.deepEqual([link.word, link.asked, link.facts.find(([term]) => term === "Payment link")?.[1], link.facts[1][1]], ["Ready", "A payment link", `ethereum:${USDC}@1672/transfer?address=${STUDIO}&uint256=5e6`, "0xB274…9553Example Studio in your payees"]);
    await page.fill("#f-invoice", `Invoice: A-7\nFrom: Example Studio\nDesign 2.00 USDC\nTotal: 2 USDC\nPay to: ${STUDIO}\nWith thanks`);
    await page.fill("#f-from", PAYER);
    await answered(page, () => page.press("#f-invoice", "Control+Enter"));
    assert.deepEqual(requests.at(-1), { task: "19", invoice: `Invoice: A-7\nFrom: Example Studio\nDesign 2.00 USDC\nTotal: 2 USDC\nPay to: ${STUDIO}\nWith thanks`, payees: PAYEES, from: PAYER });
    const typed = await view(page);
    assert.deepEqual([typed.payer, typed.unread], ["from 0x912c…f647 · given", ["With thanks"]]);
    const asked = requests.length;
    await page.press("#f-invoice", "Enter");
    assert.equal(requests.length, asked, "Enter alone starts a new line, and sends nothing");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.click("#sign-copy");
    await page.waitForFunction(() => document.getElementById("sign-copy").dataset.copy === "copied");
    assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).nonce, 41);
    await page.click("#link-copy");
    await page.waitForFunction(() => document.getElementById("link-copy").dataset.copy === "copied");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `ethereum:${USDC}@1672/transfer?address=${STUDIO}&uint256=2000000`);
  });

  test("held for a check: a changed address, and a new payee; nothing to sign while it is held", async () => {
    const { page } = await open();
    await answered(page, () => page.click("#ex-changed"));
    const changed = await view(page);
    assert.deepEqual([changed.word, changed.detail, changed.tone, changed.whyTone, changed.sign], ["Check first", "held, not sent", "warning", "warning", null]);
    assert.match(changed.why, /^Check first: not the address your payees give\. Invoice INV-1042 from Example Studio asks for 20 USDC to 0xB274000000000000000000000000000000009553\./);
    assert.deepEqual([changed.off, changed.checks.filter(([, state]) => state === "warn").map(([id]) => id)], [["not the address your payees give Example Studio"], ["payee"]]);
    // The swapped address is never named for the studio, and shown in full: short, a lookalike looks the same.
    assert.equal(changed.payment.head, "20 USDC to 0xB274000000000000000000000000000000009553");
    assert.equal(changed.facts[1][1], "0xB274000000000000000000000000000000009553not the address your payees give Example Studio");
    await page.fill("#f-payees", "");
    await answered(page, () => page.click("#ex-invoice"));
    assert.deepEqual(requests.at(-1).payees, PAYEES, "an empty book falls back to the example's for an example");
    await page.fill("#f-payees", `Someone Else = 0x1111111111111111111111111111111111111111`);
    await submit(page);
    const fresh = await view(page);
    assert.deepEqual([fresh.word, fresh.checks.find(([id]) => id === "payee")], ["Check first", ["payee", "warn", "A new payee"]]);
  });

  test("an invoice that does not add up is refused, saying which figures disagree; one that would fail; bad fields never sent", async () => {
    const { page } = await open();
    await answered(page, () => page.click("#ex-wrong"));
    const wrong = await view(page);
    assert.deepEqual([wrong.word, wrong.tone, wrong.facts, wrong.why], ["Not prepared", "error", null, null]);
    assert.equal(wrong.error, "The subtotal is 20 USDC, but the total says 25 USDC.");
    await page.fill("#f-invoice", `Total: 500 USDC\nPay to: ${STUDIO}`);
    await submit(page);
    const fail = await view(page);
    assert.deepEqual([fail.word, fail.tone, fail.payment.state, fail.sign], ["Would fail", "error", "fail", null]);
    assert.match(fail.payment.note, /^It reverts: /);
    const sent = requests.length;
    await page.fill("#f-payees", "Studio = 0x12");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-payees");
    assert.equal(await page.textContent("#h-payees"), "Each line reads Name = 0x… (40 hex characters).");
    await page.fill("#f-payees", PAYEES);
    await page.fill("#f-from", "0x12");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-from");
    await page.fill("#f-from", "");
    await page.fill("#f-invoice", "");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-invoice");
    assert.equal(requests.length, sent);
  });

  test("the proof: each Chain MCP call, the raw result behind a toggle; the skip link lands on the payment", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls.slice(0, 6), ["get_chain_info", "get_block_number", "get_block", "get_logs", "get_logs", "get_transaction_count"]);
    assert.ok(!calls.includes("send_raw_transaction"));
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.verdict, json.result.nonce], ["pharos-agent/invoice-payment/1", "ready", 41]);
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
            rowsInside: [...document.querySelectorAll(".fact, .check, .payment, .cmd, .trail-step, .calls > li, .ask")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Prepare again share the top line`);
        assert.equal(layout.trailOpen, width >= 1000, `${where}: the steps open beside the payment only where there is room`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Prepare again is a 44 px target`);
      }
    }
  });
});
