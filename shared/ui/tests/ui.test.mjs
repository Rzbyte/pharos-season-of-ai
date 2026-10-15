// The shared UI: pure helpers, the sync that keeps every deployment's copy identical, and the task
// navigation in a real browser (skipped, with the reason, when Playwright is not installed).
//   NODE_PATH="$(npm root -g)" node --test shared/ui/tests/ui.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import { neighbours, onUnifiedSite, pageOf } from "../lab.js";
import { shellPart, stampShell } from "../sync.mjs";
import { BUILT, LAB, LEGACY, route, TASKS } from "../tasks.js";

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

  test("the manifest: 28 tasks, 01 to 04 built at /tasks/NN, legacy addresses only as fallbacks", () => {
    assert.equal(TASKS.length, LAB.total);
    assert.equal(BUILT, 4);
    assert.equal(LAB.home, "/");
    for (const task of TASKS) {
      assert.equal(task.href, task.status === "built" ? route(task.n) : null, task.n);
      assert.equal(task.legacy, task.status === "built" ? (LEGACY[task.n] ?? null) : null, task.n);
    }
    assert.equal(route("27"), "/tasks/27", "future tasks continue the same way");
  });

  test("onUnifiedSite: true only at /tasks/NN, where same-domain routes exist", () => {
    for (const path of ["/tasks/01", "/tasks/28", "/tasks/04/"]) assert.equal(onUnifiedSite(path), true, path);
    for (const path of ["/", "/index.html", "/tasks", "/tasks/1", "/tasks/01/x"]) assert.equal(onUnifiedSite(path), false, path);
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
  test("on the unified site every link is a same-domain route; on a standalone page, only its legacy fallbacks", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const files = { "/lab.js": read("lab.js"), "/tasks.js": read("tasks.js") };
    const shell = `<!doctype html><body>${shellPart(read("header.html"), "02")}${shellPart(read("footer.html"), "02")}</body>`;
    await page.route("http://ui.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: files[path] ?? "" });
      return route.fulfill({ contentType: "text/html", body: shell });
    });
    const render = async (path) => {
      await page.goto(`http://ui.test${path}`);
      return page.evaluate(async () => {
        const { renderTaskNav } = await import("/lab.js");
        const { TASKS, LAB } = await import("/tasks.js");
        renderTaskNav(TASKS, "02", LAB);
        const step = (direction) => document.querySelector(`[data-task-step="${direction}"]`);
        return {
          home: document.querySelector("[data-lab-home]").getAttribute("href"),
          count: document.querySelector("[data-task-count]").textContent,
          previous: [step("previous").tagName, step("previous").getAttribute("href"), step("previous").getAttribute("aria-label")],
          next: [step("next").tagName, step("next").getAttribute("href"), step("next").getAttribute("aria-disabled"), step("next").tabIndex],
          footer: [...document.querySelectorAll("[data-task-neighbour]")].map((slot) => [slot.textContent, slot.querySelector("a")?.getAttribute("href") ?? null]),
        };
      });
    };
    assert.deepEqual(await render("/tasks/02"), {
      home: "/",
      count: "Task 02 / 28",
      previous: ["A", "/tasks/01", "Previous task: 01 Contract State"],
      next: ["A", "/tasks/03", null, 0],
      footer: [["Previous01Contract State", "/tasks/01"], ["Next03Docs Onboarding", "/tasks/03"]],
    });
    // The standalone Task 02 deployment serves this page at "/": Task 01 has its own deployment to link
    // to, Task 03 has none, and there is no lab there.
    assert.deepEqual(await render("/"), {
      home: null,
      count: "Task 02 / 28",
      previous: ["A", "https://pharos-task-01.vercel.app", "Previous task: 01 Contract State"],
      next: ["SPAN", null, "true", -1],
      footer: [["Previous01Contract State", "https://pharos-task-01.vercel.app"], ["Next03Docs Onboarding", null]],
    });
    await browser.close();
  });
});
