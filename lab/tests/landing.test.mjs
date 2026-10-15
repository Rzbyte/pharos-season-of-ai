// The lab's landing page: built from the task manifest, bounded and honest about what exists.
//   node --test tests/landing.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { FOLDERS, renderMain } from "../build.mjs";
import { DEPLOYMENTS, LAB, TASKS } from "../public/assets/tasks.js";

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
      for (const part of [`<span class="row-n">${task.n}</span>`, `<span class="row-title">${task.title}</span>`, `>${task.verb}</span>`, `>${task.purpose.replaceAll("'", "&#39;")}</span>`]) assert.ok(rows[index].includes(part), `${task.n}: ${part}`);
    }
    assert.match(html, /<p class="lab-count"><b>4<\/b> \/ 28 built<\/p>/);
  });

  test("a row opens its deployment when the manifest has an address, otherwise its source folder; never a dead link", () => {
    for (const task of TASKS.filter((entry) => entry.status === "built")) assert.ok(FOLDERS[task.n], task.n);
    // 01 and 02 are deployed; 03 and 04 have no address yet.
    for (const n of ["01", "02"]) assert.match(html, new RegExp(`<a class="row-open" href="https://pharos-task-${n}\\.vercel\\.app"><span>Open</span>`));
    for (const folder of ["03-docs-mcp-onboarding", "04-doc-search-cli"]) assert.match(html, new RegExp(`<a class="row-open row-source" href="https://github\\.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/${folder}" target="_blank" rel="noopener noreferrer">`));
    const linked = TASKS.map((task) => (task.n === "04" ? { ...task, href: "https://search.example.com/" } : task));
    assert.match(renderMain(linked, LAB), /<a class="row-open" href="https:\/\/search\.example\.com\/"><span>Open<\/span>/, "an address, once set, replaces Source with Open");
    assert.doesNotMatch(html, /href=""|href="#"|href="null"/);
  });

  test("planned tasks wait behind one collapsed row, never as links; Task 03 is built, not planned", () => {
    assert.match(html, /<button class="toggle-row" id="planned-toggle" type="button" aria-expanded="false" aria-controls="planned-body">/);
    // Not hidden in the markup: without JavaScript the list is shown; landing.js collapses it.
    const planned = html.match(/<ol class="planned" id="planned-body">([\s\S]*?)<\/ol>/)[1];
    assert.match(read("public/assets/landing.css"), /\.js \.planned:not\(\[data-ready\]\) \{ display: none; \}/);
    assert.equal(planned.match(/<li>/g).length, 24);
    assert.doesNotMatch(planned, /<a\b/);
    assert.doesNotMatch(planned, /Docs MCP Onboarding|Docs Onboarding/);
  });

  test("every link that leaves the lab opens a new tab with no opener and says so; a task's own page opens in place", () => {
    const deployments = Object.values(DEPLOYMENTS).filter(Boolean);
    for (const [anchor] of html.matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
      if (deployments.some((url) => anchor.includes(`href="${url}"`))) {
        assert.doesNotMatch(anchor, /target=/, anchor);
        continue;
      }
      assert.match(anchor, /target="_blank" rel="noopener noreferrer"/, anchor);
      assert.ok(/opens in a new tab/.test(anchor), anchor);
    }
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
  });
});
