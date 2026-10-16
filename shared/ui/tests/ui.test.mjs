// The shared UI: pure helpers, the sync that keeps every deployment's copy identical, and the task
// navigation in a real browser (skipped, with the reason, when Playwright is not installed).
//   NODE_PATH="$(npm root -g)" node --test shared/ui/tests/ui.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import { neighbours, onUnifiedSite, pageOf } from "../lab.js";
import { shellPart, stampShell, TARGETS } from "../sync.mjs";
import { BUILT, LAB, LEGACY, route, TASKS } from "../tasks.js";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

/** The legacy map: 28 tasks, before the official map inserted the two x402 tasks at 20 and 21. */
const LEGACY_MAP = [
  "Read Contract State", "Event / Log Monitor", "Docs MCP Onboarding", "Doc-Search CLI", "Threshold Guardian", "Saga Executor", "Arbitrage Scanner",
  "Dry-Run Executor", "Trend Watcher", "Batch Executor", "Policy Gatekeeper", "Skill + Chain MCP Flow", "Docs MCP + Chain MCP Agent", "Portfolio Assistant",
  "Yield Optimizer", "Liquidation Watchdog", "Natural-Language Payment Agent", "Recurring Payment Agent", "Invoice-to-Payment Agent", "On-Chain Alert Bot",
  "Whale-Watching Agent", "Gas Fee Optimizer", "Wallet Risk Checker", "Audit-Log Agent", "dApp Support Agent", "Weekly Digest Agent",
  "Doc-Grounded Builder Agent", "Multi-Protocol Aggregator",
];

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
    assert.deepEqual([neighbours(TASKS, "30").previous.n, neighbours(TASKS, "30").next], ["29", null]);
    assert.equal(neighbours(TASKS, "99").index, -1);
  });

  test("the manifest: 01 to 04 built at /tasks/NN, legacy addresses only as fallbacks", () => {
    assert.equal(TASKS.length, LAB.total);
    assert.equal(BUILT, 4);
    assert.equal(LAB.home, "/");
    for (const task of TASKS) {
      assert.equal(task.href, task.status === "built" ? route(task.n) : null, task.n);
      assert.equal(task.legacy, task.status === "built" ? (LEGACY[task.n] ?? null) : null, task.n);
    }
    assert.equal(route("30"), "/tasks/30", "future tasks continue the same way");
  });

  test("onUnifiedSite: true only at /tasks/NN, where same-domain routes exist", () => {
    for (const path of ["/tasks/01", "/tasks/30", "/tasks/04/"]) assert.equal(onUnifiedSite(path), true, path);
    for (const path of ["/", "/index.html", "/tasks", "/tasks/1", "/tasks/01/x"]) assert.equal(onUnifiedSite(path), false, path);
  });
});

