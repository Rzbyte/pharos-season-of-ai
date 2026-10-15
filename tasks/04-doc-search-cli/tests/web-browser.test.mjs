// Browser tests for the documentation terminal, in Chromium.
//   NODE_PATH="$(npm root -g)" node --test tests/web-browser.test.mjs
// Playwright is used where it is installed globally; without it the suite is skipped and says why.
// The real api/search.js runs against the in-process fake docs site (made-up values).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { createHandler } from "../api/search.js";
import { startFakeDocs } from "../dist/tests/fake-docs.js";

let chromium = null;
let skip = false;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
  await (await chromium.launch()).close();
} catch (error) {
  skip = chromium ? `Chromium for Playwright is not available (${error.message.split("\n")[0]})` : "Playwright is not installed (set NODE_PATH to a global install)";
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };
const WIDTHS = [[320, 640], [360, 740], [390, 844], [768, 1024], [1280, 860]];

describe("the documentation terminal in a browser", { skip }, () => {
  let fake;
  let server;
  let browser;
  let base;
  let apiCalls = 0;
  const contexts = [];

  before(async () => {
    fake = await startFakeDocs();
    const api = createHandler({ fetchOrigin: fake.url, timeoutMs: 5000 });
    const root = new URL("../public/", import.meta.url);
    server = createServer(async (req, res) => {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/api/search") {
        apiCalls += 1;
        return api(req, res);
      }
      try {
        const file = path === "/" ? "index.html" : path.slice(1);
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
    await fake?.close();
  });
  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
    fake.reset();
    apiCalls = 0;
  });

  async function open(options = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    contexts.push(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    return { page, errors };
  }
  /** Type a command and press Enter; wait for its entry to finish. */
  async function command(page, line) {
    const before = await page.locator(".entry").count();
    await page.fill("#cmd", line);
    await page.press("#cmd", "Enter");
    await page.waitForFunction((n) => document.querySelectorAll(".entry").length > n && !document.querySelector(".out-pending"), before);
    return page.locator(".entry").last();
  }

  test("a question runs through the real search and renders Answer and Sources", async () => {
    const { page, errors } = await open();
    const entry = await command(page, 'pharos-docs "What is the chain ID of the Atlantic testnet?"');
    assert.equal(await entry.locator(".cmd").innerText(), '$ pharos-docs "What is the chain ID of the Atlantic testnet?"');
    assert.equal(await entry.locator(".out-answer").innerText(), "Chain ID: 424242");
    const link = entry.locator(".sources a");
    assert.equal(await link.getAttribute("href"), "https://docs.pharos.xyz/getting-started/network/atlantic-testnet");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    assert.match(await entry.locator(".out-meta").innerText(), /1 docs page asked/);
    assert.equal(apiCalls, 1);
    assert.equal(await page.inputValue("#cmd"), "", "the command line is cleared");
    assert.deepEqual(errors, []);
  });

  test("a bare question works too; a no-answer says so with nearby topics", async () => {
    const { page } = await open();
    const entry = await command(page, "How do I deploy an Anchor program to Solana?");
    assert.equal(await entry.locator(".out-none").innerText(), "No good answer found in the Pharos Developer Docs.");
    assert.equal(await entry.locator(".out-answer").count(), 0);
    assert.ok((await entry.locator(".sources a").count()) >= 1);
  });

  test("--json shows the raw result", async () => {
    const { page } = await open();
    const entry = await command(page, '"What is the chain ID of the Atlantic testnet?" --json');
    const json = JSON.parse(await entry.locator(".out-json").innerText());
    assert.equal(json.schema, "pharos-docs-result/1");
    assert.equal(json.status, "answered");
  });

  test("help, clear and history never call the API; an unknown option is an error", async () => {
    const { page } = await open();
    assert.ok((await (await command(page, "help")).locator(".help dt").count()) >= 4);
    assert.match(await (await command(page, "pharos-docs q --nope")).locator(".out-error").innerText(), /Unknown option --nope/);
    assert.equal(apiCalls, 0);
    await page.fill("#cmd", "clear");
    await page.press("#cmd", "Enter");
    assert.equal(await page.locator(".entry").count(), 0);
  });

  test("keyboard: Enter runs, ↑/↓ recall history, Escape clears, Ctrl+L empties the log", async () => {
    const { page } = await open();
    await command(page, "help");
    await command(page, "pharos-docs --version");
    await page.focus("#cmd");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.inputValue("#cmd"), "pharos-docs --version");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.inputValue("#cmd"), "help");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.inputValue("#cmd"), "pharos-docs --version");
    await page.keyboard.press("Escape");
    assert.equal(await page.inputValue("#cmd"), "");
    await page.keyboard.press("Control+l");
    assert.equal(await page.locator(".entry").count(), 0);
    // Tab order: the command line, then Run.
    await page.focus("#cmd");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "run");
  });

  test("example chips run their question; Run is disabled while a question is out", async () => {
    const { page } = await open();
    fake.set("/getting-started/network/atlantic-testnet", "hang");
    await page.click(".chip >> nth=0");
    await page.waitForSelector(".out-pending");
    assert.equal(await page.locator("#run").isDisabled(), true);
    assert.equal(await page.locator("#terminal").getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("#term-state").innerText(), "Asking docs.pharos.xyz");
    await page.waitForSelector(".out-error", { timeout: 15_000 });
    assert.equal(await page.locator("#run").isDisabled(), false);
    assert.match(await page.locator(".out-error").innerText(), /^Error: /);
  });

  test("the log stays bounded", async () => {
    const { page } = await open();
    for (let i = 0; i < 24; i += 1) {
      await page.fill("#cmd", "pharos-docs --version");
      await page.press("#cmd", "Enter");
    }
    assert.equal(await page.locator(".entry").count(), 20);
  });

  for (const scheme of ["dark", "light"]) {
    test(`layout at every width, ${scheme}: no overflow, 44px targets, compact type`, async () => {
      for (const [width, height] of WIDTHS) {
        const { page } = await open({ viewport: { width, height }, colorScheme: scheme });
        await command(page, "How do I set up Foundry and deploy a contract to the Atlantic testnet?");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(overflow, 0, `${width}px overflows by ${overflow}px`);
        const small = await page.$$eval("button, input, .sources a, .links a", (elements) =>
          elements.filter((element) => element.getClientRects().length && element.getBoundingClientRect().height < 44).map((element) => element.id || element.className || element.tagName),
        );
        assert.deepEqual(small, [], `${width}px: targets under 44px`);
        const sizes = await page.evaluate(() => ({ h1: parseFloat(getComputedStyle(document.querySelector("h1")).fontSize), body: parseFloat(getComputedStyle(document.body).fontSize), meta: parseFloat(getComputedStyle(document.querySelector(".out-meta")).fontSize) }));
        if (width < 600) assert.ok(sizes.h1 >= 27 && sizes.h1 <= 31, `${width}px: title ${sizes.h1}px`);
        assert.ok(sizes.body >= 15 && sizes.body <= 16, `body ${sizes.body}px`);
        assert.ok(sizes.meta >= 12 && sizes.meta <= 13, `meta ${sizes.meta}px`);
        const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert.equal(background, scheme === "dark" ? "rgb(11, 11, 11)" : "rgb(239, 241, 242)");
      }
    });
  }
});
