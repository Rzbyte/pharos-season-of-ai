// Task 17's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/17-natural-language-payment/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/payments.js");
const runner = shared("agent.js");

describe("the Task 17 page", () => {
  test("carries the shared shell, stamped for 17, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 17 -->\n${shellPart(shared("header.html"), "17")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 17 -->\n${shellPart(shared("footer.html"), "17")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "17", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/payments.css", "/assets/payments.js", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="17">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and each field has a label, a hint, and the request a length limit", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    // Looked up by key: the fields, their hints, and the examples.
    for (const id of ["f-request", "h-request", "f-from", "h-from", "f-contacts", "h-contacts", "ex-two", "ex-split", "ex-each"]) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-request", "f-from", "f-contacts"]);
    for (const id of fields) assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
    for (const [, id] of html.matchAll(/<(?:input|textarea) class="input" id="([^"]+)"/g)) assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
    assert.match(html, /id="f-request" name="request" rows="2" maxlength="500"/);
  });

  test("the result is set as text: the scripts never write markup", () => {
    for (const source of [script, runner]) assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  test("every link that leaves the site opens a new tab with no opener and says so", () => {
    for (const [anchor] of html.matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
      assert.match(anchor, /target="_blank" rel="noopener noreferrer"/, anchor);
      assert.ok(/opens in a new tab/.test(anchor), anchor);
    }
  });

  test("the first request and the address book are the API's own defaults, and the CLI prepares that request too", async () => {
    const { DEFAULT_CONTACTS, DEFAULT_PAYMENT } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    assert.match(script, new RegExp(`two: "${DEFAULT_PAYMENT}",`));
    assert.ok(script.includes(`const CONTACTS = ${JSON.stringify(DEFAULT_CONTACTS)};`));
    assert.ok(html.includes(`node dist/src/cli.js pay "${DEFAULT_PAYMENT}" --contacts contacts.txt --proof flow.json`));
  });

  test("the page says what it does and does not do: no language model reads the request, nothing is sent from here", () => {
    assert.match(html, /No language model reads the request: a request the grammar does not read whole is refused, never guessed at\./);
    assert.match(html, /The CLI sends them on Atlantic with a key, in order, each against its receipt/);
    assert.doesNotMatch(script, /fetch\(/, "the page asks only through the shared runner");
    assert.doesNotMatch(script, /private[_ ]?key/i, "the page never handles a key");
  });
});
