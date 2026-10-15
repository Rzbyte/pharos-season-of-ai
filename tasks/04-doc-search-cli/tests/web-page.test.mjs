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

  test("minimal first screen: title, one line, the box, three examples; CLI usage and proof behind disclosures", async () => {
    const html = await read("public/index.html");
    const order = ['<h1 class="task-title">Docs Search</h1>', "Ask anything documented about building on Pharos.", 'placeholder="Ask the docs…"', ">Deploy with Foundry<", ">Atlantic RPC<", ">Use Chainlink<", ">CLI usage<", ">How it answers &amp; proof</h2>"].map((needle) => html.indexOf(needle));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(html, /<button class="toggle-row" id="cli-toggle" type="button" aria-expanded="false" aria-controls="cli-body">/);
    assert.match(html, /<div class="cli-body" id="cli-body" hidden>/);
    assert.doesNotMatch(html, /<details[^>]*\sopen/);
    // The transport disclosure stays word for word.
    assert.match(html, /Not MCP: a public Developer Docs MCP endpoint is not documented yet\./);
    // No terminal: no prompt, no log, no command echo.
    assert.doesNotMatch(html, /\$ pharos-docs<\/label>|role="log"|Documentation Terminal/);
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
