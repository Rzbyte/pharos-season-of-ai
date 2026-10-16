// Task 05's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/05-threshold-guardian/tests/browser.test.mjs
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
const PAYER = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";
const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 05 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  const fresh = () => {
    fake.state.headTime = BigInt(Math.floor(Date.now() / 1000));
    fake.state.tokens[USDC] = { decimals: 6, balances: { [PAYER]: 1_000_000_000n } };
    fake.state.native = { [PAYER]: 10n ** 18n };
    fake.state.gasPrice = 1_200_000_000n;
  };

  before(async () => {
    fake = await startFakeChain(defaultState({}));
    fresh();
    const port = await freePort();
    // No rate limit here: the suite evaluates more often in a minute than the hosted endpoint allows one IP.
    official = await startHttpServer(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: String(port), PHAROS_RPC_URL: fake.url, PHAROS_CHAIN_ID: "1672", RATE_LIMIT_PER_MINUTE: "0" }));
    const live = createHandler({ chainMcpUrl: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000 });
    api = live;
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

  async function open(path = "/", options = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    contexts.push(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.waitForFunction(() => document.getElementById("guard").getAttribute("aria-busy") === "false");
    return { page, errors };
  }

  const view = (page) =>
    page.evaluate(() => ({
      word: document.getElementById("status-word").textContent,
      detail: document.getElementById("status-detail").textContent,
      tone: document.getElementById("status").dataset.tone,
      states: [...document.querySelectorAll(".check")].map((row) => `${row.dataset.id}:${row.dataset.state}`),
      act: document.getElementById("act").hidden ? null : ["act-what", "act-sim", "act-gas", "act-sent"].map((id) => document.getElementById(id).textContent),
      rule: document.getElementById("rule").hidden ? null : document.getElementById("rule").textContent,
      pin: document.getElementById("pin").hidden ? null : document.getElementById("pin").textContent.replace(/mined \d\d:\d\d:\d\d/, "mined HH:MM:SS"),
      error: document.getElementById("error").hidden ? null : document.getElementById("error").textContent,
      why: document.getElementById("why").hidden ? null : document.getElementById("why").textContent,
    }));

  test("it evaluates the example payout on load: Fire, six conditions holding, the payout simulated and not sent", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Fire", "all 6 conditions hold", "success"]);
    assert.deepEqual(seen.states, ["usdc-live:pass", "payer-funded:pass", "payer-gas:pass", "recipient-wallet:pass", "gas-cap:pass", "chain-fresh:pass"]);
    assert.deepEqual(seen.act, [
      "25 USDC from 0x912c…f647 to 0xB274…9553",
      "Returns true at block 5,000,000.",
      "51,234 gas at 1.2 gwei = 0.00006148 PROSThe payer holds 1 PROS.",
      "No. The hosted Chain MCP is read-only; the CLI executes on Atlantic after re-reading every condition.",
    ]);
    assert.equal(seen.rule, null);
    assert.equal(seen.pin, "Block 5,000,000mined HH:MM:SS", "the separator is drawn by CSS");
    assert.equal(await page.locator(".check").first().textContent(), "USDC is not paused: holds.paused() = falseeth_call");
    assert.equal(await page.locator('.check[data-id="recipient-wallet"] .check-evidence').textContent(), "no contract codeget_code");
    assert.equal(seen.why, null);
    assert.deepEqual(requests, [{ task: "05", payer: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", recipient: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "25", maxGasGwei: "10" }]);
    // The payer and recipient link to the explorer, in a new tab, saying so.
    assert.deepEqual(await page.locator("#act-what a").evaluateAll((links) => links.map((a) => [a.getAttribute("href"), a.target, a.getAttribute("aria-label")])), [
      ["https://pharos.socialscan.io/address/0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", "_blank", "0x912c…f647: the payer, opens in a new tab"],
      ["https://pharos.socialscan.io/address/0xB2749BD12f19C24a2244176658F3dF3e48e79553", "_blank", "0xB274…9553: the recipient, opens in a new tab"],
    ]);
    // Each Chain MCP call of the run is listed in the proof, as many as the status line counts.
    const calls = await page.locator("#calls > li").count();
    assert.equal(`${calls} calls`, await page.textContent("#pin-calls"));
    assert.equal(await page.locator("#calls > li").first().textContent(), "get_chain_info ");
    assert.deepEqual(errors, []);
  });

  test("Hold: the failing condition is marked and named, and nothing is prepared", async () => {
    fake.state.tokens[USDC].balances[PAYER] = 10_000_000n;
    const { page } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Hold", "5 of 6 hold, 1 fails", "warning"]);
    assert.ok(seen.states.includes("payer-funded:fail"));
    assert.equal(seen.act, null);
    assert.equal(seen.rule, "Fires only when all 6 hold, so nothing was prepared or sent.");
    assert.equal(await page.locator('.check[data-id="payer-funded"] .check-seen').textContent(), "10 USDC");
    assert.equal(await page.locator('.check[data-id="payer-funded"] .check-label').textContent(), "The payer holds at least the payout: fails.");
  });

  test("Blocked: the conditions hold, but USDC refuses the recipient in simulation; it says why and sends nothing", async () => {
    fake.state.tokens[USDC].blacklist = [RECIPIENT];
    const { page } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Blocked", "the conditions hold; the payout does not", "error"]);
    assert.deepEqual(seen.act.slice(1), ["The action reverts in simulation: Blacklistable: account is blacklisted.", "Not estimated: the simulation failed.", "No. A payout that fails in simulation is never sent."]);
    assert.equal(await page.locator("#act-sim").getAttribute("data-tone"), "error");
    // The reason is at the top, under the status, where a phone shows it without scrolling.
    assert.equal(seen.why, "The action reverts in simulation: Blacklistable: account is blacklisted. Nothing was sent.");
  });

  test("an unreachable Chain MCP is an error the page states, with nothing half-shown", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["Not evaluated", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
      assert.deepEqual([seen.states, seen.act, seen.pin], [[], null, null]);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("changing the payout: invalid input is marked at its field; a valid one is evaluated and kept in the address bar", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-payer", "0x123");
    await page.fill("#f-amount", "1.1234567");
    await page.click('#payout button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-payer");
    assert.deepEqual(await page.evaluate(() => ["f-payer", "f-recipient", "f-amount", "f-gas"].map((id) => document.getElementById(id).getAttribute("aria-invalid"))), ["true", "false", "true", "false"]);
    assert.equal(await page.textContent("#h-payer"), "Enter a 0x address of 40 hex characters.");
    assert.equal(await page.textContent("#h-amount"), "A positive amount, up to 6 decimals.");
    assert.equal(requests.length, 1, "nothing invalid is sent");
    await page.fill("#f-payer", PAYER);
    await page.fill("#f-amount", "5");
    await page.fill("#f-gas", "2.5");
    await page.click('#payout button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("guard").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Fire");
    assert.deepEqual(requests.at(-1), { task: "05", payer: PAYER, recipient: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "5", maxGasGwei: "2.5" });
    assert.equal(new URL(page.url()).search, `?payer=${PAYER}&recipient=0xB2749BD12f19C24a2244176658F3dF3e48e79553&amount=5&maxGasGwei=2.5`);
    assert.equal(await page.textContent("#change-meta"), "5 USDC · gas cap 2.5 gwei");
    assert.equal(await page.textContent("#h-payer"), "Pays the USDC and the gas.");
    assert.equal(await page.locator('.check[data-id="gas-cap"] .check-label').textContent(), "Gas costs at most 2.5 gwei: holds.");
  });

  test("a payout in the address bar is evaluated on load; Evaluate again re-reads it", async () => {
    const { page } = await open(`/?payer=${PAYER}&recipient=${RECIPIENT}&amount=7&maxGasGwei=3`);
    assert.deepEqual(requests, [{ task: "05", payer: PAYER, recipient: RECIPIENT, amount: "7", maxGasGwei: "3" }]);
    assert.equal(await page.inputValue("#f-amount"), "7");
    await page.click("#again");
    await page.waitForFunction(() => document.getElementById("guard").getAttribute("aria-busy") === "false");
    assert.equal(requests.length, 2);
    // A half-filled address bar is ignored in favour of the example.
    const other = await open("/?payer=0x1");
    assert.equal(await other.page.inputValue("#f-payer"), "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647");
  });

  test("the proof: the raw result behind a toggle; the skip link lands on the decision", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    await page.click("#json-toggle");
    assert.equal(await page.getAttribute("#json-toggle", "aria-expanded"), "true");
    assert.equal(await page.textContent("#json-toggle"), "Hide the JSON");
    const json = JSON.parse(await page.textContent("#json"));
    assert.equal(json.result.schema, "pharos-agent/guardian-run/1");
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "decision-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every target at least 44 px", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open("/", { viewport: { width, height }, colorScheme });
        await page.click("#change > summary");
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
            rowsInside: [...document.querySelectorAll(".check, .rows > div, .calls > li")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Evaluate again share the top line`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const again = await page.locator("#again").boundingBox();
        assert.ok(again.height >= 44, `${where}: Evaluate again is a 44 px target`);
      }
    }
  });
});