describe("the official task map", () => {
  test("30 tasks, numbered 01 to 30 in order, each number once; the total says the same", () => {
    assert.equal(TASKS.length, 30);
    assert.equal(LAB.total, TASKS.length);
    assert.deepEqual(TASKS.map((task) => task.n), Array.from({ length: 30 }, (_, index) => String(index + 1).padStart(2, "0")));
    assert.equal(new Set(TASKS.map((task) => task.n)).size, TASKS.length);
    assert.ok(Object.isFrozen(TASKS) && TASKS.every(Object.isFrozen) && Object.isFrozen(LAB));
  });

  test("the legacy 28 with the two x402 tasks inserted at 20 and 21: 01 to 19 unchanged, old 20 to 28 now 22 to 30", () => {
    assert.deepEqual(TASKS.slice(0, 19).map((task) => [task.n, task.official]), LEGACY_MAP.slice(0, 19).map((title, index) => [String(index + 1).padStart(2, "0"), title]));
    assert.deepEqual(TASKS.slice(21).map((task) => [task.n, task.official]), LEGACY_MAP.slice(19).map((title, index) => [String(index + 22), title]));
    assert.equal(TASKS.find((task) => task.n === "30").tool, "Composition", "a task keeps its metadata when it moves");
    assert.deepEqual(TASKS.slice(19, 21).map((task) => [task.n, task.official, task.title]), [["20", "X402 Paywalled API", "X402 Paywalled API"], ["21", "X402 Agent Buyer", "X402 Agent Buyer"]]);
    for (const task of TASKS.slice(19, 21)) assert.deepEqual([task.status, task.href, task.legacy, task.tool], ["planned", null, null, null], task.n);
    assert.ok(TASKS.every((task) => typeof task.official === "string" && task.official.length > 0), "every task has its official title");
  });

  test("the built tasks keep their numbers, routes and fallbacks; nothing planned is linked", () => {
    assert.deepEqual(TASKS.filter((task) => task.status === "built").map((task) => [task.n, task.official, task.href, task.legacy]), [
      ["01", "Read Contract State", "/tasks/01", "https://pharos-task-01.vercel.app"],
      ["02", "Event / Log Monitor", "/tasks/02", "https://pharos-task-02.vercel.app"],
      ["03", "Docs MCP Onboarding", "/tasks/03", null],
      ["04", "Doc-Search CLI", "/tasks/04", null],
    ]);
    for (const task of TASKS.slice(4)) assert.deepEqual([task.status, task.href, task.legacy], ["planned", null, null], task.n);
  });

  test("moving through the map: 04 then 05, 19 then the x402 tasks then 22, and 30 is the last", () => {
    const around = (n) => {
      const { previous, next } = neighbours(TASKS, n);
      return [previous?.n ?? null, next?.n ?? null];
    };
    assert.deepEqual(["01", "04", "05", "19", "20", "21", "22", "29", "30"].map(around), [
      [null, "02"], ["03", "05"], ["04", "06"], ["18", "20"], ["19", "21"], ["20", "22"], ["21", "23"], ["28", "30"], ["29", null],
    ]);
    assert.equal(neighbours(TASKS, "31").index, -1, "nothing past 30");
  });

  test("every page's counter shows its own number out of the same total, before any script runs", () => {
    assert.match(read("header.html"), new RegExp(`<b>\\{\\{n\\}\\}</b> / ${LAB.total}</span>`));
    const pages = TARGETS.filter((target) => target.startsWith("tasks/"));
    assert.equal(pages.length, BUILT);
    for (const target of pages) {
      const page = readFileSync(new URL(`../../../${target}/index.html`, import.meta.url), "utf8");
      const counters = [...page.matchAll(/<span class="shell-count" data-task-count><span class="sr">Task <\/span><b>(\d{2})<\/b> \/ (\d+)<\/span>/g)];
      assert.deepEqual(counters.map(([, n, total]) => [n, Number(total)]), [[target.match(/^tasks\/(\d{2})-/)[1], LAB.total]], target);
    }
  });
});

