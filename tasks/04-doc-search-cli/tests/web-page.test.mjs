// The browser terminal without a browser: command parsing (public/assets/command.js) and the static page.
//   node --test tests/web-page.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { createHistory, echo, parseCommand, REASONS } from "../public/assets/command.js";
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

  test("echo and history", () => {
    assert.equal(echo({ kind: "ask", question: "q", json: true }), 'pharos-docs "q" --json');
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
  test("loads only its own assets; no inline or third-party script", async () => {
    const html = await read("public/index.html");
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(refs.sort(), ["/assets/fonts/GeistMono-Regular.woff2", "/assets/terminal.css", "/assets/terminal.js", "/assets/theme.js"]);
    for (const ref of refs) await read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /data-api="\/api\/search"/);
  });

  test("the brief's hierarchy and compact copy", async () => {
    const html = await read("public/index.html");
    for (const needle of ["<b>Pharos</b> Developer Lab", "Task <b>04</b> / Doc search", "<h1>Documentation Terminal</h1>", "Official Pharos docs, queried from one command.", 'id="log" role="log"', '<label for="cmd">$ pharos-docs</label>']) {
      assert.ok(html.includes(needle), needle);
    }
    assert.match(html, /Not MCP: a public Developer Docs MCP endpoint is not documented yet\./);
  });

  test("every element the script looks up exists; text only, never HTML", async () => {
    const [html, script] = await Promise.all([read("public/index.html"), read("public/assets/terminal.js")]);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const [, id] of script.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id}`);
    for (const file of ["terminal.js", "command.js"]) assert.doesNotMatch(await read(`public/assets/${file}`), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
  });

  test("no fake filesystem, editor, chat or auth", async () => {
    const text = (await read("public/assets/command.js")) + (await read("public/assets/terminal.js"));
    assert.doesNotMatch(text, /\b(ls|cd|mkdir|rm|cat)\b(?=["'\s])|localStorage|login|password/);
  });

  test("vercel.json deploys public/ and the one function", async () => {
    const config = JSON.parse(await read("vercel.json"));
    assert.equal(config.outputDirectory, "public");
    assert.deepEqual(Object.keys(config.functions), ["api/search.js"]);
  });
});
