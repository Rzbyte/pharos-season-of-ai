// The unified site: one domain, the lab at /, every task at /tasks/NN, every API at /api/<name>.
//   NODE_PATH="$(npm root -g)" node --test site/tests/site.test.mjs
// Needs the tasks' dist/ folders (npm run build in tasks 01, 02 and 04). The site is assembled into a
// temporary folder and served by site/serve.mjs with the root vercel.json rules. Every API is the
// task's own handler, pointed at that task's in-repo fake, so nothing reaches the network. Browser
// checks run in Chromium where Playwright is installed globally, and are skipped (saying why) otherwise.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiMap, assemble, TASK_DIRS } from "../build.mjs";
import { createSiteServer } from "../serve.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const at = (path) => pathToFileURL(join(REPO, path)).href;
const ROUTES = { "/": "Pharos Agent Lab", "/tasks/01": "01 · Contract State", "/tasks/02": "02 · Event Monitor", "/tasks/03": "03 · Docs Onboarding", "/tasks/04": "04 · Docs Search" };

let out;
let site;
let base;
const fakes = [];
const apiHits = [];

before(async () => {
  out = await mkdtemp(join(tmpdir(), "pharos-site-"));
  await assemble({ out });

  // Task 01: the real handlers on its fake Chain MCP and fake AI provider.
  const viem = createRequire(join(REPO, TASK_DIRS["01"], "package.json"))("viem");
  const enc = (type, value) => viem.encodeAbiParameters([{ type }], [value]);
  const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
  const { startFakeInspectorMcp } = await import(at(`${TASK_DIRS["01"]}/tests/fake-inspector-mcp.mjs`));
  const { startFakeDeepSeek } = await import(at(`${TASK_DIRS["01"]}/tests/fake-deepseek.mjs`));
  const chain01 = await startFakeInspectorMcp({
    blockNumber: 20_384_112n,
    contracts: { [USDC]: { "0x06fdde03": enc("string", "USDC"), "0x95d89b41": enc("string", "USDC"), "0x313ce567": enc("uint256", 6n), "0x18160ddd": enc("uint256", 20_271_995_983_588n), "0x5c975abb": enc("bool", false) } },
    transactions: {},
  });
  const ai = await startFakeDeepSeek({});
  // Task 02: the real handler on its fake Chain MCP, with Transfers in the window.
  const { startFakePharosMcp } = await import(at(`${TASK_DIRS["02"]}/dist/tests/fake-pharos-mcp.js`));
  const { makeLog } = await import(at(`${TASK_DIRS["02"]}/dist/tests/fixtures.js`));
  const head = 20_248_479n;
  const chain02 = await startFakePharosMcp({ head, logs: [makeLog({ block: head - 10n, index: 0 }), makeLog({ block: head - 5n, index: 1 })] });
  // Task 04: the real handler on its fake Developer Docs MCP.
  const { startFakeMcp } = await import(at(`${TASK_DIRS["04"]}/dist/tests/fake-mcp.js`));
  const docs = await startFakeMcp();
  fakes.push(chain01, ai, chain02, docs);

  const handler = async (path, args) => (await import(at(path))).createHandler(args);
  const apis = {
    state: await handler(`${TASK_DIRS["01"]}/api/state.js`, chain01.url),
    inspect: await handler(`${TASK_DIRS["01"]}/api/inspect.js`, chain01.url),
    explain: await handler(`${TASK_DIRS["01"]}/api/explain.js`, { apiKey: "sk-site-test", providerUrl: ai.url, log: () => undefined }),
    events: await handler(`${TASK_DIRS["02"]}/api/events.js`, chain02.url),
    search: await handler(`${TASK_DIRS["04"]}/api/search.js`, { mcpUrl: docs.url }),
  };
  const counted = Object.fromEntries(Object.entries(apis).map(([name, fn]) => [name, (req, res) => (apiHits.push(name), fn(req, res))]));
  site = await createSiteServer({ root: out, apis: counted });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});

after(async () => {
  site?.closeAllConnections?.();
  await new Promise((resolve) => (site ? site.close(resolve) : resolve()));
  for (const fake of fakes) await fake.close();
  await rm(out, { recursive: true, force: true });
});

const get = (path, init) => fetch(`${base}${path}`, init);

