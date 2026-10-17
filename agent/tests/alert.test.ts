// Task 22, On-Chain Alert Bot: bots and stores checked before anything runs; transfers alerted once
// each from a cursor kept between runs; state rules alerting when a condition starts and when it stops;
// delivery that keeps what a webhook did not take; proofs, one run and a history.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentError } from "../src/core/errors.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { describeTransfer, parseAlertBot } from "../src/alert/config.js";
import { deliver, webhookBody } from "../src/alert/deliver.js";
import { usdcAlerts } from "../src/alert/presets.js";
import { runAlerts, type AlertRun } from "../src/alert/run.js";
import { afterDelivery, emptyAlertStore, parseAlertStore, type AlertStore } from "../src/alert/store.js";
import { alertHistoryCheck, verifyAlertProof, type RecordedAlertRun } from "../src/alert/verify.js";
import { defaultState, startFakeChain, type FakeChain, type FakeTransfer } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const WETH = "0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9";
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const OTHER = "0x1111111111111111111111111111111111111111";
const lower = (a: string) => a.toLowerCase();
const HEAD = 5_000_000n;
const bot = () => parseAlertBot(usdcAlerts());

/** In the first run's 1,000 blocks: two USDC transfers of 500 or more, and what must not alert. */
const HISTORY: FakeTransfer[] = [
  { token: USDC, from: OTHER, to: RECIPIENT, amount: 600_000_000n, block: HEAD - 999n },
  { token: USDC, from: PAYER, to: OTHER, amount: 499_999_999n, block: HEAD - 50n }, // just under 500
  { token: USDC, from: RECIPIENT, to: PAYER, amount: 2_500_000_000n, block: HEAD - 2n },
  { token: USDC, from: OTHER, to: PAYER, amount: 900_000_000n, block: HEAD - 1000n }, // before the lookback
  { token: WETH, from: OTHER, to: PAYER, amount: 10n ** 21n, block: HEAD - 10n }, // another token
];

const mainnet = (transfers: FakeTransfer[] = structuredClone(HISTORY)) =>
  startFakeChain(defaultState({ native: { [lower(PAYER)]: 10n ** 18n }, tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(PAYER)]: 80_000_000n } }, [lower(WETH)]: { decimals: 18, balances: {} } }, transfers }));

const NOW = new Date("2026-10-17T12:00:00.000Z");

async function run(fake: FakeChain, store: AlertStore, b = bot()): Promise<{ result: AlertRun; proof: ProofFile; calls: { name: string; arguments: Record<string, unknown> }[] }> {
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    const result = await runAlerts(b, store, { chain: official.chain, now: () => NOW });
    const proof = JSON.parse(JSON.stringify(proofFile({ task: "22", capability: "alert-bot", about: "test", mcp: official.mcp, network: NETWORKS["pharos-mainnet"], startedAt: new Date(), input: { bot: usdcAlerts(), store }, result }))) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    const calls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);
    return { result, proof, calls };
  } finally {
    await official.close();
  }
}

describe("alert bots", () => {
  test("every rule is checked before anything touches the chain", () => {
    const base = usdcAlerts() as { rules: Record<string, unknown>[] };
    const with_ = (rules: unknown[], extra: Record<string, unknown> = {}) => ({ name: "b", network: "pharos-mainnet", rules, ...extra });
    const cases: [unknown, RegExp][] = [
      [with_([]), /rules must list 1 to 12 rules/],
      [with_([{ kind: "transfer", id: "x", token: "0x12" }]), /rules\[0\]\.token must be a 0x address/],
      [with_([{ kind: "transfer", id: "x", token: USDC, min: "1.1234567" }]), /more than 6 decimal places/],
      [with_([{ kind: "transfer", id: "Bad", token: USDC }]), /lowercase letters, digits and dashes/],
      [with_([{ kind: "transfer", id: "x", token: USDC }, { kind: "transfer", id: "x", token: USDC }]), /share the id "x"/],
      [with_([{ kind: "sometimes", id: "x" }]), /kind must be state or transfer/],
      [with_([{ kind: "state", id: "x", label: "L", read: { kind: "gas-price" }, op: "~", value: "1" }]), /op must be one of/],
      [with_([base.rules[0]], { lookback: 0 }), /lookback must be a whole number of blocks from 1 to 2,000/],
      [with_([base.rules[0]], { maxScan: 20_000 }), /maxScan must be a whole number of blocks from 1 to 10,000/],
      [with_([base.rules[0]], { colour: "red" }), /unknown field "colour"/],
    ];
    for (const [input, error] of cases) assert.throws(() => parseAlertBot(input), (e: unknown) => e instanceof AgentError && e.kind === "usage" && error.test(e.message), JSON.stringify(input));
    const net = NETWORKS["pharos-mainnet"];
    assert.equal(describeTransfer(net, { token: USDC, min: "500", from: null, to: null }), "A USDC transfer of 500 or more");
    assert.equal(describeTransfer(net, { token: USDC, min: "0", from: PAYER, to: null }), "Any USDC transfer from 0x912c…f647");
    assert.deepEqual(bot().rules.map((r) => r.label), ["A USDC transfer of 500 or more", "0x912c…f647 holds less than 100 USDC", "USDC is paused", "Gas costs more than 5 gwei"]);
  });

  test("a store belongs to one bot; states of rules it no longer has are dropped", () => {
    const b = bot();
    const store = { ...emptyAlertStore(b), cursor: "10", states: { "holder-low": true, gone: true } };
    assert.deepEqual(parseAlertStore(store, b).states, { "holder-low": true });
    assert.throws(() => parseAlertStore({ ...store, bot: "pharos-mainnet:Other" }, b), /belongs to another bot/);
    assert.throws(() => parseAlertStore({ ...store, cursor: "x" }, b), /cursor must be a block number/);
    assert.throws(() => parseAlertStore({ ...store, states: { "holder-low": "yes" } }, b), /must be true or false/);
  });
});

