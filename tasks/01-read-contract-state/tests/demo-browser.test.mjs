// Browser tests for the Task 01 page: layout, themes, states, keyboard and motion, in Chromium.
//   NODE_PATH="$(npm root -g)" node --test tests/demo-browser.test.mjs
// Playwright with Chromium is used where it is installed globally; it is not a dependency of this
// project, and without it the suite is skipped and says why. Needs dist/ (built by `npm ci`).
// Nothing reaches the network: the real api/state.js, api/inspect.js and api/explain.js handlers run
// against the in-process fake Pharos Chain MCP from fake-inspector-mcp.mjs and the fake AI provider
// from fake-deepseek.mjs, and every value is made up.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { after, before, describe, test } from "node:test";
import { encodeAbiParameters } from "viem";
import { createHandler as explainHandler } from "../api/explain.js";
import { createHandler as inspectHandler } from "../api/inspect.js";
import { createHandler as stateHandler, readState } from "../api/state.js";
import { startFakeDeepSeek } from "./fake-deepseek.mjs";
import { startFakeInspectorMcp } from "./fake-inspector-mcp.mjs";

let chromium = null;
let skip = false;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
  await (await chromium.launch()).close();
} catch (error) {
  skip = chromium ? `Chromium for Playwright is not available (${error.message.split("\n")[0]})` : "Playwright is not installed (set NODE_PATH to a global install)";
}

// Test fixtures only: made up, never used as proof.
const str = (value) => encodeAbiParameters([{ type: "string" }], [value]);
const uint = (value) => encodeAbiParameters([{ type: "uint256" }], [value]);
const bool = (value) => encodeAbiParameters([{ type: "bool" }], [value]);
const SEL = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd", paused: "0x5c975abb" };
const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const PARTIAL = "0x0000000000000000000000000000000000c0ffee";
const MINED = `0x${"ab".repeat(32)}`;
const PENDING = `0x${"cd".repeat(32)}`;
const UNKNOWN = `0x${"ef".repeat(32)}`;
const SENDER = "0x5b3d0f4e9a2c7d1b8e6f0a4c2d9e7b1a3c5f8d02";
const CHAIN = {
  blockNumber: 20_384_112n,
  contracts: {
    [USDC.toLowerCase()]: { [SEL.name]: str("USDC"), [SEL.symbol]: str("USDC"), [SEL.decimals]: uint(6n), [SEL.totalSupply]: uint(20_271_995_983_588n), [SEL.paused]: bool(false) },
    [PARTIAL]: { [SEL.name]: str("Partial Token"), [SEL.symbol]: { revert: "execution reverted" }, [SEL.decimals]: "0x", [SEL.totalSupply]: uint(1_000_000n) },
  },
  transactions: {
    [MINED]: {
      tx: { hash: MINED, blockNumber: "0x1370a5e", from: SENDER, to: USDC, value: "0x0", gas: "0x1d4c0", nonce: "0x2a", input: "0xa9059cbb" },
      receipt: { transactionHash: MINED, blockNumber: "0x1370a5e", from: SENDER, to: USDC, status: "0x1", gasUsed: "0xb4d2", logs: [{}, {}], contractAddress: null },
    },
    [PENDING]: { tx: { hash: PENDING, blockNumber: null, from: SENDER, to: PARTIAL, value: "0x14d1120d7b160000", gas: "0x5208", nonce: "0x2b", input: "0x" }, receipt: null },
  },
};
const WIDTHS = [[320, 568], [360, 640], [390, 844], [412, 915], [430, 932], [1280, 860]];
const BACKGROUND = { dark: "rgb(11, 11, 11)", light: "rgb(239, 241, 242)" };
const PHAROS_BLUE = "rgb(1, 19, 183)";
const EXPLORER = "https://pharos.socialscan.io";
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };

