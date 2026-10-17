// The agent over HTTP (src/web.ts): each task's route, its input checks, and its answers, against the
// official Chain MCP server in its HTTP mode on a fake chain at a fixed time.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { handle } from "../src/web.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";

const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const PAYER = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";
const STRANGER = "0x1111111111111111111111111111111111111111";

let fake: FakeChain;
let http: { close(cb: () => void): void; closeAllConnections?: () => void };
let chainMcpUrl: string;

before(async () => {
  // Monday 14:13 UTC: inside the treasury's hours.
  fake = await startFakeChain(defaultState({ headTime: 1_790_000_000n, native: { [PAYER]: 10n ** 18n }, tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: 1_000_000_000n } } } }));
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
  const { loadConfig } = (await import(new URL("../vendor/pharos-mcp/src/config.js", import.meta.url).href)) as { loadConfig(env: Record<string, string>): unknown };
  const { startHttpServer } = (await import(new URL("../vendor/pharos-mcp/src/http.js", import.meta.url).href)) as { startHttpServer(config: unknown): Promise<typeof http> };
  http = await startHttpServer(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: String(port), PHAROS_RPC_URL: fake.url, PHAROS_CHAIN_ID: "1672", RATE_LIMIT_PER_MINUTE: "0" }));
  chainMcpUrl = `http://127.0.0.1:${port}/mcp`;
});

after(async () => {
  http.closeAllConnections?.();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await fake.close();
});

const get = (query: string) => handle(new URL(`http://agent.test/api/agent?${query}`), { chainMcpUrl, timeoutMs: 5000 });
const message = (response: { body: unknown }) => (response.body as { error: { message: string } }).error.message;

