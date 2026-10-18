// Task 18's page in Chromium, against the real /api/agent handler and the official Chain MCP server (its
// HTTP mode) on a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/18-recurring-payment/tests/browser.test.mjs
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
const LANDLORD = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const STAFF = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const { DEFAULT_SCHEDULE: SCHEDULE } = await import(at("agent/dist/src/web.js"));
const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 18 page in a browser", { skip }, () => {
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
        due: shown("due-box") ? [...document.querySelectorAll(".payment")].map((li) => [li.dataset.state, li.querySelector(".payment-name").textContent, li.querySelector(".payment-due").textContent, li.querySelector(".payment-what").textContent]) : null,
        meta: shown("due-box") ? [...document.querySelectorAll(".payment-meta")].map((p) => p.textContent) : null,
        commands: shown("due-box") ? [...document.querySelectorAll(".payment pre")].map((p) => p.textContent) : null,
        nothing: text("nothing"),
        waiting: text("waiting"),
        totals: shown("totals-box") ? [...document.querySelectorAll(".total")].map((li) => [li.dataset.state, li.querySelector(".total-label").firstChild.textContent, li.querySelector(".total-figures").textContent]) : null,
        items: shown("due-box") ? [...document.querySelectorAll(".item")].map((li) => [li.querySelector(".item-head").textContent, li.querySelector(".item-meta").textContent]) : null,
        sign: shown("sign-box") ? JSON.parse(document.getElementById("sign-json").textContent) : null,
        signMeta: text("sign-meta"),
        trail: shown("trail-box") ? document.querySelectorAll(".trail-step").length : null,
      };
    });
  const submit = (page) => answered(page, () => page.click('#ask button[type="submit"]'));

  test("on load: the example schedule, everything due since the 1st, oldest first, each dry-run, the transactions to sign", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Ready", "5 payments, dry-run, not sent", "success"]);
    assert.equal(seen.asked, "3 payments, due since 2026-09-01 (the first of this month) to 2026-09-21");
    assert.match(seen.why, /^The 5 payments due by 2026-09-21, 41 USDC in all, ready to sign: each dry-runs at block 5,000,000, for about [\d.]+ PROS in gas together\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.equal(seen.payer, "from 0x912c…f647 · the example's");
    assert.deepEqual(seen.due, [
      ["ok", "Rent", "2026-09-01 · 20 days late", "25 USDC to 0xB274…9553"],
      ["ok", "Design tool", "2026-09-07 · 14 days late", "2 USDC to 0xB274…9553"],
      ["ok", "Design tool", "2026-09-14 · 7 days late", "2 USDC to 0xB274…9553"],
      ["ok", "Payroll", "2026-09-15 · 6 days late", "10 USDC to 0x1F35…c85C"],
      ["ok", "Design tool", "2026-09-21 · due today", "2 USDC to 0xB274…9553"],
    ]);
    assert.match(seen.meta[0], /^Would succeed · [\d,]+ gas, about [\d.]+ PROS at [\d.]+ gwei · nonce 41$/);
    assert.equal(seen.commands[0], `cast send ${USDC} "transfer(address,uint256)" ${LANDLORD} 25000000 --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`);
    assert.deepEqual([seen.nothing, seen.waiting], [null, null]);
    assert.deepEqual(seen.totals.map(([state, label, figures]) => [state, label, figures.split(".")[0]]), [["ok", "USDC", "41 USDC in all"], ["ok", "PROS", "Gas only, and up to 0"]]);
    assert.deepEqual(seen.items, [["Rent 25 USDC monthly on the 1st", "to 0xB274…9553 · 1 owed · next 2026-10-01"], ["Payroll 10 USDC monthly on the 15th", "to 0x1F35…c85C · 1 owed · next 2026-10-15"], ["Design tool 2 USDC weekly on Monday", "to 0xB274…9553 · 3 owed · next 2026-09-28"]]);
    assert.deepEqual(seen.sign.map((tx) => tx.nonce), [41, 42, 43, 44, 45]);
    assert.equal(seen.signMeta, `5 EIP-1559 transactions for chain 1672, nonces 41 to 45, with the dry run's gas limits and fee caps. Sign them in order, from ${PAYER}.`);
    assert.equal(seen.trail, 12);
    assert.deepEqual(requests, [{ task: "18", schedule: SCHEDULE }]);
    assert.deepEqual(errors, []);
  });

  test("every day: the oldest three taken, the rest waiting; a first day given and sent with Ctrl+Enter; Copy", async () => {
    const { page, context } = await open();
    await answered(page, () => page.click("#ex-daily"));
    const daily = await view(page);
    assert.deepEqual([daily.word, daily.due.map(([, , due]) => due.split(" · ")[0])], ["Ready", ["2026-09-01", "2026-09-02", "2026-09-03"]]);
    assert.equal(daily.waiting, "18 more are owed and wait for the next run: a run takes the oldest, at most 3 of one payment and 6 in all here.");
    await page.fill("#f-since", "2026-09-20");
    await page.fill("#f-from", PAYER);
    await answered(page, () => page.press("#f-schedule", "Control+Enter"));
    assert.deepEqual(requests.at(-1), { task: "18", schedule: `Allowance: 0.5 USDC to ${STAFF}, daily`, since: "2026-09-20", from: PAYER });
    const given = await view(page);
    assert.deepEqual([given.asked, given.due.map(([, , due]) => due), given.payer], ["One payment, due since 2026-09-20 (the day given) to 2026-09-21", ["2026-09-20 · 1 day late", "2026-09-21 · due today"], "from 0x912c…f647 · given"]);
    const asked = requests.length;
    await page.press("#f-schedule", "Enter");
    assert.equal(requests.length, asked, "Enter alone starts a new line, and sends nothing");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.click("#sign-copy");
    await page.waitForFunction(() => document.getElementById("sign-copy").dataset.copy === "copied");
    assert.deepEqual(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).map((tx) => tx.nonce), [41, 42]);
  });

  test("nothing due yet; more than the payer holds; neither has anything to sign", async () => {
    const { page } = await open();
    await page.fill("#f-schedule", `Rent: 25 USDC to ${LANDLORD}, monthly on the 1st`);
    await page.fill("#f-since", "2026-09-02");
    await submit(page);
    const quiet = await view(page);
    assert.deepEqual([quiet.word, quiet.detail, quiet.tone, quiet.due, quiet.totals, quiet.sign], ["Nothing due", "on 2026-09-21", "success", [], null, null]);
    assert.equal(quiet.nothing, "Nothing fell due from 2026-09-02 to 2026-09-21.");
    assert.equal(quiet.why, "Nothing is due at 2026-09-21: every payment since 2026-09-02 is paid or not yet due. Next: Rent on 2026-10-01.");
    // The payer named, so this is not the address of the first answer, which the browser may still hold.
    fake.state.tokens[lower(USDC)].balances[lower(PAYER)] = 30_000_000n;
    await page.fill("#f-since", "");
    await page.fill("#f-from", PAYER);
    await page.fill("#f-schedule", SCHEDULE);
    await submit(page);
    const short = await view(page);
    assert.deepEqual([short.word, short.tone, short.whyTone, short.sign], ["Short", "warning", "warning", null]);
    assert.deepEqual(short.totals[0], ["short", "USDC", "41 USDC in all. Holds 30 USDC: 41 USDC needed."]);
  });

  test("a schedule the agent cannot read is refused, saying which part; bad fields are never sent", async () => {
    const { page } = await open();
    await page.fill("#f-schedule", `Rent: 25 USDC to ${LANDLORD}, now and then`);
    await submit(page);
    const refused = await view(page);
    assert.deepEqual([refused.word, refused.tone, refused.due, refused.why], ["Not prepared", "error", null, null]);
    assert.equal(refused.error, 'Rent: "now and then" is not a rule the agent reads, like "monthly on the 1st", "weekly on Friday", "every 14 days" or "yearly on March 1".');
    const sent = requests.length;
    await page.fill("#f-schedule", "Rent 25 USDC monthly");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-schedule");
    assert.equal(await page.textContent("#h-schedule"), 'Each line starts with a name and a colon: "Rent: 25 USDC to 0x…, monthly on the 1st".');
    await page.fill("#f-schedule", SCHEDULE);
    await page.fill("#f-from", "0x12");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-from");
    assert.equal(requests.length, sent);
  });

  test("the proof: each Chain MCP call, the raw result behind a toggle; the skip link lands on what is due", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls.slice(0, 4), ["get_chain_info", "get_block_number", "get_block", "get_transaction_count"]);
    assert.ok(!calls.includes("send_raw_transaction"));
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.verdict, json.result.store], ["pharos-agent/recurring-run/1", "ready", null]);
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
            rowsInside: [...document.querySelectorAll(".payment, .total, .item, .cmd, .trail-step, .calls > li, .ask")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Prepare again share the top line`);
        assert.equal(layout.trailOpen, width >= 1000, `${where}: the steps open beside the payments only where there is room`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Prepare again is a 44 px target`);
      }
    }
  });
});
