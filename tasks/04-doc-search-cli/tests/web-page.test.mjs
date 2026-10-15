// The docs search page without a browser: command parsing (public/assets/command.js) and the static page.
//   node --test tests/web-page.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { createHistory, parseCommand, REASONS } from "../public/assets/command.js";
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
      ">Deploy with Foundry<",
      ">Atlantic RPC<",
      ">Use Chainlink<",
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

  test("the thread scrolls inside the workspace; the newest turn can always be brought to the top", async () => {
    const css = await read("public/assets/search.css");
    assert.match(css, /\.ws-scroll \{ position: relative; flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; container: thread \/ size; \}/);
    assert.match(css, /\.thread > \.turn:last-child \{ min-height: calc\(100cqh - 2 \* var\(--ws-pad\)\); padding-bottom: 0; \}/);
    assert.match(css, /\.ask \{ flex: none; padding-block: var\(--space-3\) calc\(var\(--space-3\) \+ env\(safe-area-inset-bottom\)\);/);
    const script = await read("public/assets/search.js");
    assert.match(script, /scroller\.scrollTo\(\{ top: Math\.max\(0, top\), behavior: reducedMotion\(\) \? "auto" : "smooth" \}\)/);
    assert.doesNotMatch(script, /scrollIntoView/, "only the thread scrolls, never the page");
  });

  test("every element the script looks up exists; text only, never HTML", async () => {
    const [html, script] = await Promise.all([read("public/index.html"), read("public/assets/search.js")]);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const [, id] of script.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id}`);
    for (const file of ["search.js", "command.js"]) assert.doesNotMatch(await read(`public/assets/${file}`), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
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
    assert.match(script, /if \(meta\.transport === "docs-mcp"\) line\.append\(el\("span", "", `Developer Docs MCP \(askQuestion\) · \$\{requests\} · \$\{seconds\}`\)\);/);
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