describe("one project, thin adapters, no collisions", () => {
  test("each /api/<name> is a one-line re-export of exactly one task's own handler", async () => {
    const map = await apiMap();
    assert.deepEqual([...map.keys()].sort(), ["events.js", "explain.js", "inspect.js", "search.js", "state.js"]);
    for (const [name, { target }] of map) {
      const adapter = await readFile(join(REPO, "api", name), "utf8");
      assert.equal(adapter.split("\n").filter((line) => line && !line.startsWith("//")).length, 1, `${name}: nothing but the re-export`);
      assert.equal((await import(at(`api/${name}`))).default, (await import(at(target))).default, `${name} is the task's own default handler`);
    }
    assert.deepEqual((await readdir(join(REPO, "api"))).sort(), [...map.keys()].sort(), "no adapter without a task handler");
  });

  test("vercel.json: one output, the five functions with their standalone limits, /tasks/NN rewrites", async () => {
    const config = JSON.parse(await readFile(join(REPO, "vercel.json"), "utf8"));
    assert.equal(config.outputDirectory, "site/public");
    assert.equal(config.buildCommand, "npm run build");
    const limits = {};
    for (const dir of ["01", "02", "04"].map((n) => TASK_DIRS[n])) {
      const own = JSON.parse(await readFile(join(REPO, dir, "vercel.json"), "utf8"));
      for (const [file, value] of Object.entries(own.functions)) limits[file] = value;
    }
    assert.deepEqual(config.functions, limits, "the same functions and maxDuration as each standalone deployment");
    assert.deepEqual(config.rewrites.map((rule) => rule.source), ["/tasks/:n(\\d{2})", "/tasks/:n(\\d{2})/"]);
  });

  test("the standalone Task 01 and Task 02 deployments are left as they were", async () => {
    for (const n of ["01", "02"]) {
      const own = JSON.parse(await readFile(join(REPO, TASK_DIRS[n], "vercel.json"), "utf8"));
      assert.equal(own.outputDirectory, "public", n);
      assert.equal(own.buildCommand, "npm run build", n);
    }
  });

  test("assets merge without a clash: shared files are identical everywhere, task files have their own names", async () => {
    const owners = new Map();
    for (const [n, dir] of Object.entries({ lab: "lab", ...TASK_DIRS })) {
      for (const name of await readdir(join(REPO, dir, "public", "assets"))) {
        if (name === "fonts") continue;
        const bytes = await readFile(join(REPO, dir, "public", "assets", name));
        const seen = owners.get(name);
        if (seen) assert.ok(seen.bytes.equals(bytes), `${name} differs between ${seen.n} and ${n}`);
        else owners.set(name, { n, bytes });
      }
    }
    assert.ok(owners.size >= 20);
  });
});

