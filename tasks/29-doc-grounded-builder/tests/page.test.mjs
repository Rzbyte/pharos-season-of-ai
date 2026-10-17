// Task 29's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/29-doc-grounded-builder/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/docs-builder.js");
const runner = shared("agent.js");

describe("the Task 29 page", () => {
  test("carries the shared shell, stamped for 29, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 29 -->\n${shellPart(shared("header.html"), "29")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 29 -->\n${shellPart(shared("footer.html"), "29")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "29", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/docs-builder.css", "/assets/docs-builder.js", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="29">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and each field has a label, a hint, and the question a length limit", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    // Looked up by key: the fields, their hints, and the examples.
    for (const id of ["f-q", "f-from", "h-q", "h-from", "ex-send", "ex-approve", "ex-wrap", "ex-balance"]) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-q", "f-from"]);
    for (const id of fields) assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
    for (const [, id] of html.matchAll(/<input class="input" id="([^"]+)"/g)) assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
    assert.match(html, /id="f-q" name="q" maxlength="300"/);
  });

  test("the result is set as text: the scripts never write markup; links leave only for the official docs and the Skill Engine", () => {
    for (const source of [script, runner]) assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(script, /const DOCS = "https:\/\/docs\.pharos\.xyz";/);
    assert.match(script, /const SKILL_ENGINE = "https:\/\/github\.com\/PharosNetwork\/pharos-skill-engine";/);
    assert.match(script, /const pageLink = \(url, title\) => \(url\.startsWith\(`\$\{DOCS\}\/`\) \? outLink\(url, title \?\? path\(url\)\) : el\("span", "cite-link", title \?\? url\)\);/);
  });

  test("every link that leaves the site opens a new tab with no opener and says so", () => {
    for (const [anchor] of html.matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
      assert.match(anchor, /target="_blank" rel="noopener noreferrer"/, anchor);
      assert.ok(/opens in a new tab/.test(anchor), anchor);
    }
    assert.match(script, /link\.target = "_blank";\n {2}link\.rel = "noopener noreferrer";\n {2}link\.append\(el\("span", "sr", ", opens in a new tab"\)\);/);
  });

  test("the first question is the API's own default, the CLI asks it too, and the Skill Engine is the pinned commit", async () => {
    const { DEFAULT_HOW_TO } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    const { SKILL_ENGINE } = await import(new URL("../../../agent/dist/src/builder/skill.js", import.meta.url).href);
    assert.match(script, new RegExp(`send: "${DEFAULT_HOW_TO.replace(/[?]/g, "\\?")}",`));
    assert.ok(html.includes(`node dist/src/cli.js howto "${DEFAULT_HOW_TO}" --proof answer.json`));
    assert.ok(html.includes(`https://github.com/PharosNetwork/pharos-skill-engine/tree/${SKILL_ENGINE.commit}`));
  });

  test("the page says what it does and does not do: the docs' answer is theirs, no language model, nothing sent from here", () => {
    assert.match(html, /The docs' answer is the Developer Docs MCP's; the agent adds no language model: the action comes from the question's words, and the commands from the Skill Engine's templates\./);
    assert.match(html, /Nothing is sent from here; the CLI sends on Atlantic with a key/);
    assert.doesNotMatch(script, /fetch\(/, "the page asks only through the shared runner");
    assert.doesNotMatch(script.replaceAll("$PRIVATE_KEY", ""), /private[_ ]?key/i, "the page never handles a key; it only names the variable one is kept in");
  });
});
