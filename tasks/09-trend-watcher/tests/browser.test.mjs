// Task 09's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) and a fake chain with made-up values. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/09-trend-watcher/tests/browser.test.mjs
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

const lower = (address) => address.toLowerCase();

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 09 page in a browser", { skip }, () => {
  let fake;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  // The holder starts with 1,000 USDC; the example treasury can pay a 100 USDC top-up and its gas.
  const fresh = () => {
    fake.state.head = 5_000_000n;
    fake.state.headTime = 1_790_000_000n;
    fake.state.tokens[USDC] = { decimals: 6, balances: { [lower(SENDER)]: 1_000_000_000n, [lower(RECIPIENT)]: 600_000_000n } };
    fake.state.native = { [lower(SENDER)]: 10n ** 18n, [lower(RECIPIENT)]: 10n ** 18n };
    fake.state.failures = {};
  };
  /** The chain moves on: `blocks` later, the holder holds `usdc` (base units). */
  const step = (blocks, usdc) => {
    fake.state.head += blocks;
    fake.state.headTime += blocks;
    fake.state.tokens[USDC].balances[lower(SENDER)] = usdc;
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

  const settled = () => document.getElementById("watch").getAttribute("aria-busy") === "false";

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
  /** "Observe now", then wait for the run: the click marks the panel busy before the request starts. */
  const again = async (page) => {
    await page.click("#again");
    await page.waitForFunction(settled);
  };

  const view = (page) =>
    page.evaluate(() => {
      const text = (id) => (document.getElementById(id).hidden ? null : document.getElementById(id).textContent);
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        tx: text("tx"),
        why: text("why"),
        skipped: text("skipped"),
        error: text("error"),
        meta: text("history") === null ? null : document.getElementById("history-meta").textContent,
        key: document.getElementById("obs-key").textContent,
        rows: [...document.querySelectorAll(".obs")].map((row) => [row.querySelector(".obs-when").textContent.replace(/\d\d:\d\d:\d\d/, "HH:MM:SS"), row.querySelector(".obs-value").textContent, row.querySelector(".obs-change").textContent, row.dataset.window, row.dataset.counted]),
        act: document.getElementById("act").hidden ? null : [...document.querySelectorAll("#act .rows > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
      };
    });
  const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("pharos-agent-lab:09:0x912c9ade24d44d8922f0866d8dcb079f1363f647") ?? "null"));
  const SENT = "No. The hosted Chain MCP is read-only; the CLI sends the action on Atlantic with --execute.";

  test("the first run: one observation, kept in this browser; the watcher waits for the trend", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Watching", "1 of 3 observations so far", "neutral"]);
    assert.equal(seen.tx, "USDC held by 0x912c…f647: 1,000 USDC");
    assert.equal(seen.meta, "1 kept in this browser");
    assert.deepEqual(seen.rows, [["Block 5,000,000 · HH:MM:SS", "1,000 USDC", "first", "true", "true"]]);
    assert.equal(seen.key, "Marked: the one the trend was judged on.");
    assert.deepEqual(seen.act, [
      ["When", "Fell across the last 3 observations."],
      ["Does", "Prepares a 100 USDC top-up from 0xB274…9553 and simulates it."],
      ["This run", "Waits: 1 of 3 observations so far."],
      ["Sent", SENT],
    ]);
    assert.deepEqual(requests, [{ task: "09", holder: SENDER, trend: "falling", observations: "3", every: "10" }]);
    assert.deepEqual((await stored(page)).observations.map((o) => [o.block, o.raw]), [["5000000", "1000000000"]]);
    assert.deepEqual(errors, []);
  });

  test("run after run the observations persist; the third makes the trend, the watcher fires once, and a reload keeps it all", async () => {
    const { page, context } = await open();
    step(10n, 990_000_000n);
    await again(page);
    assert.deepEqual(requests.at(-1), { task: "09", holder: SENDER, trend: "falling", observations: "3", every: "10", series: "5000000:1000000000:1790000000" });
    assert.equal((await view(page)).detail, "2 of 3 observations so far");
    step(10n, 975_500_000n);
    await again(page);
    const fired = await view(page);
    assert.deepEqual([fired.word, fired.detail, fired.tone], ["Fired", "fell across the last 3 observations", "warning"]);
    assert.equal(fired.why, "Fell across the last 3 observations: 2 of 2 steps down. The watcher acted once; the next trend counts only observations after this block. Nothing was sent.");
    assert.deepEqual(fired.rows.map(([when, value, change, window]) => [when, value, change, window]), [
      ["Block 5,000,020 · HH:MM:SSacted", "975.5 USDC", "−14.5 USDC", "true"],
      ["Block 5,000,010 · HH:MM:SS", "990 USDC", "−10 USDC", "true"],
      ["Block 5,000,000 · HH:MM:SS", "1,000 USDC", "first", "true"],
    ]);
    assert.equal(fired.act[2][1], "Would succeed: Send 100 USDC from 0xB274…9553 to 0x912c…f647, for about 0.00005635 PROS in gas.");
    assert.equal((await stored(page)).actedAt, "5000020");
    // A reload is a new run of the same watcher: it starts from the stored observations.
    const reloaded = await context.newPage();
    step(10n, 960_000_000n);
    await reloaded.goto(base);
    await reloaded.waitForFunction(settled);
    assert.match(requests.at(-1).series, /^5000000:1000000000:1790000000,5000010:990000000:1790000010,5000020:975500000:1790000020$/);
    assert.equal(requests.at(-1).actedAt, "5000020");
    const after = await view(reloaded);
    assert.deepEqual([after.word, after.detail], ["Watching", "1 of 3 observations so far"], "the acted-on trend does not count again");
    assert.deepEqual(after.rows.map(([, , , window, counted]) => [window, counted]), [["true", "true"], ["false", "false"], ["false", "false"], ["false", "false"]]);
    assert.equal(after.key, "Marked: the one the trend was judged on; dimmed: before the last action.");
  });

  test("too soon after the last observation, nothing is recorded; forgetting starts over", async () => {
    const { page } = await open();
    await again(page);
    const soon = await view(page);
    assert.equal(soon.skipped, "Nothing recorded: Block 5,000,000 is not after the last observation (block 5,000,000).");
    assert.equal(soon.rows.length, 1);
    assert.equal(soon.act[2][1], "Nothing new was recorded, so nothing was judged new.");
    step(10n, 990_000_000n);
    await page.click("#forget");
    await page.waitForFunction(settled);
    assert.equal(requests.at(-1).series, undefined, "nothing earlier is sent after forgetting");
    assert.equal((await view(page)).rows.length, 1);
  });

  test("the settings, from the form: kept in the address bar; the same holder keeps its observations", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.selectOption("#f-trend", "rising");
    await page.selectOption("#f-observations", "2");
    await page.fill("#f-every", "5");
    step(5n, 1_200_000_000n);
    await page.click('#settings button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("watch").getAttribute("aria-busy") === "false" && document.getElementById("status-word").textContent === "Fired");
    assert.deepEqual(requests.at(-1), { task: "09", holder: SENDER, trend: "rising", observations: "2", every: "5", series: "5000000:1000000000:1790000000" });
    assert.equal(new URL(page.url()).search, `?holder=${SENDER}&trend=rising&observations=2&every=5`);
    assert.equal(await page.textContent("#change-meta"), "Rising · 2 observations · every 5 blocks");
    assert.equal((await view(page)).detail, "rose across the last 2 observations");
  });

  test("invalid settings are marked at their fields and never sent", async () => {
    const { page } = await open();
    await page.click("#change > summary");
    await page.fill("#f-holder", "0x12");
    await page.fill("#f-every", "0");
    await page.click('#settings button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-holder");
    assert.equal(await page.textContent("#h-holder"), "Enter a 0x address of 40 hex characters.");
    assert.equal(await page.textContent("#h-every"), "A whole number of blocks, 1 to 1,000.");
    assert.equal(requests.length, 1);
  });

  test("observing every 15 s while it is on", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(base);
    await page.waitForFunction(settled);
    await page.click("#auto");
    assert.deepEqual([await page.getAttribute("#auto", "aria-pressed"), await page.textContent("#auto")], ["true", "Stop observing every 15 s"]);
    step(10n, 990_000_000n);
    await page.clock.runFor(15_000);
    await page.waitForFunction(() => document.querySelectorAll(".obs").length === 2);
    await page.click("#auto");
    const before = requests.length;
    await page.clock.runFor(30_000);
    assert.equal(requests.length, before, "stopped");
  });

  test("an unreachable Chain MCP is an error the page states, and the store is left as it was", async () => {
    api = createHandler({ chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone], ["Not observed", "error"]);
      assert.match(seen.error, /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
      assert.deepEqual([seen.rows, seen.act, seen.tx], [[], null, null]);
      assert.equal(await stored(page), null);
    } finally {
      api = createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, timeoutMs: 5000 });
    }
  });

  test("the proof: the raw result behind a toggle; the skip link lands on the trend", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.equal(json.result.schema, "pharos-agent/trend-run/1");
    assert.equal(json.result.store.observations.length, 1);
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "trend-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open("/", { viewport: { width, height }, colorScheme });
        step(10n, 900_000_000n);
        await again(page);
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
            rowsInside: [...document.querySelectorAll(".obs, .rows > div, .calls > li")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Observe now share the top line`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Observe now is a 44 px target`);
        fresh();
      }
    }
  });
});