describe("routes", () => {
  test("/ and every /tasks/NN load directly, with or without a trailing slash", async () => {
    for (const [path, title] of Object.entries(ROUTES)) {
      for (const variant of path === "/" ? ["/"] : [path, `${path}/`]) {
        const response = await get(variant);
        assert.equal(response.status, 200, variant);
        assert.match(response.headers.get("content-type"), /^text\/html/);
        assert.match(await response.text(), new RegExp(`<title>${title}`), variant);
      }
    }
  });

  test("unknown routes are 404, never another page", async () => {
    for (const path of ["/tasks/05", "/tasks/1", "/tasks/001", "/tasks/01/extra", "/tasks", "/tasks/", "/index.htm", "/api/nope", "/api/state/x"]) {
      assert.equal((await get(path)).status, 404, path);
    }
  });

  test("every asset a page loads is served, with its type; fonts included", async () => {
    const types = { ".css": /^text\/css/, ".js": /^text\/javascript/, ".woff2": /^font\/woff2/ };
    const wanted = new Set();
    for (const path of Object.keys(ROUTES)) {
      const html = await (await get(path)).text();
      for (const [, ref] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) wanted.add(ref);
    }
    const css = await (await get("/assets/lab.css")).text();
    for (const [, ref] of css.matchAll(/url\("(\/assets\/[^"]+)"\)/g)) wanted.add(ref);
    for (const name of await readdir(join(out, "assets"))) if (name.endsWith(".js")) wanted.add(`/assets/${name}`);
    assert.equal(wanted.size, 24, "every page asset, font and module, each once");
    for (const ref of wanted) {
      const response = await get(ref);
      assert.equal(response.status, 200, ref);
      assert.match(response.headers.get("content-type"), types[ref.slice(ref.lastIndexOf("."))], ref);
    }
  });

  test("navigation is same-domain: the landing opens /tasks/NN, no page links a standalone deployment", async () => {
    const landing = await (await get("/")).text();
    assert.deepEqual([...landing.matchAll(/class="row-title" href="([^"]+)"/g)].map(([, href]) => href), ["/tasks/01", "/tasks/02", "/tasks/03", "/tasks/04"]);
    for (const path of Object.keys(ROUTES)) assert.doesNotMatch(await (await get(path)).text(), /vercel\.app/, path);
    const { TASKS, LAB } = await import(at("shared/ui/tasks.js"));
    assert.equal(LAB.home, "/");
    assert.deepEqual(TASKS.filter((task) => task.href).map((task) => task.href), ["/tasks/01", "/tasks/02", "/tasks/03", "/tasks/04"]);
  });
});

describe("APIs on the one domain", () => {
  test("Task 01: /api/state, /api/inspect and /api/explain answer from the task's own handlers", async () => {
    const state = await (await get("/api/state")).json();
    assert.equal(state.ok, true);
    assert.equal(state.values.symbol, "USDC");
    const inspected = await (await get("/api/inspect?q=0xC879C018dB60520F4355C26eD1a6D572cdAC1815")).json();
    assert.equal(inspected.ok, true);
    assert.equal(inspected.kind, "contract");
    const explain = await get("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.ok([400, 422].includes(explain.status), "an empty request is refused by Explain's own validation");
  });

  test("Task 02: /api/events returns a window of Transfers from the task's own handler", async () => {
    const events = await (await get("/api/events")).json();
    assert.equal(events.ok, true);
    assert.ok(events.events.length >= 2);
  });

  test("Task 04: /api/search answers with the same result schema as the CLI", async () => {
    const result = await (await get("/api/search?q=What%20is%20the%20chain%20ID%20of%20the%20Atlantic%20testnet%3F")).json();
    assert.equal(result.schema, "pharos-docs-result/1");
    assert.equal(result.status, "answered");
    assert.equal(result.meta.transport, "docs-mcp");
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

describe("the site in a browser", { skip }, () => {
  let browser;
  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
  });

  async function open(path) {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("response", (response) => response.status() >= 400 && problems.push(`${response.status()} ${response.url()}`));
    page.on("requestfailed", (request) => problems.push(`failed ${request.url()}`));
    await page.goto(`${base}${path}`);
    await page.evaluate(() => document.fonts.ready);
    return { page, problems };
  }

  test("every route renders styled, with its scripts and fonts, and no failed request", async () => {
    for (const path of Object.keys(ROUTES)) {
      const { page, problems } = await open(path);
      await page.waitForTimeout(300);
      const look = await page.evaluate(() => ({ styled: getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)", font: document.fonts.check('600 16px "Geist"'), js: document.documentElement.classList.contains("js") }));
      assert.deepEqual(look, { styled: true, font: true, js: true }, path);
      assert.deepEqual(problems, [], path);
      await page.context().close();
    }
  });

  test("the shell links same-domain routes, and following them works", async () => {
    const { page, problems } = await open("/tasks/02");
    const links = await page.evaluate(() => ({
      home: document.querySelector("[data-lab-home]").getAttribute("href"),
      previous: document.querySelector('[data-task-step="previous"]').getAttribute("href"),
      next: document.querySelector('[data-task-step="next"]').getAttribute("href"),
      menu: [...document.querySelectorAll("#task-menu a")].map((a) => a.getAttribute("href")),
      outside: [...document.querySelectorAll("a[href*='vercel.app']")].length,
    }));
    assert.deepEqual(links, { home: "/", previous: "/tasks/01", next: "/tasks/03", menu: ["/tasks/01", "/tasks/02", "/tasks/03", "/tasks/04", "/"], outside: 0 });
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/03`);
    assert.match(await page.title(), /^03 · Docs Onboarding/);
    // The switcher jumps straight to any built task.
    await page.click("button.shell-count");
    await page.click('#task-menu a[href="/tasks/01"]');
    await page.waitForURL(`${base}/tasks/01`);
    await page.click("[data-lab-home]");
    await page.waitForURL(`${base}/`);
    // A landing row is one target: a tap on its description lands on the name's link, which covers the row.
    const purpose = await page.locator('.row:has(a[href="/tasks/04"]) .row-purpose').boundingBox();
    await page.mouse.click(purpose.x + purpose.width / 2, purpose.y + purpose.height / 2);
    await page.waitForURL(`${base}/tasks/04`);
    assert.equal(await page.locator('[data-task-step="next"]').getAttribute("aria-disabled"), "true", "05 is planned, so not linked");
    assert.deepEqual(problems, []);
    await page.context().close();
  });

  test("Task 01 at /tasks/01 reads its snapshot through /api/state on this domain", async () => {
    const { page, problems } = await open("/tasks/01");
    await page.waitForFunction(() => document.body.dataset.state === "fresh", null, { timeout: 15_000 });
    assert.equal(await page.textContent("#v-symbol"), "USDC");
    assert.deepEqual(problems, []);
    await page.context().close();
  });

  test("Task 02 at /tasks/02 polls /api/events on this domain and starts monitoring", async () => {
    const before = apiHits.filter((name) => name === "events").length;
    const { page, problems } = await open("/tasks/02");
    await page.waitForFunction(() => document.body.dataset.state === "monitoring", null, { timeout: 15_000 });
    assert.ok(apiHits.filter((name) => name === "events").length > before);
    assert.match(await page.textContent("#initial-count"), /^2 events/);
    assert.deepEqual(problems, []);
    await page.context().close();
  });

  test("Task 04 at /tasks/04 asks /api/search on this domain and shows the answer", async () => {
    const { page, problems } = await open("/tasks/04");
    await page.fill("#q", "What is the chain ID of the Atlantic testnet?");
    await page.press("#q", "Enter");
    await page.waitForFunction(() => document.body.dataset.state === "answer", null, { timeout: 15_000 });
    assert.match(await page.textContent(".answer"), /424242/);
    assert.deepEqual(problems, []);
    await page.context().close();
  });

  test("Task 03 at /tasks/03 shows its outcome and links the proof and video", async () => {
    const { page, problems } = await open("/tasks/03");
    assert.equal(await page.locator(".checks li").count(), 3);
    assert.equal(await page.locator('a:has-text("View proof")').getAttribute("href"), "https://drive.google.com/drive/folders/1YE5OXTxgh1xyxhrWz2drJuabZeMd5K7C");
    assert.deepEqual(problems, []);
    await page.context().close();
  });
});