describe("GET /api/agent?task=11", () => {
  test("the treasury policy on the default request: allowed, with every rule, the policy and the calls", async () => {
    const response = await get("task=11");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 15);
    const body = response.body as { result: { schema: string; outcome: string; rules: { id: string; passed: boolean }[] }; inputs: Record<string, string>; policy: { name: string; rules: unknown[] }; calls: { tool: string }[] };
    assert.equal(body.result.schema, "pharos-agent/policy-check/1");
    assert.equal(body.result.outcome, "allowed");
    assert.deepEqual(body.result.rules.map((r) => [r.id, r.passed]), [["assets", true], ["counterparties", true], ["per-action", true], ["rolling", true], ["hours", true], ["gas", true], ["simulates", true]]);
    assert.deepEqual(body.inputs, { action: "transfer", asset: "USDC", from: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", to: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "25", hoursFrom: "06:00", hoursTo: "22:00" });
    assert.equal(body.policy.name, "Treasury payouts");
    assert.deepEqual(body.calls.slice(0, 4).map((c) => c.tool), ["get_chain_info", "get_block_number", "get_block", "get_logs"]);
  });

  test("the page's hours become the policy's; a request outside them, or past the limits, is denied", async () => {
    const closed = (await get("task=11&hoursFrom=00:00&hoursTo=01:00")).body as { result: { outcome: string; decision: { failed: string[] } }; policy: { rules: { id: string; from?: string; to?: string }[] } };
    assert.deepEqual([closed.result.outcome, closed.result.decision.failed], ["denied", ["hours"]]);
    assert.deepEqual(closed.policy.rules.find((r) => r.id === "hours"), { id: "hours", kind: "time-window", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], from: "00:00", to: "01:00", utcOffset: "+00:00" });
    const over = (await get(`task=11&to=${STRANGER}&amount=150`)).body as { result: { decision: { failed: string[] } } };
    assert.deepEqual(over.result.decision.failed, ["counterparties", "per-action"]);
  });

  test("bad input is a 400 that says what is wrong, before any Chain MCP call", async () => {
    const before = fake.requests.length;
    const cases: [string, RegExp][] = [
      ["task=11&hoursFrom=6am", /allowed hours start at a time like 06:00/],
      ["task=11&hoursTo=24:30", /allowed hours end at a time like 06:00/],
      ["task=11&hoursFrom=08:00&hoursTo=08:00", /start and end at different times/],
      ["task=11&action=swap", /action must be transfer or approve/],
      ["task=11&asset=DOGE", /asset must be PROS or one of WPROS, USDC, LINK, WETH/],
      ["task=11&action=approve&asset=PROS", /Only a token can be approved/],
      ["task=11&amount=max", /Only an approval can be unlimited/],
      ["task=11&from=0x123", /The sender must be a 0x address/],
      ["task=08&to=nope", /The recipient must be a 0x address/],
      ["task=99", /Unknown task\. Use \?task=05, 08, 09, 11, 22 or 23\./],
    ];
    for (const [query, error] of cases) {
      const response = await get(query);
      assert.equal(response.status, 400, query);
      assert.equal(response.maxAge, 0, query);
      assert.match(message(response), error, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });

  test("an unreachable Chain MCP is a 502 with the reason", async () => {
    const response = await handle(new URL("http://agent.test/api/agent?task=11"), { chainMcpUrl: "http://127.0.0.1:9/mcp", timeoutMs: 2000 });
    assert.equal(response.status, 502);
    assert.match(message(response), /^Could not reach http:\/\/127\.0\.0\.1:9\/mcp/);
  });
});

describe("GET /api/agent?task=09", () => {
  type Body = { result: { schema: string; outcome: string; observation: { block: string; shown: string } | null; trend: { detail: string; holds: boolean }; action: { verdict: string } | null; store: { observations: unknown[]; actedAt: string | null } }; inputs: Record<string, string> };

  test("a first run: one observation through Chain MCP, the store to keep, never cached", async () => {
    const response = await get("task=09");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 0, "each answer depends on the store sent");
    const body = response.body as Body;
    assert.equal(body.result.schema, "pharos-agent/trend-run/1");
    assert.deepEqual([body.result.outcome, body.result.observation?.shown, body.result.trend.detail], ["watching", "1,000 USDC", "1 of 3 observations so far"]);
    assert.equal(body.result.store.observations.length, 1);
    assert.deepEqual(body.inputs, { holder: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", trend: "falling", observations: "3", every: "10" });
  });

  test("the page's earlier observations make the trend; the watcher fires and dry-runs its action", async () => {
    const response = await get("task=09&series=4999980:1020000000:1789999980,4999990:1010000000:1789999990");
    const body = response.body as Body;
    assert.deepEqual([body.result.outcome, body.result.trend.holds, body.result.trend.detail], ["fired", true, "2 of 2 steps down"]);
    // The example top-up comes from an address this chain gave no USDC: the dry run says so, and nothing is sent.
    assert.equal(body.result.action?.verdict, "would-revert");
    assert.deepEqual([body.result.store.observations.length, body.result.store.actedAt], [3, "5000000"]);
    const acted = (await get("task=09&series=4999980:1020000000:1789999980,4999990:1010000000:1789999990&actedAt=4999990")).body as Body;
    assert.deepEqual([acted.result.outcome, acted.result.trend.detail], ["watching", "1 of 3 observations so far"], "only observations after the last action count");
  });

  test("bad settings or a bad store are a 400, before any Chain MCP call", async () => {
    const before = fake.requests.length;
    const tooMany = Array.from({ length: 21 }, (_, i) => `${4_000_000 + i}:1:1789990000`).join(",");
    const cases: [string, RegExp][] = [
      ["task=09&holder=0x12", /The holder must be a 0x address/],
      ["task=09&trend=sideways", /trend must be falling or rising/],
      ["task=09&observations=7", /observations must be a whole number from 2 to 6/],
      ["task=09&every=0", /every must be a whole number of blocks from 1 to 1,000/],
      ["task=09&series=abc", /series lists earlier observations as block:raw:seconds/],
      [`task=09&series=${tooMany}`, /At most 20 earlier observations/],
      ["task=09&series=4999990:1:1789999990,4999980:2:1789999980", /in block order, one per block/],
      ["task=09&actedAt=x", /actedAt must be a block number/],
    ];
    for (const [query, error] of cases) {
      const response = await get(query);
      assert.equal(response.status, 400, query);
      assert.match(message(response), error, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

describe("GET /api/agent?task=22", () => {
  type Alert = { kind: string; rule: string; message: string };
  type Body = { result: { schema: string; scanned: { from: string; to: string; pages: number } | null; alerts: Alert[]; rules: { id: string; state: string | null; observed: string | null; matches: number | null }[]; store: { cursor: string | null; states: Record<string, boolean> } }; inputs: Record<string, string> };
  const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";
  let kept: typeof fake.state.transfers;
  before(() => {
    // Transfers between other addresses, so the payer's spending (Task 11's window) is unchanged.
    kept = fake.state.transfers;
    fake.state.transfers = [...kept, { token: USDC, from: STRANGER, to: RECIPIENT, amount: 750_000_000n, block: 4_999_995n }, { token: USDC, from: STRANGER, to: RECIPIENT, amount: 10_000_000n, block: 4_999_996n }];
  });
  after(() => {
    fake.state.transfers = kept;
  });

  test("a first run: the last 1,000 blocks scanned, every condition read, the store to keep; never cached", async () => {
    const response = await get("task=22");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 0, "each answer depends on the store sent");
    const body = response.body as Body;
    assert.equal(body.result.schema, "pharos-agent/alert-run/1");
    assert.deepEqual(body.result.scanned, { from: "4999001", to: "5000000", pages: 1 });
    assert.deepEqual(body.result.alerts.map((a) => [a.kind, a.message]), [["transfer", "750 USDC from 0x1111…1111 to 0xB274…9553 at block 4,999,995"]]);
    assert.deepEqual(body.result.rules.map((r) => [r.id, r.state ?? r.matches]), [["large-transfer", 1], ["holder-low", "clear"], ["usdc-paused", "clear"], ["gas-high", "clear"]]);
    assert.deepEqual([body.result.store.cursor, body.result.store.states], ["5000000", { "holder-low": false, "usdc-paused": false, "gas-high": false }]);
    assert.deepEqual(body.inputs, { min: "500", holder: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", low: "100" });
  });

  test("the page's cursor and states: only newer blocks scanned, a condition alerting when it starts and when it stops", async () => {
    const caughtUp = (await get("task=22&cursor=5000000&states=holder-low:0")).body as Body;
    assert.deepEqual([caughtUp.result.scanned, caughtUp.result.alerts], [null, []]);
    const starts = (await get("task=22&cursor=5000000&states=holder-low:0&low=2000")).body as Body;
    assert.deepEqual(starts.result.alerts.map((a) => [a.kind, a.message]), [["triggered", "1,000 USDC at block 5,000,000"]]);
    const still = (await get("task=22&cursor=5000000&states=holder-low:1&low=2000")).body as Body;
    assert.deepEqual(still.result.alerts, [], "already alerted");
    const stops = (await get("task=22&cursor=5000000&states=holder-low:1")).body as Body;
    assert.deepEqual(stops.result.alerts.map((a) => [a.kind, a.message]), [["resolved", "no longer holds: 1,000 USDC at block 5,000,000"]]);
    const smaller = (await get("task=22&min=5")).body as Body;
    assert.equal(smaller.result.alerts.length, 2, "both transfers are 5 USDC or more");
  });

  test("bad settings or a bad store are a 400, before any Chain MCP call", async () => {
    const before = fake.requests.length;
    const cases: [string, RegExp][] = [
      ["task=22&holder=0x12", /The holder must be a 0x address/],
      ["task=22&min=lots", /The smallest transfer must be an amount of USDC, up to 6 decimals/],
      ["task=22&low=1.1234567", /The low balance must be an amount of USDC, up to 6 decimals/],
      ["task=22&cursor=x", /cursor must be a block number/],
      ["task=22&states=holder-low", /states lists rule:1 or rule:0/],
      ["task=22&states=holder-low:2", /states lists rule:1 or rule:0/],
    ];
    for (const [query, error] of cases) {
      const response = await get(query);
      assert.equal(response.status, 400, query);
      assert.match(message(response), error, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

describe("GET /api/agent?task=23", () => {
  type Body = { result: { schema: string; scanned: { from: string; to: string; pages: number } | null; transfers: number; events: { kind: string; message: string }[]; addresses: { label: string; native: { changeShown: string | null }; tokens: { shown: string }[]; sent: number | null }[]; store: { cursor: string; snapshots: Record<string, unknown> } }; inputs: Record<string, string> };
  const BUSIEST = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";

  test("the sample addresses: each read at the newest block, the last 1,000 blocks scanned, the store to keep; never cached", async () => {
    const response = await get("task=23");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 0, "each answer depends on the store sent");
    const body = response.body as Body;
    assert.equal(body.result.schema, "pharos-agent/whale-run/1");
    assert.deepEqual(body.result.scanned, { from: "4999001", to: "5000000", pages: 2 });
    assert.deepEqual(body.result.addresses.map((a) => [a.label, a.tokens[0]!.shown, a.native.changeShown, a.sent]), [
      ["Busiest in the sample", "1,000 USDC", null, null],
      ["Sent the most", "0 USDC", null, null],
      ["Trades with the busiest", "0 USDC", null, null],
      ["Sent the largest transfer", "0 USDC", null, null],
    ]);
    assert.equal(Object.keys(body.result.store.snapshots).length, 4);
    assert.deepEqual(body.inputs, { addresses: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647,0x936564245B69f5a293b42cbd752E0eE3bb68b470,0x1F3546a29EeC2102c8d52E21a45114124014c85C,0x0018b46177c611fc1EfBca63c845c2a69045E28D", min: "250", native: "100" });
  });

  test("the page's store: only newer blocks scanned, and a balance change since the last run surfaced", async () => {
    const first = (await get(`task=23&addresses=${BUSIEST}`)).body as Body;
    const kept = { cursor: first.result.store.cursor, snapshots: first.result.store.snapshots };
    const unchanged = (await get(`task=23&addresses=${BUSIEST}&store=${encodeURIComponent(JSON.stringify(kept))}`)).body as Body;
    assert.deepEqual([unchanged.result.scanned, unchanged.result.events, unchanged.result.addresses[0]!.native.changeShown], [null, [], "±0 PROS"]);
    const richer = structuredClone(kept) as { snapshots: Record<string, { native: string }> };
    richer.snapshots[BUSIEST.toLowerCase()]!.native = (2n * 10n ** 20n).toString(); // it held 200 PROS; now 1
    const fell = (await get(`task=23&addresses=${BUSIEST}&store=${encodeURIComponent(JSON.stringify(richer))}`)).body as Body;
    assert.deepEqual(fell.result.events.map((e) => [e.kind, e.message]), [["native", "Busiest in the sample's PROS balance fell by 199 PROS since block 5,000,000, to 1 PROS"]]);
  });

  test("bad settings or a bad store are a 400, before any Chain MCP call", async () => {
    const before = fake.requests.length;
    const six = Array.from({ length: 6 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`).join(",");
    const cases: [string, RegExp][] = [
      ["task=23&addresses=", /Track 1 to 5 addresses, separated by commas/],
      [`task=23&addresses=${six}`, /Track 1 to 5 addresses, separated by commas/],
      ["task=23&addresses=0x12", /0x12 is not a 0x address/],
      [`task=23&addresses=${BUSIEST},${BUSIEST.toLowerCase()}`, /is listed twice/],
      ["task=23&min=lots", /The smallest significant transfer must be an amount, up to 6 decimals/],
      ["task=23&native=-1", /The smallest significant balance change must be an amount, up to 6 decimals/],
      ["task=23&store=nope", /store must be JSON: \{ cursor, snapshots \}/],
      [`task=23&store=${encodeURIComponent(JSON.stringify({ cursor: "x" }))}`, /cursor must be a block number or null/],
      [`task=23&store=${encodeURIComponent(JSON.stringify({ cursor: null, snapshots: { [BUSIEST.toLowerCase()]: { block: "1", native: "x", nonce: "1", contract: false, tokens: {} } } }))}`, /needs a native balance and a nonce/],
    ];
    for (const [query, error] of cases) {
      const response = await get(query);
      assert.equal(response.status, 400, query);
      assert.match(message(response), error, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

