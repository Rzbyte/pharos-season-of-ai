// The docs search page without a browser: command parsing (public/assets/command.js) and the static page.
//   node --test tests/web-page.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { createHistory, parseCommand, REASONS } from "../public/assets/command.js";
import { answerBlocks, docsSection, isOfficial, sourcesShown } from "../public/assets/search-answer.js";
import { REASON_TEXT } from "../dist/src/search.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("command line", () => {
  test("the CLI form, with or without the command name and quotes", () => {
    for (const line of ['pharos-docs "how do I deploy a contract?"', '"how do I deploy a contract?"', "how do I deploy a contract?", "pharos-docs how do I deploy a contract?", "  pharos-docs   'how do I deploy a contract?'  ", "pharos-docs “how do I deploy a contract?”"]) {
      assert.deepEqual(parseCommand(line), { kind: "ask", question: "how do I deploy a contract?", json: false }, line);
    }
  });

  test("--json anywhere; help, version, clear, history", () => {
    assert.deepEqual(parseCommand('pharos-docs "q here" --json'), { kind: "ask", question: "q here", json: true });
    assert.deepEqual(parseCommand('--json "q here"'), { kind: "ask", question: "q here", json: true });
    assert.equal(parseCommand("help").kind, "help");
    assert.equal(parseCommand("pharos-docs --help").kind, "help");
    assert.equal(parseCommand("pharos-docs -h").kind, "help");
    assert.equal(parseCommand("pharos-docs --version").kind, "version");
    assert.equal(parseCommand("clear").kind, "clear");
    assert.equal(parseCommand("history").kind, "history");
    assert.equal(parseCommand("   ").kind, "empty");
  });

  test("errors: no question, unknown option, too long", () => {
    assert.equal(parseCommand("pharos-docs").kind, "error");
    assert.equal(parseCommand('pharos-docs ""').kind, "error");
    assert.match(parseCommand("pharos-docs q --max").message, /Unknown option --max/);
    assert.equal(parseCommand("x".repeat(301)).kind, "error");
    assert.equal(parseCommand("what about -1 gas").kind, "ask", "a negative number is not an option");
  });

  test("history", () => {
    const history = createHistory(3);
    for (const line of ["a", "b", "b", "c", "d"]) history.push(line);
    assert.deepEqual(history.list(), ["b", "c", "d"]);
    assert.equal(history.up(), "d");
    assert.equal(history.up(), "c");
    assert.equal(history.down(), "d");
    assert.equal(history.down(), "");
  });

  test("no-answer reasons read the same as the CLI", () => {
    assert.deepEqual(REASONS, REASON_TEXT);
  });
});

