// Task 13's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/13-docs-chain-agent/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/docs-chain.js");
const runner = shared("agent.js");

describe("the Task 13 page", () => {
  test("carries the shared shell, stamped for 13, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 13 -->\n${shellPart(shared("header.html"), "13")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 13 -->\n${shellPart(shared("footer.html"), "13")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "13", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/docs-chain.css", "/assets/docs-chain.js", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="13">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and the question has a label, a hint and a length limit", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-q"]);
    assert.match(html, /<label class="field-label" for="f-q"/);
    assert.match(html, /id="f-q" name="q" maxlength="300"[^>]*aria-describedby="h-q"/);
  });

  test("the result is set as text: the scripts never write markup; docs links only ever go to the official docs", () => {
    for (const source of [script, runner]) assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(script, /const DOCS = "https:\/\/docs\.pharos\.xyz";/);
    assert.match(script, /if \(!url\.startsWith\(`\$\{DOCS\}\/`\)\) return el\("span", "cite-link", title \?\? url\);/);
  });

  test("every link that leaves the site opens a new tab with no opener and says so", () => {
    for (const [anchor] of html.matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
      assert.match(anchor, /target="_blank" rel="noopener noreferrer"/, anchor);
      assert.ok(/opens in a new tab/.test(anchor), anchor);
    }
    assert.match(script, /link\.target = "_blank";\n {2}link\.rel = "noopener noreferrer";\n {2}link\.append\(el\("span", "sr", ", opens in a new tab"\)\);/);
  });

  test("the first question is the API's own default, and the CLI command shown asks it too", async () => {
    const { DEFAULT_QUESTION } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    assert.match(script, new RegExp(`usdc: "${DEFAULT_QUESTION.replace(/[?]/g, "\\?")}",`));
    assert.ok(html.includes(`node dist/src/cli.js ask "${DEFAULT_QUESTION}" --proof answer.json`));
  });

  test("the page says what it does and does not do: the docs' answer is theirs, the agent adds no language model, nothing is sent", () => {
    assert.match(html, /The docs' answer is the Developer Docs MCP's; the agent adds no language model: the addresses come from the docs' text/);
    assert.match(html, /synthesized from the docs/);
    assert.doesNotMatch(script, /fetch\(/, "the page asks only through the shared runner");
  });
});