describe("watching for alerts", () => {
  test("a first run: transfers of 500 USDC or more in the last 1,000 blocks, and the conditions that already hold", async () => {
    const fake = await mainnet();
    try {
      const { result, calls } = await run(fake, emptyAlertStore(bot()));
      assert.deepEqual(result.scanned, { from: "4999001", to: "5000000", pages: 1 });
      assert.deepEqual(result.alerts.map((a) => [a.kind, a.rule, a.message]), [
        ["transfer", "large-transfer", "600 USDC from 0x1111…1111 to 0xB274…9553 at block 4,999,001"],
        ["transfer", "large-transfer", "2,500 USDC from 0xB274…9553 to 0x912c…f647 at block 4,999,998"],
        ["triggered", "holder-low", "80 USDC at block 5,000,000"],
      ]);
      assert.deepEqual(result.rules.map((r) => [r.id, r.state, r.matches]), [["large-transfer", null, 2], ["holder-low", "holds", null], ["usdc-paused", "clear", null], ["gas-high", "clear", null]]);
      assert.deepEqual([result.store.cursor, result.store.states, result.store.pending.length], ["5000000", { "holder-low": true, "usdc-paused": false, "gas-high": false }, 3]);
      assert.equal(result.headline, "3 new alerts at block 5,000,000: A USDC transfer of 500 or more: 600 USDC from 0x1111…1111 to 0xB274…9553 at block 4,999,001 …");
      const logs = calls.filter((c) => c.name === "get_logs");
      assert.deepEqual(logs.map((c) => c.arguments), [{ address: USDC, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], fromBlock: "0x4c4759", toBlock: "0x4c4b40" }]);
    } finally {
      await fake.close();
    }
  });

  test("run to run: each transfer alerts once, a condition alerts when it starts and when it stops", async () => {
    const fake = await mainnet();
    try {
      const first = await run(fake, emptyAlertStore(bot()));
      const same = await run(fake, first.result.store);
      assert.deepEqual([same.result.scanned, same.result.alerts], [null, []], "no new blocks, and the low balance was already alerted");
      fake.state.head += 10n;
      fake.state.headTime += 10n;
      fake.state.transfers.push({ token: USDC, from: PAYER, to: OTHER, amount: 1_000_000_000n, block: HEAD + 4n });
      fake.state.tokens[lower(USDC)]!.balances[lower(PAYER)] = 200_000_000n;
      const later = await run(fake, same.result.store);
      assert.deepEqual(later.result.scanned, { from: "5000001", to: "5000010", pages: 1 });
      assert.deepEqual(later.result.alerts.map((a) => [a.kind, a.message]), [
        ["transfer", "1,000 USDC from 0x912c…f647 to 0x1111…1111 at block 5,000,004"],
        ["resolved", "no longer holds: 200 USDC at block 5,000,010"],
      ]);
      assert.equal(later.result.store.states["holder-low"], false);
      // The three runs: each replays alone, and together they are one history.
      for (const proof of [first, same, later].map((r) => r.proof)) assert.deepEqual((await verifyAlertProof(proof)).filter((c) => !c.ok), []);
      const history = alertHistoryCheck([first, same, later].map((r) => r.proof));
      assert.deepEqual([history.ok, history.detail], [true, "3 runs, each from the store the last one left; 5 alerts in all"]);
      assert.equal(alertHistoryCheck([first, later].map((r) => r.proof)).ok, true, "the second run changed nothing, so there is nothing to miss");
      assert.equal(alertHistoryCheck([later, same].map((r) => r.proof)).detail, "run 2 did not start from the store run 1 left");
    } finally {
      await fake.close();
    }
  });

  test("far behind: the newest blocks are scanned in pages, the rest is said to be skipped", async () => {
    const fake = await mainnet([{ token: USDC, from: OTHER, to: PAYER, amount: 700_000_000n, block: HEAD - 1500n }]);
    try {
      const store = { ...emptyAlertStore(bot()), cursor: (HEAD - 5000n).toString() };
      const { result, calls } = await run(fake, store);
      assert.deepEqual(result.skipped, { from: "4995001", to: "4998000" });
      assert.deepEqual(result.scanned, { from: "4998001", to: "5000000", pages: 2 });
      assert.deepEqual(calls.filter((c) => c.name === "get_logs").map((c) => [BigInt(String(c.arguments.fromBlock)), BigInt(String(c.arguments.toBlock))]), [[HEAD - 1999n, HEAD - 1000n], [HEAD - 999n, HEAD]]);
      assert.equal(result.alerts[0]!.block, "4998500");
    } finally {
      await fake.close();
    }
  });

  test("a value that cannot be read changes nothing; one run reports at most 100 transfers, and every change of a condition", async () => {
    const many = Array.from({ length: 105 }, (_, i) => ({ token: USDC, from: OTHER, to: PAYER, amount: 500_000_000n, block: HEAD - BigInt(i % 90) }));
    const fake = await mainnet(many);
    try {
      fake.state.failures.eth_gasPrice = { code: -32000, message: "gas price unavailable" };
      const store = { ...emptyAlertStore(bot()), states: { "gas-high": true } };
      const { result } = await run(fake, store);
      const gas = result.rules.find((r) => r.id === "gas-high")!;
      assert.deepEqual([gas.state, result.store.states["gas-high"]], ["unreadable", true], "the last known state is kept");
      assert.ok(!result.alerts.some((a) => a.rule === "gas-high"));
      assert.deepEqual([result.alerts.length, result.truncated], [101, 5], "105 transfers and the low-balance trigger: the first 100 transfers, and the trigger");
      assert.deepEqual(result.alerts.at(-1)!.kind, "triggered");
    } finally {
      await fake.close();
    }
  });

  test("a changed log in a proof fails its replay", async () => {
    const fake = await mainnet();
    try {
      const { proof } = await run(fake, emptyAlertStore(bot()));
      const asked = proof.transcript.find((m) => m.direction === "client->server" && JSON.stringify(m.message).includes('"name":"get_logs"'))!;
      const id = (asked.message as { id: number }).id;
      const answer = proof.transcript.find((m) => m.direction === "server->client" && "id" in m.message && m.message.id === id)!;
      const content = (answer.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
      content.text = content.text.replace("0000000000000000000000000000000000000000000000000000000023c34600", "0000000000000000000000000000000000000000000000000000000000000001");
      assert.deepEqual((await verifyAlertProof(proof)).filter((c) => !c.ok).map((c) => c.name), ["result recomputed from the recorded responses"]);
    } finally {
      await fake.close();
    }
  });
});

