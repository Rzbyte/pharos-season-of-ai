// Browser tests for the docs search page, in Chromium.
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

describe("the docs search page in a browser", { skip }, () => {
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
  /** Ask in the box and press Enter; wait for that turn to finish. */
  async function ask(page, line) {
    const before = await page.locator(".turn").count();
    await page.fill("#q", line);
    await page.press("#q", "Enter");
    await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n && !document.querySelector(".turn[aria-busy]"), before, { timeout: 15_000 });
    return page.locator(".turn").last();
  }
  const state = (page) => page.evaluate(() => document.body.dataset.state);

  test("idle: the title, one box and three examples; nothing asked yet", async () => {
    const { page, errors } = await open();
    assert.equal(await state(page), "idle");
    assert.equal(await page.locator("#thread").isHidden(), true);
    assert.deepEqual(await page.locator(".chip").allInnerTexts(), ["Deploy with Foundry", "Atlantic RPC", "Use Chainlink"]);
    assert.equal(await page.getAttribute("#q", "placeholder"), "Ask the docs…");
    assert.equal(await page.locator("#cli-body").isHidden(), true);
    assert.equal(apiCalls, 0);
    assert.deepEqual(errors, []);
  });

  test("a question runs through the real search: the question, a clean answer, source rows", async () => {
    const { page, errors } = await open();
    const turn = await ask(page, 'pharos-docs "What is the chain ID of the Atlantic testnet?"');
    assert.equal(await turn.locator(".turn-q").textContent(), "You asked: What is the chain ID of the Atlantic testnet?");
    assert.equal(await turn.locator(".answer").innerText(), "Chain ID: 424242");
    const link = turn.locator(".sources a");
    assert.equal(await link.count(), 1);
    assert.equal(await link.getAttribute("href"), "https://docs.pharos.xyz/getting-started/network/atlantic-testnet");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    assert.equal(await link.locator(".source-meta").innerText(), "docs.pharos.xyz/getting-started/network/atlantic-testnet");
    assert.match(await turn.locator(".turn-meta").innerText(), /^1 docs page asked · \d+ requests? · \d+\.\d s/);
    assert.equal(await state(page), "answer");
    assert.equal(await page.locator(".try").isHidden(), true, "the examples go once something is asked");
    assert.equal(apiCalls, 1);
    assert.equal(await page.inputValue("#q"), "", "the box is ready for a follow-up");
    assert.deepEqual(errors, []);
  });

  test("a several-page answer names each page above its part", async () => {
    const { page } = await open();
    const turn = await ask(page, "How do I set up Foundry and deploy a contract to the Atlantic testnet?");
    assert.deepEqual(await turn.locator(".answer-from").allInnerTexts(), ["Foundry", "Atlantic Testnet"]);
    assert.equal(await turn.locator(".sources a").count(), 2);
  });

  test("no answer: says so plainly, with the reason, nearby pages and Try another question", async () => {
    const { page } = await open();
    const turn = await ask(page, "How do I deploy an Anchor program to Solana?");
    assert.equal(await turn.locator(".state-title").innerText(), "No good answer found.");
    assert.equal(await turn.locator(".state-text").innerText(), "I couldn't verify this in the Pharos Developer Docs.");
    assert.equal(await turn.locator(".answer").count(), 0);
    assert.ok((await turn.locator(".sources a").count()) >= 1);
    assert.equal(await state(page), "no-answer");
    await turn.locator(".retry").click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "q");
  });

  test("JSON: --json shows the raw result; every answer has a JSON toggle, built only when opened", async () => {
    const { page } = await open();
    const raw = await ask(page, '"What is the chain ID of the Atlantic testnet?" --json');
    const json = JSON.parse(await raw.locator("pre.json").innerText());
    assert.deepEqual([json.schema, json.status], ["pharos-docs-result/1", "answered"]);
    const turn = await ask(page, "What is the chain ID of the Atlantic testnet?");
    const toggle = turn.locator(".json-toggle");
    assert.equal(await turn.locator("pre.json").count(), 0);
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(JSON.parse(await turn.locator("pre.json").innerText()).schema, "pharos-docs-result/1");
    await toggle.click();
    assert.equal(await turn.locator("pre.json").isHidden(), true);
  });

  test("help opens CLI usage, clear empties the thread, an unknown option is a note: none calls the API", async () => {
    const { page } = await open();
    await page.fill("#q", "help");
    await page.press("#q", "Enter");
    // On a phone About opens as a sheet, with CLI usage open in it.
    assert.equal(await page.evaluate(() => document.getElementById("about-sheet").open), true);
    assert.equal(await page.evaluate(() => document.getElementById("cli").open), true);
    assert.equal(await page.locator("#cli .cli-body").isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.getElementById("about-sheet").open), false);
    assert.match(await (await ask(page, "pharos-docs q --nope")).locator(".turn-note").innerText(), /Unknown option --nope/);
    assert.equal(apiCalls, 0);
    await page.fill("#q", "clear");
    await page.press("#q", "Enter");
    assert.equal(await page.locator(".turn").count(), 0);
    assert.equal(await state(page), "idle");
  });

  test("keyboard: Enter asks, ↑/↓ recall earlier questions, Tab goes from the box to Ask", async () => {
    const { page } = await open();
    await ask(page, "pharos-docs --version");
    await ask(page, "history");
    await page.focus("#q");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.inputValue("#q"), "history");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.inputValue("#q"), "pharos-docs --version");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.inputValue("#q"), "history");
    await page.focus("#q");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "go");
  });

  test("an example runs its question; Ask is busy while it is out; a failure offers Try again", async () => {
    const { page } = await open();
    // Both pages the question can match never answer, so the search ends in an upstream error.
    fake.set("/developer-guide/foundry", "hang");
    fake.set("/developer-guide/hardhat", "hang");
    await page.click(".chip >> nth=0");
    await page.waitForFunction(() => document.body.dataset.state === "searching");
    assert.equal(await page.getAttribute("#go", "aria-disabled"), "true");
    assert.equal(await page.locator(".turn[aria-busy] .status-word").innerText(), "Searching");
    await page.waitForFunction(() => document.body.dataset.state === "error", null, { timeout: 30_000 });
    assert.equal(await page.getAttribute("#go", "aria-disabled"), "false");
    const turn = page.locator(".turn").last();
    assert.equal(await turn.locator(".state-title").innerText(), "Search failed.");
    await turn.locator(".retry").click();
    assert.equal(await page.inputValue("#q"), "How do I deploy a contract with Foundry?", "Try again puts the question back");
  });

  test("screen readers hear one line per search; the thread and its JSON are never read out by themselves", async () => {
    const { page } = await open();
    assert.equal(await page.getAttribute("#thread", "aria-live"), null);
    assert.equal(await page.getAttribute("#announce", "aria-live"), "polite");
    const turn = await ask(page, "What is the chain ID of the Atlantic testnet?");
    assert.equal(await page.locator("#announce").textContent(), "Answer found, 1 source.");
    await turn.locator(".json-toggle").click();
    assert.equal(await page.locator("#announce").textContent(), "Answer found, 1 source.", "opening the JSON announces nothing");
    await ask(page, "How do I deploy an Anchor program to Solana?");
    assert.equal(await page.locator("#announce").textContent(), "No good answer found.");
  });

  test("history lists earlier questions, not itself; a note leaves the first screen", async () => {
    const { page } = await open();
    const turn = await ask(page, "history");
    assert.equal(await turn.locator(".turn-note").innerText(), "No questions yet.");
    assert.equal(await state(page), "note");
    assert.equal(await page.locator(".try").isHidden(), true);
    await ask(page, "pharos-docs --version");
    assert.equal(await (await ask(page, "history")).locator(".turn-note").innerText(), "history\npharos-docs --version");
  });

  test("a one-page answer keeps its own lines: no heading made from a line ending in a colon", async () => {
    const { page } = await open();
    fake.set("/getting-started/network/atlantic-testnet", { answer: "To reach the Atlantic testnet, set the chain ID:\nchainId = 424242\nThen connect." });
    const turn = await ask(page, "What is the chain ID of the Atlantic testnet?");
    assert.equal(await turn.locator(".answer-from").count(), 0);
    assert.equal(await turn.locator(".answer-text").innerText(), "To reach the Atlantic testnet, set the chain ID:\nchainId = 424242\nThen connect.");
  });

  test("the thread stays bounded at six questions", async () => {
    const { page } = await open();
    for (let i = 0; i < 9; i += 1) {
      await page.fill("#q", `pharos-docs --version`);
      await page.press("#q", "Enter");
    }
    await page.waitForFunction(() => !document.querySelector(".turn[aria-busy]"));
    assert.equal(await page.locator(".turn").count(), 6);
  });

  test("the workspace is the screen: the page never scrolls, the box never moves, the newest question comes to the top", async () => {
    for (const [width, height] of [[390, 844], [1280, 860]]) {
      const { page } = await open({ viewport: { width, height } });
      const box = async () => page.locator(".ask-box").boundingBox();
      const start = await box();
      assert.ok(start.y + start.height <= height, `${width}px: the box is on screen`);
      for (const question of ["What is the chain ID of the Atlantic testnet?", "How do I set up Foundry and deploy a contract to the Atlantic testnet?", "How do I deploy an Anchor program to Solana?", "How do I use Hardhat?"]) await ask(page, question);
      // The smooth scroll that brings the newest question up has finished.
      await page.waitForFunction(() => {
        const scroll = document.getElementById("scroll");
        return Math.abs(document.querySelector(".turn:last-child").getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16) < 2;
      }, null, { timeout: 5_000 });
      const layout = await page.evaluate(() => ({
        page: document.documentElement.scrollHeight - innerHeight,
        pageScroll: scrollY,
        thread: document.getElementById("scroll").scrollHeight > document.getElementById("scroll").clientHeight,
      }));
      assert.deepEqual(layout, { page: 0, pageScroll: 0, thread: true }, `${width}px`);
      assert.deepEqual(await box(), start, `${width}px: the box stays where it was`);
      await page.context().close();
    }
  });

  test("About: beside the thread with room, a sheet on a phone; New clears the thread", async () => {
    const wide = await open({ viewport: { width: 1280, height: 860 } });
    assert.equal(await wide.page.locator("#about").isVisible(), true);
    assert.equal(await wide.page.locator("#about-open").isVisible(), false);
    assert.equal(await wide.page.locator(".about-foot .foot-links a").count(), 3, "the lab's links, since the page has no footer");
    const { page } = await open();
    assert.equal(await page.locator("#about").isVisible(), false);
    await page.click("#about-open");
    assert.equal(await page.evaluate(() => document.getElementById("about-sheet").open && document.getElementById("about-sheet").contains(document.getElementById("about-content"))), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "about-close");
    await page.click("#about-close");
    assert.equal(await page.evaluate(() => !document.getElementById("about-sheet").open && document.getElementById("about").contains(document.getElementById("about-content"))), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "about-open", "focus goes back to About");
    assert.equal(await page.locator("#clear").isHidden(), true);
    await ask(page, "What is the chain ID of the Atlantic testnet?");
    await page.click("#clear");
    assert.equal(await page.locator(".turn").count(), 0);
    assert.equal(await state(page), "idle");
    assert.equal(await page.locator(".chip").first().isVisible(), true, "the examples are back");
    assert.equal(await page.evaluate(() => document.activeElement.id), "q");
  });

  for (const scheme of ["dark", "light"]) {
    test(`layout at every width, ${scheme}: no overflow, 44px targets, compact type`, async () => {
      for (const [width, height] of WIDTHS) {
        const { page } = await open({ viewport: { width, height }, colorScheme: scheme });
        // Chips are 36px to see; their hit area reaches 44px through ::after.
        const chip = await page.$eval(".chip", (element) => { const after = getComputedStyle(element, "::after"); return element.getBoundingClientRect().height - parseFloat(after.top) - parseFloat(after.bottom); });
        assert.ok(chip >= 44, `${width}px: chip hit area ${chip}px`);
        await ask(page, "How do I set up Foundry and deploy a contract to the Atlantic testnet?");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(overflow, 0, `${width}px overflows by ${overflow}px`);
        // A target is its box, or its ::after where a compact control widens its hit area that way.
        const small = await page.$$eval("button, input, .sources a", (elements) =>
          elements
            .filter((element) => element.getClientRects().length)
            .filter((element) => {
              const after = getComputedStyle(element, "::after");
              const height = element.getBoundingClientRect().height;
              return (after.position === "absolute" ? height - parseFloat(after.top) - parseFloat(after.bottom) : height) < 44;
            })
            .map((element) => element.id || element.className || element.tagName),
        );
        assert.deepEqual(small, [], `${width}px: targets under 44px`);
        const sizes = await page.evaluate(() => ({ h1: parseFloat(getComputedStyle(document.querySelector("h1")).fontSize), body: parseFloat(getComputedStyle(document.body).fontSize), meta: parseFloat(getComputedStyle(document.querySelector(".turn-meta")).fontSize) }));
        assert.equal(sizes.h1, 16, `${width}px: the workspace title is the bar's size`);
        assert.ok(sizes.body >= 15 && sizes.body <= 16, `body ${sizes.body}px`);
        assert.ok(sizes.meta >= 12 && sizes.meta <= 13, `meta ${sizes.meta}px`);
        const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert.equal(background, scheme === "dark" ? "rgb(11, 11, 11)" : "rgb(239, 241, 242)");
      }
    });
  }
});
