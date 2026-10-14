// Tests for the Task 01 page in public/. No browser, no build and no network:
//   node --test tests/demo-page.test.mjs
// They read the shipped files, import the page's plain ES modules, run theme.js against a fake
// document, and drive the DOM helpers through a minimal fake document. Layout, motion, focus and
// the snapshot and inspector states in a real browser are in demo-browser.test.mjs; these tests pin
// what must never drift: what the page may load and call, the words it uses, the claims it makes,
// the two themes, the task manifest, and how chain data is formatted and written.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, test } from "node:test";
import vm from "node:vm";
import { toFunctionSelector } from "viem";
import { clockTime, duration, explorerUrl, groupDigits, hexParts, renderHex, renderTaskContext, snapshotSource, splitAmount, toHexBlock } from "../public/assets/lab.js";
import { TASKS } from "../public/assets/tasks.js";

const file = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(file(path), "utf8");
const html = read("public/index.html");
const css = read("public/assets/lab.css");
/** The stylesheet without comments, for reading selectors. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
const scripts = ["lab.js", "tasks.js", "theme.js", "task-01.js", "inspector.js", "inspect-input.js", "explain.js", "explain-input.js"].map((name) => ({ name, text: read(`public/assets/${name}`) }));
const script = (name) => scripts.find((entry) => entry.name === name).text;
const pageJs = script("task-01.js");
const inspectorJs = script("inspector.js");
const explainJs = script("explain.js");
const themeJs = script("theme.js");
const USDC = read("src/constants.ts").match(/export const DEFAULT_TOKEN = "(0x[0-9a-fA-F]{40})"/)[1];

/** Visible text of the page, roughly: tags and entities removed. */
const visibleText = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&[a-z]+;/g, " ")
  .replace(/\s+/g, " ");
