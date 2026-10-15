// The shared UI: pure helpers, the sync that keeps every deployment's copy identical, and the task
// navigation in a real browser (skipped, with the reason, when Playwright is not installed).
//   NODE_PATH="$(npm root -g)" node --test shared/ui/tests/ui.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import { neighbours, pageOf } from "../lab.js";
import { shellPart, stampShell } from "../sync.mjs";
import { BUILT, DEPLOYMENTS, LAB, TASKS } from "../tasks.js";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("helpers", () => {
  test("pageOf: five to a page, page 1 first, clamped into range", () => {
    assert.deepEqual(pageOf(0, 5, 1), { page: 1, pages: 1, start: 0, end: 0 });
    assert.deepEqual(pageOf(12, 5, 1), { page: 1, pages: 3, start: 0, end: 5 });
    assert.deepEqual(pageOf(12, 5, 3), { page: 3, pages: 3, start: 10, end: 12 });
    assert.deepEqual(pageOf(12, 5, 9), { page: 3, pages: 3, start: 10, end: 12 }, "a page that is gone becomes the last");
    assert.deepEqual(pageOf(12, 5, 0), { page: 1, pages: 3, start: 0, end: 5 });
    assert.deepEqual(pageOf(12, 5, Number.NaN), { page: 1, pages: 3, start: 0, end: 5 });
  });

  test("neighbours: the tasks either side, none past the ends", () => {
    assert.deepEqual([neighbours(TASKS, "01").previous, neighbours(TASKS, "01").next.n], [null, "02"]);
    assert.deepEqual([neighbours(TASKS, "28").previous.n, neighbours(TASKS, "28").next], ["27", null]);
    assert.equal(neighbours(TASKS, "99").index, -1);
  });

  test("the manifest: 28 tasks, 01 to 04 built, a link only from a deployment address", () => {
    assert.equal(TASKS.length, LAB.total);
    assert.equal(BUILT, 4);
    for (const task of TASKS) {
      assert.equal(task.href, task.status === "built" ? (DEPLOYMENTS[task.n] ?? null) : null, task.n);
      if (task.href !== null) assert.match(task.href, /^https:\/\//);
    }
  });
});

describe("stylesheet", () => {
  test("phone overrides come after the base rules they override (same layer, same specificity)", () => {
    const css = read("lab.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const base = css.indexOf(".beacon::after { content:");
    const phone = css.indexOf("@media (max-width: 599px) {\n    .panel { margin-inline");
    assert.ok(base > 0 && phone > base, "the phone panel and beacon rules follow the base beacon rule");
  });
});

describe("sync", () => {
  test("every deployment ships an exact copy of the shared UI and the shell markup", () => {
    execFileSync(process.execPath, [new URL("../sync.mjs", import.meta.url).pathname, "--check"]);
  });

  test("stamping fills both markers; the landing page has no task navigation", () => {
    const templates = { header: read("header.html"), footer: read("footer.html") };
    const page = "<body>\n<!-- shell:header 02 -->old<!-- /shell:header -->\n<main></main>\n<!-- shell:footer 02 --><!-- /shell:footer -->\n</body>";
    const stamped = stampShell(page, templates);
    assert.match(stamped, /<span class="sr">Task <\/span><b>02<\/b> \/ 28/);
    assert.match(stamped, /data-task-neighbour="next"/);
    assert.equal(stampShell(stamped, templates), stamped, "stamping twice changes nothing");
    assert.doesNotMatch(shellPart(templates.header, "lab"), /shell-tasks/);
    assert.doesNotMatch(shellPart(templates.footer, "lab"), /neighbours/);
    assert.throws(() => stampShell("<body></body>", templates), /expected a shell:header and a shell:footer marker/);
  });
});

let chromium = null;
let skip = false;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
  await (await chromium.launch()).close();
} catch (error) {
  skip = chromium ? `Chromium is not available (${error.message.split("\n")[0]})` : "Playwright is not installed (set NODE_PATH to a global install)";
}

describe("task navigation in a browser", { skip }, () => {
  test("a neighbour with an address is a named link; one without is marked and never focusable", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const files = { "/lab.js": read("lab.js"), "/tasks.js": read("tasks.js") };
    await page.route("http://ui.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><body>${shellPart(read("header.html"), "02")}${shellPart(read("footer.html"), "02")}</body>` });
      return route.fulfill({ contentType: "text/javascript", body: files[path] ?? "" });
    });
    await page.goto("http://ui.test/");
    const result = await page.evaluate(async () => {
      const { renderTaskNav } = await import("/lab.js");
      const { TASKS, LAB } = await import("/tasks.js");
      const tasks = TASKS.map((task) => (task.n === "01" ? { ...task, href: "https://one.example.com/" } : task));
      renderTaskNav(tasks, "02", { ...LAB, home: "https://lab.example.com/" });
      const step = (direction) => document.querySelector(`[data-task-step="${direction}"]`);
      return {
        home: document.querySelector("[data-lab-home]").getAttribute("href"),
        count: document.querySelector("[data-task-count]").textContent,
        previous: [step("previous").tagName, step("previous").getAttribute("href"), step("previous").getAttribute("aria-label")],
        next: [step("next").tagName, step("next").getAttribute("aria-disabled"), step("next").getAttribute("aria-label"), step("next").tabIndex],
        footer: [...document.querySelectorAll("[data-task-neighbour]")].map((slot) => [slot.hidden, slot.textContent, slot.querySelector("a")?.getAttribute("href") ?? null]),
      };
    });
    assert.deepEqual(result, {
      home: "https://lab.example.com/",
      count: "Task 02 / 28",
      previous: ["A", "https://one.example.com/", "Previous task: 01 Contract State"],
      next: ["SPAN", "true", "Next task: 03 Docs Onboarding, not linked", -1],
      footer: [[false, "Previous01Contract State", "https://one.example.com/"], [false, "Next03Docs Onboarding", null]],
    });
    await browser.close();
  });
});