describe("answer layout (search-answer.js)", () => {
  test("a live procedural answer: a paragraph, then steps with their code, indentation kept and nothing reworded", async () => {
    // The committed live proof's answer B, as the page receives it.
    const answer = JSON.parse(await read("proof/query-b.json")).result.answer;
    const blocks = answerBlocks(answer);
    assert.deepEqual(blocks.map((block) => block.kind), ["p", "steps"]);
    const [, steps] = blocks;
    assert.deepEqual(steps.items.map((item) => item.n), ["1", "2", "3"]);
    assert.deepEqual(steps.items[0].code, ["forge build\nforge test"]);
    assert.match(steps.items[1].code[0], /^\/\/ SPDX-License-Identifier: MIT\npragma solidity \^0\.8\.0;\n\nimport "forge-std\/Script\.sol";/);
    assert.match(steps.items[1].code[0], /\n {4}function run\(\) external \{\n {8}vm\.startBroadcast\(\);/, "the code's own indentation");
    // Every non-blank line of the answer is in the blocks, word for word.
    const shown = blocks.flatMap((block) => (block.kind === "steps" ? block.items.flatMap((item) => [item.text, ...item.code]) : [block.text ?? block.items.join("\n")])).join("\n");
    for (const line of answer.split("\n").map((line) => line.trim().replace(/^\d+\.\s+/, "")).filter(Boolean)) assert.ok(shown.includes(line), line);
  });

  test("code on its own line, items, and prose that only starts with a command word", () => {
    assert.deepEqual(answerBlocks("Deploy it:\n\nforge create src/A.sol:A --rpc-url $RPC_URL\n\n- one\n- two\n\nforge script runs your deployment script for you."), [
      { kind: "p", text: "Deploy it:" },
      { kind: "code", text: "forge create src/A.sol:A --rpc-url $RPC_URL" },
      { kind: "list", items: ["one", "two"] },
      { kind: "p", text: "forge script runs your deployment script for you." },
    ]);
    assert.deepEqual(answerBlocks("Chain ID Atlantic testnet adalah 424242.\nBaris kedua."), [{ kind: "p", text: "Chain ID Atlantic testnet adalah 424242.\nBaris kedua." }]);
  });

  test("sources: official links only, where each page sits, and when to show the rest", () => {
    assert.equal(docsSection("https://docs.pharos.xyz/getting-started/network/atlantic-testnet"), "getting-started / network");
    assert.equal(docsSection("https://docs.pharos.xyz/introduction"), "");
    assert.equal(isOfficial("https://docs.pharos.xyz/developer-guide/foundry"), true);
    for (const url of ["http://docs.pharos.xyz/x", "https://docs.pharos.xyz.evil.example/x", "https://docs.pharos.xyz:8443/x", "javascript:alert(1)", "not a url"]) assert.equal(isOfficial(url), false, url);
    // All of them, unless at least two would wait behind "Show N more".
    assert.deepEqual([1, 2, 3, 4, 5, 9].map((total) => sourcesShown(total)), [1, 2, 3, 4, 3, 3]);
  });
});

describe("static page", () => {
  const shared = (name) => readFile(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");

  test("loads only its own assets; no inline or third-party script; the shared shell, in sync", async () => {
    const html = await read("public/index.html");
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(refs.sort(), ["/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/search.css", "/assets/search.js", "/assets/theme.js"]);
    for (const ref of refs) await read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /data-api="\/api\/search"/);
    assert.ok(html.includes(`<!-- shell:header 04 -->\n${(await shared("header.html")).replaceAll("{{n}}", "04").trim()}\n<!-- /shell:header -->`));
    assert.ok(html.includes(`<!-- shell:footer 04 -->\n${(await shared("footer.html")).trim()}\n<!-- /shell:footer -->`));
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js"]) assert.equal(await read(`public/assets/${name}`), await shared(name), name);
  });

  test("a workspace, not a document: the bar, the welcome and three examples, the box at the bottom; About holds the rest", async () => {
    const html = await read("public/index.html");
    // The page is the screen's height (lab.css body.app); on Android the keyboard resizes it, so the box stays above it.
    assert.match(html, /<body class="app" data-state="idle">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">/);
    const order = [
      '<h1 class="ws-title"><span class="task-n">04</span><span>Docs Search</span></h1>',
      'id="scroll"',
      "Ask anything documented about building on Pharos.",
      ">How do I deploy a contract with Foundry?<",
      ">What is the Atlantic testnet RPC endpoint?<",
      ">How do I use Chainlink on Pharos?<",
      'id="thread" aria-label="Questions and answers" hidden',
      'id="about-h">How it answers</h2>',
      ">CLI usage</h3>",
      'id="proof-h">Proof</h3>',
      '<form class="ask" id="ask"',
      'placeholder="Ask the docs…"',
      '<dialog class="sheet" id="about-sheet" aria-labelledby="sheet-h">',
    ].map((needle) => html.indexOf(needle));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    // One title: the kicker no longer repeats the heading.
    assert.equal(html.match(/>Docs Search</g).length, 1);
    // New and About are the bar's two tools; New shows once something is asked.
    assert.match(html, /<button class="action" id="clear" type="button" hidden>/);
    assert.match(html, /<button class="action ws-about-open" id="about-open" type="button" aria-haspopup="dialog" aria-controls="about-sheet">/);
    assert.match(html, /<details class="disclosure cli" id="cli">/);
    assert.doesNotMatch(html, /<details[^>]*\sopen/);
    // The transport, stated plainly: the Developer Docs MCP and its two calls, nothing else.
    assert.match(html, /<dt>Transport<\/dt><dd class="kv-text">The Pharos Developer Docs MCP at <code>docs\.pharos\.xyz\/~gitbook\/mcp<\/code>, over Streamable HTTP: JSON-RPC <code>tools\/list<\/code> to check that <code>askQuestion<\/code> is offered, then <code>tools\/call askQuestion<\/code> with the question\./);
    assert.doesNotMatch(html, /Not MCP|\?ask=|sitemap\.md/);
    // No terminal: no prompt, no log, no command echo.
    assert.doesNotMatch(html, /\$ pharos-docs<\/label>|role="log"|Documentation Terminal/);
  });

  test("the thread and How it answers each scroll on their own; nothing scrolls inside the thread", async () => {
    const css = await read("public/assets/search.css");
    assert.match(css, /\.ws-scroll \{ position: relative; flex: 1 1 0; min-width: 0; overflow-y: auto; overscroll-behavior-y: contain; scrollbar-gutter: stable; container: thread \/ size; \}/);
    // The side panel is a sibling of the thread's scroll area, not inside it: every <div> opened from the
    // scroll area's start is closed before the panel starts.
    const html = await read("public/index.html");
    const between = html.slice(html.indexOf('<div class="ws-scroll" id="scroll">'), html.indexOf('<aside class="ws-side" id="about"'));
    assert.ok(between.length > 0);
    assert.equal((between.match(/<div\b/g) ?? []).length, (between.match(/<\/div>/g) ?? []).length, "the scroll area is closed before How it answers");
    assert.match(css, /\.ws-side > \.about \{\n\s+position: absolute; inset-block: 0; width: 18\.5rem; overflow-y: auto;/);
    // The JSON, answer code and the CLI snippet are shown at full length and wrapped: no box of their own to scroll.
    for (const rule of [/\.json \{[^}]*\}/, /\.answer-code \{[^}]*\}/, /\n  \.code \{[^}]*\}/]) {
      const block = css.match(rule)[0];
      assert.doesNotMatch(block, /max-height|overflow(?:-[xy])?: (?:auto|scroll)/, block);
      assert.match(block, /white-space: pre-wrap/);
    }
    assert.match(css, /\.ask \{ flex: none; padding-block: 10px calc\(10px \+ env\(safe-area-inset-bottom\)\);/);
    const script = await read("public/assets/search.js");
    assert.match(script, /scroller\.scrollTo\(\{ top: Math\.max\(0, top\), behavior: reducedMotion\(\) \? "auto" : "smooth" \}\)/);
    assert.doesNotMatch(script, /scrollIntoView/, "only the thread scrolls, never the page");
  });

  test("every element the script looks up exists; text only, never HTML", async () => {
    const [html, script] = await Promise.all([read("public/index.html"), read("public/assets/search.js")]);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const [, id] of script.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id}`);
    for (const file of ["search.js", "command.js", "search-answer.js"]) assert.doesNotMatch(await read(`public/assets/${file}`), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
  });

  test("the same search and result: only /api/search, the CLI's no-answer words, a bounded thread", async () => {
    const script = await read("public/assets/search.js");
    assert.equal((script.match(/\bfetch\(/g) ?? []).length, 1);
    assert.match(script, /fetch\(`\$\{API\}\?q=\$\{encodeURIComponent\(command\.question\)\}`/);
    assert.match(script, /"No good answer found\."/);
    assert.match(script, /"I couldn't verify this in the Pharos Developer Docs\."/);
    assert.match(script, /REASONS\[result\.reason\]/);
    assert.match(script, /const MAX_TURNS = 6;/);
    // The meta line names what answered, as the CLI's last line does.
    assert.match(script, /meta\.transport === "docs-mcp" \? "Developer Docs MCP \(askQuestion\)"/);
  });

  test("no fake filesystem, editor, chat or auth", async () => {
    const text = (await read("public/assets/command.js")) + (await read("public/assets/search.js"));
    assert.doesNotMatch(text, /\b(ls|cd|mkdir|rm|cat)\b(?=["'\s])|localStorage|login|password/);
  });

  test("vercel.json deploys public/ and the one function", async () => {
    const config = JSON.parse(await read("vercel.json"));
    assert.equal(config.outputDirectory, "public");
    assert.deepEqual(Object.keys(config.functions), ["api/search.js"]);
  });
});