/** Every string literal in the page scripts (comments excluded): what the scripts can write. */
const literals = scripts.flatMap(({ name, text }) =>
  [...text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((match) => [name, match[1] ?? match[2]]),
);

describe("what the page loads and calls", () => {
  test("loads only its own assets: theme.js before the stylesheet, three module scripts, nothing inline", () => {
    const tags = html.match(/<(?:script|link)\b[^>]*>/g);
    const urls = tags.map((tag) => tag.match(/\s(?:src|href)="([^"]*)"/)?.[1]);
    assert.ok(urls.length >= 4);
    for (const url of urls) assert.match(url, /^(\/assets\/|data:)/, `unexpected asset URL ${url}`);
    assert.equal(html.match(/<script\b/g).length, 4);
    // theme.js is a classic script so a saved theme applies before the first paint.
    assert.match(html, /<script src="\/assets\/theme\.js"><\/script>\n<link rel="preload"[^>]*>\n<link rel="stylesheet" href="\/assets\/lab\.css">\n<script type="module" src="\/assets\/task-01\.js"><\/script>\n<script type="module" src="\/assets\/inspector\.js"><\/script>\n<script type="module" src="\/assets\/explain\.js"><\/script>/);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, "an inline script");
    assert.doesNotMatch(html, /<style\b|\sstyle="/, "inline styles: everything lives in lab.css");
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(css, /@import/);
    for (const [, url] of css.matchAll(/url\("([^"]+)"\)/g)) assert.match(url, /^\/assets\/fonts\/[\w-]+\.woff2$/);
  });

  test("links out only to verified places: this repository, the Pharos docs and the author's X profile", () => {
    const external = [...html.matchAll(/href="(https?:[^"]+)"/g)].map((match) => match[1]);
    assert.ok(external.length >= 5);
    const verified = [/^https:\/\/github\.com\/Rzbyte\/pharos-season-of-ai(?:\/|$)/, /^https:\/\/docs\.pharos\.xyz\/$/, /^https:\/\/x\.com\/rzbyte_$/];
    for (const url of external) assert.ok(verified.some((pattern) => pattern.test(url)), url);
  });

  test("every link that leaves the site opens a new tab with no opener, and says so; links within it stay", () => {
    const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g);
    assert.ok(anchors.length >= 12);
    for (const anchor of anchors) {
      const start = anchor.match(/^<a\b[^>]*>/)[0];
      // An explorer link is a placeholder (no href, target or rel) until linkExplorer makes it from a
      // checked value; lab.js then gives it the same new tab, below.
      if (start.startsWith('<a class="action"')) {
        assert.doesNotMatch(start, /\s(?:href|target|rel)=/, start);
        continue;
      }
      const leaves = /\shref="https?:/.test(start);
      if (!leaves) {
        assert.doesNotMatch(start, /target=/, start);
        continue;
      }
      assert.match(start, /\starget="_blank" rel="noopener noreferrer"[\s>]/, start);
      // Its name says it opens a new tab: in its aria-label, or in hidden words.
      assert.ok(/aria-label="[^"]*, opens in a new tab"/.test(start) || anchor.endsWith('<span class="sr">, opens in a new tab</span></a>'), start);
      // ...and it ends in the out arrow, unless it is an icon by itself.
      assert.ok(/<svg class="(?:ext|link-arrow)"[^>]*>\s*<path d="M5 11l6-6M6 5h5v5"/.test(anchor) || start.includes('class="icon-link"'), start);
    }
    assert.match(script("lab.js"), /link\.href = href;\n {4}link\.target = "_blank";\n {4}link\.rel = "noopener noreferrer";\n {4}link\.setAttribute\("aria-label", `\$\{link\.textContent\.trim\(\)\}: \$\{what\}, opens in a new tab`\);/);
    assert.match(script("lab.js"), /for \(const name of \["href", "target", "rel", "aria-label"\]\) link\.removeAttribute\(name\);/);
  });

  test("the block explorer is named once, in a meta tag, and every link to it is built from a checked value", () => {
    // The explorer's address and name share one line: switching explorers is a one-line change.
    assert.deepEqual(html.match(/<meta name="explorer" content="([^"]+)" data-name="([^"]+)">/).slice(1), ["https://pharos.socialscan.io", "SocialScan"]);
    assert.equal(html.match(/socialscan\.io/g).length, 1, "the explorer host appears only in its meta tag");
    assert.equal(html.match(/SocialScan/g).length, 1, "the explorer name appears only in its meta tag");
    for (const text of [html, ...scripts.map(({ text }) => text)]) assert.doesNotMatch(text, /pharosscan/i, "no trace of the earlier explorer");
    assert.match(script("lab.js"), /const name = explorer\.dataset\.name\?\.trim\(\);\n {4}const slot = link\.querySelector\("\.explorer-name"\);\n {4}if \(name && slot\) slot\.textContent = name;/);
    assert.match(script("lab.js"), /const explorer = document\.querySelector\('meta\[name="explorer"\]'\);\n {2}const href = explorerUrl\(explorer\?\.content, kind, value\);/);
    for (const link of html.match(/<a class="action"[^>]*>/g)) {
      assert.doesNotMatch(link, /\shref=/, "no explorer link exists until a value is checked");
      assert.match(link, /\shidden>$/);
    }
    const base = "https://pharos.socialscan.io";
    const hash = `0x${"0123456789abcdef".repeat(4)}`;
    assert.equal(explorerUrl(base, "address", USDC), `${base}/address/${USDC}`);
    assert.equal(explorerUrl(`${base}/`, "tx", hash), `${base}/tx/${hash}`);
    assert.equal(explorerUrl(base, "block", "20384112"), `${base}/block/20384112`);
    assert.equal(explorerUrl(base, "block", "0"), `${base}/block/0`);
    // Malformed values never become links.
    for (const [kind, value] of [
      ["address", USDC.slice(0, -1)], ["address", `${USDC}0`], ["address", USDC.slice(2)], ["address", `0x${"g".repeat(40)}`], ["address", ` ${USDC}`],
      ["address", `${USDC}/../../x`], ["address", hash], ["address", "javascript:alert(1)"], ["address", null], ["address", undefined], ["address", ""],
      ["tx", USDC], ["tx", `${hash}"`], ["tx", `${hash}?x=1`], ["block", "0x10"], ["block", "-1"], ["block", "1.5"], ["block", "007"], ["block", "1e9"], ["block", ""],
      ["token", USDC], ["__proto__", USDC], ["constructor", USDC], [undefined, USDC],
    ]) assert.equal(explorerUrl(base, kind, value), null, `${kind} ${value}`);
    // Nor does a base that is not a bare https origin.
    for (const bad of ["http://pharos.socialscan.io", "https://pharos.socialscan.io/address", "https://pharos.socialscan.io?x=1", "https://pharos.socialscan.io#x", "https://user@pharos.socialscan.io", "https://pharos.socialscan.io:8443", "javascript:alert(1)", "//pharos.socialscan.io", "pharos.socialscan.io", "", undefined, null]) {
      assert.equal(explorerUrl(bad, "address", USDC), null, String(bad));
    }
  });

  test("the browser calls only this site's /api/state, /api/inspect and /api/explain: no MCP, RPC, AI provider or other client code", () => {
    assert.match(html, /<main id="main"[^>]* data-api="\/api\/state"/);
    assert.match(html, /<section class="section" id="inspector"[^>]* data-inspect-api="\/api\/inspect"/);
    assert.match(pageJs, /const API = main\.dataset\.api;/);
    assert.match(inspectorJs, /const API = root\.dataset\.inspectApi;/);
    assert.match(html, /<section class="section" id="inspector"[^>]* data-explain-api="\/api\/explain"/);
    assert.match(explainJs, /const API = inspector\.dataset\.explainApi;/);
    for (const { name, text } of scripts) {
      assert.doesNotMatch(text, /https?:\/\//, `${name} contains a URL`);
      assert.doesNotMatch(text, /XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|navigator\.connection/, name);
      assert.doesNotMatch(text, /jsonrpc|@modelcontextprotocol|mcp\.pharos|rpc\.pharos/i, name);
      assert.doesNotMatch(text, /deepseek|openai|anthropic|api[_-]?key|authorization|bearer/i, name);
      assert.doesNotMatch(text, /sessionStorage|indexedDB|document\.cookie/, name);
    }
    const fetches = Object.fromEntries(scripts.map(({ name, text }) => [name, (text.match(/\bfetch\(/g) ?? []).length]));
    assert.deepEqual(fetches, { "lab.js": 0, "tasks.js": 0, "theme.js": 0, "task-01.js": 1, "inspector.js": 1, "inspect-input.js": 0, "explain.js": 1, "explain-input.js": 0 });
    assert.match(pageJs, /fetch\(API, \{ headers: \{ accept: "application\/json" \}, cache: "no-store" \}\)/);
    assert.match(inspectorJs, /fetch\(`\$\{API\}\?q=\$\{encodeURIComponent\(check\.value\)\}`, \{ headers: \{ accept: "application\/json" \}, cache: "no-store", signal: controller\.signal \}\)/);
    // Explain posts the fixed request built from the result on screen, as JSON, and nothing else.
    assert.match(explainJs, /response = await fetch\(API, \{\n {6}method: "POST",\n {6}headers: \{ "content-type": "application\/json", accept: "application\/json" \},\n {6}body: JSON\.stringify\(request\),\n {6}cache: "no-store",\n {6}signal: controller\.signal,\n {4}\}\);/);
    assert.match(explainJs, /request = explainPayload\(event\.detail\);/);
  });

  test("only theme.js touches storage: one key, for the theme, on this device", () => {
    for (const { name, text } of scripts.filter((entry) => entry.name !== "theme.js")) assert.doesNotMatch(text, /localStorage/, name);
    assert.match(themeJs, /const KEY = "agent-arena-lab:theme";/);
    const uses = [...themeJs.matchAll(/localStorage\.(\w+)\(([^)]*)\)/g)].map(([, method, args]) => `${method}(${args})`);
    assert.deepEqual(uses.sort(), ["getItem(KEY)", "removeItem(KEY)", "setItem(KEY, choice)"]);
  });

  test("never parses markup: chain data is written as text", () => {
    for (const { name, text } of scripts) {
      assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/, name);
      assert.doesNotMatch(text, /\beval\(|new Function\b|setTimeout\(\s*["'`]/, name);
    }
  });

  test("no analytics, trackers or third-party fonts", () => {
    const everything = [html, css, ...scripts.map(({ text }) => text)].join("\n");
    assert.doesNotMatch(everything, /gtag|googletagmanager|google-analytics|plausible|posthog|mixpanel|segment\.(?:io|com)|hotjar|clarity\.ms|_vercel\/insights|@vercel\/analytics|sentry|fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/i);
  });

  test("every element the scripts write to exists in the page", () => {
    const ids = new Set([...pageJs.matchAll(/\$\("([\w-]+)"\)/g)].map((match) => match[1]));
    assert.ok(ids.size > 30);
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing`);
    for (const attribute of ["data-refresh", "data-status-word", "data-status-detail", "data-block", "data-chain"]) assert.match(html, new RegExp(`\\s${attribute}[\\s>]`), attribute);
    const inspectorIds = new Set([...inspectorJs.matchAll(/\$\("([\w-]+)"\)/g)].map((match) => match[1]));
    assert.ok(inspectorIds.size >= 10);
    for (const id of inspectorIds) assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing`);
    const explainIds = new Set([...explainJs.matchAll(/\$\("([\w-]+)"\)/g)].map((match) => match[1]));
    assert.deepEqual([...explainIds].sort(), ["explain", "explain-body", "explain-meta", "explain-note", "explain-state", "explain-submit", "explain-text", "inspector"]);
    for (const id of explainIds) assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing`);
    assert.match(themeJs, /getElementById\("theme-toggle"\)/);
    assert.match(html, /<button class="theme-toggle" id="theme-toggle" type="button">/);
  });

  test("the inspector is independent of the Task 01 snapshot: its own state, never the page's", () => {
    assert.doesNotMatch(inspectorJs, /document\.body|setState|dataset\.state\b|data-status-|data-block|data-chain|data-refresh|"snapshot"|\$\("main"\)|getElementById\("main"\)/);
    assert.match(inspectorJs, /root\.dataset\.inspectState = state;/);
    assert.doesNotMatch(pageJs, /inspect/i);
    // Its rows are never .measured, so the snapshot's READING dim cannot reach them.
    assert.doesNotMatch(inspectorJs, /measured/);
  });
});

describe("the words on the page", () => {
  test("never says LIVE: the snapshot is a read at one block, not a stream", () => {
    assert.doesNotMatch(visibleText, /\blive\b/i);
    assert.doesNotMatch(html.match(/<head>[\s\S]*<\/head>/)[0], /\blive\b/i, "title or description");
    for (const [name, text] of literals) assert.doesNotMatch(text, /\blive\b/i, `${name}: "${text}"`);
    assert.deepEqual([...new Set(TASKS.map((task) => task.status))].sort(), ["available", "planned"]);
  });

  test("names the snapshot for what it is: on-chain, fresh or cached, at a block, read at a time", () => {
    assert.match(pageJs, /const STATUS_WORD = \{ reading: "Reading", fresh: "Fresh snapshot", cached: "Cached snapshot", error: "Read failed" \};/);
    assert.match(pageJs, /const TONE = \{ reading: "active", fresh: "success", cached: "neutral", error: "error" \};/);
    assert.match(html, /<h2 class="label" id="snapshot-h">On-chain snapshot<\/h2>/);
    assert.match(visibleText, /Block — read at —/);
    assert.match(visibleText, /On-chain state via Pharos Chain MCP/);
    assert.match(visibleText, /Total supply/);
    assert.match(html, /<button class="btn" type="button" data-refresh>.*<span class="swap"><span>Refresh<span class="wide-only"> snapshot<\/span><\/span><span>Reading…<\/span><\/span><\/button>/);
    assert.match(pageJs, /last \? "showing the last good snapshot" : "no snapshot yet", `\$\{problem\} Refresh to try again\.`\)/);
  });

  test("paused reads Yes or No: Yes in the warning tone, No in none, and nothing claims more than the flag", () => {
    // The fifth read sits last, so the four rows above it keep their place on the smallest screens.
    assert.match(html, /<div><dt>network<\/dt><dd>[\s\S]*?<\/dd><\/div>\n {8}<div><dt>paused<\/dt><dd id="v-paused">—<\/dd><\/div>\n {6}<\/dl>/);
    assert.match(pageJs, /setText\(paused, values\.paused === true \? "Yes" : values\.paused === false \? "No" : "—"\);/);
    assert.match(pageJs, /if \(values\.paused === true\) paused\.dataset\.tone = "warning";\n {2}else delete paused\.dataset\.tone;/);
    assert.match(rules, /\.rows dd\[data-tone="warning"\] \{ color: var\(--warning\); font-weight: 600; \}/);
    assert.match(rules, /\.rows\.cols-2 > div:last-child:nth-child\(odd\) \{ grid-column: 1 \/ -1; \}/);
    assert.match(visibleText, /and its pause flag, paused ?, all pinned to one explicit block/);
    assert.doesNotMatch(visibleText, /\b(?:safe|healthy)\b/i);
    for (const [name, text] of literals) assert.doesNotMatch(text, /\b(?:safe|healthy)\b/i, `${name}: "${text}"`);
  });

  test("fresh or cached is decided by the response itself", () => {
    const at = "2026-10-14T09:34:03.000Z";
    const headers = (entries = {}) => new Headers(entries);
    assert.deepEqual(snapshotSource(headers(), at, undefined), { cached: false, detail: "" });
    assert.deepEqual(snapshotSource(headers({ "x-vercel-cache": "MISS" }), at, "2026-10-14T09:33:00.000Z"), { cached: false, detail: "" });
    assert.deepEqual(snapshotSource(headers({ "x-vercel-cache": "HIT", age: "12" }), at, undefined), { cached: true, detail: "12 s old" });
    assert.deepEqual(snapshotSource(headers({ "x-vercel-cache": "STALE" }), at, undefined), { cached: true, detail: "served from the edge cache" });
    assert.deepEqual(snapshotSource(headers({ age: "40" }), at, undefined), { cached: true, detail: "40 s old" });
    assert.deepEqual(snapshotSource(headers({ age: "0" }), at, undefined), { cached: false, detail: "" });
    assert.deepEqual(snapshotSource(headers({ age: "soon" }), at, undefined), { cached: false, detail: "" });
    // The read already on screen is the same read, whatever the headers say.
    assert.deepEqual(snapshotSource(headers({ "x-vercel-cache": "MISS" }), at, at), { cached: true, detail: "same read as before" });
    assert.match(pageJs, /snapshotSource\(response\.headers, data\.fetchedAt, last\?\.fetchedAt\)/);
  });
});

describe("the page reports evidence, not certification", () => {
  test("names the client path precisely: zero direct RPC calls from this client, MCP-only", () => {
    assert.match(visibleText, /Direct RPC calls from this client 0 MCP-only client path/);
    for (const match of visibleText.matchAll(/direct rpc/gi)) {
      assert.match(visibleText.slice(match.index), /^Direct RPC calls from this client/i, "every Direct RPC claim is scoped to this client");
    }
    assert.match(visibleText, /opens no JSON-RPC connection of its own\. Pharos MCP talks to the chain on its side\./);
  });

  test("makes no certification claims anywhere", () => {
    const everything = [html, ...scripts.map(({ text }) => text)].join("\n");
    assert.doesNotMatch(everything, /verif|certif|guarantee|audited|trustless|100%/i);
  });

  test("keeps the contract reads apart from the context calls, and takes both counts from the report's call model", () => {
    assert.match(visibleText, /Explicit block 1/);
    assert.match(visibleText, /get_chain_info Context: confirms chain ID/);
    assert.match(visibleText, /get_block_number Context: fixes block/);
    // Placeholders until the first read: the page states the counts the report gives, never its own.
    assert.match(html, /<div><dt>Contract reads<\/dt><dd class="count-n" id="proof-reads">—<\/dd><dd class="count-note" id="proof-reads-list">—<\/dd><\/div>/);
    assert.match(html, /<dd class="count-n" id="proof-calls">—<\/dd><dd class="count-note" id="proof-calls-sub">—<\/dd>/);
    assert.match(html, /<code class="step-k" id="step-reads">eth_call<\/code><span class="step-d">Contract reads: <span id="step-reads-list">—<\/span>, each at block <span data-block>—<\/span><\/span>/);
    // One call per context tool and per contract read, from source.contextCalls and source.contractReads;
    // anything beyond that is a same-block retry. No count is written into the page script.
    assert.match(pageJs, /const reads = source\.contractReads;\n {2}const context = source\.contextCalls;\n {2}const calls = source\.toolCalls;\n {2}const retries = calls - context\.length - reads\.length;/);
    assert.match(pageJs, /`\$\{context\.length\} context \+ \$\{reads\.length\} contract reads`/);
    assert.match(pageJs, /setText\(\$\("t-calls"\), `\$\{calls\}: \$\{context\.join\(", "\)\}, eth_call ×\$\{calls - context\.length\}`\);/);
    assert.doesNotMatch(pageJs, /calls - \d|toolCalls - \d|×\d|\d context|\d contract reads/);
  });

  test("shows the frozen contract and the real ERC-20 selectors", () => {
    assert.equal(USDC, "0xC879C018dB60520F4355C26eD1a6D572cdAC1815");
    assert.equal(html.match(new RegExp(USDC, "g")).length, 2);
    const selectors = Object.fromEntries([...visibleText.matchAll(/(\w+)\(\) (0x[0-9a-f]{8})/g)].map(([, fn, selector]) => [fn, selector]));
    assert.deepEqual(Object.keys(selectors).sort(), ["decimals", "name", "paused", "symbol", "totalSupply"]);
    for (const [fn, selector] of Object.entries(selectors)) assert.equal(selector, toFunctionSelector(`${fn}()`), fn);
  });

  test("the proof is one disclosure, collapsed until asked for, with every piece of evidence inside", () => {
    assert.equal(html.match(/<details\b/g).length, 1);
    assert.doesNotMatch(html, /<details[^>]*\sopen/);
    const proof = html.match(/<details class="disclosure" id="proof">([\s\S]*?)<\/details>/)[1];
    assert.match(proof, /<summary>\s*<h2 class="disclosure-title" id="proof-h">Proof &amp; technical details<\/h2>/);
    for (const piece of ['class="counts"', 'class="steps"', 'class="kv"', 'id="v-raw"', 'id="t-raw"', "get_transaction_receipt", "proof/mcp-transcript.json", "MCP-only client path", "Direct RPC calls from this client"]) {
      assert.ok(proof.includes(piece), piece);
    }
    assert.match(pageJs, /link\.addEventListener\("click", \(\) => void \(\$\("proof"\)\.open = true\)\)/);
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

  test("only Task 01 is available and has a page; every other task is planned with no path", () => {
    assert.deepEqual(TASKS.filter((task) => task.status === "available").map((task) => [task.n, task.path]), [["01", "/"]]);
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

  test("a hex value may break only at its middle (address) or quarters (hash), and the parts rebuild it exactly", () => {
    assert.deepEqual(hexParts(USDC), ["0xC879C018dB60520F4355", "C26eD1a6D572cdAC1815"]);
    const hash = `0x${"0123456789abcdef".repeat(4)}`;
    assert.deepEqual(hexParts(hash), [`0x${"0123456789abcdef"}`, "0123456789abcdef", "0123456789abcdef", "0123456789abcdef"]);
    for (const value of [USDC, hash]) assert.equal(hexParts(value).join(""), value);
    for (const other of ["0x1234", `${USDC}00`, "C879C018dB60520F4355C26eD1a6D572cdAC1815", `0x${"g".repeat(40)}`, "<b>0x</b>", ""]) assert.equal(hexParts(other), null, other);
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

  test("renderHex shows the exact value as one run: no spaces, only <wbr> at its break points", () => {
    withDocument(() => {
      const address = element();
      renderHex(address, USDC);
      assert.equal(address.textContent, USDC);
      assert.doesNotMatch(address.textContent, /\s/);
      assert.deepEqual(address.children.map((node) => node.tagName), ["SPAN", "WBR", "SPAN"]);
      const hash = element();
      renderHex(hash, `0x${"ab".repeat(32)}`);
      assert.equal(hash.textContent, `0x${"ab".repeat(32)}`);
      assert.deepEqual(hash.children.map((node) => node.tagName), ["SPAN", "WBR", "SPAN", "WBR", "SPAN", "WBR", "SPAN"]);
      const odd = element();
      renderHex(odd, "<b>not an address</b>");
      assert.equal(odd.textContent, "<b>not an address</b>");
      assert.equal(odd.children.length, 0);
    });
  });

  test("renderTaskContext links only an available task with a page", () => {
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

      const available = TASKS.map((task) => (task.n === "02" ? { ...task, status: "available", path: "/02" } : task));
      renderTaskContext(available, "01", { next });
      const link = next.children.find((node) => node.className === "t");
      assert.deepEqual([link.tagName, link.href], ["A", "/02"]);
      assert.equal(next.children.at(-1).textContent, "Available");
    });
  });
});

describe("two themes", () => {
  /** The custom properties of one CSS block, in order: { name: value }. */
  const block = (start) => {
    const at = css.indexOf(start);
    assert.ok(at >= 0, start);
    const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
    return Object.fromEntries([...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
  };
  const dark = block(":root {");
  const light = block(':root[data-theme="light"] {');
  const lightSystem = block(":root:not([data-theme]) {");
  const colours = Object.keys(light);
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  test("light is a designed theme: every colour token is redefined, and chosen or from the system it is the same", () => {
    assert.match(css, /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme\]\) \{/);
    assert.ok(colours.length >= 19, colours.join(", "));
    for (const name of colours) assert.ok(name in dark, `${name} has no dark value`);
    for (const [name, value] of Object.entries(dark)) {
      if (/^#|^(visible|hidden)$/.test(value)) assert.ok(name in light, `${name} is not redefined for light`);
    }
    assert.deepEqual(lightSystem, light);
    // Pharos Blue and White on it are the brand itself, the same in both themes; everything else differs.
    for (const name of colours) {
      if (light[name].startsWith("#") && !["--brand", "--on-brand"].includes(name)) assert.notEqual(light[name], dark[name], `${name} is the same in both themes`);
    }
    assert.match(html, /<meta name="color-scheme" content="dark light">/);
  });

  test("built on the Pharos brand kit: Blue #0113B7 as is, Black, Dark Gray, Light Gray and White", () => {
    for (const theme of [dark, light, lightSystem]) {
      assert.equal(theme["--brand"], "#0113B7", "Pharos Blue is never lightened or replaced");
      assert.equal(theme["--on-brand"], "#FFFFFF");
    }
    assert.deepEqual([dark["--bg"], dark["--field"], dark["--line-strong"]], ["#0B0B0B", "#0B0B0B", "#343434"]);
    assert.deepEqual([light["--surface"], light["--field"], light["--line"], light["--text"], light["--text-2"]], ["#FFFFFF", "#FFFFFF", "#DFE3E5", "#0B0B0B", "#343434"]);
    // Pharos Blue reads as text on light grounds, so light needs no other blue.
    assert.equal(light["--accent"], "#0113B7");
    // The canonical blue is used for fills and marks only: never as text or as a focus ring.
    for (const [line] of rules.matchAll(/[^\n]*var\(--brand\)[^\n]*/g)) {
      for (const declaration of line.match(/[\w-]+:\s*var\(--brand\)/g)) assert.match(declaration, /^(?:background|border-color):/, line);
    }
    assert.match(rules, /\.btn-primary \{[^}]*border-color: var\(--brand-edge\); background: var\(--brand\); color: var\(--on-brand\);/);
    assert.match(rules, /\.btn-primary:hover, \.btn-primary:active \{ border-color: var\(--brand-edge-hover\); background: var\(--brand-hover\); \}/);
    // Dark gives the Pharos Blue control an edge in the derived blue it already uses; light keeps the
    // fill as its own edge, exactly as before.
    assert.deepEqual([dark["--brand-edge"], dark["--brand-edge-hover"]], [dark["--accent"], dark["--accent"]]);
    assert.deepEqual([light["--brand-edge"], light["--brand-edge-hover"]], [light["--brand"], light["--brand-hover"]]);
  });

  test("dark uses a derived interaction blue only because Pharos Blue cannot be read on Black", () => {
    const oklch = (hex) => {
      const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt);
      const [L, a, bb] = [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
      return { L, h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
    };
    assert.ok(ratio(dark["--brand"], dark["--bg"]) < 4.5, "if Pharos Blue were readable on Black, it would be used as is");
    assert.equal(dark["--accent"], "#4F84FF");
    const brand = oklch(dark["--brand"]);
    const derived = oklch(dark["--accent"]);
    assert.ok(Math.abs(derived.h - brand.h) < 1.5, `same hue as Pharos Blue: ${derived.h.toFixed(1)} vs ${brand.h.toFixed(1)}`);
    assert.ok(Math.abs(derived.L - 0.64) < 0.01 && Math.abs(brand.L - 0.364) < 0.01, `lightness raised from ${brand.L.toFixed(3)} to ${derived.L.toFixed(3)}`);
    for (const ground of ["--bg", "--surface", "--surface-2"]) assert.ok(ratio(dark["--accent"], dark[ground]) >= 4.5, ground);
    assert.match(css, /Pharos Blue is 1\.67:1 on Black: too dark here for text or focus rings, so those use a derived\s+interaction blue/);
  });

  test("every text colour passes WCAG AA in both themes; inputs and focus are visible", () => {
    for (const [name, theme] of [["dark", dark], ["light", light]]) {
      for (const text of ["--text", "--text-2", "--text-3", "--accent"]) {
        for (const ground of ["--bg", "--surface", "--surface-2", "--field"]) {
          assert.ok(ratio(theme[text], theme[ground]) >= 4.5, `${name}: ${text} on ${ground} is ${ratio(theme[text], theme[ground]).toFixed(2)}:1`);
        }
      }
      assert.ok(ratio(theme["--on-brand"], theme["--brand"]) >= 4.5, `${name}: text on the primary button`);
      assert.ok(ratio(theme["--on-brand"], theme["--brand-hover"]) >= 4.5, `${name}: text on the hovered primary button`);
      for (const tone of ["--success", "--warning", "--error", "--accent"]) {
        for (const ground of ["--surface", "--bg"]) assert.ok(ratio(theme[tone], theme[ground]) >= 3, `${name}: ${tone} dot on ${ground}`);
      }
      for (const ground of ["--surface", "--field"]) assert.ok(ratio(theme["--field-line"], theme[ground]) >= 3, `${name}: input edge on ${ground}`);
      // The primary control's own boundary, at rest and on hover, against the panel and the page.
      for (const edge of ["--brand-edge", "--brand-edge-hover"]) {
        for (const ground of ["--surface", "--bg"]) assert.ok(ratio(theme[edge], theme[ground]) >= 3, `${name}: ${edge} on ${ground} is ${ratio(theme[edge], theme[ground]).toFixed(2)}:1`);
      }
    }
    assert.match(rules, /:focus-visible \{ outline: 2px solid var\(--accent\);/);
  });

  test("theme.js and lab.css agree on each theme's background", () => {
    assert.match(themeJs, new RegExp(`const BACKGROUND = \\{ dark: "${dark["--bg"]}", light: "${light["--bg"]}" \\};`));
    assert.match(html, new RegExp(`<meta name="theme-color" content="${dark["--bg"]}" media="\\(prefers-color-scheme: dark\\)">`));
    assert.match(html, new RegExp(`<meta name="theme-color" content="${light["--bg"]}" media="\\(prefers-color-scheme: light\\)">`));
  });

  /** Run theme.js against a fake browser: storage, the system setting, the toggle and two metas. */
  function runTheme({ saved, system = "dark", storage = "ok" } = {}) {
    const store = new Map(saved === undefined ? [] : [["agent-arena-lab:theme", saved]]);
    const failing = () => {
      throw new Error("storage is blocked");
    };
    const localStorage = storage === "ok"
      ? { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, String(value)), removeItem: (key) => void store.delete(key) }
      : { getItem: failing, setItem: failing, removeItem: failing };
    const listeners = {};
    const on = (target) => (type, fn) => void (listeners[`${target}:${type}`] = fn);
    const attributes = new Map();
    const button = { setAttribute: (name, value) => attributes.set(name, value), addEventListener: on("button") };
    const root = { dataset: {}, classList: { names: new Set(), add(name) { this.names.add(name); } } };
    const metas = [{ media: "(prefers-color-scheme: dark)", content: dark["--bg"] }, { media: "(prefers-color-scheme: light)", content: light["--bg"] }];
    const media = { matches: system === "light", addEventListener: on("media") };
    const document = {
      documentElement: root,
      getElementById: (id) => (id === "theme-toggle" && listeners["document:DOMContentLoaded:fired"] ? button : null),
      querySelectorAll: (selector) => (selector === 'meta[name="theme-color"]' ? metas : []),
      addEventListener: on("document"),
    };
    vm.runInNewContext(themeJs, { document, localStorage, matchMedia: () => media, addEventListener: on("window") });
    const ready = () => {
      listeners["document:DOMContentLoaded:fired"] = true;
      listeners["document:DOMContentLoaded"]();
    };
    return { root, store, metas, media, attributes, listeners, ready, click: () => listeners["button:click"]() };
  }

  test("with nothing saved the page follows the system, and the toggle offers the other theme", () => {
    const onDark = runTheme({ system: "dark" });
    assert.equal(onDark.root.dataset.theme, undefined);
    assert.ok(onDark.root.classList.names.has("js"));
    onDark.ready();
    assert.equal(onDark.attributes.get("aria-label"), "Switch to light theme");
    assert.deepEqual(onDark.metas.map((meta) => meta.content), [dark["--bg"], light["--bg"]]);

    const onLight = runTheme({ system: "light" });
    onLight.ready();
    assert.equal(onLight.root.dataset.theme, undefined);
    assert.equal(onLight.attributes.get("aria-label"), "Switch to dark theme");
  });

  test("a saved choice applies before the first paint, browser colour included", () => {
    const page = runTheme({ saved: "light", system: "dark" });
    assert.equal(page.root.dataset.theme, "light", "set by the head script, before DOMContentLoaded");
    assert.deepEqual(page.metas.map((meta) => meta.content), [light["--bg"], light["--bg"]]);
    page.ready();
    assert.equal(page.attributes.get("aria-label"), "Switch to dark theme");
    assert.equal(runTheme({ saved: "blue" }).root.dataset.theme, undefined, "an unknown value is ignored");
  });

  test("the toggle switches and remembers; switching back to the system's theme forgets", () => {
    const page = runTheme({ system: "dark" });
    page.ready();
    page.click();
    assert.equal(page.root.dataset.theme, "light");
    assert.equal(page.store.get("agent-arena-lab:theme"), "light");
    assert.equal(page.attributes.get("aria-label"), "Switch to dark theme");
    page.click();
    assert.equal(page.root.dataset.theme, undefined, "dark is the system's theme: follow the system again");
    assert.equal(page.store.has("agent-arena-lab:theme"), false);
    assert.deepEqual(page.metas.map((meta) => meta.content), [dark["--bg"], light["--bg"]]);

    // A choice made in another tab applies here too.
    page.store.set("agent-arena-lab:theme", "light");
    page.listeners["window:storage"]({ key: "agent-arena-lab:theme" });
    assert.equal(page.root.dataset.theme, "light");
  });

  test("blocked storage never breaks the page: the toggle still works for the visit", () => {
    const page = runTheme({ storage: "blocked", system: "light" });
    assert.equal(page.root.dataset.theme, undefined);
    page.ready();
    page.click();
    assert.equal(page.root.dataset.theme, "dark");
  });
});

describe("design system", () => {
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
    assert.ok(declarations(motion) >= 8);
    assert.equal(declarations(css), declarations(motion), "an animation or transition is declared outside the no-preference block");
    assert.equal(declarations(html), 0);
    // The disclosure animates only through ::details-content, so it degrades to an instant toggle.
    assert.match(motion, /\.disclosure::details-content \{ height: 0; overflow: clip; transition:/);
  });

  test("the supply is one continuous value in Geist SemiBold: one size, normal punctuation, nothing reshaped", () => {
    assert.match(html, /<p class="figure measured" id="supply"><span class="figure-num" id="supply-amount">—<\/span><span class="figure-unit" id="supply-unit"><\/span><\/p>/);
    assert.match(rules, /\.figure \{[^}]*white-space: nowrap;[^}]*font-family: var\(--sans\);[^}]*font-weight: 600;/);
    assert.match(pageJs, /setText\(\$\("supply-amount"\), supply\.major \+ supply\.minor\);/);
    assert.doesNotMatch(`${rules}\n${html}\n${pageJs}`, /figure-frac|supply-minor|\.sep\b|"sep"|scaleX|font-stretch/);
    const figureRules = [...rules.matchAll(/([^{}]*figure[^{}]*)\{([^{}]*)\}/g)].map((match) => match[2]);
    assert.ok(figureRules.length >= 4);
    for (const body of figureRules) assert.doesNotMatch(body, /margin[\w-]*:\s*-|letter-spacing:\s*-/, body);
  });

  test("every value a reader needs is set in Geist: never Departure Mono, never Geist Mono", () => {
    const using = (token) => [...rules.matchAll(new RegExp(`([^{}]+)\\{[^{}]*var\\(${token}\\)[^{}]*\\}`, "g"))].flatMap((match) => match[1].split(",").map((part) => part.trim()));
    const values = /figure|\.meta|\.rows dd|count-n|\.status|task-title|task-via|step-n|section-title|disclosure-title/;
    for (const selector of [...using("--caption"), ...using("--mono")]) assert.doesNotMatch(selector, values, selector);
    assert.match(html, /<span>Block <b id="block">—<\/b><\/span><span>read at <b id="read-at">—<\/b><\/span>/);
    assert.match(html, /<span class="sub">Chain ID <span data-chain>—<\/span><\/span>/);
  });

  test("readable sizes: captions at 12px, and no text set smaller", () => {
    assert.match(rules, /--fs-label: \.75rem;/);
    for (const [, value, unit] of rules.matchAll(/font-size:\s*(\d*\.?\d+)(rem|px)\b/g)) assert.ok(Number(value) * (unit === "rem" ? 16 : 1) >= 12, `font-size ${value}${unit}`);
    const tokens = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    const sizes = [...tokens.matchAll(/(--fs-[\w-]+):\s*([\d.]+)rem;/g)];
    assert.ok(sizes.length >= 5);
    for (const [, name, value] of sizes) assert.ok(Number(value) * 16 >= 12, `${name}: ${value}rem`);
  });

  test("every control answers a press: the hover look, or a darker fill for a bordered control", () => {
    for (const selector of [".theme-toggle", ".icon-link", ".jump a", ".btn-primary", ".btn-quiet", ".disclosure > summary", ".links a"]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(rules, new RegExp(`${escaped}:active`), selector);
    }
    assert.match(rules, /\.btn:not\(\.btn-primary\):active \{ background: var\(--line\); \}/);
    assert.match(rules, /\.action:active \{ background: var\(--line\); \}/);
  });

  test("controls offer a 44px target: buttons, toggles, footer icons and jump links; a 32px action by its hit area", () => {
    for (const rule of [
      /\.btn \{[^}]*min-height: 44px;/,
      /\.btn-quiet \{[^}]*min-height: 44px;/,
      /\.btn-primary \{ min-height: 48px;/,
      /\.theme-toggle \{[^}]*min-width: 44px; min-height: 44px;/,
      /\.icon-link \{[^}]*width: 44px; height: 44px;/,
      /\.jump a \{[^}]*min-height: 44px;/,
      /\.input \{[^}]*min-height: 48px;/,
    ]) assert.match(rules, rule);
  });

  test("Departure Mono is kept to small captions, through .label only", () => {
    const selectors = [...rules.matchAll(/([^{}]+)\{[^{}]*var\(--caption\)[^{}]*\}/g)].flatMap((match) => match[1].split(",").map((part) => part.trim()));
    assert.deepEqual([...new Set(selectors)], [".label"]);
    for (const caption of ["On-chain snapshot", "Total supply", "Contract", 'Task <span class="task-n">01</span> / Read Contract State']) {
      assert.match(html, new RegExp(`class="label[^"]*"[^>]*>${caption}<`), caption);
    }
  });

  test("restrained type: one uppercase style, no wide tracking, no glow or glass", () => {
    const uppercase = [...rules.matchAll(/([^{}]+)\{[^{}]*text-transform: uppercase[^{}]*\}/g)].map((match) => match[1].trim());
    assert.deepEqual(uppercase, [".label"]);
    for (const [, value] of `${css}\n${html}`.matchAll(/letter-spacing:\s*(-?[\d.]+)em/g)) assert.ok(Number(value) <= 0.06, `letter-spacing ${value}em`);
    assert.doesNotMatch(`${css}\n${html}`, /box-shadow|text-shadow|drop-shadow|backdrop-filter|linear-gradient|radial-gradient/);
  });

  test("colour stays semantic: green, amber and red only for their states", () => {
    const uses = (token) => [...rules.matchAll(new RegExp(`[^\\n]*var\\(${token}\\)[^\\n]*`, "g"))].map((match) => match[0].trim());
    for (const line of uses("--success")) assert.match(line, /\[data-tone="success"\]/, line);
    for (const line of uses("--warning")) assert.match(line, /\[data-tone="warning"\]/, line);
    for (const line of uses("--error")) assert.match(line, /\[data-tone="error"\]|\[aria-invalid="true"\]/, line);
    assert.ok(uses("--success").length >= 1 && uses("--warning").length >= 2 && uses("--error").length >= 3);
    assert.match(inspectorJs, /const TONE = \{ inspecting: "active", success: "success", partial: "warning", "not-found": "neutral", error: "error" \};/);
  });

  test("hex values are one continuous run that splits only into equal lines", () => {
    for (const rule of [
      /\.hex \{ display: block; line-height: 1\.6; color: var\(--text\); text-wrap: wrap; overflow-wrap: anywhere; \}/,
      /\.hex-hash \{ max-width: 26ch; \}/,
      /@container hex \(min-width: 36ch\) \{ \.hex-hash \{ max-width: 40ch; \} \}/,
      /@container hex \(min-width: 67ch\) \{ \.hex-hash \{ max-width: none; \} \}/,
    ]) assert.match(rules, rule);
    // The value measures its own width: its actions sit on their own row, never beside it.
    assert.doesNotMatch(rules, /copyable/);
    // Nothing spaces the characters out any more.
    assert.doesNotMatch(rules, /\.hex > span|\.hex \.group|hex-address/);
    // A hash breaks at its quarters: lines of 16 digits, the first also carrying "0x". A max-width
    // must hold the first line and no line one quarter longer: 26ch gives 4 x 16, 40ch gives 2 x 32.
    const lines = (max) => {
      const quarters = [18, 16, 16, 16];
      const out = [];
      for (const width of quarters) {
        if (out.length && out.at(-1) + width <= max) out[out.length - 1] += width;
        else out.push(width);
      }
      return out;
    };
    assert.deepEqual(lines(26), [18, 16, 16, 16]);
    assert.deepEqual(lines(40), [34, 32]);
    assert.deepEqual(lines(Infinity), [66]);
  });

  test("a value's actions are one group under it: Copy and View on the explorer, words that change in place", () => {
    assert.equal(html.match(/<div class="actions">/g).length, 3, "the snapshot's contract, the inspector's template and the proof's block");
    const buttons = html.match(/<button class="action copy"[^>]*>[\s\S]*?<\/button>/g);
    assert.equal(buttons.length, 2, "the snapshot's button and the inspector's template");
    for (const button of buttons) {
      assert.match(button, /data-copy="idle"><span class="swap copy-icons" aria-hidden="true"><svg [^>]*>[\s\S]*?<\/svg><svg [^>]*>[\s\S]*?<\/svg><\/span><span class="swap copy-words"><span>Copy<\/span><span>Copied<\/span><\/span><span class="sr copy-what">[^<]*<\/span><\/button>$/);
    }
    const links = html.match(/<a class="action"[^>]*>[\s\S]*?<\/a>/g);
    assert.equal(links.length, 3);
    for (const link of links) assert.match(link, /^<a class="action"(?: id="[\w-]+")? hidden><span>View on <span class="explorer-name">the explorer<\/span><\/span><svg class="ext" viewBox="0 0 16 16" aria-hidden="true" focusable="false">/);
    assert.match(html, /<template id="actions-template"><div class="actions"><button class="action copy"/);
    assert.match(pageJs, /wireCopy\(\$\("copy"\), \{ value: /);
    assert.match(inspectorJs, /wireCopy\(button, \{ value: \(\) => hex, /);
    // Explorer links: the contract and its block from the read, an inspected address or hash, and
    // never a hash that was not found (there is nothing to show for it).
    assert.match(pageJs, /linkExplorer\(\$\("contract-explorer"\), "address", contract\.address, "contract address"\);/);
    assert.match(pageJs, /linkExplorer\(\$\("block-explorer"\), "block", data\.blockNumber, `block \$\{block\}`\);/);
    assert.match(inspectorJs, /if \(explorer\) linkExplorer\(link, explorer, hex, what\);\n {2}if \(link\.hidden\) link\.remove\(\);/);
    assert.deepEqual([...inspectorJs.matchAll(/explorer: "(\w+)"/g)].map((match) => match[1]), ["address", "tx"]);
    assert.match(inspectorJs, /\["Hash", data\.hash, \{ hex: true, copy: "transaction hash" \}\]/);
    // A utility action: 32px to see, 44px to hit; its words and icon share one cell each.
    assert.match(rules, /\.action \{[^}]*height: 32px;[^}]*border: 1px solid var\(--line-strong\);/);
    assert.match(rules, /\.action::after \{ content: ""; position: absolute; inset: -7px -1px; \}/);
    assert.match(rules, /\.swap > \* \{ grid-area: 1 \/ 1; \}/);
    assert.match(rules, /\.copy:not\(\[data-copy="copied"\]\) \.swap > :last-child, \.copy\[data-copy="copied"\] \.swap > :first-child,/);
  });

  test("Sources are one set: title and arrow on one line, a path that breaks only between segments", () => {
    const links = html.match(/<ul class="links">([\s\S]*?)<\/ul>/)[1].match(/<a [\s\S]*?<\/a>/g);
    assert.equal(links.length, 3);
    for (const link of links) assert.match(link, /^<a href="[^"]+"(?: target="_blank" rel="noopener noreferrer")?><span class="link-title">[^<]+<\/span><svg class="link-arrow"[\s\S]*?<\/svg><span class="link-meta">/);
    // Out arrow and a new tab for the two on GitHub; an arrow across for this site's own data.
    assert.deepEqual(links.map((link) => [/target="_blank"/.test(link), link.match(/<path d="([^"]+)"/)[1]]), [[true, "M5 11l6-6M6 5h5v5"], [true, "M5 11l6-6M6 5h5v5"], [false, "M3 8h10M9 4l4 4-4 4"]]);
    assert.match(links[0], /<span class="link-meta"><span class="nowrap">Rzbyte\/<\/span><wbr><span class="nowrap">pharos-season-of-ai<\/span><\/span>/);
    assert.match(links[1], /<span class="link-meta"><span class="nowrap">proof\/<\/span><wbr><span class="nowrap">mcp-transcript\.json<\/span><\/span>/);
    assert.match(rules, /\.link-arrow \{ grid-column: 2; grid-row: 1; align-self: center;/);
    assert.match(rules, /@media \(min-width: 960px\) \{\s*\.links \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  });

  test("the footer links are icons with names: GitHub, the Pharos docs and X, nothing guessed", () => {
    const footer = html.match(/<footer class="foot">[\s\S]*<\/footer>/)[0];
    const links = [...footer.matchAll(/<a class="icon-link" href="([^"]+)" target="_blank" rel="noopener noreferrer" aria-label="([^"]+)" title="([^"]+)"><svg viewBox="[^"]+" aria-hidden="true" focusable="false">/g)].map(([, href, label, title]) => [href, label, title]);
    assert.deepEqual(links, [
      ["https://github.com/Rzbyte/pharos-season-of-ai", "Source code on GitHub, opens in a new tab", "GitHub"],
      ["https://docs.pharos.xyz/", "Pharos documentation, opens in a new tab", "Pharos Docs"],
      ["https://x.com/rzbyte_", "rzbyte_ on X, opens in a new tab", "X"],
    ]);
    assert.equal(footer.match(/<a\b/g).length, 3, "no other footer links");
    assert.match(footer, /<nav aria-label="Elsewhere">/);
    assert.match(rules, /\.icon-link \{ display: grid; place-items: center; width: 44px; height: 44px;/);
    assert.match(rules, /\.icon-link svg \{ width: 20px; height: 20px; \}/);
    assert.match(rules, /\.icon-link:hover, \.icon-link:focus-visible, \.icon-link:active \{ color: var\(--accent\); \}/);
  });
});

describe("accessible structure", () => {
  test("one h1, then h2 sections, then h3 only inside the proof and the Inspector's explanation", () => {
    const headings = [...html.matchAll(/<h([1-6])\b[^>]*>(.*?)<\/h\1>/g)].map(([, level, text]) => [Number(level), text.replace(/<[^>]+>/g, "")]);
    assert.deepEqual(headings.filter(([level]) => level === 1), [[1, "Circle USDC Contract"]]);
    assert.deepEqual(headings.filter(([level]) => level === 2).map(([, text]) => text), ["On-chain snapshot", "Pharos Inspector", "Proof &amp; technical details", "Sources"]);
    const proof = html.match(/<details[\s\S]*<\/details>/)[0];
    const explanation = html.slice(html.indexOf('<div class="explain" id="explain"'), html.indexOf('<span class="sr" id="inspect-copy-state"'));
    assert.equal(html.match(/<h3\b/g).length, proof.match(/<h3\b/g).length + 1);
    assert.equal(explanation.match(/<h3\b[^>]*>(.*?)<\/h3>/)[1], "Plain-language explanation");
    // The explanation's sections are h4, under that h3, inside the Inspector (h2).
    assert.match(explainJs, /element\("h4", "explain-h", section\.heading\)/);
  });

  test("labels, names and live regions are in place", () => {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<a class="skip" href="#snapshot">Skip to the snapshot<\/a>/);
    assert.match(html, /<section class="panel" id="snapshot" aria-labelledby="snapshot-h" tabindex="-1">/);
    assert.match(html, /<label class="field-label" for="inspect-input">Paste contract address or transaction hash<\/label>/);
    assert.match(html, /<input class="input" id="inspect-input"[^>]* aria-describedby="inspect-detected">/);
    assert.match(html, /<p class="status" id="status" role="status"/);
    assert.match(html, /<p class="status inspect-status" id="inspect-status" role="status" hidden>/);
    // Icons are decoration: each is hidden itself or sits inside a hidden wrapper.
    const unwrapped = html.replace(/<span class="[^"]*" aria-hidden="true">(?:\s*<svg[\s\S]*?<\/svg>)+\s*<\/span>/g, "");
    assert.ok(html.match(/<svg\b/g).length - unwrapped.match(/<svg\b/g).length >= 7, "theme, chevron and copy icons sit in hidden wrappers");
    for (const svg of unwrapped.match(/<svg\b[^>]*>/g)) assert.match(svg, /aria-hidden="true"/, svg);
    // Every button has words: its own text, or the name theme.js gives the theme toggle.
    for (const [, inner] of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) assert.match(inner.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim(), /\w/);
    assert.match(themeJs, /button\.setAttribute\("aria-label", `Switch to \$\{current\(\) === "dark" \? "light" : "dark"\} theme`\)/);
  });

  test("busy controls keep focus: aria-disabled, never disabled", () => {
    for (const text of [pageJs, inspectorJs]) {
      assert.doesNotMatch(text, /\.disabled\s*=/);
      assert.match(text, /setAttribute\("aria-disabled", String\(on\)\)/);
      assert.match(text, /setAttribute\("aria-busy", String\(on\)\)/);
    }
    assert.match(inspectorJs, /example\.addEventListener\("click", \(\) => \{\n {2}if \(busy\) return;/);
  });

  test("a busy button says what it is doing, in place: Reading… and Inspecting…, at the same size", () => {
    assert.match(html, /<button class="btn btn-primary" id="inspect-submit" type="submit"><span class="swap"><span>Inspect<\/span><span>Inspecting…<\/span><\/span><\/button>/);
    assert.match(html, /data-refresh>[^\n]*<span class="swap"><span>Refresh<span class="wide-only"> snapshot<\/span><\/span><span>Reading…<\/span><\/span><\/button>/);
    // The state picks the words (lab.css); no script rewrites them, so the button cannot resize.
    assert.match(rules, /\.btn:not\(\[aria-disabled="true"\]\) > \.swap > :last-child, \.btn\[aria-disabled="true"\] > \.swap > :first-child \{ visibility: hidden; \}/);
    assert.doesNotMatch(inspectorJs, /setText\(submit|submit\.textContent/);
    assert.doesNotMatch(pageJs, /\[data-refresh\][^;]*(?:textContent|setText)/);
  });
});

describe("Explain this result, as shipped", () => {
  const block = html.slice(html.indexOf('<div class="explain" id="explain"'), html.indexOf('<span class="sr" id="inspect-copy-state"'));

  test("one button for the whole result, right after it, hidden until there is a result; never in a menu", () => {
    assert.equal(html.match(/Explain this result/g).length, 1, "one explanation action on the page");
    assert.equal(html.match(/id="explain-submit"/g).length, 1);
    assert.match(
      block,
      /^<div class="explain" id="explain" hidden>\n {10}<button class="btn btn-explain" id="explain-submit" type="button" aria-disabled="false"><svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span class="swap"><span>Explain this result<\/span><span>Explaining…<\/span><\/span><\/button>/,
    );
    // Directly after the Inspector's result, inside its panel, and not behind a disclosure or menu.
    assert.ok(html.indexOf('id="inspect-result"') < html.indexOf('id="explain"'));
    const panel = html.slice(html.indexOf('<div class="panel" id="inspect-panel">'), html.indexOf("</section>", html.indexOf('id="inspect-panel"')));
    assert.ok(panel.includes('id="explain-submit"'));
    assert.doesNotMatch(panel, /<details|<summary|role="menu"|popover/);
    // The explanation goes under the button; a failure note sits between them.
    assert.ok(block.indexOf('id="explain-submit"') < block.indexOf('id="explain-note"'));
    assert.ok(block.indexOf('id="explain-note"') < block.indexOf('id="explain-body"'));
    assert.match(block, /<h3 class="label explain-title">Plain-language explanation<\/h3>/);
    assert.match(block, /<span class="sr" id="explain-state" aria-live="polite"><\/span>/);
  });

  test("it asks only when clicked: one request per click, none for an inspection, and a late answer for an old result is dropped", () => {
    const code = explainJs.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal([...code.matchAll(/(?<!function )\bexplain\(\)/g)].length, 1, "explain() is called from one place");
    assert.match(code, /button\.addEventListener\("click", \(\) => void explain\(\)\);/);
    assert.match(code, /inspector\.addEventListener\("inspect:result", \(event\) => \{/);
    assert.match(code, /if \(request === null \|\| busy\) return;/);
    assert.match(code, /if \(explained\) return void body\.scrollIntoView/);
    assert.match(code, /if \(mine !== round\) return;/);
    // The Inspector only announces a result; it never asks for an explanation.
    assert.match(inspectorJs, /root\.dispatchEvent\(new CustomEvent\("inspect:result", \{ detail: JSON\.parse\(JSON\.stringify\(data\)\) \}\)\);/);
    assert.doesNotMatch(inspectorJs, /explain-input|explain\.js|\/api\/explain/);
  });

  test("its words: no provider name, no claim, and the result stays the source of truth", () => {
    const words = literals.filter(([name]) => name === "explain.js").map(([, text]) => text).join(" ");
    assert.match(words, /Written by an AI model from the result above\. The result above is the source of truth\./);
    assert.match(words, /The inspection result above is unchanged\./);
    assert.match(words, /Reused from an earlier explanation of this same result\./);
    assert.doesNotMatch(`${visibleText} ${words}`, /deepseek/i, "the page never names the provider");
    assert.doesNotMatch(words, /\b(?:safe|secure|trusted|verified|legitimate)\b/i);
  });

  test("the button is full width on a phone's panel, and dims with the result while a new one is read", () => {
    assert.match(rules, /\.btn-explain \{ width: 100%; \}\n {2}@container panel \(min-width: 460px\) \{ \.btn-explain \{ width: auto; \} \}/);
    assert.match(rules, /#inspector\[data-inspect-state="inspecting"\] \.explain \{ opacity: \.55; \}/);
    assert.match(rules, /\.explain-h \{ margin: 14px 0 0;/);
  });
});