describe("delivering alerts", () => {
  const alert = (id: string) => ({ id, rule: "r", label: "A USDC transfer of 500 or more", kind: "transfer" as const, block: "1", message: `message ${id}`, transfer: null, observed: null });

  test("without a webhook every alert is delivered by being printed", async () => {
    assert.deepEqual(await deliver("Bot", [alert("a"), alert("b")], null), { channel: "stdout", delivered: ["a", "b"], failed: [] });
  });

  test("a webhook gets one POST per alert; what it refuses stays pending for the next run", async () => {
    const posts: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return new Response(null, { status: body.alert.id === "b" ? 500 : 204 });
    }) as typeof fetch;
    const delivery = await deliver("Bot", [alert("a"), alert("b")], "https://hooks.example/x", fetchImpl);
    assert.deepEqual(delivery, { channel: "webhook", delivered: ["a"], failed: [{ id: "b", error: "HTTP 500" }] });
    assert.deepEqual(posts[0], JSON.parse(webhookBody("Bot", alert("a"))));
    assert.deepEqual(Object.keys(posts[0] as object), ["text", "content", "bot", "alert"]);
    assert.equal((posts[0] as { text: string }).text, "Bot: A USDC transfer of 500 or more: message a");
    const store = { ...emptyAlertStore(bot()), pending: [alert("a"), alert("b")] };
    assert.deepEqual(afterDelivery(store, delivery.delivered).pending.map((a) => a.id), ["b"]);
  });

  test("a webhook that does not answer is not tried again in the same run: the rest wait for the next", async () => {
    const tried: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { alert: sent } = JSON.parse(String(init.body)) as { alert: { id: string } };
      tried.push(sent.id);
      if (sent.id === "b") throw new TypeError("fetch failed");
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const delivery = await deliver("Bot", [alert("a"), alert("b"), alert("c")], "https://hooks.example/x", fetchImpl);
    assert.deepEqual(tried, ["a", "b"]);
    assert.deepEqual(delivery, { channel: "webhook", delivered: ["a"], failed: [{ id: "b", error: "fetch failed" }, { id: "c", error: "not tried: the webhook did not answer the alert before it" }] });
  });

  test("a recorded delivery is checked against the run's alerts", async () => {
    const fake = await mainnet();
    try {
      const { proof } = await run(fake, emptyAlertStore(bot()));
      const recorded = proof.result as RecordedAlertRun;
      recorded.delivery = { channel: "webhook", delivered: recorded.store.pending.map((a) => a.id).slice(0, 2), failed: [] };
      assert.deepEqual((await verifyAlertProof(proof)).filter((c) => !c.ok), []);
      recorded.delivery.delivered.push("not-an-alert");
      assert.deepEqual((await verifyAlertProof(proof)).filter((c) => !c.ok).map((c) => c.name), ["delivery"]);
    } finally {
      await fake.close();
    }
  });
});
