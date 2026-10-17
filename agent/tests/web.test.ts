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
      ["task=99", /Unknown task\. Use \?task=05, 08 or 11\./],
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
