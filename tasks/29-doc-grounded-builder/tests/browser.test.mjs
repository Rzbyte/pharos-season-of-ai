// Task 29's page in Chromium, against the real /api/agent handler, the official Chain MCP server (its
// HTTP mode) on a fake chain, and a stand-in Developer Docs MCP with made-up pages in the shape the live
// one answers. Skipped, saying why, where Playwright is not installed.
//   NODE_PATH="$(npm root -g)" node --test tasks/29-doc-grounded-builder/tests/browser.test.mjs
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
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const STRANGER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x2222222222222222222222222222222222222222";
const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
const ASK = Object.freeze({
  send: "How do I send USDC to another wallet on Pharos Mainnet?",
  approve: "How do I approve a spender to use my USDC?",
  wrap: "How do I wrap 0.5 PROS into WPROS?",
  balance: "How do I check my USDC balance?",
});
const lower = (address) => address.toLowerCase();
const cited = `\n\n# Sources\n\n- [Token Registry](${REGISTRY})`;
/** A made-up registry page: mainnet's tokens, USDC at the address given. */
const registry = (usdc = USDC) => `# Token Registry\n\n## Pharos Mainnet\n\n| Token | Address | Decimals |\n| --- | --- | --- |\n| WPROS | ${WPROS} | 18 |\n| USDC | ${usdc} | 6 |\n`;
const ANSWERS = {
  [ASK.send]: `To send USDC, call \`transfer(address,uint256)\` on the USDC contract in the [Token Registry](${REGISTRY}). Pharos Mainnet's chain ID is 1672 and its RPC is https://rpc.pharos.xyz.${cited}`,
  [ASK.approve]: `Call \`approve(address,uint256)\` on the token; its address is in the [Token Registry](${REGISTRY}).${cited}`,
  [ASK.wrap]: `Send PROS to the WPROS contract's \`deposit()\`; WPROS is in the [Token Registry](${REGISTRY}).${cited}`,
  [ASK.balance]: `Call balanceOf on the USDC contract, listed in the [Token Registry](${REGISTRY}).${cited}`,
  "How do I deploy a contract?": `Use forge script with --broadcast.${cited}`,
};
const answer = (question) => ANSWERS[question] ?? `I cannot find information about that in the Pharos Developer Docs.${cited}`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

