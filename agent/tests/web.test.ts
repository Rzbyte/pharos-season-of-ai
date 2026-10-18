// The agent over HTTP (src/web.ts): each task's route, its input checks, and its answers, against the
// official Chain MCP server in its HTTP mode on a fake chain at a fixed time.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { DEFAULT_CONTACTS, DEFAULT_HOW_TO, DEFAULT_INVOICE, DEFAULT_PAYEES, DEFAULT_PAYMENT, DEFAULT_QUESTION, DEFAULT_SCHEDULE, handle } from "../src/web.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { startFakeDocs, type FakeDocs } from "./fake-docs.js";

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
      ["task=99", /Unknown task\. Use \?task=05, 08, 09, 11, 13, 17 to 20, 22 to 29\./],
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

describe("GET /api/agent?task=24", () => {
  type Body = { result: { schema: string; decision: string; reason: string; window: { block: string; fee: string }[]; target: { shown: string }; settings: { shown: { maxFeePerGas: string } } | null; store: { waitingSince: string | null } }; inputs: Record<string, string> };
  const half = (block: number) => `${block}:500000000:21000:30000000:${1_790_000_000 - (5_000_000 - block)}:b`;

  test("a first run: earlier blocks read, the fee judged, the transaction priced; never cached", async () => {
    const response = await get("task=24");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 0, "each answer depends on the observations sent");
    const body = response.body as Body;
    assert.equal(body.result.schema, "pharos-agent/gas-run/1");
    assert.equal(body.result.window.length, 6);
    assert.deepEqual([body.result.decision, body.result.reason], ["send", "The base fee has held at 1 gwei across 6 observations, so waiting saves nothing."]);
    assert.deepEqual(body.inputs, { action: "transfer", asset: "USDC", from: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", to: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "25", percentile: "25" });
  });

  test("the page's observations: cheaper ones earlier make it wait, capped at the target, and it remembers since when", async () => {
    const response = await get(`task=24&series=${[4_999_960, 4_999_970, 4_999_980, 4_999_990].map(half).join(",")}`);
    const body = response.body as Body;
    assert.deepEqual([body.result.window.length, body.result.decision, body.result.target.shown, body.result.settings?.shown.maxFeePerGas], [5, "wait", "0.5 gwei", "0.6 gwei"]);
    assert.equal(body.result.store.waitingSince, "5000000");
    const later = (await get(`task=24&series=${[4_999_960, 4_999_970].map(half).join(",")}&waitingSince=4999990&percentile=75`)).body as Body;
    assert.deepEqual([later.result.decision, later.result.store.waitingSince], ["send", null]);
  });

  test("bad settings or bad observations are a 400, before any Chain MCP call", async () => {
    const before = fake.requests.length;
    const tooMany = Array.from({ length: 13 }, (_, i) => half(4_999_000 + i)).join(",");
    const cases: [string, RegExp][] = [
      ["task=24&percentile=30", /percentile must be 10, 25, 50 or 75/],
      ["task=24&asset=DOGE", /asset must be PROS or one of/],
      ["task=24&series=abc", /series lists earlier observations as block:fee:gasUsed:gasLimit:seconds:b/],
      [`task=24&series=${tooMany}`, /At most 12 earlier observations/],
      [`task=24&series=${half(4_999_990)},${half(4_999_980)}`, /in block order, one per block/],
      ["task=24&waitingSince=soon", /waitingSince must be a block number/],
    ];
    for (const [query, error] of cases) {
      const response = await get(query);
      assert.equal(response.status, 400, query);
      assert.match(message(response), error, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

describe("GET /api/agent?task=27", () => {
  type Body = { result: { schema: string; status: string; cause: { kind: string } | null; headline: string }; inputs: Record<string, string> };
  const HASH = `0x${"b2".repeat(32)}`;

  test("a failed transaction by its hash: explained, and cached for a while since it will not change", async () => {
    const data = `0xa9059cbb${STRANGER.slice(2).padStart(64, "0")}${(5_000_000_000).toString(16).padStart(64, "0")}`;
    fake.transactions.set(HASH, { hash: HASH, from: PAYER, to: USDC, input: data, value: "0x0", gas: "0x186a0", nonce: "0x1", blockNumber: "0x4c4b40", type: "0x2" });
    fake.receipts.set(HASH, { transactionHash: HASH as `0x${string}`, blockNumber: "0x4c4b40", status: "0x0", gasUsed: "0x7918", effectiveGasPrice: "0x3b9aca00", from: PAYER as `0x${string}`, to: USDC as `0x${string}`, logs: [], cumulativeGasUsed: "0x7918", type: "0x2" });
    const response = await get(`task=27&hash=${HASH}`);
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 300);
    const body = response.body as Body;
    assert.deepEqual([body.result.schema, body.result.status, body.result.cause?.kind], ["pharos-agent/tx-explanation/1", "failed", "revert"]);
    assert.deepEqual(body.inputs, { hash: HASH });
    const unknown = await get(`task=27&hash=0x${"0".repeat(63)}1`);
    assert.deepEqual([(unknown.body as Body).result.status, unknown.maxAge], ["not-found", 0], "an unknown hash may be found later");
  });

  test("a transaction described: why it would fail if sent now, never cached", async () => {
    const response = await get("task=27&amount=5000");
    const body = response.body as Body;
    assert.deepEqual([body.result.status, body.result.cause?.kind, response.maxAge], ["would-fail", "revert", 0]);
    assert.equal(body.inputs.amount, "5000");
  });

  test("a malformed hash or description is a 400, before any Chain MCP call", async () => {
    const before = fake.requests.length;
    for (const [query, error] of [["task=27&hash=0x12", /A transaction hash is 0x and 64 hex characters/], ["task=27&asset=DOGE", /asset must be PROS or one of/]] as const) {
      const response = await get(query);
      assert.equal(response.status, 400, query);
      assert.match(message(response), error, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

describe("GET /api/agent?task=25", () => {
  type Body = { result: { schema: string; level: string; verdict: string; signals: { id: string }[]; history: { from: string; pages: number } | null; counterparty: { code: string } }; inputs: Record<string, string> };

  test("Task 08's example transfer: the recipient read, 2,000 blocks of history, the level and verdict; never cached", async () => {
    const response = await get("task=25");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 0);
    const body = response.body as Body;
    assert.equal(body.result.schema, "pharos-agent/risk-check/1");
    assert.deepEqual([body.result.history?.from, body.result.history?.pages], ["4998001", 4]);
    assert.deepEqual([body.result.counterparty.code, body.result.signals.map((s) => s.id), body.result.level, body.result.verdict], ["none", ["never-used"], "medium", "check-first"]);
    assert.deepEqual(body.inputs, { action: "transfer", asset: "USDC", from: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", to: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "25" });
  });

  test("an unlimited approval to a wallet is high risk; bad input is a 400 before any Chain MCP call", async () => {
    const body = (await get(`task=25&action=approve&to=${STRANGER}&amount=max`)).body as Body;
    assert.deepEqual([body.result.signals.slice(0, 1).map((s) => s.id), body.result.verdict], [["approve-wallet"], "do-not-send"]);
    const before = fake.requests.length;
    const bad = await get("task=25&to=0x12");
    assert.equal(bad.status, 400);
    assert.match(message(bad), /The recipient must be a 0x address/);
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});


describe("GET /api/agent?task=26", () => {
  type Body = { result: { schema: string; headline: string; summary: string[]; period: { description: string; from: { number: string }; to: { number: string }; trimmed: unknown }; scanned: { pages: number } }; inputs: Record<string, string>; calls: { tool: string }[] };

  test("the example address over the last hour by default, in sentences; never cached", async () => {
    const response = await get("task=26");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 0);
    const body = response.body as Body;
    assert.equal(body.result.schema, "pharos-agent/audit-log/1");
    assert.deepEqual([body.result.period.description, body.result.period.from.number, body.result.period.to.number, body.result.scanned.pages], ["in the last hour", "4996401", "5000000", 8]);
    assert.equal(body.result.headline, "0x912c…f647 in the last hour: nothing happened.");
    assert.deepEqual(body.inputs, { address: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", hours: "1" });
    assert.deepEqual(body.calls.slice(0, 3).map((c) => c.tool), ["get_chain_info", "get_block_number", "get_block"]);
  });

  test("a block period that has ended is cached; the page reads at most 20,000 blocks; bad input is a 400 before any call", async () => {
    const ended = await get("task=26&fromBlock=4990001&toBlock=4991000");
    assert.equal(ended.maxAge, 300);
    assert.deepEqual((ended.body as Body).inputs, { address: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", fromBlock: "4990001", toBlock: "4991000" });
    const long = (await get("task=26&hours=24")).body as Body;
    assert.deepEqual([long.result.period.from.number, long.result.period.trimmed, long.result.scanned.pages], ["4980001", { from: "4913601", blocks: "86400" }, 40]);
    const before = fake.requests.length;
    for (const [query, pattern] of [
      ["task=26&address=0x12", /The address must be a 0x address/],
      ["task=26&hours=0", /hours must be a whole number from 1 to 168/],
      ["task=26&hours=1&since=2026-10-17T09:00Z", /Give the period one way/],
      ["task=26&since=2026-02-30", /since is not a real date and time/],
    ] as const) {
      const bad = await get(query);
      assert.equal(bad.status, 400, query);
      assert.match(message(bad), pattern, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

describe("GET /api/agent?task=28", () => {
  type Body = { result: { schema: string; every: string; subject: { kind: string }; digests: { label: string }[]; current: { complete: boolean } | null; cut: number }; inputs: Record<string, string> };

  test("USDC hour by hour by default: the last 3 hours and the hour so far; never cached", async () => {
    const response = await get("task=28");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 0);
    const body = response.body as Body;
    assert.deepEqual([body.result.schema, body.result.every, body.result.subject.kind, body.result.cut], ["pharos-agent/digest-run/1", "hour", "token", 0]);
    assert.deepEqual(body.result.digests.map((d) => d.label), ["21 Sep 2026, 11:00 to 12:00 UTC", "21 Sep 2026, 12:00 to 13:00 UTC", "21 Sep 2026, 13:00 to 14:00 UTC"]);
    assert.equal(body.result.current?.complete, false);
    assert.deepEqual(body.inputs, { subject: "USDC", hours: "3" });
  });

  test("a wallet's digest; bad input is a 400 before any Chain MCP call", async () => {
    const body = (await get(`task=28&subject=${PAYER}&hours=1`)).body as Body;
    assert.deepEqual([body.result.subject.kind, body.result.digests.length, body.inputs], ["wallet", 1, { subject: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", hours: "1" }]);
    const before = fake.requests.length;
    for (const [query, pattern] of [
      ["task=28&hours=6", /hours must be a whole number from 1 to 5/],
      ["task=28&subject=pepe", /A digest is of an official token/],
    ] as const) {
      const bad = await get(query);
      assert.equal(bad.status, 400, query);
      assert.match(message(bad), pattern, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

describe("GET /api/agent?task=13", () => {
  // Made-up docs in the shape the Developer Docs MCP answers: a registry page that lists USDC on mainnet.
  const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
  const cited = `\n\n# Sources\n\n- [Token Registry](${REGISTRY})`;
  type Body = { result: { schema: string; question: string; verdict: string; headline: string; docs: { status: string; answer: string | null; pages: string[] }; readings: { address: string; code: string; agrees: boolean | null }[] }; inputs: Record<string, string>; calls: { tool: string }[]; docsCalls: { tool: string; args: Record<string, unknown>; ok: boolean }[] };
  let docs: FakeDocs;
  before(async () => {
    fake.state.tokens[USDC]!.symbol = "USDC";
    docs = await startFakeDocs((q) => (/usdc/i.test(q) ? `USDC is listed in the [Token Registry](${REGISTRY}).${cited}` : `I cannot find information about that in the Pharos Developer Docs.${cited}`), { [REGISTRY]: `# Token Registry\n\n## Pharos Mainnet\n\n| Token | Address |\n| --- | --- |\n| USDC | 0xC879C018dB60520F4355C26eD1a6D572cdAC1815 |\n` });
  });
  after(async () => {
    delete fake.state.tokens[USDC]!.symbol;
    await docs.close();
  });
  const ask = (query: string, docsMcpUrl = docs.url) => handle(new URL(`http://agent.test/api/agent?${query}`), { chainMcpUrl, docsMcpUrl, timeoutMs: 5000 });

  test("the default question: the docs, then the chain; the docs calls listed beside the chain calls; cached a minute", async () => {
    const response = await ask("task=13");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 60);
    const body = response.body as Body;
    assert.deepEqual([body.result.schema, body.result.question, body.result.verdict, body.result.docs.answer, body.result.docs.pages], ["pharos-agent/docs-chain/1", DEFAULT_QUESTION, "confirmed", "USDC is listed in the Token Registry.", [REGISTRY]]);
    assert.deepEqual(body.result.readings.map((r) => [r.address, r.code, r.agrees]), [["0xC879C018dB60520F4355C26eD1a6D572cdAC1815", "contract", true]]);
    assert.deepEqual(body.inputs, { q: DEFAULT_QUESTION });
    assert.deepEqual(body.docsCalls, [{ tool: "askQuestion", args: { question: DEFAULT_QUESTION, goal: "Find the Pharos contract or function this question is about: its address, its network, and what it returns." }, ok: true }, { tool: "getPage", args: { url: REGISTRY }, ok: true }]);
    assert.deepEqual(body.calls.map((c) => c.tool), ["get_chain_info", "get_block_number", "get_block", "get_code", "eth_call", "eth_call", "eth_call", "eth_call"]);
  });

  test("a question the docs do not cover reads nothing but the block; a bad question is a 400 before any call; an unreachable docs MCP a 502", async () => {
    const uncovered = (await ask(`task=13&q=${encodeURIComponent("How do I stake on Solana?")}`)).body as Body;
    assert.deepEqual([uncovered.result.verdict, uncovered.result.docs.status, uncovered.calls.map((c) => c.tool)], ["no-answer", "no_answer", ["get_chain_info", "get_block_number", "get_block"]]);
    const [chainBefore, docsBefore] = [fake.requests.length, docs.requests.length];
    for (const [query, pattern] of [
      ["task=13&q=", /Ask a question about a Pharos contract/],
      [`task=13&q=${"x".repeat(301)}`, /at most 300 characters/],
    ] as const) {
      const bad = await ask(query);
      assert.equal(bad.status, 400, query);
      assert.match(message(bad), pattern, query);
    }
    assert.deepEqual([fake.requests.length, docs.requests.length], [chainBefore, docsBefore], "nothing reached the chain or the docs");
    const down = await ask("task=13", "http://127.0.0.1:9/~gitbook/mcp");
    assert.equal(down.status, 502);
    assert.match(message(down), /^Could not reach the Developer Docs MCP at http:\/\/127\.0\.0\.1:9\/~gitbook\/mcp/);
  });
});

describe("GET /api/agent?task=29", () => {
  // Made-up docs in the shape the Developer Docs MCP answers: how to send a token, and a registry page.
  const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
  type Body = { result: { schema: string; verdict: string; action: { kind: string; account: { value: string; from: string }; amount: { value: string; from: string } } | null; grounding: { id: string; agrees: boolean | null }[]; prepared: { verdict: string } | null; skillEngine: { commands: { label: string }[] } | null }; inputs: Record<string, string>; calls: { tool: string }[]; docsCalls: { tool: string }[] };
  let docs: FakeDocs;
  before(async () => {
    docs = await startFakeDocs(() => `Call \`transfer(address,uint256)\` on USDC, listed in the [Token Registry](${REGISTRY}).\n\n# Sources\n\n- [Token Registry](${REGISTRY})`, { [REGISTRY]: "# Token Registry\n\n## Pharos Mainnet\n\n| Token | Address |\n| --- | --- |\n| USDC | 0xC879C018dB60520F4355C26eD1a6D572cdAC1815 |\n" });
  });
  after(() => docs.close());
  const howto = (query: string) => handle(new URL(`http://agent.test/api/agent?${query}`), { chainMcpUrl, docsMcpUrl: docs.url, timeoutMs: 5000 });

  test("the default question: the docs, the registry page for USDC's address, the transfer dry-run and its cast commands; shared 15 s", async () => {
    const response = await howto("task=29");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 15);
    const body = response.body as Body;
    assert.deepEqual([body.result.schema, body.result.verdict, body.result.action?.kind, body.result.prepared?.verdict], ["pharos-agent/how-to/1", "ready", "erc20-transfer", "would-succeed"]);
    assert.deepEqual(body.result.grounding.map((g) => [g.id, g.agrees]), [["chain-id", null], ["rpc", null], ["token", true], ["function", true]]);
    assert.deepEqual(body.result.skillEngine?.commands.map((c) => c.label), ["Estimate its gas", "Send it", "The gas price"]);
    assert.deepEqual(body.inputs, { q: DEFAULT_HOW_TO });
    assert.deepEqual(body.docsCalls.map((c) => c.tool), ["askQuestion", "getPage"]);
    assert.equal(body.calls.some((c) => c.tool === "send_raw_transaction"), false);
  });

  test("inputs over the question; one that would fail; bad input is a 400 before any call", async () => {
    const body = (await howto(`task=29&from=${STRANGER}&amount=3`)).body as Body;
    assert.deepEqual([body.result.action?.account, body.result.action?.amount, body.result.verdict], [{ value: STRANGER, from: "input" }, { value: "3", from: "input" }, "would-fail"]);
    assert.deepEqual(body.inputs, { q: DEFAULT_HOW_TO, from: STRANGER, amount: "3" });
    const [chainBefore, docsBefore] = [fake.requests.length, docs.requests.length];
    for (const [query, pattern] of [
      ["task=29&from=0x12", /from must be a 0x address/],
      ["task=29&amount=-1", /amount/],
      ["task=29&token=PEPE", /token must be PROS or an official Pharos Mainnet token/],
      [`task=29&q=${"x".repeat(301)}`, /at most 300 characters/],
    ] as const) {
      const bad = await howto(query);
      assert.equal(bad.status, 400, query);
      assert.match(message(bad), pattern, query);
    }
    assert.deepEqual([fake.requests.length, docs.requests.length], [chainBefore, docsBefore], "nothing reached the chain or the docs");
  });
});

describe("GET /api/agent?task=17", () => {
  type Body = { result: { schema: string; verdict: string; sender: { address: string; from: string }; payments: { to: { name: string | null }; amount: string; asset: string; tx: { nonce: number } | null }[]; totals: { asset: string; covered: boolean }[] }; inputs: Record<string, string>; calls: { tool: string }[] };

  test("the example request and address book: two payments dry-run, the totals covered, nonces in order; shared 15 s", async () => {
    const response = await get("task=17");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 15);
    const body = response.body as Body;
    assert.deepEqual([body.result.schema, body.result.verdict, body.result.sender.from], ["pharos-agent/payment-flow/1", "ready", "example"]);
    assert.deepEqual(body.result.payments.map((p) => [p.to.name, p.amount, p.asset]), [["alice", "25", "USDC"], ["bob", "0.01", "PROS"]]);
    assert.deepEqual(body.result.payments.map((p) => p.tx!.nonce - body.result.payments[0]!.tx!.nonce), [0, 1]);
    assert.deepEqual(body.inputs, { request: DEFAULT_PAYMENT, contacts: DEFAULT_CONTACTS });
    assert.equal(body.calls.some((c) => c.tool === "send_raw_transaction"), false);
  });

  test("a request of your own, from your address; refused before any call when it is not read whole", async () => {
    const mine = (await get(`task=17&request=${encodeURIComponent("Send 5 USDC each to alice and bob")}&contacts=${encodeURIComponent(`alice=${PAYER}, bob=${USDC}`)}&from=${STRANGER}`)).body as Body;
    assert.deepEqual([mine.result.verdict, mine.result.sender], ["would-fail", { address: STRANGER, from: "input" }]);
    const before = fake.requests.length;
    for (const [query, pattern] of [
      [`task=17&request=${encodeURIComponent("Pay carol 5 USDC")}`, /Who is "carol"\?/],
      [`task=17&request=${encodeURIComponent(Array.from({ length: 6 }, () => "pay alice 1 USDC").join(" and "))}`, /at most 5 payments/],
      ["task=17&contacts=alice%3D0x12", /alice's address must be 0x and 40 hex characters/],
      ["task=17&from=0x12", /from must be a 0x address/],
    ] as const) {
      const bad = await get(query);
      assert.equal(bad.status, 400, query);
      assert.match(message(bad), pattern, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

describe("GET /api/agent?task=19", () => {
  type Body = { result: { schema: string; verdict: string; payer: { address: string; from: string }; payee: { book: { status: string } }; invoice: { number: string; due: { amount: string } }; due: { date: string; words: string }; checks: { id: string; state: string }[]; payment: { asset: string; tx: { nonce: number } | null }; link: string }; inputs: Record<string, string>; calls: { tool: string }[] };
  const STUDIO = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";

  test("the example invoice and payees: read, checked, the payer's history read, prepared with its link; shared 15 s", async () => {
    const response = await get("task=19");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 15);
    const body = response.body as Body;
    assert.deepEqual([body.result.schema, body.result.verdict, body.result.payer.from, body.result.payee.book.status, body.result.invoice.number, body.result.invoice.due.amount], ["pharos-agent/invoice-payment/1", "ready", "example", "matches", "INV-1042", "20"]);
    assert.deepEqual(body.result.due, { date: "2026-11-14", days: 54, words: "due in 54 days" });
    assert.equal(body.result.link, `ethereum:0xC879C018dB60520F4355C26eD1a6D572cdAC1815@1672/transfer?address=${STUDIO}&uint256=20000000`);
    assert.deepEqual(body.inputs, { invoice: DEFAULT_INVOICE, payees: DEFAULT_PAYEES });
    assert.deepEqual([body.calls.filter((c) => c.tool === "get_logs").length, body.calls.some((c) => c.tool === "send_raw_transaction")], [2, false]);
  });

  test("an invoice of your own, paid from your address; refused before any call when it does not add up", async () => {
    const mine = (await get(`task=19&invoice=${encodeURIComponent(`ethereum:${USDC}@1672/transfer?address=${STUDIO}&uint256=5e6`)}&from=${STRANGER}`)).body as Body;
    assert.deepEqual([mine.result.verdict, mine.result.payer, mine.result.payee.book.status, mine.result.payment.tx], ["would-fail", { address: STRANGER, from: "input" }, "listed", null]);
    const before = fake.requests.length;
    for (const [query, pattern] of [
      [`task=19&invoice=${encodeURIComponent(`Design 15.00 USDC\nTotal: 25 USDC\nPay to: ${STUDIO}`)}`, /The line is 15 USDC, but the total says 25 USDC\./],
      [`task=19&invoice=${encodeURIComponent(`Total: $20\nPay to: ${STUDIO}`)}`, /a currency, not an asset on Pharos/],
      [`task=19&invoice=${encodeURIComponent(`Total: 1 USDC\nPay to: ${STUDIO}\n${"x".repeat(2000)}`)}`, /at most 2,000 characters/],
      ["task=19&payees=Studio%3D0x12", /Studio's address must be 0x and 40 hex characters/],
      ["task=19&from=0x12", /from must be a 0x address/],
    ] as const) {
      const bad = await get(query);
      assert.equal(bad.status, 400, query);
      assert.match(message(bad), pattern, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

describe("GET /api/agent?task=20", () => {
  type Body = { result: { schema: string; verdict: string; reason: string | null; payTo: string; payer: { key: string }; facilitator: { address: string | null; settles: boolean }; endpoint: { price: { amount: string; shown: string } }; cap: { amount: string }; data: unknown; settle: unknown; response: { status: number }; required: { accepts: { network: string; asset: string; amount: string; payTo: string; extra: Record<string, unknown> }[] } | null }; inputs: Record<string, string>; calls: { tool: string }[] };
  // For these, the chain's USDC is an EIP-3009 token, as Circle's is.
  before(() => {
    Object.assign(fake.state.tokens[USDC]!, { name: "USD Coin", symbol: "USDC", eip3009: { version: "2" } });
  });
  after(() => {
    for (const key of ["name", "symbol", "eip3009"] as const) delete fake.state.tokens[USDC]![key];
  });

  test("GET /data's 402 terms, an authorization signed by a key made for the request, refused at verify: the data stays locked, nothing is sent; shared 15 s", async () => {
    const response = await get("task=20");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 15);
    const body = response.body as Body;
    assert.deepEqual([body.result.schema, body.result.verdict, body.result.reason, body.result.payer.key, body.result.facilitator, body.result.data, body.result.settle, body.result.response.status], ["pharos-agent/x402-run/1", "refused", "the payer does not hold the amount", "new", { address: null, settles: false }, null, null, 402]);
    const accepted = body.result.required!.accepts[0]!;
    assert.deepEqual([accepted.network, accepted.asset, accepted.amount, accepted.payTo, accepted.extra], ["eip155:1672", "0xC879C018dB60520F4355C26eD1a6D572cdAC1815", "1000", "0xB2749BD12f19C24a2244176658F3dF3e48e79553", { name: "USD Coin", version: "2" }]);
    assert.deepEqual(body.inputs, { price: "0.001" });
    assert.deepEqual(body.calls.slice(0, 3).map((c) => c.tool), ["get_chain_info", "get_block_number", "get_block"]);
    assert.ok(body.calls.some((c) => c.tool === "eth_call"));
    assert.equal(body.calls.some((c) => c.tool === "send_raw_transaction"), false);
  });

  test("a price, a cap and a recipient of your own; refused before any call when one is wrong", async () => {
    const capped = (await get(`task=20&price=0.01&cap=0.001&to=${STRANGER}`)).body as Body;
    assert.deepEqual([capped.result.verdict, capped.result.reason, capped.result.payTo, capped.result.endpoint.price.shown, capped.result.cap.amount], ["not-paid", "the endpoint asks 0.01 USDC, more than the client's cap of 0.001 USDC a request", STRANGER, "0.01 USDC", "1000"]);
    assert.deepEqual(capped.inputs, { price: "0.01", cap: "0.001", to: STRANGER });
    const before = fake.requests.length;
    for (const [query, pattern] of [
      ["task=20&price=abc", /price must be a number of USDC/],
      ["task=20&price=0", /price must be more than zero/],
      ["task=20&price=0.0000001", /more than 6 decimal places/],
      ["task=20&price=2000000", /price is at most 1,000,000 USDC here/],
      ["task=20&cap=-1", /cap must be a number of USDC/],
      ["task=20&to=0x12", /to must be a 0x address/],
      [`task=20&to=${USDC}`, /cannot be the token's own contract/],
    ] as const) {
      const bad = await get(query);
      assert.equal(bad.status, 400, query);
      assert.match(message(bad), pattern, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
  });
});

describe("GET /api/agent?task=18", () => {
  type Body = { result: { schema: string; verdict: string; today: string; since: string; sinceFrom: string; payer: { address: string; from: string }; owed: { id: string }[]; due: string[]; later: number; payments: { memo: string; tx: { nonce: number } | null }[]; items: { id: string; next: string | null }[]; store: unknown }; inputs: Record<string, string>; calls: { tool: string }[] };

  test("the example schedule this month: what fell due since the 1st, oldest first, prepared; nothing kept; shared 15 s", async () => {
    const response = await get("task=18");
    assert.equal(response.status, 200);
    assert.equal(response.maxAge, 15);
    const body = response.body as Body;
    assert.deepEqual([body.result.schema, body.result.verdict, body.result.today, body.result.since, body.result.sinceFrom, body.result.payer.from, body.result.store], ["pharos-agent/recurring-run/1", "ready", "2026-09-21", "2026-09-01", "month", "example", null]);
    assert.deepEqual(body.result.due, ["rent@2026-09-01", "design-tool@2026-09-07", "design-tool@2026-09-14", "payroll@2026-09-15", "design-tool@2026-09-21"]);
    assert.deepEqual(body.result.items.map((i) => [i.id, i.next]), [["rent", "2026-10-01"], ["payroll", "2026-10-15"], ["design-tool", "2026-09-28"]]);
    assert.deepEqual(body.inputs, { schedule: DEFAULT_SCHEDULE });
    assert.equal(body.calls.some((c) => c.tool === "send_raw_transaction"), false);
  });

  test("a schedule of your own from a day given, at most 6 a run; refused before any call when a line is not read", async () => {
    const mine = (await get(`task=18&schedule=${encodeURIComponent(`Tool: 1 USDC to ${PAYER}, daily`)}&since=2026-09-10&from=${STRANGER}`)).body as Body;
    assert.deepEqual([mine.result.verdict, mine.result.sinceFrom, mine.result.owed.length, mine.result.due.length, mine.result.later, mine.result.payer], ["would-fail", "input", 12, 3, 9, { address: STRANGER, from: "input" }]);
    const before = fake.requests.length;
    for (const [query, pattern] of [
      [`task=18&schedule=${encodeURIComponent("Rent: 25 USDC to 0x12, monthly on the 1st")}`, /is not an address: 0x and 40 hex characters/],
      [`task=18&schedule=${encodeURIComponent(`Rent: 25 USDC to ${PAYER}, sometimes`)}`, /"sometimes" is not a rule the agent reads/],
      [`task=18&schedule=${encodeURIComponent(Array.from({ length: 9 }, (_, k) => `P${k}: 1 USDC to ${PAYER}, daily`).join("\n"))}`, /at most 8 payments here/],
      ["task=18&since=yesterday", /since must be a day as YYYY-MM-DD/],
      ["task=18&from=0x12", /from must be a 0x address/],
    ] as const) {
      const bad = await get(query);
      assert.equal(bad.status, 400, query);
      assert.match(message(bad), pattern, query);
    }
    assert.equal(fake.requests.length, before, "nothing reached the chain");
    const late = await get("task=18&since=2025-01-01");
    assert.equal(late.status, 400);
    assert.match(message(late), /Without a store, a run counts from a day in the last year/);
  });
});
