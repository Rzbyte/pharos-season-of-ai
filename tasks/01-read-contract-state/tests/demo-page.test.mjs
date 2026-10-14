// Tests for the Task 01 page in public/. No browser, no build and no network:
//   node --test tests/demo-page.test.mjs
// They read the shipped files, import the page's plain ES modules, and drive the DOM helpers
// through a minimal fake document. Layout, motion and the LIVE / READING / ERROR states are
// checked in a real browser; these tests pin what must never drift: what the page may load and
// call, the claims it makes, the task manifest, and how chain data is formatted and written.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, test } from "node:test";
import { toFunctionSelector } from "viem";
import { chunkAddress, clockTime, duration, groupDigits, renderAddress, renderFigure, renderTaskContext, splitAmount, toHexBlock } from "../public/assets/lab.js";
import { TASKS } from "../public/assets/tasks.js";

const file = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(file(path), "utf8");
const html = read("public/index.html");
const css = read("public/assets/lab.css");
const scripts = ["lab.js", "tasks.js", "task-01.js"].map((name) => ({ name, text: read(`public/assets/${name}`) }));
const pageJs = scripts.find((script) => script.name === "task-01.js").text;
const USDC = read("src/constants.ts").match(/export const DEFAULT_TOKEN = "(0x[0-9a-fA-F]{40})"/)[1];

/** Visible text of the page, roughly: tags, the inline style block and entities removed. */
const visibleText = html
  .replace(/<style>[\s\S]*?<\/style>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&[a-z]+;/g, " ")
  .replace(/\s+/g, " ");

