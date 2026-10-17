// Task 08's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/08-dry-run-executor/tests/browser.test.mjs
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
const ROUTER = "0x1111111111111111111111111111111111111111";
const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 08 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  const fresh = () => {
    fake.state.tokens[USDC] = { decimals: 6, balances: { [lower(SENDER)]: 1_000_000_000n, [lower(RECIPIENT)]: 600_000_000n } };
    fake.state.native = { [lower(SENDER)]: 10n ** 18n, [lower(RECIPIENT)]: 5n * 10n ** 17n };
    fake.state.code = {};
  };

  before(async () => {
    fake = await startFakeChain(defaultState({}));
    fresh();
    const port = await freePort();
    // No rate limit here: the suite runs more dry runs in a minute than the hosted endpoint allows one IP.
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

  const settled = () => document.getElementById("run").getAttribute("aria-busy") === "false";

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
        heading: text("outcome") === null ? null : document.getElementById("outcome-h").textContent,
        changes: [...document.querySelectorAll(".change")].map((row) => [row.dataset.role, row.dataset.dir, row.querySelector(".change-who").textContent, row.querySelector(".change-delta").textContent, row.querySelector(".change-span")?.textContent ?? null]),
        warnings: [...document.querySelectorAll("#warnings li")].map((item) => item.dataset.code),
        cost: document.getElementById("cost").hidden ? null : [...document.querySelectorAll("#cost .rows > div")].filter((row) => !row.hidden).map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
        pin: text("pin")?.replace(/mined \d\d:\d\d:\d\d/, "mined HH:MM:SS") ?? null,
      };
    });

  test("it dry-runs the example on load: would succeed, who ends with what, the cost, and nothing sent", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Would succeed", "about 0.00005635 PROS in gas", "success"]);
    assert.equal(seen.tx, "Send 25 USDC from 0x912c…f647 to 0xB274…9553");
    assert.equal(seen.pin, "Block 5,000,000mined HH:MM:SS", "the separator is drawn by CSS");
    assert.equal(seen.heading, "Outcome if sent");
    assert.deepEqual(seen.changes, [
      ["sender", "down", "Sender 0x912c…f647", "−25 USDC", "1,000 USDC → 975 USDC"],
      ["recipient", "up", "Recipient 0xB274…9553", "+25 USDC", "600 USDC → 625 USDC"],
      ["sender", "down", "Sender 0x912c…f647", "−0.00005635 PROS", "1 PROS → about 0.99994364 PROSpays the gas"],
    ]);
    assert.deepEqual(seen.cost, [
      ["Simulation", "Succeeds at block 5,000,000, returns true."],
      ["Gas", "51,234 estimated, 61,480 limit"],
      ["Fee", "About 0.00005635 PROS at 1.1 gweiAt most 0.0001291 PROS, under the 2.1 gwei cap."],
      ["Funds", "Holds 1 PROS; needs up to 0.0001291 PROS."],
      ["Sent", "No. The hosted Chain MCP is read-only; the CLI submits on Atlantic and checks the receipt against the prediction."],
    ]);
    assert.deepEqual([seen.why, seen.error, seen.warnings], [null, null, []]);
    assert.deepEqual(requests, [{ task: "08", action: "transfer", asset: "USDC", from: SENDER, to: RECIPIENT, amount: "25" }]);
    // The addresses link to the explorer, in a new tab, saying so.
    assert.deepEqual(await page.locator("#tx a").evaluateAll((links) => links.map((a) => [a.getAttribute("href"), a.target, a.getAttribute("aria-label")])), [
      [`https://pharos.socialscan.io/address/${SENDER}`, "_blank", "0x912c…f647: the sender, opens in a new tab"],
      [`https://pharos.socialscan.io/address/${RECIPIENT}`, "_blank", "0xB274…9553: the recipient, opens in a new tab"],
    ]);
    // Each Chain MCP call of the run is in the proof, as many as it counts; the simulation names the block.
    const calls = await page.locator("#calls > li").allTextContents();
    assert.equal(`${calls.length} calls`, await page.textContent("#pin-calls"));
    assert.equal(calls[0], "get_chain_info ");
    assert.ok(calls.some((call) => /^eth_call from 0x912c…f647 to 0xC879…1815 data 0xa9059cbb… @ 5,000,000$/.test(call)), calls.join("\n"));
    assert.ok(calls.includes("estimate_gas from 0x912c…f647 to 0xC879…1815 data 0xa9059cbb…"), "estimate_gas takes no block");
    assert.deepEqual(errors, []);
  });

  test("a transfer above the balance would revert: the reason at the top, today's balances, no cost", async () => {
    fake.state.tokens[USDC].balances[lower(SENDER)] = 10_000_000n;
    const { page } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Would revert", "in simulation", "error"]);
    assert.equal(seen.why, "It reverts: ERC20: transfer amount exceeds balance. Nothing was sent.");
    assert.equal(seen.heading, "Balances at this block");
    assert.deepEqual(seen.changes.map(([role, dir, , delta, span]) => [role, dir, delta, span]), [
      ["sender", "none", "10 USDC", null],
      ["recipient", "none", "600 USDC", null],
      ["sender", "none", "1 PROS", null],
    ]);
    assert.deepEqual(seen.cost, [
      ["Simulation", "Reverts at block 5,000,000."],
      ["Gas", "Not estimated: it would not go through."],
      ["Funds", "Holds 1 PROS."],
      ["Sent", "No. The hosted Chain MCP is read-only; the CLI submits on Atlantic and checks the receipt against the prediction."],
    ]);
    assert.equal(await page.getAttribute("#cost-sim", "data-tone"), "error");
  });

  test("an approval never reads as money received: its row is not green", async () => {
    const { page } = await open(`/?action=approve&asset=USDC&from=${SENDER}&to=${ROUTER}&amount=5`);
    const colors = await page.evaluate(() => {
      const delta = (role) => getComputedStyle(document.querySelector(`.change[data-role="${role}"] .change-delta`)).color;
      const probe = Object.assign(document.createElement("span"), { style: "color: var(--success)" });
      document.body.append(probe);
      return { allowance: delta("allowance"), success: getComputedStyle(probe).color };
    });
    assert.notEqual(colors.allowance, colors.success);
  });

  test("a sender without enough PROS for the fee cannot pay, and the page says by how much", async () => {
    fake.state.native[lower(SENDER)] = 10n ** 12n;
    const { page } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Can't pay", "the sender is short of PROS", "error"]);
    assert.equal(seen.why, "The sender holds 0.000001 PROS but needs up to 0.0001291 PROS: the value plus the maximum fee. Nothing was sent.");
    assert.equal(seen.cost.find(([name]) => name === "Funds")[1], "Holds 0.000001 PROS; needs up to 0.0001291 PROS.");
    assert.equal(await page.getAttribute("#cost-funds", "data-tone"), "error");
  });

  test("an unlimited approval, from the form: labels follow the action, PROS cannot be approved, the warnings are listed", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.selectOption("#f-action", "approve");
    assert.deepEqual(await page.evaluate(() => [document.getElementById("l-to").textContent, document.getElementById("h-to").textContent, document.getElementById("h-amount").textContent]), ["Spender", "May then move the sender's USDC.", "Up to 6 decimals, or max for unlimited."]);
    assert.equal(await page.locator('#f-asset option[value="PROS"]').evaluate((option) => option.disabled), true);
    await page.fill("#f-to", ROUTER);
    await page.fill("#f-amount", "max");
    await page.click('#tx-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("run").getAttribute("aria-busy") === "false" && document.getElementById("tx").textContent.startsWith("Approve"));
    const seen = await view(page);
    assert.deepEqual(requests.at(-1), { task: "08", action: "approve", asset: "USDC", from: SENDER, to: ROUTER, amount: "max" });
    assert.deepEqual([seen.word, seen.detail], ["Would succeed", "about 0.00005115 PROS in gas, 2 warnings"]);
    assert.equal(seen.tx, "Approve 0x1111…1111 to spend unlimited USDC of 0x912c…f647");
    assert.deepEqual(seen.changes[0], ["allowance", "up", "Allowance to 0x1111…1111", "set to unlimited USDC", "0 USDC → unlimited USDC"]);
    assert.deepEqual(seen.warnings, ["unlimited-approval", "spender-not-contract"]);
    assert.equal(new URL(page.url()).search, `?action=approve&asset=USDC&from=${SENDER}&to=${ROUTER}&amount=max`);
    assert.equal(await page.textContent("#change-meta"), "Approve · unlimited USDC");
    // Back to a transfer: PROS can be picked again, and its 18 decimals are the amount's limit.
    await page.selectOption("#f-action", "transfer");
    await page.selectOption("#f-asset", "PROS");
    assert.deepEqual(await page.evaluate(() => [document.getElementById("l-to").textContent, document.getElementById("l-amount").textContent, document.getElementById("h-amount").textContent]), ["Recipient", "Amount, PROS", "Up to 18 decimals."]);
  });

  test("a PROS transfer: the recipient gains the value, the sender loses the value and the gas", async () => {
    const { page } = await open(`/?action=transfer&asset=PROS&from=${SENDER}&to=${RECIPIENT}&amount=0.25`);
    const seen = await view(page);
    assert.equal(seen.word, "Would succeed");
    assert.deepEqual(seen.changes.map(([role, dir, , delta, span]) => [role, dir, delta, span]), [
      ["recipient", "up", "+0.25 PROS", "0.5 PROS → 0.75 PROS"],
      ["sender", "down", "−0.2500231 PROS", "1 PROS → about 0.7499769 PROSpays the gas"],
    ]);
  });

  test("invalid input is marked at its field and never sent; a token's own decimals are the limit", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-from", "0x123");
    await page.fill("#f-amount", "1.1234567");
    await page.click('#tx-form button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-from");
    assert.deepEqual(await page.evaluate(() => ["f-from", "f-to", "f-amount"].map((id) => document.getElementById(id).getAttribute("aria-invalid"))), ["true", "false", "true"]);
    assert.equal(await page.textContent("#h-from"), "Enter a 0x address of 40 hex characters.");
    assert.equal(await page.textContent("#h-amount"), "A positive amount, up to 6 decimals.");
    await page.fill("#f-from", SENDER);
    await page.fill("#f-amount", "max");
    await page.click('#tx-form button[type="submit"]');
    assert.equal(await page.textContent("#h-amount"), "A positive amount, up to 6 decimals.", "only an approval can be unlimited");
    assert.equal(requests.length, 1, "nothing invalid is sent");
    await page.fill("#f-amount", "5");
    await page.click('#tx-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("run").getAttribute("aria-busy") === "false" && document.getElementById("tx").textContent.startsWith("Send 5 "));
    assert.equal(await page.textContent("#h-amount"), "Up to 6 decimals.", "the hint comes back once the value is right");
    assert.equal(await page.evaluate(() => document.activeElement.id), "verdict-h");
  });

  test("an unreachable Chain MCP is an error the page states, with nothing half-shown", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["Not simulated", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
      assert.deepEqual([seen.changes, seen.cost, seen.pin, seen.tx], [[], null, null, null]);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("a transaction in the address bar runs on load; Simulate again re-reads it; a broken one falls back to the example", async () => {
    const { page } = await open(`/?action=transfer&asset=USDC&from=${SENDER}&to=${RECIPIENT}&amount=7`);
    assert.deepEqual(requests, [{ task: "08", action: "transfer", asset: "USDC", from: SENDER, to: RECIPIENT, amount: "7" }]);
    assert.equal(await page.inputValue("#f-amount"), "7");
    await page.click("#again");
    await page.waitForFunction(settled);
    assert.equal(requests.length, 2);
    const broken = await open("/?action=approve&asset=PROS&from=0x1&to=0x2&amount=1");
    assert.equal(await broken.page.inputValue("#f-asset"), "USDC");
    assert.equal(await broken.page.inputValue("#f-amount"), "25");
  });

  test("the proof: the raw result behind a toggle; the skip link lands on the verdict", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    await page.click("#json-toggle");
    assert.equal(await page.getAttribute("#json-toggle", "aria-expanded"), "true");
    assert.equal(await page.textContent("#json-toggle"), "Hide the JSON");
    const json = JSON.parse(await page.textContent("#json"));
    assert.equal(json.result.schema, "pharos-agent/dry-run/1");
    assert.equal(json.result.submission, null);
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "verdict-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open(`/?action=approve&asset=USDC&from=${SENDER}&to=${ROUTER}&amount=max`, { viewport: { width, height }, colorScheme });
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
            rowsInside: [...document.querySelectorAll(".change, .rows > div, .calls > li, #warnings li")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Simulate again share the top line`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const again = await page.locator("#again").boundingBox();
        assert.ok(again.height >= 44, `${where}: Simulate again is a 44 px target`);
      }
    }
  });
});
