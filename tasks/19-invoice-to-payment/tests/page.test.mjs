// Task 19's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/19-invoice-to-payment/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/invoice.js");
const runner = shared("agent.js");

describe("the Task 19 page", () => {
  test("carries the shared shell, stamped for 19, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 19 -->\n${shellPart(shared("header.html"), "19")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 19 -->\n${shellPart(shared("footer.html"), "19")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "19", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/invoice.css", "/assets/invoice.js", "/assets/lab.css", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="19">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and each field has a label, a hint, and the invoice a length limit", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    // Looked up by key: the fields, their hints, and the examples.
    for (const id of ["f-invoice", "h-invoice", "f-from", "h-from", "f-payees", "h-payees", "ex-invoice", "ex-link", "ex-wrong", "ex-changed"]) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-invoice", "f-from", "f-payees"]);
    for (const id of fields) assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
    for (const [, id] of html.matchAll(/<(?:input|textarea) class="input" id="([^"]+)"/g)) assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
    assert.match(html, /id="f-invoice" name="invoice" rows="8" maxlength="2000"/);
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

  test("the first invoice and your payees are the API's own defaults, and the page caps an invoice as the API does", async () => {
    const { DEFAULT_INVOICE, DEFAULT_PAYEES, WEB_MAX_INVOICE } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    const studio = /const STUDIO = "(0x[0-9a-fA-F]{40})";/.exec(script)[1];
    const invoice = /const INVOICE = `([\s\S]*?)`;/.exec(script)[1].replaceAll("${STUDIO}", studio);
    assert.equal(invoice, DEFAULT_INVOICE);
    assert.equal(/const PAYEES = `([^`]*)`;/.exec(script)[1].replaceAll("${STUDIO}", studio), DEFAULT_PAYEES);
    assert.match(script, new RegExp(`const MAX = ${WEB_MAX_INVOICE};`));
  });

  test("the page says what it does and does not do: no language model reads the invoice, nothing is sent from here", () => {
    assert.match(html, /An invoice that does not add up is never paid, and nothing is guessed: no language model reads it\./);
    assert.match(html, /the CLI sends on Atlantic, with a key, only when nothing does/);
    assert.doesNotMatch(script, /fetch\(/, "the page asks only through the shared runner");
    assert.doesNotMatch(script, /private[_ ]?key/i, "the page never handles a key");
  });
});