describe("what the page loads and calls", () => {
  test("loads only its own assets: one module script, no inline script or handlers", () => {
    const tags = html.match(/<(?:script|link)\b[^>]*>/g);
    const urls = tags.map((tag) => tag.match(/\s(?:src|href)="([^"]*)"/)?.[1]);
    assert.ok(urls.length >= 3);
    for (const url of urls) assert.match(url, /^(\/assets\/|data:)/, `unexpected asset URL ${url}`);
    assert.equal(html.match(/<script\b/g).length, 1);
    assert.match(html, /<script type="module" src="\/assets\/task-01\.js"><\/script>/);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(css, /@import/);
    for (const [, url] of css.matchAll(/url\("([^"]+)"\)/g)) assert.match(url, /^\/assets\/fonts\/[\w-]+\.woff2$/);
  });

  test("links out only to this project's GitHub repository", () => {
    const external = [...html.matchAll(/href="(https?:[^"]+)"/g)].map((match) => match[1]);
    assert.ok(external.length >= 2);
    for (const url of external) assert.ok(url.startsWith("https://github.com/Rzbyte/pharos-season-of-ai"), url);
  });

  test("the browser calls only this site's /api/state: no MCP, RPC or other client code", () => {
    assert.match(html, /<main id="main"[^>]* data-api="\/api\/state"/);
    assert.match(pageJs, /const API = main\.dataset\.api;/);
    for (const { name, text } of scripts) {
      assert.doesNotMatch(text, /https?:\/\//, `${name} contains a URL`);
      assert.doesNotMatch(text, /XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|navigator\.connection/, name);
      assert.doesNotMatch(text, /jsonrpc|@modelcontextprotocol|mcp\.pharos|rpc\.pharos/i, name);
      assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie/, name);
    }
    const fetches = scripts.flatMap(({ text }) => text.match(/\bfetch\(/g) ?? []);
    assert.equal(fetches.length, 1);
    assert.match(pageJs, /fetch\(API, \{ headers: \{ accept: "application\/json" \}, cache: "no-store" \}\)/);
  });

  test("never parses markup: chain data is written as text", () => {
    for (const { name, text } of scripts) {
      assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/, name);
      assert.doesNotMatch(text, /\beval\(|new Function\b|setTimeout\(\s*["'`]/, name);
    }
  });

  test("no analytics, trackers or third-party fonts", () => {
    const everything = [html, css, ...scripts.map(({ text }) => text)].join("\n");
    assert.doesNotMatch(everything, /gtag|googletagmanager|google-analytics|plausible|posthog|mixpanel|segment\.(?:io|com)|hotjar|clarity\.ms|_vercel\/insights|@vercel\/analytics|sentry|fonts\.googleapis|fonts\.gstatic/i);
  });

  test("every element the script writes to exists in the page", () => {
    const ids = new Set([...pageJs.matchAll(/\$\("([\w-]+)"\)/g)].map((match) => match[1]));
    assert.ok(ids.size > 30);
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing`);
    for (const attribute of ["data-refresh", "data-status-word", "data-block", "data-chain"]) assert.match(html, new RegExp(`\\s${attribute}[\\s>]`), attribute);
  });
});

describe("the page reports evidence, not certification", () => {
  test("names the client path precisely: zero direct RPC calls from this client, MCP-only", () => {
    assert.match(visibleText, /Direct RPC calls from this client 0 MCP-only client path/);
    for (const match of visibleText.matchAll(/direct rpc/gi)) {
      assert.match(visibleText.slice(match.index), /^Direct RPC calls from this client/, "every Direct RPC claim is scoped to this client");
    }
    assert.match(visibleText, /opens no JSON-RPC connection of its own\. Pharos MCP talks to the chain on its side\./);
  });

  test("makes no certification claims anywhere", () => {
    const everything = [html, ...scripts.map(({ text }) => text)].join("\n");
    assert.doesNotMatch(everything, /verif|certif|guarantee|audited|trustless|100%/i);
    assert.match(pageJs, /MCP read OK/);
    assert.match(pageJs, /const STATUS_WORD = \{ reading: "Reading", live: "Live", error: "Error" \};/);
  });

  test("keeps the four contract reads apart from the two context calls", () => {
    assert.match(visibleText, /Contract reads 4 name · symbol · decimals · totalSupply/);
    assert.match(visibleText, /Explicit block 1/);
    assert.match(visibleText, /Chain MCP tool calls — 2 context \+ 4 contract reads/);
    assert.match(visibleText, /get_chain_info Context: confirms chain ID/);
    assert.match(visibleText, /get_block_number Context: fixes block/);
    assert.match(visibleText, /eth_call ×4 Contract reads: name, symbol, decimals, totalSupply/);
    assert.match(pageJs, /"2 context \+ 4 contract reads"/);
  });

  test("shows the frozen contract and the real ERC-20 selectors", () => {
    assert.equal(USDC, "0xC879C018dB60520F4355C26eD1a6D572cdAC1815");
    assert.equal(html.match(new RegExp(USDC, "g")).length, 2);
    const selectors = Object.fromEntries([...visibleText.matchAll(/(\w+)\(\) (0x[0-9a-f]{8})/g)].map(([, fn, selector]) => [fn, selector]));
    assert.deepEqual(Object.keys(selectors).sort(), ["decimals", "name", "symbol", "totalSupply"]);
    for (const [fn, selector] of Object.entries(selectors)) assert.equal(selector, toFunctionSelector(`${fn}()`), fn);
  });

  test("technical details stay collapsed until asked for", () => {
    assert.match(html, /<details class="tech-details">/);
    assert.doesNotMatch(html, /<details[^>]*\sopen/);
  });
});

describe("task manifest", () => {
  const titles = [
    "Read Contract State", "Event / Log Monitor", "Docs MCP Onboarding", "Doc-Search CLI", "Threshold Guardian", "Saga Executor", "Arbitrage Scanner",
    "Dry-Run Executor", "Trend Watcher", "Batch Executor", "Policy Gatekeeper", "Skill + Chain MCP Flow", "Docs MCP + Chain MCP Agent", "Portfolio Assistant",
    "Yield Optimizer", "Liquidation Watchdog", "Natural-Language Payment Agent", "Recurring Payment Agent", "Invoice-to-Payment Agent", "On-Chain Alert Bot",
    "Whale-Watching Agent", "Gas Fee Optimizer", "Wallet Risk Checker", "Audit-Log Agent", "dApp Support Agent", "Weekly Digest Agent",
    "Doc-Grounded Builder Agent", "Multi-Protocol Aggregator",
  ];

  test("lists all 28 tasks in order, with their exact titles", () => {
    assert.deepEqual(TASKS.map((task) => task.n), titles.map((_, index) => String(index + 1).padStart(2, "0")));
    assert.deepEqual(TASKS.map((task) => task.title), titles);
    assert.ok(Object.isFrozen(TASKS) && TASKS.every(Object.isFrozen));
  });

  test("only Task 01 is live and has a page; every other task is planned with no path", () => {
    assert.deepEqual(TASKS.filter((task) => task.status === "live").map((task) => [task.n, task.path]), [["01", "/"]]);
    for (const task of TASKS.slice(1)) assert.deepEqual([task.status, task.path], ["planned", null], task.n);
  });

  test("names a tool only where it is already known", () => {
    const tools = Object.fromEntries(TASKS.filter((task) => task.tool !== null).map((task) => [task.n, task.tool]));
    assert.deepEqual(tools, { "01": "Chain MCP", "02": "Chain MCP", "03": "Docs MCP", "04": "Docs MCP", 28: "Composition" });
  });

  test("the page links to no other task page", () => {
    const internal = [...html.matchAll(/href="(\/[^"]*)"/g)].map((match) => match[1]).filter((href) => !href.startsWith("/assets/"));
    assert.deepEqual(internal, ["/api/state"]);
  });
});

describe("formatting chain data", () => {
  test("groups digits without converting to a number", () => {
    assert.equal(groupDigits("18212174"), "18,212,174");
    assert.equal(groupDigits("999"), "999");
    assert.equal(groupDigits("1000"), "1,000");
    assert.equal(groupDigits("123456789012345678901234567890"), "123,456,789,012,345,678,901,234,567,890");
  });

  test("splits a display amount into its whole part, fraction and unit", () => {
    assert.deepEqual(splitAmount("18,212,174.034793 USDC"), { major: "18,212,174", minor: ".034793", unit: "USDC" });
    assert.deepEqual(splitAmount("5 USDC"), { major: "5", minor: "", unit: "USDC" });
    assert.deepEqual(splitAmount("0.5"), { major: "0", minor: ".5", unit: "" });
  });

  test("chunks only a real address, and the chunks rebuild it exactly", () => {
    const groups = chunkAddress(USDC);
    assert.deepEqual(groups, ["0xC879", "C018", "dB60", "520F", "4355", "C26e", "D1a6", "D572", "cdAC", "1815"]);
    assert.equal(groups.join(""), USDC);
    assert.equal(chunkAddress("0x1234"), null);
    assert.equal(chunkAddress(`${USDC}00`), null);
  });

  test("block in hex, durations and clock times", () => {
    assert.equal(toHexBlock("20175330"), "0x133d9e2");
    assert.equal(toHexBlock("12345678901234567890"), "0xab54a98ceb1f0ad2");
    assert.equal(toHexBlock("0x10"), "");
    assert.equal(duration(640), "640 ms");
    assert.equal(duration(2140), "2.1 s");
    assert.equal(clockTime("not a date"), "");
    assert.equal(clockTime(new Date(2026, 9, 14, 0, 5, 9).toISOString()), "00:05:09");
    assert.equal(clockTime(new Date(2026, 9, 14, 23, 59, 59).toISOString()), "23:59:59");
  });
});

describe("DOM helpers write text, never markup", () => {
  /** The few DOM features the helpers use, and nothing that could parse HTML. */
  class FakeElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.className = "";
      this.textContent = "";
      this.hidden = false;
      this.children = [];
    }
    replaceChildren(...nodes) {
      this.children = nodes;
      this.textContent = nodes.map((node) => (typeof node === "string" ? node : node.textContent)).join("");
    }
  }
  const element = () => new FakeElement("p");
  const withDocument = (fn) => {
    const saved = globalThis.document;
    globalThis.document = { createElement: (tag) => new FakeElement(tag) };
    try {
      return fn();
    } finally {
      if (saved === undefined) delete globalThis.document;
      else globalThis.document = saved;
    }
  };

  test("renderFigure keeps the text and puts each separator in its own span", () => {
    withDocument(() => {
      const major = element();
      renderFigure(major, "12,345,678");
      assert.equal(major.textContent, "12,345,678");
      assert.deepEqual(major.children.map((node) => (typeof node === "string" ? node : `<${node.className}>${node.textContent}`)), ["12", "<sep>,", "345", "<sep>,", "678"]);
      const minor = element();
      renderFigure(minor, ".034793");
      assert.equal(minor.textContent, ".034793");
      assert.equal(minor.children[0].className, "sep sep-lead");
    });
  });

  test("renderAddress shows the exact address in groups, adding no characters", () => {
    withDocument(() => {
      const target = element();
      renderAddress(target, USDC);
      assert.equal(target.textContent, USDC);
      assert.equal(target.children.filter((node) => node.tagName === "SPAN").length, 10);
      assert.equal(target.children.filter((node) => node.tagName === "WBR").length, 9);
      const odd = element();
      renderAddress(odd, "<b>not an address</b>");
      assert.equal(odd.textContent, "<b>not an address</b>");
      assert.equal(odd.children.length, 0);
    });
  });

  test("renderTaskContext links only a live task with a page", () => {
    withDocument(() => {
      const counter = element();
      const previous = element();
      const next = element();
      renderTaskContext(TASKS, "01", { counter, previous, next });
      assert.equal(counter.textContent, "01 / 28");
      assert.equal(previous.hidden, true);
      assert.equal(next.hidden, false);
      assert.equal(next.textContent, "Next02Event / Log MonitorPlanned");
      const title = next.children.find((node) => node.className === "t");
      assert.equal(title.tagName, "SPAN");
      assert.equal(title.href, undefined);

      const planned = TASKS.map((task) => (task.n === "02" ? { ...task, path: "/02" } : task));
      renderTaskContext(planned, "01", { next });
      assert.equal(next.children.find((node) => node.className === "t").tagName, "SPAN", "a planned task never becomes a link, path or not");

      const live = TASKS.map((task) => (task.n === "02" ? { ...task, status: "live", path: "/02" } : task));
      renderTaskContext(live, "01", { next });
      const link = next.children.find((node) => node.className === "t");
      assert.deepEqual([link.tagName, link.href], ["A", "/02"]);
      assert.equal(next.children.at(-1).textContent, "Live");
    });
  });
});

describe("design system assets", () => {
  test("self-hosts four font faces under 200 KB, each with its OFL licence", () => {
    const dir = "public/assets/fonts";
    const files = readdirSync(file(dir)).sort();
    assert.deepEqual(files, ["DepartureMono-OFL.txt", "DepartureMono-Regular.woff2", "Geist-OFL.txt", "Geist-Regular.woff2", "Geist-SemiBold.woff2", "GeistMono-Regular.woff2"]);
    const fonts = files.filter((name) => name.endsWith(".woff2"));
    const bytes = fonts.reduce((sum, name) => sum + statSync(file(`${dir}/${name}`)).size, 0);
    assert.ok(bytes < 200 * 1024, `${bytes} bytes of fonts`);
    for (const [, url] of css.matchAll(/url\("\/assets\/fonts\/([^"]+)"\)/g)) assert.ok(fonts.includes(url), url);
    for (const licence of ["Geist-OFL.txt", "DepartureMono-OFL.txt"]) {
      assert.match(read(`${dir}/${licence}`), /SIL OPEN FONT LICENSE Version 1\.1/, licence);
    }
    assert.match(read(`${dir}/Geist-OFL.txt`), /Copyright \(c\) 2023 Vercel, in collaboration with basement\.studio/);
    assert.match(read(`${dir}/DepartureMono-OFL.txt`), /Copyright 2022–2024 Helena Zhang/);
  });

  test("all motion sits behind prefers-reduced-motion: no-preference", () => {
    const start = css.indexOf("@media (prefers-reduced-motion: no-preference) {");
    assert.ok(start > 0);
    let depth = 0;
    let end = start;
    for (let index = css.indexOf("{", start); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}" && --depth === 0) {
        end = index;
        break;
      }
    }
    const motion = css.slice(start, end);
    const declarations = (text) => (text.match(/(?:^|[\s;{])(?:animation|transition)(?:-[a-z-]+)?\s*:/g) ?? []).length;
    assert.ok(declarations(motion) >= 5);
    assert.equal(declarations(css), declarations(motion), "an animation or transition is declared outside the no-preference block");
    assert.equal(declarations(html), 0);
  });

  test("colour stays semantic: green only for LIVE, red only for ERROR", () => {
    const uses = (token) => [...css.matchAll(new RegExp(`[^\\n]*var\\(${token}[^\\n]*`, "g"))].map((match) => match[0].trim());
    for (const line of uses("--live")) assert.match(line, /data-state="live"|\.tag-live/, line);
    for (const line of uses("--fault")) assert.match(line, /data-state="error"/, line);
  });
});
