// The lab's landing page: built from the task manifest, bounded and honest about what exists.
//   node --test tests/landing.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { renderMain } from "../build.mjs";
import { LAB, TASKS } from "../public/assets/tasks.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../shared/ui/${name}`, import.meta.url), "utf8");
const html = read("public/index.html");

describe("the landing page", () => {
  test("is exactly what the manifest renders, with the shared shell and no task navigation", () => {
    execFileSync(process.execPath, [new URL("../build.mjs", import.meta.url).pathname, "--check"]);
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
    assert.match(html, /<!-- shell:header lab -->/);
    assert.doesNotMatch(html, /data-task-step|data-task-neighbour/, "the index has no previous/next");
  });

  test("one row per built task, with its number, name, verb and one line; the count says how many", () => {
    const rows = [...html.matchAll(/<li class="row">([\s\S]*?)<\/li>/g)].map(([, row]) => row);
    assert.equal(rows.length, 4);
    for (const [index, task] of TASKS.filter((entry) => entry.status === "built").entries()) {
      for (const part of [`<span class="row-n">${task.n}</span>`, `<a class="row-title" href="/tasks/${task.n}">${task.title}</a>`, `>${task.verb}</span>`, `>${task.purpose.replaceAll("'", "&#39;")}</span>`]) assert.ok(rows[index].includes(part), `${task.n}: ${part}`);
    }
    assert.match(html, /<p class="lab-count"><b>4<\/b> \/ 30 built<\/p>/);
    assert.equal(LAB.total, 30);
  });

  test("every built row opens its page on this site, /tasks/NN, in place; never a dead link", () => {
    assert.deepEqual([...html.matchAll(/<a class="row-title" href="([^"]+)">/g)].map(([, href]) => href), ["/tasks/01", "/tasks/02", "/tasks/03", "/tasks/04"]);
    assert.doesNotMatch(html, /vercel\.app|row-source|row-open/);
    assert.doesNotMatch(html, /href=""|href="#"|href="null"/);
  });

  test("a row is one target: the name is the link and it covers the whole row; one link per row", () => {
    const css = read("public/assets/landing.css");
    assert.match(css, /\.row \{\s*position: relative;/);
    assert.match(css, /a\.row-title::after \{ content: ""; position: absolute; inset: 0; \}/);
    // The focus ring is drawn around the whole row, since the link covers it.
    assert.match(css, /\.row:has\(a\.row-title:focus-visible\) \{ outline: 2px solid var\(--accent\);/);
    for (const [, row] of html.matchAll(/<li class="row">([\s\S]*?)<\/li>/g)) assert.equal(row.match(/<a\b/g).length, 1, row);
  });

  test("planned tasks wait behind one collapsed row, never as links; Task 03 is built, not planned", () => {
    assert.match(html, /<button class="toggle-row" id="planned-toggle" type="button" aria-expanded="false" aria-controls="planned-body">/);
    // Not hidden in the markup: without JavaScript the list is shown; landing.js collapses it.
    const planned = html.match(/<ol class="planned" id="planned-body">([\s\S]*?)<\/ol>/)[1];
    assert.match(read("public/assets/landing.css"), /\.js \.planned:not\(\[data-ready\]\) \{ display: none; \}/);
    assert.equal(planned.match(/<li>/g).length, 26);
    assert.match(html, /<span class="disclosure-meta">26 tasks, 05–30<\/span>/);
    assert.doesNotMatch(planned, /<a\b/);
    assert.doesNotMatch(planned, /Docs MCP Onboarding|Docs Onboarding/);
  });

  test("the planned list follows the official map: the x402 tasks at 20 and 21, then 22 to 30", () => {
    const planned = html.match(/<ol class="planned" id="planned-body">([\s\S]*?)<\/ol>/)[1];
    const rows = [...planned.matchAll(/<li><span class="row-n">(\d{2})<\/span><span>([^<]*)<\/span><\/li>/g)].map(([, n, title]) => [n, title]);
    assert.deepEqual(rows, TASKS.filter((task) => task.status !== "built").map((task) => [task.n, task.title]));
    assert.deepEqual(rows.slice(14, 18), [["19", "Invoice-to-Payment Agent"], ["20", "x402 task (title pending)"], ["21", "x402 task (title pending)"], ["22", "On-Chain Alert Bot"]]);
    assert.deepEqual(rows.at(-1), ["30", "Multi-Protocol Aggregator"]);
  });

  test("every link that leaves the site opens a new tab with no opener and says so", () => {
    for (const [anchor] of html.matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
      assert.match(anchor, /target="_blank" rel="noopener noreferrer"/, anchor);
      assert.ok(/opens in a new tab/.test(anchor), anchor);
    }
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
  });
});
