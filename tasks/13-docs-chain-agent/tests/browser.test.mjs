// Task 13's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) on a fake chain, and a stand-in Developer Docs MCP with made-up pages in the shape the live
// one answers. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/13-docs-chain-agent/tests/browser.test.mjs
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
const { startFakeDocs } = await import(at("agent/dist/tests/fake-docs.js"));
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
const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const WPROS = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0";
const HOLDER = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";
const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
const ASK_USDC = "What is the USDC token address on Pharos Mainnet?";
const ASK_WPROS = "What is the WPROS token address on Pharos Mainnet?";
const lower = (address) => address.toLowerCase();
const cited = `\n\n# Sources\n\n- [Token Registry](${REGISTRY})`;
/** A made-up registry page: a table of mainnet tokens, USDC at the address given. */
const registry = (usdc = USDC) => `# Token Registry\n\nTokens on Pharos.\n\n## Pharos Mainnet\n\n| Token | Address | Decimals |\n| --- | --- | --- |\n| WPROS | ${WPROS} | 18 |\n| USDC | ${usdc} | 6 |\n`;
const answer = (question) => {
  const token = /\b(USDC|WPROS)\b/.exec(question)?.[1];
  return token ? `${token} is listed in the [Token Registry](${REGISTRY}), with its address and decimals.${cited}` : `I cannot find information about that in the Pharos Developer Docs.${cited}`;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 13 page in a browser", { skip }, () => {
  let fake;
  let docs;
  let official;
  let server;
  let browser;
  let base;
  let api;
  const requests = [];
  const contexts = [];
  const handler = (docsMcpUrl = docs.url) => createHandler({ chainMcpUrl: `http://127.0.0.1:${official.address().port}/mcp`, docsMcpUrl, timeoutMs: 5000 });
  const fresh = () => {
    fake.state.tokens = {
      [lower(USDC)]: { decimals: 6, symbol: "USDC", name: "USD Coin", balances: { [HOLDER]: 1_000_000_000n } },
      [lower(WPROS)]: { decimals: 18, symbol: "WPROS", name: "Wrapped PROS", balances: { [HOLDER]: 5n * 10n ** 18n } },
    };
    docs.pages[REGISTRY] = registry();
  };

  before(async () => {
    fake = await startFakeChain(defaultState({}));
    docs = await startFakeDocs(answer, {});
    fresh();
    const port = await freePort();
    // No rate limit here: the suite runs more checks in a minute than the hosted endpoint allows one IP.
    official = await startHttpServer(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: String(port), PHAROS_RPC_URL: fake.url, PHAROS_CHAIN_ID: "1672", RATE_LIMIT_PER_MINUTE: "0" }));
    api = handler();
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
    await docs?.close();
    await fake?.close();
  });
  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
    requests.length = 0;
    fresh();
  });

  const settled = () => document.getElementById("answer").getAttribute("aria-busy") === "false";

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
  /** Ask `question` in the box and wait for the answer. */
  const askIn = async (page, question) => {
    await page.fill("#f-q", question);
    await page.click('#ask button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("answer").getAttribute("aria-busy") === "false");
  };

  const view = (page) =>
    page.evaluate(() => {
      const shown = (id) => !document.getElementById(id).hidden;
      const text = (id) => (shown(id) ? document.getElementById(id).textContent : null);
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        asked: text("asked"),
        why: text("why"),
        whyTone: document.getElementById("why").dataset.tone ?? "",
        error: text("error"),
        answer: shown("docs-box") ? document.getElementById("docs-answer").textContent : null,
        cited: shown("docs-box") ? [...document.querySelectorAll("#cited > li")].map((li) => li.textContent) : null,
        readings: shown("readings-box")
          ? [...document.querySelectorAll(".reading")].map((card) => ({
              head: card.querySelector(".reading-head").textContent,
              where: card.querySelector(".reading-where").textContent,
              checks: [...card.querySelectorAll(".check")].map((row) => [row.querySelector(".check-label").firstChild.textContent, row.dataset.state, row.querySelector(".check-seen")?.textContent ?? null, row.querySelector(".check-need")?.textContent ?? null, row.querySelector(".check-tool").textContent]),
              facts: [...card.querySelectorAll(".facts > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]),
            }))
          : null,
        trail: shown("trail-box") ? [...document.querySelectorAll(".trail-step")].map((li) => [li.querySelector(".trail-text").textContent, li.querySelector(".trail-source").textContent]) : null,
      };
    });

  test("on load: the USDC question, answered by the docs, its row found on the page they cite, and the chain agrees", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Confirmed", "the chain agrees with the docs", "success"]);
    assert.equal(seen.asked, `Asked: ${ASK_USDC}`);
    assert.deepEqual([seen.why, seen.whyTone], ['The docs give 0xC879…1815 as "USDC · 6", and Pharos Mainnet agrees: a contract whose symbol() is USDC, with 6 decimals and 1,000 USDC in supply.', ""]);
    assert.equal(seen.answer, "USDC is listed in the Token Registry, with its address and decimals.");
    assert.deepEqual(seen.cited, ["Token Registry, opens in a new tabread"]);
    assert.deepEqual(seen.readings, [
      {
        head: '0xC879…1815"USDC · 6"',
        where: "On Token Registry, opens in a new tab · Pharos Mainnet",
        checks: [
          ["Code", "pass", "a contract", null, "get_code"],
          ["Its name on chain", "pass", "USDC · USD Coin", null, "eth_call"],
          ["Skill Engine token list", "pass", "lists it as USDC", null, "tokens.json"],
        ],
        facts: [["Decimals", "6"], ["Total supply", "1,000 USDC"]],
      },
    ]);
    assert.deepEqual(seen.trail, [
      ["The docs answered, citing one page: Token Registry.", "Developer Docs MCP · askQuestion"],
      ['Read "Token Registry": 2 contract addresses.', "Developer Docs MCP · getPage /getting-started/token-registry"],
      [`The docs give ${USDC} as "USDC · 6" on Pharos Mainnet.`, "docs page /getting-started/token-registry"],
      ["0xC879…1815 is a contract (5 bytes of code).", "Chain MCP · get_code"],
      ["symbol() returns USDC (a standard ERC-20 view).", "Chain MCP · eth_call"],
      ["name() returns USD Coin (a standard ERC-20 view).", "Chain MCP · eth_call"],
      ["decimals() returns 6 (a standard ERC-20 view).", "Chain MCP · eth_call"],
      ["totalSupply() returns 1000000000 (a standard ERC-20 view).", "Chain MCP · eth_call"],
    ]);
    assert.equal(await page.getAttribute(".reading-head a", "href"), `https://pharos.socialscan.io/address/${USDC}`);
    assert.equal(await page.getAttribute("#cited a", "href"), REGISTRY);
    assert.deepEqual(requests, [{ task: "13", q: ASK_USDC }]);
    assert.equal(new URL(page.url()).searchParams.get("q"), null, "the first question leaves the address bar alone");
    assert.deepEqual(errors, []);
  });

  test("the WPROS example, and a question typed in the box, each go in the address bar", async () => {
    const { page } = await open();
    await page.click("#ex-wpros");
    await page.waitForFunction(() => document.getElementById("answer").getAttribute("aria-busy") === "false" && document.getElementById("asked").textContent.includes("WPROS"));
    assert.deepEqual(requests.at(-1), { task: "13", q: ASK_WPROS });
    assert.equal(new URL(page.url()).searchParams.get("q"), ASK_WPROS);
    const wpros = await view(page);
    assert.deepEqual([wpros.word, wpros.readings.map((r) => r.head), wpros.readings[0].facts], ["Confirmed", ['0x52C4…F0B0"WPROS · 18"'], [["Decimals", "18"], ["Total supply", "5 WPROS"]]]);
    assert.equal(await page.inputValue("#f-q"), ASK_WPROS);
    await askIn(page, "  Where   is USDC on Pharos Mainnet?  ");
    assert.deepEqual(requests.at(-1), { task: "13", q: "Where is USDC on Pharos Mainnet?" }, "spaces collapsed before it is sent");
  });

  test("Ask again reads again: the answer may be shared for a minute, but never from the browser's own copy", async () => {
    const { page } = await open();
    await Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agent"), page.click("#again")]);
    await page.waitForFunction(settled);
    assert.deepEqual(requests, [{ task: "13", q: ASK_USDC }, { task: "13", q: ASK_USDC }], "the second answer came from the agent");
  });

  test("the docs listing USDC at another token's address: a mismatch, with what the docs said beside what the chain says", async () => {
    docs.pages[REGISTRY] = registry(WPROS);
    const { page } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone, seen.whyTone], ["Mismatch", "the chain says otherwise", "warning", "warning"]);
    assert.equal(seen.why, 'The docs give 0x52C4…F0B0 as "USDC · 6", but on Pharos Mainnet it calls itself WPROS, and the Skill Engine lists it as WPROS too.');
    assert.deepEqual(seen.readings[0].checks[1], ["Its name on chain", "fail", "WPROS · Wrapped PROS", 'the docs say "USDC · 6"', "eth_call"]);
  });

  test("a question the docs do not cover: said so, nothing read on chain but the block; an empty question is never sent", async () => {
    const { page } = await open();
    await askIn(page, "How do I stake on Solana?");
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone, seen.answer, seen.readings], ["Not in the docs", "nothing called on chain", "neutral", null, null]);
    assert.deepEqual(seen.trail, [["The docs do not cover this question.", "Developer Docs MCP · askQuestion"]]);
    await page.click("#proof > summary");
    assert.deepEqual(await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0])), ["get_chain_info", "get_block_number", "get_block"]);
    const sent = requests.length;
    await page.fill("#f-q", "   ");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-q");
    assert.equal(await page.textContent("#h-q"), "Ask a question first: about a Pharos contract, its address or a function.");
    assert.equal(await page.getAttribute("#f-q", "aria-invalid"), "true");
    assert.equal(requests.length, sent);
  });

  test("an unreachable Developer Docs MCP is an error the page states, with nothing of an answer shown", async () => {
    // A fresh page (each has its own browser cache), so the answer comes from the handler now in use.
    api = handler("http://127.0.0.1:9/~gitbook/mcp");
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone, seen.asked, seen.why, seen.answer, seen.trail], ["Not answered", "error", null, null, null, null]);
      assert.match(seen.error, /^Could not reach the Developer Docs MCP at http:\/\/127\.0\.0\.1:9\/~gitbook\/mcp/);
    } finally {
      api = handler();
    }
  });

  test("the proof: each Developer Docs MCP call and each Chain MCP call, the raw result behind a toggle; the skip link lands on the answer", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    assert.deepEqual(await page.$$eval("#docs-calls > li", (items) => items.map((item) => item.textContent)), [`askQuestion "${ASK_USDC}"`, "getPage /getting-started/token-registry"]);
    assert.deepEqual([await page.textContent("#docs-calls-n"), await page.textContent("#pin-calls")], ["2 calls", "8 calls"]);
    assert.deepEqual(await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0])), ["get_chain_info", "get_block_number", "get_block", "get_code", "eth_call", "eth_call", "eth_call", "eth_call"]);
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.verdict, json.result.docsMcp.where], ["pharos-agent/docs-chain/1", "confirmed", docs.url]);
    await page.focus("a.skip");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "answer-h");
  });

  test("six widths, both themes: no sideways scroll, the status beside its button, every row inside, 44 px targets", async () => {
    for (const colorScheme of ["light", "dark"]) {
      for (const [width, height] of WIDTHS) {
        const { page } = await open("/", { viewport: { width, height }, colorScheme });
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
            rowsInside: [...document.querySelectorAll(".check, .trail-step, .facts > div, .calls > li, .ask, .docs-answer, .cite")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Ask again share the top line`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Ask again is a 44 px target`);
      }
    }
  });
});
