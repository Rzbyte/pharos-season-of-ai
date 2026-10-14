// Browser tests for the Task 01 page: layout, themes, states, keyboard and motion, in Chromium.
//   NODE_PATH="$(npm root -g)" node --test tests/demo-browser.test.mjs
// Playwright with Chromium is used where it is installed globally; it is not a dependency of this
// project, and without it the suite is skipped and says why. Needs dist/ (built by `npm ci`).
// Nothing reaches the network: the real api/state.js and api/inspect.js handlers run against the
// in-process fake Pharos Chain MCP from fake-inspector-mcp.mjs, and every value is made up.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { after, before, describe, test } from "node:test";
import { encodeAbiParameters } from "viem";
import { createHandler as inspectHandler } from "../api/inspect.js";
import { createHandler as stateHandler, readState } from "../api/state.js";
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
const SEL = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" };
const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const PARTIAL = "0x0000000000000000000000000000000000c0ffee";
const MINED = `0x${"ab".repeat(32)}`;
const PENDING = `0x${"cd".repeat(32)}`;
const UNKNOWN = `0x${"ef".repeat(32)}`;
const SENDER = "0x5b3d0f4e9a2c7d1b8e6f0a4c2d9e7b1a3c5f8d02";
const CHAIN = {
  blockNumber: 20_384_112n,
  contracts: {
    [USDC.toLowerCase()]: { [SEL.name]: str("USDC"), [SEL.symbol]: str("USDC"), [SEL.decimals]: uint(6n), [SEL.totalSupply]: uint(20_271_995_983_588n) },
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
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };

describe("the Task 01 page in a browser", { skip }, () => {
  let fake;
  let server;
  let browser;
  let base;
  const mode = { state: "fresh", inspect: "ok" };
  const requests = [];
  const inspectQueries = [];
  let replay = null;

  before(async () => {
    fake = await startFakeInspectorMcp(CHAIN);
    const state = stateHandler(fake.url);
    const deadState = stateHandler("http://127.0.0.1:9/mcp");
    const inspect = inspectHandler(fake.url);
    const deadInspect = inspectHandler("http://127.0.0.1:9/mcp");
    server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/state") {
        if (mode.state === "slow") await new Promise((resolve) => setTimeout(resolve, 1500));
        if (mode.state === "error") return void deadState(req, res);
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
  /** Group counts per line of every hex value on the page: [[5, 5], [8, 8], ...]. */
  const hexLines = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll(".hex")].filter((hex) => hex.offsetParent).map((hex) => {
        const lines = new Map();
        for (const group of hex.querySelectorAll(":scope > span")) {
          const top = Math.round(group.getBoundingClientRect().top);
          lines.set(top, (lines.get(top) ?? 0) + 1);
        }
        return [...lines.values()];
      }),
    );
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
        for (const lines of await hexLines(page)) {
          assert.ok(lines.every((count) => count === lines[0]), `${where}: hex lines ${lines.join("/")}`);
          assert.ok([4, 5, 8, 10, 16].includes(lines[0]), `${where}: ${lines[0]} groups per line`);
        }
        assert.deepEqual(errors, [], where);
        await context.close();
      }
    }
  });

  test("the first screen holds the task, contract, tool, snapshot state, block, read time, supply and state rows", async () => {
    for (const [width, height, extra] of [[320, 568, []], [390, 844, ["#address", "[data-refresh]", "#copy"]], [1280, 860, ["#address", "[data-refresh]", "#copy"]]]) {
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

    // READING: the last snapshot stays, dimmed; Refresh waits and keeps focus.
    mode.state = "slow";
    await page.focus("[data-refresh]");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.body.dataset.state === "reading");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const reading = await snapshot(page);
    assert.deepEqual([reading.tone, reading.word, reading.detail, reading.busy, reading.supply, reading.opacity], ["active", "Reading", "taking a new snapshot", "true", fresh.supply, "0.55"]);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.matches("[data-refresh]"), document.querySelector("[data-refresh]").getAttribute("aria-disabled")]), [true, "true"]);
    await settled(page, ["fresh"]);

    // READ FAILED: the last good snapshot stays, with the reason.
    mode.state = "error";
    await page.click("[data-refresh]");
    await settled(page, ["error"]);
    await page.waitForTimeout(300);
    const failed = await snapshot(page);
    assert.deepEqual([failed.tone, failed.word, failed.detail, failed.supply, failed.opacity], ["error", "Read failed", "showing the last good snapshot", fresh.supply, "0.75"]);
    assert.match(failed.note, /Could not reach/);

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

  test("the Task 01 proof is intact: the same read the API reports, four reads at one block, six tool calls", async () => {
    const { context, page } = await open({ width: 1280, height: 860 });
    const api = await page.evaluate(async () => (await fetch("/api/state", { cache: "no-store" })).json());
    const shown = await page.evaluate(() => {
      const text = (selector) => document.querySelector(selector).textContent;
      return {
        supply: text("#supply-amount") + " " + text("#supply-unit"),
        values: [text("#v-name"), text("#v-symbol"), text("#v-decimals"), text("#network"), text("#snapshot .rows [data-chain]")],
        counts: [...document.querySelectorAll(".counts .count-n")].map((count) => count.textContent),
        calls: text("#t-calls"),
        block: text("#t-block"),
        raw: text("#v-raw"),
        address: text("#address"),
        transcript: document.querySelector('a[href$="proof/mcp-transcript.json"]').href,
      };
    });
    assert.equal(shown.supply, api.display.totalSupply);
    assert.deepEqual(shown.values, [api.values.name, api.values.symbol, String(api.values.decimals), "Pharos Mainnet", "1672"]);
    assert.deepEqual(shown.counts, ["4", "1", "6", "0"]);
    assert.equal(shown.calls, "6: get_chain_info, get_block_number, eth_call ×4");
    assert.equal(shown.block, `${api.blockNumber}, sent as 0x${BigInt(api.blockNumber).toString(16)} in every eth_call`);
    assert.equal(shown.raw, api.values.totalSupply.raw);
    assert.equal(shown.address, USDC);
    assert.equal(shown.transcript, "https://github.com/Rzbyte/pharos-season-of-ai/blob/main/tasks/01-read-contract-state/proof/mcp-transcript.json");
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

    await inspect(page, PENDING, "partial");
    assert.equal((await rows(page)).Status, "Pending");

    // INSPECTING keeps the last result, dimmed; the button keeps focus and sends nothing twice.
    mode.inspect = "slow";
    const before = inspectQueries.length;
    const previous = await page.textContent("#inspect-result");
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
    // force: Playwright itself would wait for an aria-disabled button; a visitor's click does not.
    await page.click("#inspect-example", { force: true });
    assert.equal(await page.inputValue("#inspect-input"), USDC, "the example waits too");
    await page.waitForFunction(() => document.getElementById("inspector").dataset.inspectState === "success", null, { timeout: 15_000 });
    assert.equal(inspectQueries.length, before + 1);

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
    const expected = ["#snapshot", "theme-toggle", "Refresh snapshot", "copy", "#inspector", "#proof", "inspect-input", "inspect-submit", "inspect-example", "Proof & technical"];
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
      transitions: [".measured", ".btn", ".inspect-result"].map((selector) => getComputedStyle(document.querySelector(selector)).transitionDuration),
    }));
    assert.deepEqual(motion, { running: 0, beacon: "none", dot: "none", transitions: ["0s", "0s", "0s"] });
    await settled(page, ["fresh"]);
    mode.state = "fresh";
    mode.inspect = "ok";
    await page.waitForFunction(() => document.getElementById("inspector").dataset.inspectState === "success", null, { timeout: 15_000 });
    await page.click("#proof > summary");
    assert.equal(await page.evaluate(() => document.getElementById("proof").open), true);
    assert.equal(await page.evaluate(() => document.getElementById("supply").classList.contains("settle")), false);
    await context.close();
  });

  test("the page made no request outside this site", () => {
    assert.ok(requests.length > 50);
    const outside = requests.filter((url) => !url.startsWith(`${base}/`) && !url.startsWith("data:"));
    assert.deepEqual(outside, []);
    const paths = new Set(requests.filter((url) => url.startsWith(base)).map((url) => new URL(url).pathname.replace(/^\/assets\/.*/, "/assets/*")));
    assert.deepEqual([...paths].sort(), ["/", "/api/inspect", "/api/state", "/assets/*"]);
  });
});
