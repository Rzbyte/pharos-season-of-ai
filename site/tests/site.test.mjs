// The unified site: one domain, the lab at /, every task at /tasks/NN, every API at /api/<name>.
//   NODE_PATH="$(npm root -g)" node --test site/tests/site.test.mjs
// Needs the tasks' dist/ folders (npm run build in tasks 01, 02 and 04). The site is assembled into a
// temporary folder and served by site/serve.mjs with the root vercel.json rules. Every API is the
// task's own handler, pointed at that task's in-repo fake, so nothing reaches the network. Browser
// checks run in Chromium where Playwright is installed globally, and are skipped (saying why) otherwise.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiMap, assemble, TASK_DIRS } from "../build.mjs";
import { createSiteServer } from "../serve.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const at = (path) => pathToFileURL(join(REPO, path)).href;
const ROUTES = { "/": "Pharos Agent Lab", "/tasks/01": "01 · Contract State", "/tasks/02": "02 · Event Monitor", "/tasks/03": "03 · Docs Onboarding", "/tasks/04": "04 · Docs Search", "/tasks/05": "05 · Threshold Guardian", "/tasks/08": "08 · Dry-Run Executor", "/tasks/09": "09 · Trend Watcher", "/tasks/11": "11 · Policy Gatekeeper", "/tasks/13": "13 · Docs MCP + Chain MCP Agent", "/tasks/17": "17 · Natural-Language Payment Agent", "/tasks/18": "18 · Recurring Payment Agent", "/tasks/19": "19 · Invoice-to-Payment Agent", "/tasks/22": "22 · On-Chain Alert Bot", "/tasks/23": "23 · Whale-Watching Agent", "/tasks/24": "24 · Gas Fee Optimizer", "/tasks/25": "25 · Wallet Risk Checker", "/tasks/26": "26 · Audit-Log Agent", "/tasks/27": "27 · dApp Support Agent", "/tasks/28": "28 · Weekly Digest Agent", "/tasks/29": "29 · Doc-Grounded Builder Agent" };

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
  // The agent (Tasks 05 onward): its real handler on the official Chain MCP server (HTTP mode) over a fake chain.
  const { defaultState, startFakeChain } = await import(at("agent/dist/tests/fake-chain.js"));
  const chain05 = await startFakeChain(defaultState({ headTime: BigInt(Math.floor(Date.now() / 1000)), native: { "0x912c9ade24d44d8922f0866d8dcb079f1363f647": 10n ** 18n }, tokens: { [USDC]: { decimals: 6, balances: { "0x912c9ade24d44d8922f0866d8dcb079f1363f647": 1_000_000_000n } } } }));
  const { loadConfig } = await import(at("agent/dist/vendor/pharos-mcp/src/config.js"));
  const { startHttpServer } = await import(at("agent/dist/vendor/pharos-mcp/src/http.js"));
  const official = await new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      // No rate limit: the agent pages and APIs here make more calls in a minute than the hosted endpoint allows one IP.
      probe.close(() => startHttpServer(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: String(port), PHAROS_RPC_URL: chain05.url, PHAROS_CHAIN_ID: "1672", RATE_LIMIT_PER_MINUTE: "0" })).then((server) => resolve({ server, url: `http://127.0.0.1:${port}/mcp` }), reject));
    });
  });
  // Task 13 also asks the agent's stand-in Developer Docs MCP, whose made-up registry lists USDC.
  const { startFakeDocs } = await import(at("agent/dist/tests/fake-docs.js"));
  const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
  const docs13 = await startFakeDocs(() => `USDC is listed in the [Token Registry](${REGISTRY}).\n\n# Sources\n\n- [Token Registry](${REGISTRY})`, { [REGISTRY]: "# Token Registry\n\n## Pharos Mainnet\n\n| Token | Address |\n| --- | --- |\n| USDC | 0xC879C018dB60520F4355C26eD1a6D572cdAC1815 |\n" });
  fakes.push(chain01, ai, chain02, docs, chain05, docs13, { close: () => new Promise((resolve) => (official.server.closeAllConnections?.(), official.server.close(resolve))) });

  const handler = async (path, args) => (await import(at(path))).createHandler(args);
  const apis = {
    state: await handler(`${TASK_DIRS["01"]}/api/state.js`, chain01.url),
    inspect: await handler(`${TASK_DIRS["01"]}/api/inspect.js`, chain01.url),
    explain: await handler(`${TASK_DIRS["01"]}/api/explain.js`, { apiKey: "sk-site-test", providerUrl: ai.url, log: () => undefined }),
    events: await handler(`${TASK_DIRS["02"]}/api/events.js`, chain02.url),
    search: await handler(`${TASK_DIRS["04"]}/api/search.js`, { mcpUrl: docs.url }),
    agent: await handler("agent/api/agent.js", { chainMcpUrl: official.url, docsMcpUrl: docs13.url }),
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
    assert.deepEqual([...map.keys()].sort(), ["agent.js", "events.js", "explain.js", "inspect.js", "search.js", "state.js"]);
    for (const [name, { target }] of map) {
      const adapter = await readFile(join(REPO, "api", name), "utf8");
      assert.equal(adapter.split("\n").filter((line) => line && !line.startsWith("//")).length, 1, `${name}: nothing but the re-export`);
      assert.equal((await import(at(`api/${name}`))).default, (await import(at(target))).default, `${name} is the task's own default handler`);
    }
    assert.deepEqual((await readdir(join(REPO, "api"))).sort(), [...map.keys()].sort(), "no adapter without a task handler");
  });

  test("vercel.json: one output, the task functions with their standalone limits plus the agent's, /tasks/NN rewrites", async () => {
    const config = JSON.parse(await readFile(join(REPO, "vercel.json"), "utf8"));
    assert.equal(config.outputDirectory, "site/public");
    assert.equal(config.buildCommand, "npm run build");
    const limits = {};
    for (const dir of ["01", "02", "04"].map((n) => TASK_DIRS[n])) {
      const own = JSON.parse(await readFile(join(REPO, dir, "vercel.json"), "utf8"));
      for (const [file, value] of Object.entries(own.functions)) limits[file] = value;
    }
    assert.deepEqual(config.functions, { ...limits, "api/agent.js": { maxDuration: 60 } }, "each standalone deployment's functions and limits, and the agent's one function");
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
        assert.ok((await response.text()).includes(`<title>${title}`), variant);
      }
    }
  });

  test("unknown routes are 404, never another page", async () => {
    for (const path of ["/tasks/06", "/tasks/1", "/tasks/001", "/tasks/01/extra", "/tasks", "/tasks/", "/index.htm", "/api/nope", "/api/state/x"]) {
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
    assert.equal(wanted.size, 59, "every page asset, font and module, each once");
    for (const ref of wanted) {
      const response = await get(ref);
      assert.equal(response.status, 200, ref);
      assert.match(response.headers.get("content-type"), types[ref.slice(ref.lastIndexOf("."))], ref);
    }
  });

  test("navigation is same-domain: the landing opens /tasks/NN, no page links a standalone deployment", async () => {
    const landing = await (await get("/")).text();
    assert.deepEqual([...landing.matchAll(/class="row-title" href="([^"]+)"/g)].map(([, href]) => href), ["/tasks/01", "/tasks/02", "/tasks/03", "/tasks/04", "/tasks/05", "/tasks/08", "/tasks/09", "/tasks/11", "/tasks/13", "/tasks/17", "/tasks/18", "/tasks/19", "/tasks/22", "/tasks/23", "/tasks/24", "/tasks/25", "/tasks/26", "/tasks/27", "/tasks/28", "/tasks/29"]);
    for (const path of Object.keys(ROUTES)) assert.doesNotMatch(await (await get(path)).text(), /vercel\.app/, path);
    const { TASKS, LAB } = await import(at("shared/ui/tasks.js"));
    assert.equal(LAB.home, "/");
    assert.deepEqual(TASKS.filter((task) => task.href).map((task) => task.href), ["/tasks/01", "/tasks/02", "/tasks/03", "/tasks/04", "/tasks/05", "/tasks/08", "/tasks/09", "/tasks/11", "/tasks/13", "/tasks/17", "/tasks/18", "/tasks/19", "/tasks/22", "/tasks/23", "/tasks/24", "/tasks/25", "/tasks/26", "/tasks/27", "/tasks/28", "/tasks/29"]);
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

  test("Task 05: /api/agent?task=05 runs the guardian through Chain MCP; bad input is a 400, an unknown task too", async () => {
    const response = await get("/api/agent?task=05");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /^public, s-maxage=15/);
    const body = await response.json();
    assert.equal(body.result.schema, "pharos-agent/guardian-run/1");
    assert.equal(body.result.outcome, "fire");
    assert.equal(body.result.chainMcp.server, "pharos-mcp-server 0.1.0");
    assert.deepEqual(body.calls.map((call) => call.tool).slice(0, 2), ["get_chain_info", "get_block_number"]);
    const bad = await get("/api/agent?task=05&payer=0x123");
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get("cache-control"), "no-store");
    assert.match((await bad.json()).error.message, /payer must be a 0x address/);
    assert.equal((await get("/api/agent?task=99")).status, 400);
    assert.equal((await get("/api/agent?task=05", { method: "POST" })).status, 405);
  });

  test("Task 08: /api/agent?task=08 dry-runs a transfer through Chain MCP; an unknown action is a 400", async () => {
    const response = await get("/api/agent?task=08");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.schema, "pharos-agent/dry-run/1");
    assert.equal(body.result.verdict, "would-succeed");
    assert.equal(body.result.submission, null, "nothing is sent from the site");
    assert.deepEqual(body.calls.map((call) => call.tool).slice(0, 2), ["get_chain_info", "get_block_number"]);
    const bad = await get("/api/agent?task=08&action=burn");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /action must be transfer or approve/);
  });

  test("Task 09: /api/agent?task=09 adds one observation through Chain MCP to the page's store; never cached", async () => {
    const response = await get("/api/agent?task=09");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.result.schema, "pharos-agent/trend-run/1");
    assert.deepEqual([body.result.outcome, body.result.store.observations.length], ["watching", 1]);
    const bad = await get("/api/agent?task=09&series=nope");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /block:raw:seconds/);
  });

  test("Task 11: /api/agent?task=11 checks a request against the treasury policy through Chain MCP; bad hours are a 400", async () => {
    const response = await get("/api/agent?task=11");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.schema, "pharos-agent/policy-check/1");
    // This chain runs on the wall clock, so the hours rule may hold or not; every other rule holds.
    assert.deepEqual(body.result.rules.filter((rule) => rule.id !== "hours").map((rule) => [rule.id, rule.passed]), [["assets", true], ["counterparties", true], ["per-action", true], ["rolling", true], ["gas", true], ["simulates", true]]);
    assert.equal(body.result.execution, null, "nothing is sent from the site");
    const bad = await get("/api/agent?task=11&hoursFrom=noon");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /allowed hours start at a time like 06:00/);
  });

  test("Task 22: /api/agent?task=22 scans for new transfers and reads every condition through Chain MCP; never cached", async () => {
    const response = await get("/api/agent?task=22");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.result.schema, "pharos-agent/alert-run/1");
    assert.deepEqual(body.result.rules.map((rule) => [rule.id, rule.state ?? rule.matches]), [["large-transfer", 0], ["holder-low", "clear"], ["usdc-paused", "clear"], ["gas-high", "clear"]]);
    assert.equal(body.result.store.cursor, body.result.block.number);
    const bad = await get("/api/agent?task=22&states=nope");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /states lists rule:1 or rule:0/);
  });

  test("Task 23: /api/agent?task=23 reads every tracked address and scans for their transfers through Chain MCP; never cached", async () => {
    const response = await get("/api/agent?task=23");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.result.schema, "pharos-agent/whale-run/1");
    assert.deepEqual(body.result.addresses.map((a) => [a.label, a.tokens[0].shown]), [["Busiest in the sample", "1,000 USDC"], ["Sent the most", "0 USDC"], ["Trades with the busiest", "0 USDC"], ["Sent the largest transfer", "0 USDC"]]);
    assert.equal(body.result.store.cursor, body.result.block.number);
    const bad = await get("/api/agent?task=23&addresses=0x12");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /0x12 is not a 0x address/);
  });

  test("Task 24: /api/agent?task=24 observes the fee and times a transaction through Chain MCP; never cached", async () => {
    const response = await get("/api/agent?task=24");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.result.schema, "pharos-agent/gas-run/1");
    assert.deepEqual([body.result.window.length, body.result.decision, body.result.dryRun.verdict], [6, "send", "would-succeed"]);
    assert.equal(body.result.execution, null, "nothing is sent from the site");
    const bad = await get("/api/agent?task=24&percentile=99");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /percentile must be 10, 25, 50 or 75/);
  });

  test("Task 25: /api/agent?task=25 checks the recipient of Task 08's example transfer through Chain MCP; never cached", async () => {
    const response = await get("/api/agent?task=25");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.result.schema, "pharos-agent/risk-check/1");
    assert.deepEqual([body.result.counterparty.code, body.result.signals.map((s) => s.id), body.result.verdict], ["none", ["never-used"], "check-first"]);
    const bad = await get("/api/agent?task=25&to=0x12");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /The recipient must be a 0x address/);
  });

  test("Task 26: /api/agent?task=26 reports the example address's last hour through Chain MCP, in sentences; never cached", async () => {
    const response = await get("/api/agent?task=26");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.result.schema, "pharos-agent/audit-log/1");
    assert.deepEqual([body.result.period.description, body.result.quiet], ["in the last hour", true]);
    const bad = await get("/api/agent?task=26&hours=0");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /hours must be a whole number from 1 to 168/);
  });

  test("Task 28: /api/agent?task=28 digests USDC hour by hour through Chain MCP; never cached", async () => {
    const response = await get("/api/agent?task=28");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual([body.result.schema, body.result.every, body.result.digests.length, body.result.current.complete], ["pharos-agent/digest-run/1", "hour", 3, false]);
    const bad = await get("/api/agent?task=28&hours=6");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /hours must be a whole number from 1 to 5/);
  });

  test("Task 13: /api/agent?task=13 asks the Developer Docs MCP, then reads what it names through Chain MCP; cached a minute", async () => {
    const response = await get("/api/agent?task=13");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, s-maxage=60, stale-while-revalidate=60");
    const body = await response.json();
    assert.deepEqual([body.result.schema, body.result.verdict, body.docsCalls.map((call) => call.tool)], ["pharos-agent/docs-chain/1", "confirmed", ["askQuestion", "getPage"]]);
    const bad = await get("/api/agent?task=13&q=");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /Ask a question about a Pharos contract/);
  });

  test("Task 17: /api/agent?task=17 prepares a payment request through Chain MCP: each payment dry-run, ready to sign", async () => {
    const response = await get("/api/agent?task=17");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, s-maxage=15, stale-while-revalidate=15");
    const body = await response.json();
    assert.deepEqual([body.result.schema, body.result.verdict, body.result.payments.length], ["pharos-agent/payment-flow/1", "ready", 2]);
    const bad = await get(`/api/agent?task=17&request=${encodeURIComponent("Pay carol 5 USDC")}`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /Who is "carol"/);
  });

  test("Task 18: /api/agent?task=18 works out what a schedule owes this month and prepares it through Chain MCP", async () => {
    const response = await get("/api/agent?task=18");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, s-maxage=15, stale-while-revalidate=15");
    const body = await response.json();
    assert.deepEqual([body.result.schema, body.result.sinceFrom, body.result.store, body.result.items.length], ["pharos-agent/recurring-run/1", "month", null, 3]);
    const bad = await get(`/api/agent?task=18&schedule=${encodeURIComponent("Rent: 25 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, now and then")}`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /"now and then" is not a rule the agent reads/);
  });

  test("Task 19: /api/agent?task=19 reads an invoice, checks it and its payee, and prepares the payment through Chain MCP", async () => {
    const response = await get("/api/agent?task=19");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, s-maxage=15, stale-while-revalidate=15");
    const body = await response.json();
    assert.deepEqual([body.result.schema, body.result.verdict, body.result.invoice.number, body.result.payee.book.status], ["pharos-agent/invoice-payment/1", "ready", "INV-1042", "matches"]);
    const bad = await get(`/api/agent?task=19&invoice=${encodeURIComponent("Total: $20\nPay to: 0xB2749BD12f19C24a2244176658F3dF3e48e79553")}`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /a currency, not an asset on Pharos/);
  });

  test("Task 29: /api/agent?task=29 asks the Developer Docs MCP how, then dry-runs it through Chain MCP with the Skill Engine's commands", async () => {
    const response = await get("/api/agent?task=29");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, s-maxage=15, stale-while-revalidate=15");
    const body = await response.json();
    assert.deepEqual([body.result.schema, body.result.verdict, body.result.action.kind, body.result.skillEngine.commands.length], ["pharos-agent/how-to/1", "ready", "erc20-transfer", 3]);
    const bad = await get("/api/agent?task=29&from=0x12");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /from must be a 0x address/);
  });

  test("Task 27: /api/agent?task=27 explains a transaction through Chain MCP; an unknown hash is said so, uncached", async () => {
    const response = await get(`/api/agent?task=27&hash=0x${"5".repeat(64)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual([body.result.schema, body.result.status], ["pharos-agent/tx-explanation/1", "not-found"]);
    const bad = await get("/api/agent?task=27&hash=0x12");
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /0x and 64 hex characters/);
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
    // A request cut short by leaving the page (or by a newer run replacing it) is aborted, not failed.
    page.on("requestfailed", (request) => request.failure()?.errorText !== "net::ERR_ABORTED" && problems.push(`failed ${request.url()}`));
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
    assert.deepEqual(links, { home: "/", previous: "/tasks/01", next: "/tasks/03", menu: ["/tasks/01", "/tasks/02", "/tasks/03", "/tasks/04", "/tasks/05", "/tasks/08", "/tasks/09", "/tasks/11", "/tasks/13", "/tasks/17", "/tasks/18", "/tasks/19", "/tasks/22", "/tasks/23", "/tasks/24", "/tasks/25", "/tasks/26", "/tasks/27", "/tasks/28", "/tasks/29", "/"], outside: 0 });
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
    assert.equal(await page.locator('[data-task-step="next"]').getAttribute("href"), "/tasks/05", "05 is built, so linked");
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/05`);
    // 06 and 07 are still planned: the arrow steps over them to the next built task.
    assert.equal(await page.locator('[data-task-step="next"]').getAttribute("href"), "/tasks/08");
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/08`);
    assert.equal(await page.locator('[data-task-step="previous"]').getAttribute("href"), "/tasks/05");
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/09`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/11`);
    // 12, 14 to 16, 20 and 21 are still planned: from 11 the arrow goes to 13, then 17 to 19, then 22.
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/13`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/17`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/18`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/19`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/22`);
    assert.equal(await page.locator('[data-task-step="previous"]').getAttribute("href"), "/tasks/19");
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/23`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/24`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/25`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/26`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/27`);
    assert.equal(await page.locator('[data-task-step="previous"]').getAttribute("href"), "/tasks/26");
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/28`);
    await page.click('[data-task-step="next"]');
    await page.waitForURL(`${base}/tasks/29`);
    assert.equal(await page.locator('[data-task-step="next"]').getAttribute("aria-disabled"), "true", "nothing built after 29 yet");
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

  test("Tasks 05, 08, 09, 11, 13, 17 to 19 and 22 to 29 at /tasks/NN run the agent through /api/agent on this domain", async () => {
    for (const [path, panel, word] of [["/tasks/05", "guard", /^Fire$/], ["/tasks/08", "run", /^Would succeed$/], ["/tasks/09", "watch", /^Watching$/], ["/tasks/11", "gate", /^(Allowed|Denied)$/], ["/tasks/13", "answer", /^Confirmed$/], ["/tasks/17", "answer", /^Ready$/], ["/tasks/18", "answer", /^(Ready|Nothing due)$/], ["/tasks/19", "answer", /^Ready$/], ["/tasks/22", "watch", /^Watching$/], ["/tasks/23", "watch", /^Watching$/], ["/tasks/24", "gas", /^Send now$/], ["/tasks/25", "check", /^Check first$/], ["/tasks/26", "report", /^(Quiet|Active)$/], ["/tasks/27", "answer", /^Would fail$/], ["/tasks/28", "digest", /^Quiet$/], ["/tasks/29", "answer", /^Ready$/]]) {
      const before = apiHits.filter((name) => name === "agent").length;
      const { page, problems } = await open(path);
      await page.waitForFunction((id) => document.getElementById(id).getAttribute("aria-busy") === "false", panel, { timeout: 15_000 });
      assert.match(await page.textContent("#status-word"), word, path);
      assert.equal(apiHits.filter((name) => name === "agent").length, before + 1, path);
      assert.deepEqual(problems, [], path);
      await page.context().close();
    }
  });

  test("Task 03 at /tasks/03 shows its outcome and links the proof and video", async () => {
    const { page, problems } = await open("/tasks/03");
    assert.equal(await page.locator(".checks li").count(), 3);
    assert.equal(await page.locator('a:has-text("View proof")').getAttribute("href"), "https://drive.google.com/drive/folders/1YE5OXTxgh1xyxhrWz2drJuabZeMd5K7C");
    assert.deepEqual(problems, []);
    await page.context().close();
  });
});