describe("stylesheet", () => {
  test("the app page model: as tall as the screen on the dynamic viewport, no page scroll, no footer", () => {
    const css = read("lab.css");
    assert.match(css, /body\.app \{ height: 100vh; height: 100dvh; min-height: 0; overflow: hidden; \}/);
    assert.match(css, /body\.app > main \{ flex: 1 1 auto; min-height: 0; \}/);
    assert.match(css, /body\.app > \.foot \{ display: none; \}/);
  });

  test("the gutters respect the safe area, so viewport-fit=cover never puts text under a notch", () => {
    const css = read("lab.css");
    assert.match(css, /padding-left: max\(var\(--pad-x\), env\(safe-area-inset-left\)\); padding-right: max\(var\(--pad-x\), env\(safe-area-inset-right\)\);/);
    assert.match(css, /padding-block: var\(--space-2\) calc\(var\(--space-2\) \+ env\(safe-area-inset-bottom\)\);/, "the footer clears the home indicator");
  });

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
    assert.match(stamped, /<span class="sr">Task <\/span><b>02<\/b> \/ 30<\/span>/);
    assert.equal(stampShell(stamped, templates), stamped, "stamping twice changes nothing");
    assert.doesNotMatch(shellPart(templates.header, "lab"), /shell-tasks/);
    // Moving between tasks is the shell bar's job only: the footer is one line, the lab and its links.
    assert.doesNotMatch(stamped, /neighbour/);
    assert.match(shellPart(templates.footer, "02"), /^<footer class="foot">\s*<div class="rail foot-inner">\s*<p class="foot-tag">/);
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
  test("on the unified site every link is a same-domain route; on a standalone page, only its legacy fallbacks", async (t) => {
    const browser = await chromium.launch();
    // Closed even when an assertion fails, so a failure ends the run instead of leaving Chromium open.
    t.after(() => browser.close());
    const page = await browser.newPage();
    const files = { "/lab.js": read("lab.js"), "/tasks.js": read("tasks.js") };
    const shell = `<!doctype html><body>${shellPart(read("header.html"), "02")}${shellPart(read("footer.html"), "02")}</body>`;
    await page.route("http://ui.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: files[path] ?? "" });
      return route.fulfill({ contentType: "text/html", body: shell });
    });
    const render = async (path, current = "02") => {
      await page.goto(`http://ui.test${path}`);
      return page.evaluate(async (current) => {
        const { renderTaskNav } = await import("/lab.js");
        const { TASKS, LAB } = await import("/tasks.js");
        renderTaskNav(TASKS, current, LAB);
        const step = (direction) => document.querySelector(`[data-task-step="${direction}"]`);
        const count = document.querySelector("[data-task-count]");
        const menu = document.getElementById("task-menu");
        return {
          home: document.querySelector("[data-lab-home]").getAttribute("href"),
          count: [count.tagName, count.textContent, count.getAttribute("aria-expanded"), count.popoverTargetElement === menu],
          previous: [step("previous").tagName, step("previous").getAttribute("href"), step("previous").getAttribute("aria-label")],
          next: [step("next").tagName, step("next").getAttribute("href"), step("next").getAttribute("aria-disabled"), step("next").tabIndex],
          menu: [...menu.querySelectorAll(".task-menu-row, .task-menu-all")].map((row) => [row.textContent.trim(), row.getAttribute("href"), row.getAttribute("aria-current")]),
          footer: document.querySelectorAll("[data-task-neighbour], .neighbours").length,
        };
      }, current);
    };
    assert.deepEqual(await render("/tasks/02"), {
      home: "/",
      count: ["BUTTON", "Task 02 / 30, switch task", "false", true],
      previous: ["A", "/tasks/01", "Previous task: 01 Contract State"],
      next: ["A", "/tasks/03", null, 0],
      menu: [
        ["01 Contract State Read", "/tasks/01", null],
        ["02 Event Monitor Watch", "/tasks/02", "page"],
        ["03 Docs Onboarding Audit", "/tasks/03", null],
        ["04 Docs Search Query", "/tasks/04", null],
        ["All 30 tasks", "/", null],
      ],
      footer: 0,
    });
    // The switcher opens and closes as a popover, and says so on its button.
    await page.click("button.shell-count");
    assert.equal(await page.evaluate(() => document.getElementById("task-menu").matches(":popover-open")), true);
    await page.waitForFunction(() => document.querySelector("button.shell-count").getAttribute("aria-expanded") === "true");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("button.shell-count").getAttribute("aria-expanded") === "false");
    // The standalone Task 02 deployment serves this page at "/": Task 01 has its own deployment to link
    // to, Tasks 03 and 04 have none, and there is no lab there.
    assert.deepEqual(await render("/"), {
      home: null,
      count: ["BUTTON", "Task 02 / 30, switch task", "false", true],
      previous: ["A", "https://pharos-task-01.vercel.app", "Previous task: 01 Contract State"],
      next: ["SPAN", null, "true", -1],
      menu: [
        ["01 Contract State Read", "https://pharos-task-01.vercel.app", null],
        ["02 Event Monitor Watch", "https://pharos-task-02.vercel.app", "page"],
        ["03 Docs Onboarding Audit, not linked from here", null, null],
        ["04 Docs Search Query, not linked from here", null, null],
      ],
      footer: 0,
    });
    // The last built task: its next arrow names Task 05, planned and so not linked; the switcher still
    // ends with the lab and the full total.
    const last = await render("/tasks/04", "04");
    assert.deepEqual([last.count[1], last.previous, last.next], [
      "Task 04 / 30, switch task",
      ["A", "/tasks/03", "Previous task: 03 Docs Onboarding"],
      ["SPAN", null, "true", -1],
    ]);
    assert.equal(await page.getAttribute('[data-task-step="next"]', "aria-label"), "Next task: 05 Threshold Guardian, not linked");
    assert.deepEqual(last.menu.at(-1), ["All 30 tasks", "/", null]);
  });
});