describe("the Task 01 page in a browser", { skip }, () => {
  let fake;
  let pausedFake;
  let retryFake;
  let ai;
  let server;
  let browser;
  let base;
  const mode = { state: "fresh", inspect: "ok", explain: "ok" };
  const requests = [];
  const inspectQueries = [];
  const explainRequests = [];
  let replay = null;

  before(async () => {
    fake = await startFakeInspectorMcp(CHAIN);
    // The same chain with the contract paused, and with one transient paused() failure to retry.
    const withPaused = (behavior) => ({ ...CHAIN, contracts: { ...CHAIN.contracts, [USDC.toLowerCase()]: { ...CHAIN.contracts[USDC.toLowerCase()], [SEL.paused]: behavior } } });
    pausedFake = await startFakeInspectorMcp(withPaused(bool(true)));
    retryFake = await startFakeInspectorMcp(withPaused({ failTimes: 1, then: bool(false) }));
    const pausedState = stateHandler(pausedFake.url);
    const retryState = stateHandler(retryFake.url);
    const state = stateHandler(fake.url);
    const deadState = stateHandler("http://127.0.0.1:9/mcp");
    const inspect = inspectHandler(fake.url);
    const deadInspect = inspectHandler("http://127.0.0.1:9/mcp");
    // Explain: the real handler on the fake provider; one that is always over its limit; one whose
    // provider cannot be reached.
    ai = await startFakeDeepSeek({});
    const quiet = () => undefined;
    const explain = explainHandler({ apiKey: "sk-browser-test", providerUrl: ai.url, log: quiet });
    const limitedExplain = explainHandler({ apiKey: "sk-browser-test", providerUrl: ai.url, limits: { perClient: 0 }, log: quiet });
    const downExplain = explainHandler({ apiKey: "sk-browser-test", providerUrl: "http://127.0.0.1:9/chat/completions", log: quiet });
    server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/state") {
        if (mode.state === "slow") await new Promise((resolve) => setTimeout(resolve, 1500));
        if (mode.state === "error") return void deadState(req, res);
        if (mode.state === "paused") return void pausedState(req, res);
        if (mode.state === "retry") return void retryState(req, res);
        if (mode.state === "malformed") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        if (mode.state === "repeat") {
          // The same report twice, as an edge cache would serve it, with no cache headers at all.
          replay ??= JSON.stringify((await readState(fake.url)).body);
          return void res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(replay);
        }
        if (mode.state === "cached") {
          res.setHeader("age", "12");
          res.setHeader("x-vercel-cache", "HIT");
        }
        return void state(req, res);
      }
      if (url.pathname === "/api/inspect") {
        inspectQueries.push(url.searchParams.get("q"));
        if (mode.inspect === "slow") await new Promise((resolve) => setTimeout(resolve, 1500));
        return void (mode.inspect === "error" ? deadInspect : inspect)(req, res);
      }
      if (url.pathname === "/api/explain") {
        explainRequests.push(req.method);
        if (mode.explain === "slow") await new Promise((resolve) => setTimeout(resolve, 1200));
        if (mode.explain === "unreachable") return void req.socket.destroy();
        return void (mode.explain === "limited" ? limitedExplain : mode.explain === "down" ? downExplain : explain)(req, res);
      }
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      if (path.includes("..")) return void res.writeHead(404).end();
      try {
        res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(await readFile(new URL(`../public${path}`, import.meta.url)));
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
    server?.closeAllConnections();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await fake?.close();
    await pausedFake?.close();
    await retryFake?.close();
    await ai?.close();
  });

  /** A fresh page; resolves once the snapshot has settled (or failed). */
  async function open({ width = 390, height = 844, theme = "dark", motion = "no-preference", storage } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: motion, isMobile: width < 760, hasTouch: width < 760 });
    if (storage) await context.addInitScript((value) => localStorage.setItem("agent-arena-lab:theme", value), storage);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && !/status of 502/.test(message.text()) && errors.push(message.text()));
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(base);
    await settled(page);
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  }
  const settled = (page, states = ["fresh", "cached", "error"]) => page.waitForFunction((list) => list.includes(document.body.dataset.state), states, { timeout: 15_000 });
  /** Wait until no animation is running (the settle on a new value moves it by a few pixels). */
  const still = (page) => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  const snapshot = (page) =>
    page.evaluate(() => ({
      state: document.body.dataset.state,
      tone: document.getElementById("status").dataset.tone,
      word: document.querySelector("[data-status-word]").textContent,
      detail: document.querySelector("[data-status-detail]").textContent,
      block: document.getElementById("block").textContent,
      readAt: document.getElementById("read-at").textContent,
      supply: document.getElementById("supply").textContent,
      note: document.getElementById("status-note").hidden ? "" : document.getElementById("status-note").textContent,
      opacity: getComputedStyle(document.getElementById("supply")).opacity,
      busy: document.getElementById("snapshot").getAttribute("aria-busy"),
    }));
  async function inspect(page, value, expected) {
    await page.fill("#inspect-input", value);
    await page.click("#inspect-submit");
    await page.waitForFunction((state) => document.getElementById("inspector").dataset.inspectState === state, expected, { timeout: 15_000 });
  }
  const rows = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#inspect-result dl > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent])));
  /** Inspect again, even when the result before had the same state: wait for this request's answer. */
  async function inspectAgain(page, value) {
    const sent = inspectQueries.length;
    await page.fill("#inspect-input", value);
    await page.click("#inspect-submit");
    for (let wait = 0; inspectQueries.length === sent; wait += 1) {
      assert.ok(wait < 500, "the inspection was never sent");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await page.waitForFunction(() => document.getElementById("inspector").dataset.inspectState !== "inspecting", null, { timeout: 15_000 });
  }
  /** Click "Explain this result" and wait for the explanation or a failure note. */
  async function explainResult(page) {
    await page.click("#explain-submit");
    await page.waitForFunction(() => document.getElementById("explain-submit").getAttribute("aria-disabled") === "false" && (!document.getElementById("explain-body").hidden || !document.getElementById("explain-note").hidden), null, { timeout: 15_000 });
  }
  const explainView = (page) =>
    page.evaluate(() => ({
      shown: !document.getElementById("explain").hidden,
      busy: document.getElementById("explain-submit").getAttribute("aria-disabled"),
      body: !document.getElementById("explain-body").hidden,
      note: document.getElementById("explain-note").hidden ? "" : document.getElementById("explain-note").textContent,
    }));
  const pageFailures = (errors) => errors.filter((error) => !/Failed to load resource/.test(error));
  /** The words a control shows (innerText skips the words swapped out), and its box. */
  const words = (page, selector) => page.evaluate((s) => document.querySelector(s).innerText.trim(), selector);
  const box = (page, selector) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(" "); }, selector);
  /** Every hex value on screen: its text, and its characters per line ([22, 20], [34, 32], ...). */
  const hexLines = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll(".hex")].filter((hex) => hex.offsetParent).map((hex) => {
        const lines = new Map();
        for (const part of hex.querySelectorAll(":scope > span")) {
          const top = Math.round(part.getBoundingClientRect().top);
          lines.set(top, (lines.get(top) ?? 0) + part.textContent.length);
        }
        return { text: hex.textContent, lines: [...lines.values()] };
      }),
    );
  /** The only ways a value may sit: one line, or equal halves (address) or quarters (hash). */
  const BALANCED = { 42: ["42", "22/20"], 66: ["66", "34/32", "18/16/16/16"] };
  /** Overflow that a clipped body would hide: any box past the viewport's right edge. */
  const overflow = (page) =>
    page.evaluate(() => {
      let widest = 0;
      for (const element of document.querySelectorAll("body *")) {
        const box = element.getBoundingClientRect();
        if (box.width && !element.closest(".sr, [hidden]")) widest = Math.max(widest, box.right);
      }
      return { scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, box: Math.round((widest - innerWidth) * 10) / 10 };
    });

  test("every width, both themes: no horizontal overflow, one-line supply, balanced hex lines, no errors", async () => {
    for (const theme of ["dark", "light"]) {
      for (const [width, height] of WIDTHS) {
        const { context, page, errors } = await open({ width, height, theme });
        const where = `${theme} ${width}`;
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), BACKGROUND[theme], where);
        await inspect(page, MINED, "success");
        const room = await overflow(page);
        assert.ok(room.scroll <= 0 && room.box <= 0.5, `${where}: ${JSON.stringify(room)}`);
        const figure = await page.evaluate(() => {
          const supply = document.getElementById("supply");
          const amount = document.getElementById("supply-amount").getBoundingClientRect();
          const unit = document.getElementById("supply-unit").getBoundingClientRect();
          return {
            fits: supply.scrollWidth <= supply.clientWidth,
            oneLine: document.getElementById("supply-amount").getClientRects().length === 1 && Math.abs(unit.bottom - amount.bottom) < amount.height * 0.25,
            px: parseFloat(getComputedStyle(supply).fontSize),
            h1: parseFloat(getComputedStyle(document.getElementById("subject")).fontSize),
            text: supply.textContent,
          };
        });
        assert.equal(figure.text, "20,271,995.983588USDC", where);
        assert.ok(figure.fits && figure.oneLine, `${where}: ${JSON.stringify(figure)}`);
        assert.ok(figure.px > figure.h1, `${where}: the supply (${figure.px}px) is the largest type, above the title (${figure.h1}px)`);
        for (const { text, lines } of await hexLines(page)) {
          assert.doesNotMatch(text, /\s/, `${where}: no spaces in ${text}`);
          assert.ok(BALANCED[text.length]?.includes(lines.join("/")), `${where}: ${text} sits as ${lines.join("/")}`);
        }
        assert.deepEqual(errors, [], where);
        await context.close();
      }
    }
  });

  test("the first screen holds the task, contract, tool, snapshot state, block, read time, supply and state rows", async () => {
    for (const [width, height, extra] of [[320, 568, []], [390, 844, ["#v-paused", "#address", "[data-refresh]", "#copy", "#contract-explorer"]], [1280, 860, ["#v-paused", "#address", "[data-refresh]", "#copy", "#contract-explorer"]]]) {
      for (const theme of ["dark", "light"]) {
        const { context, page } = await open({ width, height, theme });
        const below = await page.evaluate((selectors) => selectors.filter((selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return box.bottom > innerHeight || box.top < 0 || box.height === 0;
        }), [".task-head .label", "#subject", ".task-via strong", "#status", "#block", "#read-at", "#supply", "#v-name", "#v-symbol", "#v-decimals", "#network", "#snapshot .rows [data-chain]", ...extra]);
        assert.deepEqual(below, [], `${theme} ${width}x${height}`);
        await context.close();
      }
    }
  });

  test("values a reader needs are in Geist; captions in Departure Mono; technical strings in Geist Mono", async () => {
    const { context, page } = await open({ width: 390 });
    const faces = await page.evaluate(() => {
      const face = (selector) => getComputedStyle(document.querySelector(selector)).fontFamily.split(",")[0].replaceAll('"', "").trim();
      return {
        values: ["#supply", "#block", "#read-at", "#v-decimals", "#network", "#snapshot .rows [data-chain]", "#subject", "[data-status-word]"].map(face),
        captions: [".task-head .label", "#snapshot-h", ".figure-label", ".contract .label"].map(face),
        technical: ["#address", "#inspect-input", ".kv dd:not(.kv-text)"].map(face),
      };
    });
    assert.deepEqual([...new Set(faces.values)], ["Geist"]);
    assert.deepEqual([...new Set(faces.captions)], ["Departure Mono"]);
    assert.deepEqual([...new Set(faces.technical)], ["Geist Mono"]);
    await context.close();
  });

  test("theme: follows the system, the toggle switches without moving anything, and the choice persists", async () => {
    const { context, page } = await open({ width: 1280, height: 860, theme: "light" });
    const look = async () => {
      await still(page);
      return page.evaluate(() => ({
        theme: document.documentElement.dataset.theme ?? null,
        saved: localStorage.getItem("agent-arena-lab:theme"),
        background: getComputedStyle(document.body).backgroundColor,
        label: document.getElementById("theme-toggle").getAttribute("aria-label"),
        word: [...document.querySelectorAll(".theme-words > span")].find((word) => getComputedStyle(word).visibility === "visible").textContent,
        metas: [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.content),
        boxes: ["#theme-toggle", ".topbar-count", "#subject", "#supply", "#snapshot", "#inspector", "#proof"].map((selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return [selector, Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)].join(" ");
        }),
      }));
    };
    const system = await look();
    assert.deepEqual([system.theme, system.saved, system.background, system.label, system.word], [null, null, BACKGROUND.light, "Switch to dark theme", "Dark"]);

    // Keyboard: Tab from the skip link reaches the toggle; Enter switches.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "theme-toggle");
    await page.keyboard.press("Enter");
    const dark = await look();
    assert.deepEqual([dark.theme, dark.saved, dark.background, dark.label, dark.word], ["dark", "dark", BACKGROUND.dark, "Switch to light theme", "Light"]);
    assert.deepEqual(dark.metas, ["#0B0B0B", "#0B0B0B"]);
    assert.deepEqual(dark.boxes, system.boxes, "switching theme moves nothing");

    await page.reload();
    await settled(page);
    assert.equal((await look()).background, BACKGROUND.dark, "the choice survives a reload");

    // Back to the system's own theme: the saved choice is forgotten.
    await page.click("#theme-toggle");
    const back = await look();
    assert.deepEqual([back.theme, back.saved, back.background], [null, null, BACKGROUND.light]);
    await context.close();

    // A saved choice applies before the first paint: it is on <html> before the page script runs.
    const saved = await open({ width: 390, theme: "light", storage: "dark" });
    assert.equal(await saved.page.evaluate(() => getComputedStyle(document.body).backgroundColor), BACKGROUND.dark);
    await saved.context.close();
  });

  test("Pharos Blue: the primary action and the brand marks in both themes; readable blue for focus and text", async () => {
    const expected = {
      dark: {
        focus: "rgb(79, 132, 255)",
        edge: "rgb(79, 132, 255)",
        hover: ["rgb(9, 55, 210)", "rgb(79, 132, 255)"],
        inactive: ["rgb(28, 28, 28)", "rgb(52, 52, 52)", "rgb(134, 136, 137)"],
        tones: { success: "rgb(61, 214, 140)", warning: "rgb(242, 179, 61)", error: "rgb(255, 107, 107)" },
      },
      light: {
        focus: PHAROS_BLUE,
        edge: PHAROS_BLUE,
        hover: ["rgb(1, 1, 146)", "rgb(1, 1, 146)"],
        inactive: ["rgb(246, 247, 248)", "rgb(196, 199, 201)", "rgb(95, 96, 96)"],
        tones: { success: "rgb(14, 122, 71)", warning: "rgb(154, 91, 0)", error: "rgb(196, 43, 43)" },
      },
    };
    for (const theme of ["dark", "light"]) {
      const { context, page } = await open({ width: 390, theme });
      const brand = await page.evaluate(() => ({
        inspect: getComputedStyle(document.getElementById("inspect-submit")).backgroundColor,
        inspectText: getComputedStyle(document.getElementById("inspect-submit")).color,
        mark: getComputedStyle(document.querySelector(".brand-mark")).backgroundColor,
        beacon: getComputedStyle(document.querySelector("#snapshot .beacon"), "::after").backgroundColor,
        taskNumber: getComputedStyle(document.querySelector(".task-n")).color,
      }));
      assert.deepEqual(brand, { inspect: PHAROS_BLUE, inspectText: "rgb(255, 255, 255)", mark: PHAROS_BLUE, beacon: PHAROS_BLUE, taskNumber: expected[theme].focus }, theme);
      // Focus rings: keyboard focus on the input, the Inspect button and the theme toggle.
      for (const selector of ["#inspect-input", "#inspect-submit", "#theme-toggle"]) {
        await page.focus(selector);
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const ring = await page.evaluate(() => ({ style: getComputedStyle(document.activeElement).outlineStyle, color: getComputedStyle(document.activeElement).outlineColor, width: getComputedStyle(document.activeElement).outlineWidth }));
        assert.deepEqual(ring, { style: "solid", color: expected[theme].focus, width: "2px" }, `${theme} ${selector}`);
      }
      // The Inspect button: Pharos Blue fill; its edge reads at 3:1+ on the dark panel; hover keeps it.
      const button = () => page.evaluate(() => { const style = getComputedStyle(document.getElementById("inspect-submit")); return [style.backgroundColor, style.borderTopColor, style.color]; });
      assert.deepEqual(await button(), [PHAROS_BLUE, expected[theme].edge, "rgb(255, 255, 255)"], `${theme} at rest`);
      await page.hover("#inspect-submit");
      await page.waitForTimeout(250);
      assert.deepEqual(await button(), [...expected[theme].hover, "rgb(255, 255, 255)"], `${theme} on hover`);
      // While inspecting, the button is inactive (aria-disabled) and looks it.
      mode.inspect = "slow";
      await page.fill("#inspect-input", USDC);
      await page.click("#inspect-submit");
      await page.waitForFunction(() => document.getElementById("inspector").dataset.inspectState === "inspecting");
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
      assert.deepEqual(await button(), expected[theme].inactive, `${theme} while inspecting`);
      await page.waitForFunction(() => document.getElementById("inspector").dataset.inspectState === "success", null, { timeout: 15_000 });
      mode.inspect = "ok";
      // Inspector tones: success, partial (warning) and error dots in the semantic colours.
      const tones = {};
      await inspect(page, USDC, "success");
      tones.success = await page.evaluate(() => getComputedStyle(document.querySelector("#inspect-status .status-dot")).backgroundColor);
      await inspect(page, PARTIAL, "partial");
      tones.warning = await page.evaluate(() => getComputedStyle(document.querySelector("#inspect-status .status-dot")).backgroundColor);
      mode.inspect = "error";
      await inspect(page, MINED, "error");
      tones.error = await page.evaluate(() => [getComputedStyle(document.querySelector("#inspect-status .status-dot")).backgroundColor, getComputedStyle(document.getElementById("inspect-note")).borderLeftColor]);
      mode.inspect = "ok";
      assert.deepEqual(tones, { success: expected[theme].tones.success, warning: expected[theme].tones.warning, error: [expected[theme].tones.error, expected[theme].tones.error] }, theme);
      await context.close();
    }
  });

  test("snapshot states: fresh, cached by the edge, cached as the same read, reading, read failed; never LIVE", async () => {
    mode.state = "fresh";
    const { context, page, errors } = await open({ width: 390 });
    const fresh = await snapshot(page);
    assert.deepEqual([fresh.state, fresh.tone, fresh.word, fresh.detail, fresh.block, fresh.busy], ["fresh", "success", "Fresh snapshot", "", "20,384,112", "false"]);
    assert.match(fresh.readAt, /^\d\d:\d\d:\d\d$/);
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /\blive\b/i);

    mode.state = "cached";
    await page.click("[data-refresh]");
    await page.waitForFunction(() => document.body.dataset.state === "cached");
    const cached = await snapshot(page);
    assert.deepEqual([cached.tone, cached.word, cached.detail], ["neutral", "Cached snapshot", "12 s old"]);

    mode.state = "repeat";
    await page.click("[data-refresh]");
    await settled(page);
    await page.click("[data-refresh]");
    await page.waitForFunction(() => document.querySelector("[data-status-detail]").textContent === "same read as before");
    assert.equal((await snapshot(page)).word, "Cached snapshot");

    // READING: the last snapshot stays, dimmed; Refresh waits, keeps focus and reads Reading… in
    // place, at the same size.
    mode.state = "slow";
    const rest = [await words(page, "[data-refresh]"), await box(page, "[data-refresh]")];
    assert.equal(rest[0], "Refresh");
    await page.focus("[data-refresh]");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.body.dataset.state === "reading");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const reading = await snapshot(page);
    assert.deepEqual([reading.tone, reading.word, reading.detail, reading.busy, reading.supply, reading.opacity], ["active", "Reading", "taking a new snapshot", "true", fresh.supply, "0.55"]);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.matches("[data-refresh]"), document.querySelector("[data-refresh]").getAttribute("aria-disabled")]), [true, "true"]);
    assert.deepEqual([await words(page, "[data-refresh]"), await box(page, "[data-refresh]")], ["Reading…", rest[1]]);
    await settled(page, ["fresh"]);
    assert.deepEqual([await words(page, "[data-refresh]"), await box(page, "[data-refresh]")], rest);

    // READ FAILED: the last good snapshot stays, with the reason.
    mode.state = "error";
    await page.click("[data-refresh]");
    await settled(page, ["error"]);
    await page.waitForTimeout(300);
    const failed = await snapshot(page);
    assert.deepEqual([failed.tone, failed.word, failed.detail, failed.supply, failed.opacity], ["error", "Read failed", "showing the last good snapshot", fresh.supply, "0.75"]);
    // What happened, then what to do next.
    assert.match(failed.note, /^Could not reach[\s\S]* Refresh to try again\.$/);

    mode.state = "malformed";
    await page.click("[data-refresh]");
    await page.waitForFunction(() => /could not read/.test(document.getElementById("status-note").textContent));
    assert.equal((await snapshot(page)).supply, fresh.supply);

    mode.state = "fresh";
    await page.click("[data-refresh]");
    await settled(page, ["fresh"]);
    assert.equal((await snapshot(page)).note, "");
    assert.deepEqual(errors, []);
    await context.close();

    // A first read that fails leaves the page whole and says so.
    mode.state = "error";
    const first = await open({ width: 360, height: 640 });
    const none = await snapshot(first.page);
    assert.deepEqual([none.word, none.detail, none.block], ["Read failed", "no snapshot yet", "—"]);
    assert.match(none.note, /Could not reach/);
    await first.context.close();
    mode.state = "fresh";
  });

  test("the Task 01 proof is intact: the same read the API reports, five reads at one block, seven tool calls", async () => {
    const { context, page } = await open({ width: 1280, height: 860 });
    const api = await page.evaluate(async () => (await fetch("/api/state", { cache: "no-store" })).json());
    const shown = await page.evaluate(() => {
      const text = (selector) => document.querySelector(selector).textContent;
      return {
        supply: text("#supply-amount") + " " + text("#supply-unit"),
        values: [text("#v-name"), text("#v-symbol"), text("#v-decimals"), text("#network"), text("#snapshot .rows [data-chain]"), text("#v-paused")],
        counts: [...document.querySelectorAll(".counts .count-n")].map((count) => count.textContent),
        reads: [text("#proof-reads-list"), text("#proof-calls-sub"), text("#step-reads"), text("#step-reads-list")],
        selectors: [...document.querySelectorAll(".kv dt")].find((dt) => dt.textContent === "Selectors").nextElementSibling.textContent,
        calls: text("#t-calls"),
        block: text("#t-block"),
        raw: text("#v-raw"),
        address: text("#address"),
        transcript: document.querySelector('a[href$="proof/mcp-transcript.json"]').href,
      };
    });
    assert.equal(shown.supply, api.display.totalSupply);
    assert.deepEqual(shown.values, [api.values.name, api.values.symbol, String(api.values.decimals), "Pharos Mainnet", "1672", "No"]);
    assert.equal(api.values.paused, false);
    // Every count comes from the report's call model: 2 context calls + 5 contract reads = 7.
    assert.deepEqual([api.source.contextCalls, api.source.contractReads, api.source.toolCalls], [["get_chain_info", "get_block_number"], ["name", "symbol", "decimals", "totalSupply", "paused"], 7]);
    assert.deepEqual(shown.counts, ["5", "1", "7", "0"]);
    assert.deepEqual(shown.reads, ["name · symbol · decimals · totalSupply · paused", "2 context + 5 contract reads", "eth_call ×5", "name, symbol, decimals, totalSupply, paused"]);
    assert.match(shown.selectors, / · paused\(\) 0x5c975abb$/);
    assert.equal(shown.calls, "7: get_chain_info, get_block_number, eth_call ×5");
    assert.equal(shown.block, `${api.blockNumber}, sent as 0x${BigInt(api.blockNumber).toString(16)} in every eth_call`);
    assert.equal(shown.raw, api.values.totalSupply.raw);
    assert.equal(shown.address, USDC);
    assert.equal(shown.transcript, "https://github.com/Rzbyte/pharos-season-of-ai/blob/main/tasks/01-read-contract-state/proof/mcp-transcript.json");
    await context.close();
  });

  test("paused: No takes the text colour, Yes the warning tone in words; a same-block retry is counted on top of the model", async () => {
    const tone = (page) => page.evaluate(() => {
      const cell = document.getElementById("v-paused");
      const style = getComputedStyle(cell);
      return { text: cell.textContent, tone: cell.dataset.tone ?? null, color: style.color, weight: style.fontWeight, key: cell.previousElementSibling.textContent };
    });
    for (const theme of ["dark", "light"]) {
      const { context, page, errors } = await open({ width: 390, theme });
      const text = await page.evaluate(() => getComputedStyle(document.getElementById("v-name")).color);
      assert.deepEqual(await tone(page), { text: "No", tone: null, color: text, weight: "400", key: "paused" }, `${theme} not paused`);

      mode.state = "paused";
      await page.click("[data-refresh]");
      await page.waitForFunction(() => document.getElementById("v-paused").textContent === "Yes", null, { timeout: 15_000 });
      await settled(page, ["fresh"]);
      const warning = theme === "dark" ? "rgb(242, 179, 61)" : "rgb(154, 91, 0)";
      assert.deepEqual(await tone(page), { text: "Yes", tone: "warning", color: warning, weight: "600", key: "paused" }, `${theme} paused`);
      // A read fact, not a status: the snapshot itself is still a fresh read, and nothing says "safe".
      assert.equal(await page.evaluate(() => document.querySelector("[data-status-word]").textContent), "Fresh snapshot");
      assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /\bsafe\b/i);

      mode.state = "fresh";
      await page.click("[data-refresh]");
      await page.waitForFunction(() => document.getElementById("v-paused").textContent === "No", null, { timeout: 15_000 });
      assert.equal((await tone(page)).tone, null, `${theme} back to not paused`);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // One transient paused() failure, retried at the same block: 2 + 5 + 1 = 8 tool calls, said as a retry.
    mode.state = "retry";
    const { context, page } = await open({ width: 1280, height: 860 });
    const counts = await page.evaluate(() => [document.getElementById("proof-calls").textContent, document.getElementById("proof-calls-sub").textContent, document.getElementById("t-calls").textContent, document.getElementById("t-retries").textContent]);
    assert.deepEqual(counts, ["8", "includes 1 same-block retry", "8: get_chain_info, get_block_number, eth_call ×6", "paused() retried once at the same block"]);
    assert.equal(await page.evaluate(() => document.getElementById("v-paused").textContent), "No");
    mode.state = "fresh";
    await context.close();
  });

  test("explain: one button, only for a result, full width and within reach on a phone, unlike the utility actions", async () => {
    const { context, page, errors } = await open({ width: 390 });
    const sent = explainRequests.length;
    const count = () => page.evaluate(() => [...document.querySelectorAll("button")].filter((button) => /Explain this result/.test(button.textContent)).length);
    assert.deepEqual([(await explainView(page)).shown, await count()], [false, 1], "one button in the page, hidden before any result");
    await inspect(page, USDC, "success");
    assert.equal((await explainView(page)).shown, true);
    assert.equal(await count(), 1, "one action for the whole result, not one per field");
    const geometry = await page.evaluate(() => {
      const button = document.getElementById("explain-submit");
      const box = button.getBoundingClientRect();
      const panel = document.getElementById("inspect-panel");
      const style = getComputedStyle(panel);
      const copy = document.querySelector("#inspect-result .action").getBoundingClientRect();
      return {
        width: Math.round(box.width),
        content: Math.round(panel.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        height: box.height,
        inView: box.left >= 0 && box.right <= innerWidth,
        afterResult: box.top >= document.getElementById("inspect-result").getBoundingClientRect().bottom,
        utility: button.classList.contains("action"),
        taller: box.height > copy.height,
      };
    });
    assert.deepEqual(geometry, { width: geometry.content, content: geometry.content, height: geometry.height, inView: true, afterResult: true, utility: false, taller: true });
    assert.ok(geometry.height >= 44, `${geometry.height}px`);
    // A partial result can be explained; "not found" cannot.
    await inspect(page, PARTIAL, "partial");
    assert.equal((await explainView(page)).shown, true);
    await inspect(page, UNKNOWN, "not-found");
    assert.equal((await explainView(page)).shown, false);
    assert.equal(explainRequests.length, sent, "showing the button asks for nothing");
    assert.deepEqual(errors, []);
    await context.close();

    // An inspection that fails before any result shows no button either.
    mode.inspect = "error";
    const failed = await open({ width: 390 });
    await inspect(failed.page, USDC, "error");
    assert.equal((await explainView(failed.page)).shown, false);
    mode.inspect = "ok";
    await failed.context.close();
  });

  test("explain: Explaining… while it waits, then the explanation under the button, asked once", async () => {
    mode.explain = "slow";
    const { context, page, errors } = await open({ width: 390 });
    await inspect(page, MINED, "success");
    const sent = explainRequests.length;
    await page.click("#explain-submit");
    await page.waitForFunction(() => document.getElementById("explain-submit").getAttribute("aria-disabled") === "true");
    assert.equal(await words(page, "#explain-submit"), "Explaining…");
    assert.equal(await page.getAttribute("#explain", "aria-busy"), "true");
    const idle = await box(page, "#explain-submit");
    await page.click("#explain-submit"); // a click while it waits does nothing
    await page.waitForFunction(() => !document.getElementById("explain-body").hidden, null, { timeout: 15_000 });
    mode.explain = "ok";
    assert.equal(explainRequests.length - sent, 1, "two clicks, one request");
    const shown = await page.evaluate(() => {
      const button = document.getElementById("explain-submit").getBoundingClientRect();
      return {
        label: document.getElementById("explain-submit").innerText.trim(),
        busy: document.getElementById("explain-submit").getAttribute("aria-disabled"),
        title: document.querySelector("#explain-body h3").textContent,
        headings: [...document.querySelectorAll("#explain-text h4")].map((heading) => heading.textContent),
        items: [...document.querySelectorAll("#explain-text li")].map((item) => item.textContent),
        meta: document.getElementById("explain-meta").textContent,
        live: document.getElementById("explain-state").textContent,
        below: document.getElementById("explain-body").getBoundingClientRect().top >= button.bottom,
        result: document.querySelectorAll("#inspect-result dl > div").length,
      };
    });
    assert.deepEqual(shown, {
      label: "Explain this result",
      busy: "false",
      title: "Plain-language explanation",
      headings: ["What this shows", "What it means", "Key details", "Anything to note"],
      items: ["Name and symbol: USDC", "Decimals: 6, so one token is 1,000,000 of its smallest units"],
      meta: shown.meta,
      live: "Explanation ready, below the button.",
      below: true,
      result: shown.result,
    });
    assert.match(shown.meta, /^Written by an AI model from the result above\. The result above is the source of truth\./);
    assert.ok(shown.result >= 8, "the inspection result is still there");
    assert.equal((await box(page, "#explain-submit")).split(" ").slice(2).join(" "), idle.split(" ").slice(2).join(" "), "the button keeps its size while it waits");
    // Explained already: a click shows it again without asking again.
    await page.click("#explain-submit");
    await page.waitForTimeout(250);
    assert.equal(explainRequests.length - sent, 1);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("explain: the same result again comes from the cache and shows the same", async () => {
    const asked = ai.requests.length;
    const seen = [];
    for (let visit = 0; visit < 2; visit += 1) {
      const { context, page } = await open({ width: 1280, height: 860 });
      await inspect(page, USDC, "success");
      await explainResult(page);
      seen.push(await page.evaluate(() => ({ text: document.getElementById("explain-text").textContent, meta: document.getElementById("explain-meta").textContent })));
      await context.close();
    }
    assert.ok(ai.requests.length - asked <= 1, "one provider call at most for the same result");
    assert.equal(seen[1].text, seen[0].text);
    assert.match(seen[1].meta, /Reused from an earlier explanation of this same result\.$/);
  });

  test("explain: a limit, a provider failure or no answer leaves the inspection result as it was", async () => {
    const { context, page, errors } = await open({ width: 390 });
    await inspect(page, USDC, "success");
    const result = await page.textContent("#inspect-result");
    for (const [name, message] of [
      ["limited", "Explanation limit reached. Try again later. The inspection result above is unchanged."],
      ["down", "The explanation is not available right now. Try again later. The inspection result above is unchanged."],
      ["unreachable", "The explanation service could not be reached. The inspection result above is unchanged."],
    ]) {
      mode.explain = name;
      await explainResult(page);
      assert.deepEqual(await explainView(page), { shown: true, busy: "false", body: false, note: message }, name);
      assert.equal(await page.evaluate(() => document.getElementById("inspector").dataset.inspectState), "success", name);
      assert.equal(await page.textContent("#inspect-result"), result, `${name}: the result is untouched`);
    }
    mode.explain = "ok";
    // The Inspector still works, and the button is ready for the new result.
    await inspectAgain(page, MINED);
    assert.equal(await page.evaluate(() => document.getElementById("inspector").dataset.inspectState), "success");
    assert.deepEqual(await explainView(page), { shown: true, busy: "false", body: false, note: "" });
    assert.deepEqual(pageFailures(errors), []);
    await context.close();
  });

  test("explain: inspecting again and again never asks for an explanation", async () => {
    const { context, page } = await open({ width: 1280, height: 860 });
    const [sent, asked, seen] = [explainRequests.length, ai.requests.length, requests.length];
    for (const value of [USDC, USDC, MINED, PARTIAL, USDC, MINED]) await inspectAgain(page, value);
    assert.equal(explainRequests.length, sent);
    assert.equal(ai.requests.length, asked);
    assert.deepEqual(requests.slice(seen).filter((url) => url.includes("/api/explain")), []);
    await context.close();
  });

  test("explain: a new result replaces the explanation, and a late answer for the old result is dropped", async () => {
    mode.explain = "slow";
    const { context, page, errors } = await open({ width: 390 });
    await inspect(page, USDC, "success");
    await page.click("#explain-submit");
    await inspectAgain(page, MINED); // a new result while the old one is still being explained
    await page.waitForTimeout(1600); // the old answer arrives
    mode.explain = "ok";
    assert.deepEqual(await explainView(page), { shown: true, busy: "false", body: false, note: "" });
    assert.equal(await page.textContent("#explain-text"), "");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("proof & technical details: collapsed, opened by keyboard or by the link to it, closed again", async () => {
    const { context, page } = await open({ width: 390 });
    const isOpen = () => page.evaluate(() => document.getElementById("proof").open);
    const shown = () => page.evaluate(() => document.querySelector("#proof .counts").checkVisibility());
    assert.deepEqual([await isOpen(), await shown()], [false, false]);
    await page.focus("#proof > summary");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(450);
    assert.deepEqual([await isOpen(), await shown()], [true, true]);
    await page.keyboard.press("Space");
    await page.waitForTimeout(450);
    assert.equal(await isOpen(), false);
    await page.click('.jump a[href="#proof"]');
    await page.waitForTimeout(450);
    assert.deepEqual([await isOpen(), await shown()], [true, true]);
    await context.close();
  });

  test("inspector: contract, partial, transaction, not found, and an error that keeps the last result", async () => {
    const { context, page, errors } = await open({ width: 390 });
    await inspect(page, USDC, "success");
    const contract = await rows(page);
    assert.equal(contract.totalSupply, "20,271,995.983588 USDC");
    assert.ok(contract.Address.startsWith(USDC));
    assert.equal(await page.evaluate(() => document.getElementById("inspect-status").dataset.tone), "success");

    await inspect(page, PARTIAL, "partial");
    const partial = await rows(page);
    assert.deepEqual([partial.name, partial.symbol, partial.decimals], ["Partial Token", "Unavailablereverted", "Unavailableno data returned"]);
    assert.equal(await page.evaluate(() => document.getElementById("inspect-status").dataset.tone), "warning");

    await inspect(page, MINED, "success");
    const tx = await rows(page);
    assert.deepEqual(Object.keys(tx), ["Hash", "Status", "Block", "From", "To", "Value", "Gas limit", "Gas used", "Logs", "Network"]);
    assert.deepEqual([tx.Status, tx["Gas used"], tx.Logs], ["Success", "46,290", "2"]);

    await inspect(page, UNKNOWN, "not-found");
    assert.equal((await rows(page)).Result, "Not found through Pharos Chain MCP");
    assert.equal(await page.evaluate(() => document.getElementById("inspect-status").dataset.tone), "neutral");
    // Not found is an answer with a next step, not a dead end.
    assert.match(await page.textContent("#inspect-result .inspect-message"), /^Check that the hash is complete and from Pharos Mainnet, not a testnet\./);

    await inspect(page, PENDING, "partial");
    assert.equal((await rows(page)).Status, "Pending");

    // INSPECTING keeps the last result, dimmed; the button keeps focus, sends nothing twice and
    // reads Inspecting… in place, at the same size.
    mode.inspect = "slow";
    const before = inspectQueries.length;
    const previous = await page.textContent("#inspect-result");
    const idle = [await words(page, "#inspect-submit"), await box(page, "#inspect-submit")];
    assert.equal(idle[0], "Inspect");
    await page.fill("#inspect-input", USDC);
    await page.focus("#inspect-submit");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("inspector").dataset.inspectState === "inspecting");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const busy = await page.evaluate(() => ({
      result: document.getElementById("inspect-result").textContent,
      opacity: getComputedStyle(document.getElementById("inspect-result")).opacity,
      focus: document.activeElement.id,
      disabled: document.getElementById("inspect-submit").getAttribute("aria-disabled"),
    }));
    assert.deepEqual(busy, { result: previous, opacity: "0.55", focus: "inspect-submit", disabled: "true" });
    assert.deepEqual([await words(page, "#inspect-submit"), await box(page, "#inspect-submit")], ["Inspecting…", idle[1]]);
    // force: Playwright itself would wait for an aria-disabled button; a visitor's click does not.
    await page.click("#inspect-example", { force: true });
    assert.equal(await page.inputValue("#inspect-input"), USDC, "the example waits too");
    await page.waitForFunction(() => document.getElementById("inspector").dataset.inspectState === "success", null, { timeout: 15_000 });
    assert.equal(inspectQueries.length, before + 1);
    assert.deepEqual([await words(page, "#inspect-submit"), await box(page, "#inspect-submit")], idle);

    // ERROR keeps the last good result, with the reason.
    mode.inspect = "error";
    const good = await page.textContent("#inspect-result");
    await inspect(page, MINED, "error");
    const failed = await page.evaluate(() => ({ result: document.getElementById("inspect-result").textContent, note: document.getElementById("inspect-note").textContent, tone: document.getElementById("inspect-status").dataset.tone }));
    assert.equal(failed.result, good);
    assert.equal(failed.tone, "error");
    assert.match(failed.note, /previous result/);
    mode.inspect = "ok";

    // Malformed input is never sent.
    const sent = inspectQueries.length;
    for (const bad of ["0x123", "<script>alert(1)</script>", `0x${"g".repeat(40)}`]) {
      await page.fill("#inspect-input", bad);
      await page.click("#inspect-submit");
    }
    assert.equal(inspectQueries.length, sent);
    assert.equal(await page.getAttribute("#inspect-input", "aria-invalid"), "true");
    // The snapshot never moved.
    assert.equal(await page.evaluate(() => document.body.dataset.state), "fresh");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the contract address: one exact value, one line where it fits, two halves on phones, its actions in a row under it", async () => {
    for (const [width, expected] of [[320, "22/20"], [360, "22/20"], [390, "42"], [412, "42"], [430, "42"], [768, "42"], [1024, "42"], [1280, "42"]]) {
      const { context, page } = await open({ width, height: 900 });
      const [address] = await hexLines(page);
      assert.deepEqual([address.text, address.lines.join("/")], [USDC, expected], `${width}`);
      const layout = await page.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        const [value, copy, link] = [r("address"), r("copy"), r("contract-explorer")];
        return { gap: Math.round(copy.top - value.bottom), left: Math.round(copy.left - value.left), row: Math.round(link.top - copy.top), after: Math.round(link.left - copy.right), heights: [Math.round(copy.height), Math.round(link.height)] };
      });
      assert.deepEqual(layout, { gap: 10, left: 0, row: 0, after: 8, heights: [32, 32] }, `${width}: Copy, then View on SocialScan, in one row under the value`);
      await context.close();
    }
  });

  test("Copy: copies the exact value and says so in place; a refused clipboard selects the value instead", async () => {
    const { context, page } = await open({ width: 390 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    const box = () => page.evaluate(() => { const r = document.getElementById("copy").getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(" "); });
    const before = await box();
    await page.click("#copy");
    const copied = await page.evaluate(async () => ({
      clipboard: await navigator.clipboard.readText(),
      word: [...document.querySelectorAll("#copy .copy-words > span")].find((span) => getComputedStyle(span).visibility === "visible").textContent,
      live: document.getElementById("copy-state").textContent,
    }));
    assert.deepEqual(copied, { clipboard: USDC, word: "Copied", live: "Contract address copied" });
    assert.equal(await box(), before, "the button does not move or resize");
    await page.waitForFunction(() => document.getElementById("copy").dataset.copy === "idle", null, { timeout: 5_000 });

    // The inspector's Copy, from the same template, copies the exact hash.
    await inspect(page, MINED, "success");
    await page.click("#inspect-result .copy");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), MINED);
    assert.equal(await page.evaluate(() => document.getElementById("inspect-copy-state").textContent), "Transaction hash copied");
    await context.close();

    // Clipboard refused: the value is selected, ready to copy by hand, and that is announced.
    const refused = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await refused.addInitScript(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error("refused"));
    });
    const page2 = await refused.newPage();
    await page2.goto(base);
    await settled(page2);
    await page2.click("#copy");
    const fallback = await page2.evaluate(() => ({ selection: getSelection().toString(), live: document.getElementById("copy-state").textContent, state: document.getElementById("copy").dataset.copy }));
    assert.deepEqual(fallback, { selection: USDC, live: "Contract address selected, ready to copy", state: "selected" });
    await refused.close();
  });

  test("View on SocialScan: made only from a checked value, for the contract, its block, and an inspected address or transaction", async () => {
    const { context, page, errors } = await open({ width: 390 });
    const link = (selector) => page.evaluate((s) => {
      const a = document.querySelector(s);
      return { href: a.getAttribute("href"), name: a.getAttribute("aria-label"), target: a.target, rel: a.rel, words: a.innerText.trim() };
    }, selector);
    const shape = { target: "_blank", rel: "noopener noreferrer", words: "View on SocialScan" };
    assert.deepEqual(await link("#contract-explorer"), { href: `${EXPLORER}/address/${USDC}`, name: "View on SocialScan: contract address, opens in a new tab", ...shape });
    assert.deepEqual({ ...(await link("#block-explorer")), words: "View on SocialScan" }, { href: `${EXPLORER}/block/20384112`, name: "View on SocialScan: block 20,384,112, opens in a new tab", ...shape });

    await inspect(page, USDC, "success");
    assert.deepEqual(await link("#inspect-result a"), { href: `${EXPLORER}/address/${USDC}`, name: "View on SocialScan: address, opens in a new tab", ...shape });
    await inspect(page, PARTIAL, "partial");
    assert.equal((await link("#inspect-result a")).href.toLowerCase(), `${EXPLORER}/address/${PARTIAL}`);
    await inspect(page, MINED, "success");
    assert.deepEqual(await link("#inspect-result a"), { href: `${EXPLORER}/tx/${MINED}`, name: "View on SocialScan: transaction hash, opens in a new tab", ...shape });
    // One per result, on the hash itself: never on Block, From or To.
    assert.equal(await page.locator("#inspect-result a").count(), 1);
    // Not found: nothing to show on the explorer, so no link; Copy stays.
    await inspect(page, UNKNOWN, "not-found");
    assert.deepEqual([await page.locator("#inspect-result a").count(), await page.locator("#inspect-result .copy").count()], [0, 1]);

    // An explorer base that is not a bare https origin makes no link at all.
    await page.evaluate(() => document.querySelector('meta[name="explorer"]').setAttribute("content", "javascript:alert(1)"));
    await inspect(page, USDC, "success");
    assert.equal(await page.locator("#inspect-result a").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("Sources: one set at every width, equal heights, titles and arrows aligned, paths unbroken", async () => {
    for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1024, 768], [1280, 860]]) {
      const { context, page } = await open({ width, height });
      const items = await page.evaluate(() =>
        [...document.querySelectorAll(".links a")].map((link) => {
          const box = link.getBoundingClientRect();
          const of = (selector) => link.querySelector(selector).getBoundingClientRect();
          const title = of(".link-title");
          const arrow = of(".link-arrow");
          const meta = of(".link-meta");
          return { top: Math.round(box.top), height: Math.round(box.height), title: Math.round(title.top - box.top), arrow: Math.round(arrow.top + arrow.height / 2 - (title.top + title.height / 2)), metaLines: Math.round(meta.height / parseFloat(getComputedStyle(link.querySelector(".link-meta")).lineHeight)) };
        }),
      );
      const rows = Object.values(Object.groupBy(items, (item) => item.top));
      for (const row of rows) assert.equal(new Set(row.map((item) => item.height)).size, 1, `${width}: equal heights in a row ${JSON.stringify(row)}`);
      assert.equal(new Set(items.map((item) => item.title)).size, 1, `${width}: titles aligned`);
      for (const item of items) assert.ok(Math.abs(item.arrow) <= 1, `${width}: arrow centred on its title line (${item.arrow}px)`);
      for (const item of items) assert.equal(item.metaLines, 1, `${width}: path on one line`);
      assert.equal(rows.length, width >= 960 ? 1 : 3, `${width}: ${rows.length} row(s)`);
      await context.close();
    }
  });

  test("footer icon links: named, 20px icons in 44px targets, neutral at rest, Pharos blue on hover and focus", async () => {
    for (const theme of ["dark", "light"]) {
      const { context, page } = await open({ width: 390, theme });
      const icons = await page.evaluate(() =>
        [...document.querySelectorAll(".foot-links a")].map((link) => {
          const box = link.getBoundingClientRect();
          const svg = link.querySelector("svg").getBoundingClientRect();
          return { name: link.getAttribute("aria-label"), title: link.title, href: link.href, target: [Math.round(box.width), Math.round(box.height)], icon: [Math.round(svg.width), Math.round(svg.height)], color: getComputedStyle(link).color };
        }),
      );
      assert.deepEqual(icons.map((icon) => [icon.name, icon.title, icon.href]), [
        ["Source code on GitHub, opens in a new tab", "GitHub", "https://github.com/Rzbyte/pharos-season-of-ai"],
        ["Pharos documentation, opens in a new tab", "Pharos Docs", "https://docs.pharos.xyz/"],
        ["rzbyte_ on X, opens in a new tab", "X", "https://x.com/rzbyte_"],
      ]);
      for (const icon of icons) assert.deepEqual([icon.target, icon.icon], [[44, 44], [20, 20]], icon.name);
      const rest = theme === "dark" ? "rgb(155, 158, 159)" : "rgb(52, 52, 52)";
      const blue = theme === "dark" ? "rgb(79, 132, 255)" : PHAROS_BLUE;
      assert.deepEqual([...new Set(icons.map((icon) => icon.color))], [rest], `${theme} at rest`);
      await page.hover(".foot-links li:nth-child(3) a");
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".foot-links li:nth-child(3) a")).color), blue, `${theme} hover`);
      await page.mouse.move(0, 0);
      await page.focus(".foot-links a");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(250);
      const focus = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return [document.activeElement.getAttribute("aria-label"), style.color, style.outlineStyle, style.outlineColor]; });
      assert.deepEqual(focus, ["Source code on GitHub, opens in a new tab", blue, "solid", blue], `${theme} focus`);
      await context.close();
    }
  });

  test("keyboard: every control is reachable in order, with a visible focus ring", async () => {
    const { context, page } = await open({ width: 1280, height: 860 });
    const stops = [];
    for (let step = 0; step < 30; step += 1) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const element = document.activeElement;
        if (element === document.body) return null;
        const style = getComputedStyle(element);
        return {
          name: element.id || element.getAttribute("href") || element.textContent.trim().slice(0, 24),
          ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2,
        };
      });
      if (!stop) break;
      stops.push(stop);
    }
    assert.ok(stops.length >= 14, `${stops.length} focus stops`);
    const names = stops.map((stop) => stop.name);
    const expected = ["#snapshot", "theme-toggle", "Refresh snapshot", "copy", "contract-explorer", "#inspector", "#proof", "inspect-input", "inspect-submit", "inspect-example", "Proof & technical"];
    let at = -1;
    for (const name of expected) {
      const index = names.findIndex((stop, position) => position > at && stop.startsWith(name));
      assert.ok(index > at, `${name} is reachable after ${names[at] ?? "the start"} (${names.join(" | ")})`);
      at = index;
    }
    for (const stop of stops) assert.ok(stop.ring, `no focus ring on ${stop.name}`);
    await context.close();
  });

  test("reduced motion: nothing animates or transitions, and the states still update", async () => {
    const { context, page } = await open({ width: 390, motion: "reduce" });
    mode.state = "slow";
    mode.inspect = "slow";
    await page.click("[data-refresh]");
    await page.fill("#inspect-input", USDC);
    await page.click("#inspect-submit");
    await page.waitForFunction(() => document.body.dataset.state === "reading" && document.getElementById("inspector").dataset.inspectState === "inspecting");
    const motion = await page.evaluate(() => ({
      running: document.getAnimations().length,
      beacon: getComputedStyle(document.querySelector("#snapshot .beacon"), "::after").animationName,
      dot: getComputedStyle(document.querySelector("#status .status-dot")).animationName,
      transitions: [".measured", ".btn", ".action", ".inspect-result"].map((selector) => getComputedStyle(document.querySelector(selector)).transitionDuration),
    }));
    assert.deepEqual(motion, { running: 0, beacon: "none", dot: "none", transitions: ["0s", "0s", "0s", "0s"] });
    await settled(page, ["fresh"]);
    mode.state = "fresh";
    mode.inspect = "ok";
    await page.waitForFunction(() => document.getElementById("inspector").dataset.inspectState === "success", null, { timeout: 15_000 });
    await page.click("#proof > summary");
    assert.equal(await page.evaluate(() => document.getElementById("proof").open), true);
    assert.equal(await page.evaluate(() => document.getElementById("supply").classList.contains("settle")), false);
    await context.close();
  });

  test("touch: every control offers at least 44 x 44px, a 32px action through its hit area", async () => {
    const { context, page } = await open({ width: 390 });
    await inspect(page, MINED, "success");
    await page.click("#proof > summary");
    await page.waitForTimeout(450);
    const sweep = await page.evaluate(() => {
      // Links inside running text are exempt (WCAG 2.5.8), as is the skip link, which sits off screen.
      const controls = [...document.querySelectorAll("a[href], button, summary, input")].filter((element) => element.checkVisibility() && !element.closest(".proof-text, .skip"));
      const small = [];
      for (const element of controls) {
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const hits = (y) => { const at = document.elementFromPoint(x, y); return at === element || element.contains(at); };
        let up = 0;
        while (up < 12 && hits(rect.top - up - 0.5)) up += 1;
        let down = 0;
        while (down < 12 && hits(rect.bottom + down + 0.5)) down += 1;
        const height = rect.height + up + down;
        if (height < 43.5 || rect.width < 43.5) small.push(`${element.id || element.className || element.tagName}: ${Math.round(rect.width)} x ${Math.round(height)}`);
      }
      return { count: controls.length, small };
    });
    assert.ok(sweep.count >= 18, `${sweep.count} controls`);
    assert.deepEqual(sweep.small, []);
    await context.close();
  });

  test("no text on screen is set smaller than 12px", async () => {
    for (const width of [320, 1280]) {
      const { context, page } = await open({ width, height: 900 });
      await inspect(page, MINED, "success");
      const tiny = await page.evaluate(() => {
        const found = new Set();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const element = node.parentElement;
          if (!node.textContent.trim() || !element.checkVisibility() || element.closest(".sr")) continue;
          const size = parseFloat(getComputedStyle(element).fontSize);
          if (size < 12) found.add(`${element.className || element.tagName} ${size}px: ${node.textContent.trim().slice(0, 24)}`);
        }
        return [...found];
      });
      assert.deepEqual(tiny, [], `${width}`);
      await context.close();
    }
  });

  test("the page made no request outside this site", () => {
    assert.ok(requests.length > 50);
    const outside = requests.filter((url) => !url.startsWith(`${base}/`) && !url.startsWith("data:"));
    assert.deepEqual(outside, []);
    const paths = new Set(requests.filter((url) => url.startsWith(base)).map((url) => new URL(url).pathname.replace(/^\/assets\/.*/, "/assets/*")));
    assert.deepEqual([...paths].sort(), ["/", "/api/explain", "/api/inspect", "/api/state", "/assets/*"]);
  });
});
