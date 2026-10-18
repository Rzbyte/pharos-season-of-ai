// Task 18's page: its files, the shared shell, and what the scripts rely on.
//   node --test tasks/18-recurring-payment/tests/page.test.mjs   (after npm run build in agent/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { shellPart } from "../../../shared/ui/sync.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");
const script = read("public/assets/schedule.js");
const runner = shared("agent.js");

describe("the Task 18 page", () => {
  test("carries the shared shell, stamped for 18, and an exact copy of the shared UI and the agent page layer", () => {
    assert.ok(html.includes(`<!-- shell:header 18 -->\n${shellPart(shared("header.html"), "18")}\n<!-- /shell:header -->`), "header");
    assert.ok(html.includes(`<!-- shell:footer 18 -->\n${shellPart(shared("footer.html"), "18")}\n<!-- /shell:footer -->`), "footer");
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js", "agent.css", "agent.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(script, /renderTaskNav\(TASKS, "18", LAB\);/);
  });

  test("loads only its own files: no inline script, nothing third-party", () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(refs, ["/assets/agent.css", "/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/schedule.css", "/assets/schedule.js", "/assets/theme.js"]);
    for (const ref of refs) read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.match(html, /<main id="main" class="rail page" data-api="\/api\/agent" data-task="18">/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
  });

  test("every element the scripts look up exists, and each field has a label, a hint, and the schedule a length limit", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const source of [script, runner]) for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
    // Looked up by key: the fields, their hints, and the examples.
    for (const id of ["f-schedule", "h-schedule", "f-since", "h-since", "f-from", "h-from", "ex-household", "ex-subscriptions", "ex-daily"]) assert.ok(ids.has(id), `#${id} missing`);
    const fields = [...html.matchAll(/<(?:input|select|textarea) class="input[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    assert.deepEqual(fields, ["f-schedule", "f-since", "f-from"]);
    for (const id of fields) assert.match(html, new RegExp(`<label class="field-label" for="${id}"`), id);
    for (const [, id] of html.matchAll(/<(?:input|textarea) class="input" id="([^"]+)"/g)) assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="h-${id.slice(2)}"`), id);
    assert.match(html, /id="f-schedule" name="schedule" rows="4" maxlength="3000"/);
    assert.match(html, /id="f-since" name="since" type="date"/);
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

  test("the first schedule is the API's own default, and the CLI's run shown is the same command", async () => {
    const { DEFAULT_SCHEDULE } = await import(new URL("../../../agent/dist/src/web.js", import.meta.url).href);
    const landlord = /const LANDLORD = "(0x[0-9a-fA-F]{40})";/.exec(script)[1];
    const staff = /const STAFF = "(0x[0-9a-fA-F]{40})";/.exec(script)[1];
    const schedule = /const SCHEDULE = `([\s\S]*?)`;/.exec(script)[1].replaceAll("${LANDLORD}", landlord).replaceAll("${STAFF}", staff);
    assert.equal(schedule, DEFAULT_SCHEDULE);
    assert.ok(html.includes("node dist/src/cli.js recurring schedule.txt --store store.json --since 2026-10-01 --proof run-1.json"));
  });

  test("the page says what it does and does not do: nothing kept or sent from here, the CLI's store pays each once", () => {
    assert.match(html, /This page keeps nothing between runs, so nothing here is recorded as paid\. The CLI keeps a store: each payment paid once, a missed run caught up\./);
    assert.match(html, /Several runs verified together must form one history, each from the store the last one left, no payment recorded twice\./);
    assert.doesNotMatch(script, /fetch\(/, "the page asks only through the shared runner");
    assert.doesNotMatch(script, /private[_ ]?key/i, "the page never handles a key");
  });
});
