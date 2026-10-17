// Task 11's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/11-policy-gatekeeper/tests/browser.test.mjs
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
const SENDER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const STRANGER = "0x1111111111111111111111111111111111111111";
const ALLOWED = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 11 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  // Monday 14:13 UTC, inside the treasury's 06:00 to 22:00; the sender sent 1,200 USDC in the last 1,000 blocks.
  const fresh = () => {
    fake.state.headTime = 1_790_000_000n;
    fake.state.tokens[USDC] = { decimals: 6, balances: { [lower(SENDER)]: 1_000_000_000n, [lower(RECIPIENT)]: 600_000_000n } };
    fake.state.native = { [lower(SENDER)]: 10n ** 18n, [lower(RECIPIENT)]: 5n * 10n ** 17n };
    fake.state.code = {};
    fake.state.failures = {};
    fake.state.transfers = [
      { token: USDC, from: lower(SENDER), to: lower(RECIPIENT), amount: 700_000_000n, block: 4_999_500n },
      { token: USDC, from: lower(SENDER), to: lower(STRANGER), amount: 500_000_000n, block: 4_999_990n },
    ];
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

  const settled = () => document.getElementById("gate").getAttribute("aria-busy") === "false";

  async function open(path = "/", options = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    contexts.push(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.waitForFunction(settled);
    return { page, errors };
  }

  const view = (page) =>
    page.evaluate(() => {
      const text = (id) => (document.getElementById(id).hidden ? null : document.getElementById(id).textContent);
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        tx: text("tx"),
        why: text("why"),
        error: text("error"),
        rules: [...document.querySelectorAll(".check")].map((row) => `${row.dataset.id}:${row.dataset.state}`),
        act: document.getElementById("act").hidden ? null : [...document.querySelectorAll("#act .rows > div")].filter((row) => !row.hidden).map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
        pin: text("pin")?.replace(/mined \d\d:\d\d:\d\d/, "mined HH:MM:SS") ?? null,
      };
    });
  const row = (page, id) => page.evaluate((id) => {
    const item = document.querySelector(`.check[data-id="${id}"]`);
    const part = (name) => item.querySelector(`.check-${name}`)?.textContent ?? null;
    return { state: item.dataset.state, label: part("label"), seen: part("seen"), need: part("need"), tool: part("tool"), note: part("note"), error: part("error") };
  }, id);
  const SENT_ALLOWED = "No. The hosted Chain MCP is read-only; the CLI sends allowed requests on Atlantic.";

  test("it checks the example on load: allowed, seven rules with their values and sources, and what it would do", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Allowed", "all 7 rules hold", "success"]);
    assert.equal(seen.tx, "Send 25 USDC from 0x912c…f647 to 0xB274…9553");
    assert.equal(seen.pin, "Block 5,000,000mined HH:MM:SS");
    assert.deepEqual(seen.rules, ["assets:pass", "counterparties:pass", "per-action:pass", "rolling:pass", "hours:pass", "gas:pass", "simulates:pass"]);
    assert.deepEqual(await row(page, "rolling"), { state: "pass", label: "At most 5,000 USDC sent in 1,000 blocks: holds.", seen: "1,225 USDC", need: null, tool: "get_logs", note: "1,200 USDC sent in 2 transfers over blocks 4,999,001–5,000,000 (17 min), plus 25 USDC now.", error: null });
    assert.deepEqual(await row(page, "hours"), { state: "pass", label: "Between 06:00 and 22:00 UTC, every day: holds.", seen: "Mon 14:13 UTC", need: null, tool: "get_block", note: null, error: null });
    assert.deepEqual(await row(page, "counterparties"), { state: "pass", label: "The recipient is one of 3 allowed addresses: holds.", seen: "0xB274…9553", need: null, tool: "request", note: null, error: null });
    assert.equal(await page.getAttribute('.check[data-id="counterparties"] .check-seen a', "href"), `https://pharos.socialscan.io/address/${RECIPIENT}`);
    assert.deepEqual(seen.act, [
      ["Dry run", "Would succeed at block 5,000,000."],
      ["Moves", "Sender −25 USDC, recipient +25 USDC."],
      ["Gas", "About 0.00005635 PROSAt most 0.0001291 PROS."],
      ["Sent", SENT_ALLOWED],
    ]);
    assert.deepEqual([seen.why, seen.error], [null, null]);
    assert.deepEqual(requests, [{ task: "11", action: "transfer", asset: "USDC", from: SENDER, to: RECIPIENT, amount: "25", hoursFrom: "06:00", hoursTo: "22:00" }]);
    const calls = await page.locator("#calls > li").allTextContents();
    assert.equal(`${calls.length} calls`, await page.textContent("#pin-calls"));
    assert.deepEqual(calls.slice(0, 4).map((call) => call.split(" ")[0]), ["get_chain_info", "get_block_number", "get_block", "get_logs"]);
    assert.deepEqual(errors, []);
  });

  test("denied: every failing rule is marked and named at the top; nothing is signed", async () => {
    const { page } = await open(`/?action=transfer&asset=USDC&from=${SENDER}&to=${STRANGER}&amount=150&hoursFrom=06:00&hoursTo=22:00`);
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Denied", "2 of 7 rules fail", "error"]);
    assert.deepEqual(seen.rules, ["assets:pass", "counterparties:fail", "per-action:fail", "rolling:pass", "hours:pass", "gas:pass", "simulates:pass"]);
    assert.equal(seen.why, "Not allowed: the recipient is not on the allowlist; 150 USDC is over the 100 USDC limit per action. Nothing was signed.");
    assert.equal((await row(page, "counterparties")).note, "The recipient is not on the list.");
    assert.deepEqual(seen.act.at(-1), ["Sent", "No. A denied request is never signed."]);
  });

  test("the allowed hours, from the form: a window that excludes the block's time denies, and is kept in the address bar", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-hours-from", "00:00");
    await page.fill("#f-hours-to", "01:00");
    await page.click('#request button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("gate").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Denied");
    const seen = await view(page);
    assert.equal(seen.detail, "1 of 7 rules fails");
    assert.equal(seen.why, "Not allowed: Mon 14:13 UTC is outside the allowed hours. Nothing was signed.");
    assert.deepEqual(await row(page, "hours"), { state: "fail", label: "Between 00:00 and 01:00 UTC, every day: fails.", seen: "Mon 14:13 UTC", need: null, tool: "get_block", note: "Outside the allowed hours.", error: null });
    assert.deepEqual(requests.at(-1), { task: "11", action: "transfer", asset: "USDC", from: SENDER, to: RECIPIENT, amount: "25", hoursFrom: "00:00", hoursTo: "01:00" });
    assert.equal(new URL(page.url()).searchParams.get("hoursTo"), "01:00");
    assert.equal(await page.textContent("#change-meta"), "Transfer · 25 USDC · 00:00–01:00 UTC");
  });

  test("the window limit counts what the sender already sent; an unreadable value denies", async () => {
    fake.state.transfers.push({ token: USDC, from: lower(SENDER), to: lower(RECIPIENT), amount: 3_790_000_000n, block: 4_999_999n });
    const near = await open();
    assert.equal((await view(near.page)).why, "Not allowed: 5,015 USDC in the window is over 5,000 USDC. Nothing was signed.");
    fake.state.failures.eth_getLogs = { code: -32005, message: "query timeout exceeded" };
    const { page } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail], ["Denied", "1 unreadable"]);
    assert.equal(seen.why, "Not allowed: the sender's transfers could not be read. Nothing was signed.");
    const rolling = await row(page, "rolling");
    assert.deepEqual([rolling.state, rolling.label, rolling.seen, rolling.error], ["unknown", "At most 5,000 USDC sent in 1,000 blocks: could not be read.", null, "query timeout exceeded"]);
  });

  test("an approval: the spender is the counterparty; an unlimited one is over every limit", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.selectOption("#f-action", "approve");
    assert.equal(await page.textContent("#l-to"), "Spender");
    await page.fill("#f-to", ALLOWED);
    await page.fill("#f-amount", "max");
    await page.click('#request button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("gate").getAttribute("aria-busy") === "false" && document.getElementById("tx").textContent.startsWith("Approve"));
    const seen = await view(page);
    assert.equal(seen.why, "Not allowed: an unlimited approval is over any limit; unlimited USDC in the window is over 5,000 USDC. Nothing was signed.");
    assert.equal((await row(page, "counterparties")).label, "The spender is one of 3 allowed addresses: holds.");
    assert.deepEqual(seen.act.find(([name]) => name === "Moves"), ["Moves", "Allowance set to unlimited USDC."]);
  });

  test("invalid input is marked at its field and never sent", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-hours-from", "6am");
    await page.fill("#f-hours-to", "6am");
    await page.click('#request button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-hours-from");
    assert.equal(await page.textContent("#h-hours-from"), "A time like 06:00.");
    assert.equal(await page.textContent("#h-hours-to"), "A time like 22:00 (24:00 ends the day).");
    await page.fill("#f-hours-from", "08:00");
    await page.fill("#f-hours-to", "08:00");
    await page.click('#request button[type="submit"]');
    assert.equal(await page.textContent("#h-hours-to"), "Different from the start.");
    assert.equal(requests.length, 1, "nothing invalid is sent");
  });

  test("an unreachable Chain MCP is an error the page states, with nothing half-shown", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["Not checked", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
      assert.deepEqual([seen.rules, seen.act, seen.pin, seen.tx], [[], null, null, null]);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("the proof: the raw result behind a toggle; the skip link lands on the decision", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.equal(json.result.schema, "pharos-agent/policy-check/1");
    assert.equal(json.policy.name, "Treasury payouts");
    assert.equal(json.result.execution, null);
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "decision-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open(`/?action=transfer&asset=USDC&from=${SENDER}&to=${STRANGER}&amount=150&hoursFrom=06:00&hoursTo=22:00`, { viewport: { width, height }, colorScheme });
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
            rowsInside: [...document.querySelectorAll(".check, .rows > div, .calls > li")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Check again share the top line`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const again = await page.locator("#again").boundingBox();
        assert.ok(again.height >= 44, `${where}: Check again is a 44 px target`);
      }
    }
  });
});
