// Browser tests for the docs search page, in Chromium.
//   NODE_PATH="$(npm root -g)" node --test tests/web-browser.test.mjs
// Playwright is used where it is installed globally; without it the suite is skipped and says why.
// The real api/search.js runs against the in-process fake Developer Docs MCP (made-up values).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { createHandler } from "../api/search.js";
import { startFakeMcp } from "../dist/tests/fake-mcp.js";

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
const Q = {
  short: "What is the Atlantic chain ID?",
  many: "What is in the token registry?",
  long: "How do I run a validator node?",
  none: "How do I deploy an Anchor program to Solana?",
};

describe("the docs search page in a browser", { skip }, () => {
  let fake;
  let server;
  let browser;
  let base;
  let apiCalls = 0;
  const contexts = [];

  before(async () => {
    fake = await startFakeMcp();
    const api = createHandler({ mcpUrl: fake.url, timeoutMs: 5000 });
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
    await page.waitForFunction((n) => document.querySelectorAll(".turn").length > Math.min(n, 5) && !document.querySelector(".turn[aria-busy]"), before, { timeout: 15_000 });
    return page.locator(".turn").last();
  }
  const state = (page) => page.evaluate(() => document.body.dataset.state);
  /** Nothing wider than the screen, and nothing in the thread wider than the thread. */
  const overflow = (page) =>
    page.evaluate(() => {
      const scroll = document.getElementById("scroll");
      const edge = scroll.getBoundingClientRect().left + scroll.clientWidth;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        thread: [...document.querySelectorAll("#thread *")].filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > edge + 1).map((node) => node.className || node.tagName),
      };
    });

  test("idle: the welcome, three questions to try, the box; nothing asked yet", async () => {
    const { page, errors } = await open();
    assert.equal(await state(page), "idle");
    assert.equal(await page.locator("#thread").isHidden(), true);
    assert.deepEqual(await page.locator(".suggestion").allInnerTexts(), ["How do I deploy a contract with Foundry?", "What is the Atlantic testnet RPC endpoint?", "How do I use Chainlink on Pharos?"]);
    assert.equal(await page.getAttribute("#q", "placeholder"), "Ask the docs…");
    assert.equal(await page.locator(".cli-body").isHidden(), true);
    assert.equal(apiCalls, 0);
    assert.deepEqual(errors, []);
  });

  test("a question runs through the real search: its band, a clean answer, its sources, one quiet meta line", async () => {
    const { page, errors } = await open();
    const turn = await ask(page, `pharos-docs "${Q.short}"`);
    assert.equal(await turn.locator(".turn-q").textContent(), `You asked: ${Q.short}`);
    assert.equal(await turn.locator(".turn-tag").textContent(), "1 source");
    assert.equal(await turn.locator("h2.turn-head > button.turn-toggle").getAttribute("aria-expanded"), "true");
    assert.equal(await turn.locator(".turn-toggle").getAttribute("aria-controls"), await turn.locator(".turn-body").getAttribute("id"));
    assert.equal(await turn.locator(".answer").innerText(), "The Atlantic testnet chain ID is 424242 (test fixture).");
    const link = turn.locator(".src-list a");
    assert.equal(await link.count(), 1);
    assert.equal(await link.getAttribute("href"), "https://docs.pharos.xyz/getting-started/network/atlantic-testnet");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    assert.equal(await link.locator(".src-title").innerText(), "Atlantic Testnet");
    assert.equal(await link.locator(".src-where").innerText(), "getting-started / network");
    assert.equal(await turn.locator(".src-count").innerText(), "1 page · docs.pharos.xyz");
    assert.match(await turn.locator(".turn-run").innerText(), /^Developer Docs MCP \(askQuestion\) · \d+ requests? · \d+\.\d s$/);
    assert.equal(await state(page), "answer");
    assert.equal(await page.locator(".try").isHidden(), true, "the examples go once something is asked");
    assert.equal(apiCalls, 1);
    assert.equal(await page.inputValue("#q"), "", "the box is ready for a follow-up");
    assert.deepEqual(errors, []);
  });

  test("a long procedure: numbered steps, code exactly as written in monospace, wrapped in place, with Copy", async () => {
    const { page } = await open({ permissions: ["clipboard-read", "clipboard-write"] });
    const turn = await ask(page, Q.long);
    assert.deepEqual(await turn.locator(".answer-step-n").allInnerTexts(), ["1.", "2.", "3.", "4."]);
    assert.equal(await turn.locator("ol.answer-steps > li").count(), 4);
    const code = turn.locator(".answer-code");
    assert.equal(await code.count(), 3);
    assert.equal(await code.nth(0).locator("code").textContent(), "sudo ufw allow 18100/tcp\nsudo ufw allow 19000/tcp");
    assert.equal(await code.nth(2).locator("code").textContent(), '[network]\nseeds = ["fixture-seed-1:19000", "fixture-seed-2:19000"]');
    const look = await code.nth(1).evaluate((pre) => ({ font: getComputedStyle(pre).fontFamily, wrap: getComputedStyle(pre).whiteSpace, sideways: pre.scrollWidth - pre.clientWidth, calt: getComputedStyle(pre).fontFeatureSettings }));
    assert.match(look.font, /^"Geist Mono"/);
    assert.equal(look.wrap, "pre-wrap");
    assert.equal(look.sideways, 0, "long lines wrap; the code never scrolls sideways");
    assert.match(look.calt, /"calt" 0/, "a flag's -- keeps the space before it");
    assert.equal(await turn.getByRole("button", { name: "Copy code", exact: true }).count(), 3, "one Copy per code block, named for screen readers");
    const copy = turn.locator(".code-copy").nth(1);
    await copy.click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "tar -xzf pharos-node-fixture.tar.gz && ./pharos-node --version");
    assert.equal(await copy.getAttribute("data-copy"), "copied");
    assert.equal(await page.locator("#announce").textContent(), "Code copied");
    assert.equal(await turn.locator(".answer-cut").count(), 0, "a whole answer is not marked shortened");
  });

  test("an answer the source gate shortened says so, and points to its sources", async () => {
    const { page } = await open();
    fake.answer(`${"The fixture registry lists its test tokens in detail (test fixture). ".repeat(16)}\n\n# Sources\n\n- [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)\n`);
    const turn = await ask(page, Q.many);
    assert.match(await turn.locator(".answer p").first().innerText(), /…$/);
    assert.equal(await turn.locator(".answer-cut").innerText(), "Answer shortened. Read on in the sources below.");
  });

  test("many sources: the first three listed, the rest one tap away in place, every one a docs.pharos.xyz link", async () => {
    const { page } = await open();
    const turn = await ask(page, Q.many);
    assert.equal(await turn.locator(".turn-tag").innerText(), "5 sources");
    assert.equal(await turn.locator(".src-count").innerText(), "5 pages · docs.pharos.xyz");
    assert.equal(await turn.locator(".src-list > li").count(), 5);
    assert.equal(await turn.locator(".src-list > li:visible").count(), 3);
    const more = turn.locator(".src-more");
    assert.equal(await more.innerText(), "Show 2 more");
    assert.equal(await more.getAttribute("aria-expanded"), "false");
    assert.equal(await more.getAttribute("aria-controls"), await turn.locator(".src-list").getAttribute("id"));
    await more.click();
    assert.equal(await turn.locator(".src-list > li:visible").count(), 5);
    assert.equal(await more.innerText(), "Show fewer");
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector(".src-title")?.textContent), "LayerZero", "focus goes to the first page it showed");
    const hrefs = await turn.locator(".src-list a").evaluateAll((links) => links.map((link) => link.href));
    assert.equal(hrefs.length, 5);
    for (const href of hrefs) assert.match(href, /^https:\/\/docs\.pharos\.xyz\//);
    // The long title is whole; only where the page sits may be shortened.
    assert.equal(await turn.locator(".src-title").nth(2).innerText(), "Chainlink CCIP: Cross-Chain Interoperability Protocol for Token Transfers");
    await more.click();
    assert.equal(await turn.locator(".src-list > li:visible").count(), 3);
  });

  test("sources stay compact at every width: whole titles, no wall of rows, nothing wider than the thread", async () => {
    for (const [width, height] of WIDTHS) {
      const { page } = await open({ viewport: { width, height } });
      const turn = await ask(page, Q.many);
      const size = await turn.evaluate((node) => ({
        sources: Math.round(node.querySelector(".src").getBoundingClientRect().height),
        rows: [...node.querySelectorAll(".src-list > li:not([hidden]) .src-row")].map((row) => Math.round(row.getBoundingClientRect().height)),
        clipped: [...node.querySelectorAll(".src-title")].filter((title) => title.scrollWidth > title.clientWidth + 1).length,
      }));
      assert.equal(size.rows.length, 3, `${width}px`);
      assert.ok(size.sources <= (width < 600 ? 270 : 210), `${width}px: five sources take ${size.sources}px`);
      assert.equal(size.clipped, 0, `${width}px: titles are never cut`);
      if (width >= 768) assert.ok(size.rows[0] <= 48 && size.rows[1] <= 48, `${width}px: a short title and its section share one line: ${size.rows}`);
      assert.deepEqual(await overflow(page), { page: 0, thread: [] }, `${width}px`);
      await page.context().close();
    }
  });

  test("asking again folds earlier turns to their bands; a band opens its answer again; the outcome of each is on it", async () => {
    const { page } = await open();
    await ask(page, Q.short);
    await ask(page, Q.many);
    await ask(page, Q.none);
    const toggles = page.locator(".turn-toggle");
    assert.deepEqual(await toggles.evaluateAll((list) => list.map((toggle) => toggle.getAttribute("aria-expanded"))), ["false", "false", "true"]);
    assert.deepEqual(await page.locator(".turn-tag").allInnerTexts(), ["1 source", "5 sources", "No answer"]);
    assert.equal(await page.locator(".turn-body:visible").count(), 1);
    assert.equal(await page.locator("h2.turn-head").count(), 3, "each question is a heading");
    await toggles.first().click();
    assert.equal(await toggles.first().getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator(".turn").first().locator(".answer").innerText(), "The Atlantic testnet chain ID is 424242 (test fixture).");
    await toggles.last().click();
    assert.equal(await page.locator(".turn").last().locator(".turn-body").isHidden(), true);
  });

  test("no answer: says so plainly, with the reason and nearby pages, in English and in Indonesian", async () => {
    const { page } = await open();
    const turn = await ask(page, Q.none);
    assert.equal(await turn.locator(".turn-tag").innerText(), "No answer");
    assert.equal(await turn.locator(".state-title").innerText(), "No good answer found.");
    assert.equal(await turn.locator(".state-text").innerText(), "The Pharos Developer Docs say they do not cover this.");
    assert.equal(await turn.locator(".answer").count(), 0);
    assert.equal(await turn.locator(".src-head .label").textContent(), "Nearby in the docs");
    assert.equal(await turn.locator(".src-list a").count(), 2);
    assert.equal(await state(page), "no-answer");
    const indonesian = await ask(page, "Bagaimana cara deploy program fixture ke chain lain?");
    assert.equal(await indonesian.locator(".state-title").innerText(), "No good answer found.");
    assert.equal(await indonesian.locator(".turn-tag").innerText(), "No answer");
    assert.equal(await indonesian.locator(".answer").count(), 0);
    const answered = await ask(page, "Berapa chain ID Atlantic testnet?");
    assert.equal(await answered.locator(".answer").innerText(), "Chain ID Atlantic testnet adalah 424242 (fixture uji).");
    assert.equal(await answered.locator(".turn-tag").innerText(), "1 source");
  });

  test("JSON: --json shows the raw result; every answer has a JSON toggle, built when opened, shown at full length", async () => {
    const { page } = await open();
    const raw = await ask(page, `"${Q.short}" --json`);
    const json = JSON.parse(await raw.locator("pre.json").innerText());
    assert.deepEqual([json.schema, json.status], ["pharos-docs-result/1", "answered"]);
    assert.equal(await raw.locator(".turn-tag").innerText(), "1 source");
    const turn = await ask(page, Q.short);
    const toggle = turn.locator(".json-toggle");
    assert.equal(await turn.locator("pre.json").count(), 0);
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    const pre = turn.locator("pre.json");
    assert.equal(await pre.getAttribute("id"), await toggle.getAttribute("aria-controls"));
    assert.equal(JSON.parse(await pre.innerText()).schema, "pharos-docs-result/1");
    assert.equal(await pre.evaluate((node) => node.scrollHeight - node.clientHeight), 0, "no box that scrolls inside the thread");
    await toggle.click();
    assert.equal(await pre.isHidden(), true);
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

  test("the wait is said while the MCP works (a running count); a failure offers Try again", async () => {
    const { page } = await open();
    // askQuestion never answers, so the search ends in a timeout error.
    fake.set("hang", "tools/call");
    await page.click(".suggestion >> nth=0");
    await page.waitForFunction(() => document.body.dataset.state === "searching");
    assert.equal(await page.getAttribute("#go", "aria-disabled"), "true");
    const turn = page.locator(".turn").last();
    assert.equal(await turn.locator(".turn-tag").innerText(), "Searching");
    assert.equal(await turn.locator(".pending .status-word").innerText(), "Asking the Developer Docs MCP");
    assert.equal(await turn.locator(".pending-note").innerText(), "An answer can take 10 to 20 seconds.");
    await page.waitForFunction(() => /^[1-9]\d* s$/.test(document.querySelector(".pending .status-detail")?.textContent ?? ""), null, { timeout: 4_000 });
    await page.waitForFunction(() => document.body.dataset.state === "error", null, { timeout: 30_000 });
    assert.equal(await page.getAttribute("#go", "aria-disabled"), "false");
    assert.equal(await turn.locator(".turn-tag").innerText(), "Failed");
    assert.equal(await turn.locator(".pending").count(), 0);
    assert.equal(await turn.locator(".state-title").innerText(), "Search failed.");
    await turn.locator(".retry").click();
    assert.equal(await page.inputValue("#q"), "How do I deploy a contract with Foundry?", "Try again puts the question back");
  });

  test("New during a search: the late result is dropped and the page stays at its start", async () => {
    const { page } = await open();
    fake.set("hang", "tools/call");
    await page.fill("#q", Q.short);
    await page.press("#q", "Enter");
    await page.waitForFunction(() => document.body.dataset.state === "searching");
    await page.click("#clear");
    assert.equal(await state(page), "idle");
    // The endpoint gives up after its timeout; the page must not come back to an empty thread.
    await page.waitForFunction(() => document.getElementById("go").getAttribute("aria-disabled") === "false", null, { timeout: 30_000 });
    assert.equal(await state(page), "idle");
    assert.equal(await page.locator(".turn").count(), 0);
    assert.equal(await page.locator(".welcome").isVisible(), true);
  });

  test("screen readers hear one line per search; the thread and its JSON are never read out by themselves", async () => {
    const { page } = await open();
    assert.equal(await page.getAttribute("#thread", "aria-live"), null);
    assert.equal(await page.getAttribute("#announce", "aria-live"), "polite");
    const turn = await ask(page, Q.short);
    assert.equal(await page.locator("#announce").textContent(), "Answer found, 1 source.");
    await turn.locator(".json-toggle").click();
    assert.equal(await page.locator("#announce").textContent(), "Answer found, 1 source.", "opening the JSON announces nothing");
    await ask(page, Q.none);
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

  test("an answer keeps its own lines: no heading made from a line ending in a colon", async () => {
    const { page } = await open();
    fake.answer("To reach the Atlantic testnet, set the chain ID:\nchainId = 424242\nThen connect.\n\n# Sources\n\n- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)\n");
    const turn = await ask(page, "What is the chain ID of the Atlantic testnet?");
    assert.equal(await turn.locator(".answer").innerText(), "To reach the Atlantic testnet, set the chain ID:\nchainId = 424242\nThen connect.");
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

  test("the workspace is the screen: the page never scrolls, the box never moves, a new answer is brought up as far as the thread goes", async () => {
    for (const [width, height] of [[390, 844], [1280, 860]]) {
      const { page } = await open({ viewport: { width, height } });
      const box = async () => page.locator(".ask-box").boundingBox();
      const start = await box();
      assert.ok(start.y + start.height <= height, `${width}px: the box is on screen`);
      for (const question of [Q.short, Q.many, Q.none, Q.long]) {
        await ask(page, question);
        // The newest band is at the top of the thread, or the thread is scrolled to its end with the band in view.
        await page.waitForFunction(() => {
          const scroll = document.getElementById("scroll");
          const band = document.querySelector(".turn:last-child .turn-toggle").getBoundingClientRect();
          const view = scroll.getBoundingClientRect();
          const atTop = Math.abs(band.top - view.top - 16) < 2;
          const atEnd = Math.abs(scroll.scrollTop - (scroll.scrollHeight - scroll.clientHeight)) < 2 && band.top >= view.top;
          return atTop || atEnd;
        }, null, { timeout: 5_000 });
      }
      const layout = await page.evaluate(() => ({ page: document.documentElement.scrollHeight - innerHeight, pageScroll: scrollY }));
      assert.deepEqual(layout, { page: 0, pageScroll: 0 }, `${width}px`);
      assert.deepEqual(await box(), start, `${width}px: the box stays where it was`);
      await page.context().close();
    }
  });

  test("every control reached with Tab is on screen and visible, in every state; folded answers hold none", async () => {
    for (const [width, height] of [[360, 740], [1280, 860]]) {
      const { page } = await open({ viewport: { width, height } });
      // From the first control (the skip link), Tab through the page until focus leaves it.
      const stops = async () => {
        await page.focus("a.skip");
        const seen = [];
        for (let i = 0; i < 90; i += 1) {
          if (i > 0) await page.keyboard.press("Tab");
          const stop = await page.evaluate(() => {
            const element = document.activeElement;
            if (!element || element === document.body) return null;
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const visible = box.width >= 1 && box.height >= 1 && style.visibility === "visible" && Number(style.opacity) > 0 && box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;
            return { name: `${element.tagName.toLowerCase()}.${element.className || element.id}`, visible, folded: Boolean(element.closest(".turn-body[hidden], [hidden]")) };
          });
          if (!stop || (i > 0 && stop.name.startsWith("a.skip"))) break;
          seen.push(stop);
        }
        return seen;
      };
      const check = async (label) => {
        const seen = await stops();
        assert.ok(seen.length > 3, `${width}px ${label}: Tab reaches the page`);
        assert.deepEqual(seen.filter((stop) => !stop.visible || stop.folded).map((stop) => stop.name), [], `${width}px ${label}`);
        return seen;
      };
      await check("idle");
      await ask(page, Q.many);
      await check("answer");
      await ask(page, Q.long);
      await ask(page, Q.none);
      const seen = await check("three turns");
      assert.equal(seen.filter((stop) => stop.name.startsWith("a.src-row")).length, 2, `${width}px: only the open turn's pages are reached`);
      await page.context().close();
    }
  });

  test("About: beside the thread with room (its own region), a sheet on a phone; New clears the thread", async () => {
    const wide = await open({ viewport: { width: 1280, height: 860 } });
    assert.equal(await wide.page.locator("#about-content").isVisible(), true);
    assert.equal(await wide.page.locator("#about-open").isVisible(), false);
    assert.equal(await wide.page.locator(".about-foot .foot-links a").count(), 3, "the lab's links, since the page has no footer");
    // The panel is not inside the thread's scroll area, and lines up with the thread's column edge.
    assert.equal(await wide.page.evaluate(() => document.getElementById("scroll").contains(document.getElementById("about"))), false);
    const columns = await wide.page.evaluate(() => ({ bar: document.querySelector(".ws-title").getBoundingClientRect().left, box: document.querySelector(".ask-input").getBoundingClientRect().left, welcome: document.querySelector(".welcome").getBoundingClientRect().left }));
    assert.ok(Math.abs(columns.bar - columns.box) < 1 && Math.abs(columns.box - columns.welcome) < 1, JSON.stringify(columns));
    const { page } = await open();
    assert.equal(await page.locator("#about").isVisible(), false);
    await page.click("#about-open");
    assert.equal(await page.evaluate(() => document.getElementById("about-sheet").open && document.getElementById("about-sheet").contains(document.getElementById("about-content"))), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "about-close");
    await page.click("#about-close");
    // The dialog's close event (it fires as its own task) moves About back beside the thread.
    await page.waitForFunction(() => !document.getElementById("about-sheet").open && document.getElementById("about").contains(document.getElementById("about-content")), null, { timeout: 2_000 });
    assert.equal(await page.evaluate(() => document.activeElement.id), "about-open", "focus goes back to About");
    assert.equal(await page.locator("#clear").isHidden(), true);
    await ask(page, Q.short);
    await page.click("#clear");
    assert.equal(await page.locator(".turn").count(), 0);
    assert.equal(await state(page), "idle");
    assert.equal(await page.locator(".suggestion").first().isVisible(), true, "the examples are back");
    assert.equal(await page.evaluate(() => document.activeElement.id), "q");
  });

  test("the bar stays one line on the narrowest phone: with New shown, the tools are icons with names", async () => {
    const { page } = await open({ viewport: { width: 320, height: 568 } });
    assert.equal(await page.locator("#about-open .tool-label").isVisible(), true, "alone, About keeps its word");
    await ask(page, Q.short);
    const bar = await page.evaluate(() => ({ title: document.querySelector(".ws-title").getBoundingClientRect().height, label: getComputedStyle(document.querySelector("#clear .tool-label")).position }));
    assert.ok(bar.title < 24, `the title is one line (${bar.title}px)`);
    assert.equal(bar.label, "absolute", "the word is kept for screen readers only");
    assert.equal(await page.locator("#clear").getAttribute("aria-label"), null);
    assert.match(await page.locator("#clear").textContent(), /New search: clear these questions/);
  });

  for (const scheme of ["dark", "light"]) {
    test(`layout at every width, ${scheme}: no overflow in any state, 44px targets, compact type`, async () => {
      for (const [width, height] of WIDTHS) {
        const { page } = await open({ viewport: { width, height }, colorScheme: scheme });
        const suggestion = await page.$eval(".suggestion", (element) => element.getBoundingClientRect().height);
        assert.ok(suggestion >= 44, `${width}px: a suggestion is ${suggestion}px tall`);
        for (const question of [Q.long, Q.many, Q.none]) await ask(page, question);
        await page.locator(".turn").first().locator(".turn-toggle").click();
        assert.deepEqual(await overflow(page), { page: 0, thread: [] }, `${width}px`);
        // A target is its box, or its ::after where a compact control widens its hit area that way.
        const small = await page.$$eval("button, input, .src-list a", (elements) =>
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
        const sizes = await page.evaluate(() => ({
          h1: parseFloat(getComputedStyle(document.querySelector("h1")).fontSize),
          body: parseFloat(getComputedStyle(document.body).fontSize),
          question: parseFloat(getComputedStyle(document.querySelector(".turn-q")).fontSize),
          answer: parseFloat(getComputedStyle(document.querySelector(".answer")).fontSize),
          source: parseFloat(getComputedStyle(document.querySelector(".src-title")).fontSize),
          meta: parseFloat(getComputedStyle(document.querySelector(".turn-meta")).fontSize),
        }));
        assert.equal(sizes.h1, 15, `${width}px: the workspace title is the bar's size`);
        assert.ok(sizes.body >= 15 && sizes.body <= 16, `body ${sizes.body}px`);
        assert.equal(sizes.question, 14, `${width}px: a question reads by its weight and band, not its size`);
        assert.ok(sizes.answer >= 15 && sizes.answer <= 16, `answer ${sizes.answer}px`);
        assert.equal(sizes.source, 14);
        assert.equal(sizes.meta, 12);
        const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert.equal(background, scheme === "dark" ? "rgb(11, 11, 11)" : "rgb(239, 241, 242)");
        await page.context().close();
      }
    });
  }
});