describe("the Task 29 page in a browser", { skip }, () => {
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
    fake.state.native = { [lower(PAYER)]: 2n * 10n ** 18n };
    fake.state.tokens = {
      [lower(USDC)]: { decimals: 6, symbol: "USDC", name: "USD Coin", balances: { [lower(PAYER)]: 1_000_000_000n } },
      [lower(WPROS)]: { decimals: 18, symbol: "WPROS", name: "Wrapped PROS", balances: {} },
    };
    docs.pages[REGISTRY] = registry();
  };

  before(async () => {
    // The wrapped token's payable deposit() takes the value and returns nothing, as WETH-style tokens do.
    fake = await startFakeChain(defaultState({ answers: { [lower(WPROS)]: { "0xd0e30db0": "0x" } } }));
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
  /** Wait for the answer to a click, or a submit, that asks again. */
  const answered = (page, run) => Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agent"), run()]).then(() => page.waitForFunction(settled));

  const view = (page) =>
    page.evaluate(() => {
      const shown = (id) => !document.getElementById(id).hidden && !document.getElementById(id).closest("[hidden]");
      const text = (id) => (shown(id) ? document.getElementById(id).textContent : null);
      const rows = (id) => (shown(id) ? [...document.querySelectorAll(`#${id} > div`)].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]) : null);
      return {
        word: document.getElementById("status-word").textContent,
        detail: document.getElementById("status-detail").textContent,
        tone: document.getElementById("status").dataset.tone,
        asked: text("asked"),
        why: text("why"),
        whyTone: document.getElementById("why").dataset.tone ?? "",
        error: text("error"),
        answer: text("docs-answer"),
        cited: shown("docs-box") ? [...document.querySelectorAll("#cited > li")].map((li) => li.textContent) : null,
        summary: text("action-summary"),
        action: rows("action-rows"),
        ground: shown("ground-box") ? [...document.querySelectorAll(".ground-row")].map((li) => [li.querySelector(".ground-label").firstChild.textContent, li.dataset.state, li.querySelector(".ground-uses").textContent, li.querySelector(".ground-docs").textContent]) : null,
        dryTitle: text("dry-h"),
        dry: rows("dry-rows"),
        outcome: shown("dry-box") ? [...document.querySelectorAll(".change")].map((li) => li.textContent) : null,
        warnings: shown("warnings") ? [...document.querySelectorAll("#warnings > li")].map((li) => li.textContent) : [],
        commands: shown("skill-box") ? [...document.querySelectorAll(".skill-cmd")].map((box) => [box.querySelector(".skill-label").firstChild.textContent.trim(), box.querySelector("pre").textContent]) : null,
        fee: text("skill-fee"),
        trail: shown("trail-box") ? document.querySelectorAll(".trail-step").length : null,
      };
    });

  test("on load: how to send USDC, answered by the docs, each piece beside the Skill Engine, dry-run, with its cast commands", async () => {
    const { page, errors } = await open();
    const seen = await view(page);
    assert.deepEqual([seen.word, seen.detail, seen.tone], ["Ready", "dry-run, not sent", "success"]);
    assert.equal(seen.asked, `Asked: ${ASK.send}`);
    assert.match(seen.why, /^Send 25 USDC from 0x912c…f647 to 0xB274…9553: ready\. The dry run at block 5,000,000 succeeds, for about [\d.]+ PROS in gas\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.deepEqual(seen.cited, ["Token Registry, opens in a new tabread"]);
    assert.equal(seen.summary, "Send 25 USDC from 0x912c…f647 to 0xB274…9553");
    assert.deepEqual(seen.action, [["Sender", "0x912c…f647the example's"], ["Recipient", "0xB274…9553the example's"], ["Amount", "25 USDCthe example's"], ["Token", "USDC 0xC879…1815the Skill Engine's token list"]]);
    assert.deepEqual(seen.ground, [
      ["Chain ID", "same", "1672Skill Engine networks.json", "The docs' answer gives the same."],
      ["RPC URL", "same", "https://rpc.pharos.xyzSkill Engine networks.json", "The docs' answer gives the same."],
      ["USDC's address", "same", "0xC879…1815Skill Engine tokens.json", "Token Registry, opens in a new tab gives the same."],
      ["Function", "same", "transfer(address,uint256)the ERC-20 standard", "The docs' answer gives the same."],
    ]);
    assert.equal(seen.dryTitle, "Dry run at block 5,000,000");
    assert.deepEqual(seen.dry.map(([label]) => label), ["Simulated", "Gas", "Fee", "Funds", "Sent"]);
    assert.equal(seen.dry[0][1], "Succeeds, returns trueeth_call");
    assert.deepEqual(seen.outcome.slice(0, 2), ["Sender 0x912c…f647 · USDC1,000 USDC → 975 USDC", "Recipient 0xB274…9553 · USDC0 USDC → 25 USDC"]);
    assert.deepEqual(seen.commands, [
      ["Estimate its gas", `cast estimate ${USDC} "transfer(address,uint256)" ${RECIPIENT} 25000000 --from ${PAYER} --rpc-url https://rpc.pharos.xyz`],
      ["Send it", `cast send ${USDC} "transfer(address,uint256)" ${RECIPIENT} 25000000 --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`],
      ["The gas price", "cast gas-price --rpc-url https://rpc.pharos.xyz"],
    ]);
    assert.match(seen.fee, /^By its gas rule: a [\d,]+ gas limit \(the [\d,]+ estimate × 1\.2, rounded up\), at [\d.]+ gwei, is [\d.]+ PROS\.$/);
    assert.equal(seen.trail, 9);
    assert.equal(await page.getAttribute(".skill-ref", "href"), "https://github.com/PharosNetwork/pharos-skill-engine/tree/a873387c9e34e9ae8e71360d43dc33329a335a24");
    assert.equal(await page.getAttribute(".skill-cmd .skill-ref", "href"), "https://github.com/PharosNetwork/pharos-skill-engine/blob/a873387c9e34e9ae8e71360d43dc33329a335a24/references/transaction.md#estimate-gas-consumption");
    assert.deepEqual(requests, [{ task: "29", q: ASK.send }]);
    assert.deepEqual(errors, []);
  });

  test("Copy puts the command on the clipboard, and says so", async () => {
    const { page, context } = await open();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.click(".skill-cmd:nth-child(2) .copy");
    await page.waitForFunction(() => document.querySelector(".skill-cmd:nth-child(2) .copy").dataset.copy === "copied");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `cast send ${USDC} "transfer(address,uint256)" ${RECIPIENT} 25000000 --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`);
    assert.equal(await page.textContent("#copy-state"), "Command copied");
  });

  test("the examples: an approval with its warning, a wrap through deposit(), a balance read; your address goes with each", async () => {
    const { page } = await open();
    await answered(page, () => page.click("#ex-approve"));
    const approve = await view(page);
    assert.deepEqual([approve.word, approve.summary], ["Ready", "Approve 0xB274…9553 to spend 25 USDC of 0x912c…f647"]);
    assert.equal(approve.warnings.length, 1, "Task 08's warning: the spender is not a contract");
    await answered(page, () => page.click("#ex-wrap"));
    const wrap = await view(page);
    assert.deepEqual([wrap.word, wrap.summary, wrap.commands[1][1]], ["Ready", "Wrap 0.5 PROS into WPROS for 0x912c…f647", `cast send ${WPROS} "deposit()" --value 0.5ether --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`]);
    await page.fill("#f-from", PAYER);
    await answered(page, () => page.click("#ex-balance"));
    const balance = await view(page);
    assert.deepEqual([balance.word, balance.detail, balance.dryTitle, balance.dry, balance.fee], ["Read", "on Pharos Mainnet", "Read at block 5,000,000", [["Holds", "1,000 USDCeth_call balanceOf"]], null]);
    assert.deepEqual(balance.action[0], ["Address", "0x912c…f647given"]);
    assert.deepEqual(requests.at(-1), { task: "29", q: ASK.balance, from: PAYER });
    assert.equal(new URL(page.url()).searchParams.get("from"), PAYER);
  });

  test("the docs giving another USDC address: a warning, the Skill Engine's prepared; a sender without USDC: it would fail", async () => {
    docs.pages[REGISTRY] = registry(OTHER);
    const { page } = await open();
    const differ = await view(page);
    assert.deepEqual([differ.word, differ.detail, differ.tone, differ.whyTone], ["Ready", "the docs differ on one point", "warning", "warning"]);
    assert.deepEqual(differ.ground[2], ["USDC's address", "differs", "0xC879…1815Skill Engine tokens.json", "Token Registry, opens in a new tab gives 0x2222…2222 instead."]);
    await page.fill("#f-from", STRANGER);
    await answered(page, () => page.click('#ask button[type="submit"]'));
    const fail = await view(page);
    assert.deepEqual([fail.word, fail.detail, fail.tone, fail.whyTone], ["Would fail", "in the dry run", "error", "error"]);
    assert.match(fail.dry[0][1], /^Reverts: /);
  });

  test("a question the docs do not cover, one it prepares nothing for, and a bad address never sent", async () => {
    const { page } = await open();
    await page.fill("#f-q", "How do I stake on Solana?");
    await answered(page, () => page.click('#ask button[type="submit"]'));
    const uncovered = await view(page);
    assert.deepEqual([uncovered.word, uncovered.detail, uncovered.answer, uncovered.summary, uncovered.commands, uncovered.trail], ["Not in the docs", "nothing prepared", null, null, null, 1]);
    await page.fill("#f-q", "How do I deploy a contract?");
    await answered(page, () => page.click('#ask button[type="submit"]'));
    const deploy = await view(page);
    assert.deepEqual([deploy.word, deploy.why, deploy.summary], ["Not prepared", "The docs answered. The question asks for nothing this agent prepares: sending, approving, wrapping, or a balance.", null]);
    const sent = requests.length;
    await page.fill("#f-from", "0x12");
    await page.click('#ask button[type="submit"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), "f-from");
    assert.equal(await page.textContent("#h-from"), "Enter a 0x address of 40 hex characters, or leave it empty.");
    assert.equal(await page.getAttribute("#f-from", "aria-invalid"), "true");
    assert.equal(requests.length, sent);
  });

  test("an unreachable Developer Docs MCP is an error the page states, with nothing of an answer shown", async () => {
    api = handler("http://127.0.0.1:9/~gitbook/mcp");
    try {
      const { page } = await open();
      const seen = await view(page);
      assert.deepEqual([seen.word, seen.tone, seen.asked, seen.why, seen.summary, seen.trail], ["Not answered", "error", null, null, null, null]);
      assert.match(seen.error, /^Could not reach the Developer Docs MCP at http:\/\/127\.0\.0\.1:9\/~gitbook\/mcp/);
    } finally {
      api = handler();
    }
  });

  test("the proof: both MCPs' calls, the raw result behind a toggle; the skip link lands on the answer", async () => {
    const { page } = await open();
    await page.click("#proof > summary");
    assert.deepEqual(await page.$$eval("#docs-calls > li", (items) => items.map((item) => item.textContent)), [`askQuestion "${ASK.send}"`, "getPage /getting-started/token-registry"]);
    const calls = await page.$$eval("#calls > li", (items) => items.map((item) => item.textContent.split(" ")[0]));
    assert.deepEqual(calls.slice(0, 4), ["get_chain_info", "get_block_number", "get_block", "get_code"]);
    assert.ok(!calls.includes("send_raw_transaction"));
    await page.click("#json-toggle");
    const json = JSON.parse(await page.textContent("#json"));
    assert.deepEqual([json.result.schema, json.result.verdict, json.result.skillEngine.commit], ["pharos-agent/how-to/1", "ready", "a873387c9e34e9ae8e71360d43dc33329a335a24"]);
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
            trailOpen: document.getElementById("trail-box").open,
            small: targets.filter(([, h]) => h < 32),
            rowsInside: [...document.querySelectorAll(".ground-row, .change, .rows > div, .skill-cmd, .cmd, .trail-step, .calls > li, .ask, .docs-answer, .cite")].every((row) => box(row).right <= window.innerWidth + 0.5),
          };
        });
        const where = `${width}px ${colorScheme}`;
        assert.equal(layout.overflow, 0, `${where}: no sideways scroll`);
        assert.ok(layout.beside, `${where}: the status and Ask again share the top line`);
        assert.equal(layout.trailOpen, width >= 1000, `${where}: the steps open beside the answer only where there is room`);
        assert.deepEqual(layout.small, [], `${where}: no control under 32 px tall`);
        assert.ok(layout.rowsInside, `${where}: every row fits`);
        const button = await page.locator("#again").boundingBox();
        assert.ok(button.height >= 44, `${where}: Ask again is a 44 px target`);
      }
    }
  });
});
