// Task 11, Policy Gatekeeper: policies checked before anything runs; every rule evaluated against the
// official Chain MCP server on a fake chain (the window from Transfer logs, the hours from the block's
// time); denials that list every failing rule; execution on Atlantic only when allowed; proofs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Chain } from "../src/core/chain.js";
import { ChainMcp, Recorder } from "../src/core/chain-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS, type Network } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { parseDryRun, type Intent } from "../src/dryrun/intent.js";
import { runGate, type GateRun } from "../src/policy/check.js";
import { describeRule, parsePolicy, type Policy } from "../src/policy/config.js";
import { atlanticTreasuryPolicy, TREASURY_ALLOWLIST, treasuryPolicy } from "../src/policy/presets.js";
import { verifyGateProof } from "../src/policy/verify.js";
import { defaultState, startFakeChain, type FakeChain, type FakeTransfer } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const WETH = "0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9";
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const STRANGER = "0x1111111111111111111111111111111111111111";
const lower = (a: string) => a.toLowerCase();
/** 1,790,000,000 s is a Monday, 14:13:20 UTC: inside the treasury's 06:00–22:00 UTC. */
const MONDAY_AFTERNOON = 1_790_000_000n;
const HEAD = 5_000_000n;

/** USDC moved by the payer: 1,200 USDC in the last 1,000 blocks, and what must not count. */
const HISTORY: FakeTransfer[] = [
  { token: USDC, from: PAYER, to: RECIPIENT, amount: 500_000_000n, block: HEAD - 999n },
  { token: USDC, from: PAYER, to: STRANGER, amount: 400_000_000n, block: HEAD - 500n },
  { token: USDC, from: PAYER, to: RECIPIENT, amount: 300_000_000n, block: HEAD },
  { token: USDC, from: PAYER, to: RECIPIENT, amount: 9_000_000_000n, block: HEAD - 1000n }, // just outside the window
  { token: USDC, from: RECIPIENT, to: PAYER, amount: 7_000_000_000n, block: HEAD - 10n }, // received, not sent
  { token: USDC, from: PAYER, to: PAYER, amount: 8_000_000_000n, block: HEAD - 5n }, // to itself: nothing leaves
  { token: WETH, from: PAYER, to: RECIPIENT, amount: 10n ** 21n, block: HEAD - 20n }, // another token
];

const mainnet = (overrides: { usdc?: bigint; headTime?: bigint; transfers?: FakeTransfer[] } = {}) =>
  startFakeChain(defaultState({ headTime: overrides.headTime ?? MONDAY_AFTERNOON, native: { [lower(PAYER)]: 10n ** 18n }, tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(PAYER)]: overrides.usdc ?? 2_000_000_000n } }, [lower(WETH)]: { decimals: 18, balances: { [lower(PAYER)]: 10n ** 20n } } }, transfers: overrides.transfers ?? structuredClone(HISTORY) }));

const intent = (fields: Record<string, unknown>, network = "pharos-mainnet"): Intent => parseDryRun({ network, intent: fields }).intent;
const transfer = (amount = "25", extra: Record<string, unknown> = {}) => intent({ kind: "erc20-transfer", token: USDC, from: PAYER, to: RECIPIENT, amount, ...extra });
const treasury = (hours?: { from: string; to: string }) => parsePolicy(treasuryPolicy(hours));

async function gate(fake: FakeChain, policy: Policy, request: Intent, block?: bigint) {
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    return { run: await runGate(policy, request, { chain: official.chain, block }), official };
  } finally {
    await official.close();
  }
}

const rule = (run: GateRun, id: string) => run.rules.find((r) => r.id === id)!;
const tools = (messages: Recorder["messages"]) =>
  messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);

describe("policies", () => {
  test("every rule is checked before anything touches the chain", () => {
    const base = treasuryPolicy() as { rules: Record<string, unknown>[] };
    const withRule = (rule: Record<string, unknown>) => ({ name: "p", network: "pharos-mainnet", rules: [rule] });
    const cases: [unknown, RegExp][] = [
      [null, /a JSON object/],
      [{ name: "p", rules: [] }, /a list of 1 to 20 rules/],
      [{ name: "p", network: "solana", rules: base.rules }, /network: pharos-mainnet or atlantic-testnet/],
      [{ name: "p", rules: [base.rules[0], base.rules[0]] }, /"assets" is used twice/],
      [withRule({ id: "Bad Id", kind: "simulates" }), /lowercase letters, digits and dashes/],
      [withRule({ id: "x", kind: "teleport" }), /kind: one of asset-allowlist/],
      [withRule({ id: "x", kind: "asset-allowlist", assets: ["DOGE"] }), /an asset is PROS or an official Pharos Mainnet token/],
      [withRule({ id: "x", kind: "counterparty-allowlist", addresses: ["0x123"] }), /"0x123" is not a 0x address/],
      [withRule({ id: "x", kind: "max-per-action", asset: "USDC", amount: "1.1234567" }), /more than 6 decimal places/],
      [withRule({ id: "x", kind: "max-per-action", asset: "USDC", amount: "0" }), /more than 0/],
      [withRule({ id: "x", kind: "max-in-window", asset: "PROS", amount: "1", blocks: 10 }), /native PROS transfers do not/],
      [withRule({ id: "x", kind: "max-in-window", asset: "USDC", amount: "1", blocks: 10_001 }), /1 to 10,000/],
      [withRule({ id: "x", kind: "time-window", from: "25:00", to: "06:00" }), /times like "06:00"/],
      [withRule({ id: "x", kind: "time-window", from: "06:00", to: "06:00" }), /must differ/],
      [withRule({ id: "x", kind: "time-window", from: "06:00", to: "07:00", days: ["funday"] }), /some of mon, tue/],
      [withRule({ id: "x", kind: "time-window", from: "06:00", to: "07:00", utcOffset: "+15:00" }), /at most 14 hours/],
      [withRule({ id: "x", kind: "max-gas-price", gwei: "-1" }), /./],
    ];
    for (const [input, error] of cases) assert.throws(() => parsePolicy(input), (e: unknown) => e instanceof AgentError && e.kind === "usage" && error.test(e.message), JSON.stringify(input));
  });

  test("each rule says what it means, and names the counterparty for the request", () => {
    const policy = treasury();
    const net = NETWORKS["pharos-mainnet"];
    assert.deepEqual(policy.rules.map((r) => describeRule(r, net, "recipient")), [
      "Only USDC",
      "The recipient is one of 3 allowed addresses",
      "At most 100 USDC per action",
      "At most 5,000 USDC sent in 1,000 blocks",
      "Between 06:00 and 22:00 UTC, every day",
      "Gas costs at most 10 gwei",
      "It succeeds in a dry run on Pharos Mainnet",
    ]);
    assert.equal(describeRule(policy.rules[1]!, net, "spender"), "The spender is one of 3 allowed addresses");
    const weekdays = parsePolicy({ name: "p", rules: [{ id: "x", kind: "time-window", days: ["fri", "mon", "tue", "wed", "thu"], from: "09:00", to: "17:30", utcOffset: "+07:00" }] });
    assert.equal(describeRule(weekdays.rules[0]!, net), "Between 09:00 and 17:30 UTC+07:00, Mon–Fri");
  });
});

describe("the gatekeeper", () => {
  test("allowed: every rule holds at one block; the window counts only the sender's own USDC transfers in it", async () => {
    const fake = await mainnet();
    try {
      const { run, official } = await gate(fake, treasury(), transfer());
      assert.equal(run.outcome, "allowed");
      assert.deepEqual(run.decision, { allowed: true, passed: 7, total: 7, failed: [], unreadable: [] });
      assert.deepEqual(run.rules.map((r) => [r.id, r.passed, r.observed, r.limit, r.tool]), [
        ["assets", true, "USDC", "one of USDC", "request"],
        ["counterparties", true, RECIPIENT, "3 allowed", "request"],
        ["per-action", true, "25 USDC", "≤ 100 USDC", "request"],
        ["rolling", true, "1,225 USDC", "≤ 5,000 USDC", "get_logs"],
        ["hours", true, "Mon 14:13 UTC", "every day, 06:00–22:00", "get_block"],
        ["gas", true, "1.2 gwei", "≤ 10 gwei", "get_gas_price"],
        ["simulates", true, "succeeds, about 0.00005635 PROS in gas", "must succeed", "eth_call"],
      ]);
      assert.equal(rule(run, "rolling").note, "1,200 USDC sent in 3 transfers over blocks 4,999,001–5,000,000 (17 min), plus 25 USDC now.");
      assert.equal(run.headline, "Allowed: Send 25 USDC from 0x912c…f647 to 0xB274…9553; all 7 rules hold.");
      assert.equal(run.dryRun?.verdict, "would-succeed");
      assert.equal(run.execution, null);
      // The chain is checked and the block pinned once: the dry run reuses them. The window is one page.
      const calls = tools(official.recorder.messages);
      assert.deepEqual(calls.slice(0, 6).map((c) => c.name), ["get_chain_info", "get_block_number", "get_block", "get_logs", "get_block", "get_gas_price"]);
      assert.equal(calls.filter((c) => c.name === "get_chain_info").length, 1);
      assert.deepEqual(calls[3]!.arguments, { address: "0xc879c018db60520f4355c26ed1a6d572cdac1815", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x000000000000000000000000912c9ade24d44d8922f0866d8dcb079f1363f647"], fromBlock: `0x${(HEAD - 999n).toString(16)}`, toBlock: `0x${HEAD.toString(16)}` });
      const pinned = `0x${HEAD.toString(16)}`;
      for (const call of calls.filter((c) => ["eth_call", "get_balance", "get_code"].includes(c.name))) assert.equal(call.arguments.block, pinned, JSON.stringify(call));
    } finally {
      await fake.close();
    }
  });

  test("denied: every failing rule is listed, not just the first", async () => {
    const fake = await mainnet();
    try {
      const { run } = await gate(fake, treasury(), transfer("150", { to: STRANGER }));
      assert.equal(run.outcome, "denied");
      assert.deepEqual(run.decision, { allowed: false, passed: 5, total: 7, failed: ["counterparties", "per-action"], unreadable: [] });
      assert.equal(rule(run, "counterparties").note, "The recipient is not on the list.");
      assert.equal(run.headline, "Denied: Send 150 USDC from 0x912c…f647 to 0x1111…1111. 2 of 7 rules do not hold: The recipient is one of 3 allowed addresses; At most 100 USDC per action.");
      // A denied request is still dry-run: what it would have done is part of the answer.
      assert.equal(run.dryRun?.verdict, "would-succeed");
    } finally {
      await fake.close();
    }
  });

  test("assets and approvals: another asset fails the allowlist but no USDC limit applies; an unlimited approval fails every limit", async () => {
    const fake = await mainnet();
    try {
      const weth = (await gate(fake, treasury(), intent({ kind: "erc20-transfer", token: WETH, from: PAYER, to: RECIPIENT, amount: "1" }))).run;
      assert.deepEqual(weth.decision.failed, ["assets"]);
      assert.equal(rule(weth, "assets").observed, "WETH");
      assert.deepEqual([rule(weth, "per-action").passed, rule(weth, "per-action").observed, rule(weth, "per-action").note], [true, null, "Applies to USDC only; this is WETH."]);
      const unlimited = (await gate(fake, treasury(), intent({ kind: "erc20-approve", token: USDC, from: PAYER, spender: RECIPIENT, amount: "max" }))).run;
      assert.deepEqual(unlimited.decision.failed, ["per-action", "rolling"]);
      assert.equal(rule(unlimited, "per-action").observed, "unlimited USDC");
      assert.equal(rule(unlimited, "per-action").note, "An unlimited approval is more than any limit.");
      assert.equal(rule(unlimited, "counterparties").label, "The spender is one of 3 allowed addresses");
      // A bounded approval counts like a transfer against the limits.
      const approval = (await gate(fake, treasury(), intent({ kind: "erc20-approve", token: USDC, from: PAYER, spender: TREASURY_ALLOWLIST[1]!, amount: "50" }))).run;
      assert.equal(approval.outcome, "allowed");
    } finally {
      await fake.close();
    }
  });

  test("the window: spent plus this action against the cap; a long window is read in pages of 1,000 blocks, each transfer once", async () => {
    const near = await mainnet({ transfers: [{ token: USDC, from: PAYER, to: RECIPIENT, amount: 4_990_000_000n, block: HEAD - 3n }] });
    try {
      const { run } = await gate(near, treasury(), transfer("25"));
      assert.deepEqual([rule(run, "rolling").passed, rule(run, "rolling").observed], [false, "5,015 USDC"]);
      assert.equal((await gate(near, treasury(), transfer("10"))).run.outcome, "allowed", "exactly at the cap is within it");
    } finally {
      await near.close();
    }
    // Transfers on the page boundaries of a 2,500-block window are counted once each.
    const edges: FakeTransfer[] = [HEAD - 2499n, HEAD - 1500n, HEAD - 1499n, HEAD - 500n, HEAD - 499n, HEAD].map((block) => ({ token: USDC, from: PAYER, to: RECIPIENT, amount: 1_000_000n, block }));
    const fake = await mainnet({ transfers: [...edges, { token: USDC, from: PAYER, to: RECIPIENT, amount: 1_000_000n, block: HEAD - 2500n }] });
    try {
      const policy = parsePolicy({ name: "p", rules: [{ id: "window", kind: "max-in-window", asset: "USDC", amount: "100", blocks: 2500 }] });
      const { run, official } = await gate(fake, policy, transfer("1"));
      assert.equal(rule(run, "window").observed, "7 USDC");
      assert.match(rule(run, "window").note!, /^6 USDC sent in 6 transfers over blocks 4,997,501–5,000,000/);
      assert.deepEqual(tools(official.recorder.messages).filter((c) => c.name === "get_logs").map((c) => [BigInt(String(c.arguments.fromBlock)), BigInt(String(c.arguments.toBlock))]), [
        [HEAD - 2499n, HEAD - 1500n],
        [HEAD - 1499n, HEAD - 500n],
        [HEAD - 499n, HEAD],
      ]);
    } finally {
      await fake.close();
    }
  });

  test("the hours: the pinned block's time, in the policy's offset; a window over midnight; days", async () => {
    const at = (iso: string) => BigInt(Date.parse(iso) / 1000);
    const late = await mainnet({ headTime: at("2026-10-18T23:30:00Z") }); // a Sunday
    try {
      const { run } = await gate(late, treasury(), transfer());
      assert.deepEqual([rule(run, "hours").passed, rule(run, "hours").observed, rule(run, "hours").note], [false, "Sun 23:30 UTC", "Outside the allowed hours."]);
      assert.equal(run.outcome, "denied");
      assert.equal((await gate(late, treasury({ from: "22:00", to: "06:00" }), transfer())).run.outcome, "allowed", "22:00 to 06:00 holds at 23:30");
      const custom = (days: string[], offset: string) => parsePolicy({ name: "p", rules: [{ id: "office", kind: "time-window", days, from: "06:00", to: "12:00", utcOffset: offset }] });
      // Sunday 23:30 UTC is Monday 06:30 in UTC+07:00.
      const jakarta = (await gate(late, custom(["mon", "tue", "wed", "thu", "fri"], "+07:00"), transfer())).run;
      assert.deepEqual([rule(jakarta, "office").passed, rule(jakarta, "office").observed], [true, "Mon 06:30 UTC+07:00"]);
      const weekdaysUtc = (await gate(late, custom(["mon", "tue", "wed", "thu", "fri"], "+00:00"), transfer())).run;
      assert.deepEqual([rule(weekdaysUtc, "office").passed, rule(weekdaysUtc, "office").note], [false, "Not an allowed day."]);
    } finally {
      await late.close();
    }
  });

  test("fail-closed: a value that cannot be read never holds; a failing dry run denies", async () => {
    const fake = await mainnet();
    try {
      fake.state.failures.eth_getLogs = { code: -32005, message: "query returned more than 10000 results" };
      const { run } = await gate(fake, treasury(), transfer());
      assert.deepEqual([rule(run, "rolling").passed, rule(run, "rolling").tool, rule(run, "rolling").error], [null, "get_logs", "query returned more than 10000 results"]);
      assert.deepEqual(run.decision.unreadable, ["rolling"]);
      assert.equal(run.outcome, "denied");
      assert.match(run.headline, /1 of 7 rules does not hold: At most 5,000 USDC sent in 1,000 blocks\.$/);
    } finally {
      await fake.close();
    }
    const poor = await mainnet({ usdc: 10_000_000n });
    try {
      const { run } = await gate(poor, treasury(), transfer());
      assert.deepEqual([rule(run, "simulates").passed, rule(run, "simulates").observed, rule(run, "simulates").note], [false, "reverts", "It reverts: ERC20: transfer amount exceeds balance."]);
      assert.deepEqual(run.decision.failed, ["simulates"]);
    } finally {
      await poor.close();
    }
  });

  test("refused before anything runs: a contract call, a policy for another network", async () => {
    const fake = await mainnet();
    try {
      const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
      try {
        const call = intent({ kind: "call", from: PAYER, to: RECIPIENT, signature: "ping()", args: [] });
        await assert.rejects(runGate(treasury(), call, { chain: official.chain }), /checks transfers and approvals/);
        await assert.rejects(runGate(parsePolicy(atlanticTreasuryPolicy()), transfer(), { chain: official.chain }), /The policy is for atlantic-testnet/);
        assert.equal(official.mcp.toolCalls, 0);
      } finally {
        await official.close();
      }
    } finally {
      await fake.close();
    }
  });
});

describe("executing on Atlantic", () => {
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" }); // Hardhat/Anvil public test key #1
  const TUSDC = NETWORKS["atlantic-testnet"].tokens[0]!.address;
  const policy = () => parsePolicy(JSON.parse(JSON.stringify(atlanticTreasuryPolicy()).replaceAll("$SIGNER", signer.address)));
  async function atlantic() {
    const fake = await startFakeChain(defaultState({ chainId: 688689, native: { [lower(signer.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: { decimals: 6, balances: { [lower(signer.address)]: 5_000_000n } } } }));
    const net: Network = { ...NETWORKS["atlantic-testnet"], rpcUrl: fake.url };
    const mcp = await ChainMcp.connect({ kind: "local", network: net, broadcast: true }, { timeoutMs: 15_000 });
    return { fake, mcp, chain: new Chain(mcp, net) };
  }
  const pay = (amount: string) => intent({ kind: "erc20-transfer", token: TUSDC, from: signer.address, to: RECIPIENT, amount }, "atlantic-testnet");

  test("allowed: the dry-run transaction is sent through Chain MCP, and the receipt matches the prediction", async () => {
    const { fake, mcp, chain } = await atlantic();
    let proof: ProofFile;
    try {
      const request = { network: "atlantic-testnet" as const, intent: pay("1") };
      const run = await runGate(policy(), request.intent, { chain, signer, wait: { pollMs: 10 } });
      assert.equal(run.outcome, "executed");
      assert.equal(run.execution?.status, "success");
      assert.equal(run.execution?.matched, true);
      assert.equal(fake.state.tokens[lower(TUSDC)]!.balances[lower(RECIPIENT)], 1_000_000n);
      proof = JSON.parse(JSON.stringify(proofFile({ task: "11", capability: "policy-gatekeeper", about: "test", mcp, network: NETWORKS["atlantic-testnet"], startedAt: new Date(), input: { policy: policy(), request }, result: run }))) as ProofFile;
    } finally {
      await mcp.close();
      await fake.close();
    }
    const checks = await verifyGateProof(proof);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.match(checks.find((c) => c.name === "signed transaction")!.detail, /^chain 688689, signed by 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, exactly the prepared gated transaction$/);
  });

  test("denied: nothing is signed or sent", async () => {
    const { fake, mcp, chain } = await atlantic();
    try {
      const run = await runGate(policy(), pay("3"), { chain, signer, wait: { pollMs: 10 } });
      assert.deepEqual([run.outcome, run.decision.failed, run.execution], ["denied", ["per-action"], null]);
      assert.ok(!fake.requests.some((r) => r.method === "eth_sendRawTransaction"));
    } finally {
      await mcp.close();
      await fake.close();
    }
  });

  test("never on mainnet", async () => {
    const fake = await mainnet();
    try {
      const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
      try {
        await assert.rejects(runGate(treasury(), transfer(), { chain: official.chain, signer }), /limited to the Atlantic testnet/);
      } finally {
        await official.close();
      }
    } finally {
      await fake.close();
    }
  });
});

describe("gatekeeper proofs", () => {
  const failing = async (proof: ProofFile) => (await verifyGateProof(proof)).filter((c) => !c.ok).map((c) => c.name);

  async function mainnetProof() {
    const fake = await mainnet();
    try {
      const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
      try {
        const request = { network: "pharos-mainnet" as const, intent: transfer() };
        const run = await runGate(treasury(), request.intent, { chain: official.chain });
        const proof = JSON.parse(JSON.stringify(proofFile({ task: "11", capability: "policy-gatekeeper", about: "test", mcp: official.mcp, network: NETWORKS["pharos-mainnet"], startedAt: new Date(), input: { policy: treasuryPolicy(), request }, result: run }))) as ProofFile;
        proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
        return proof;
      } finally {
        await official.close();
      }
    } finally {
      await fake.close();
    }
  }

  test("a mainnet decision verifies by replay, with its window read in whole pages up to the pinned block", async () => {
    const proof = await mainnetProof();
    const checks = await verifyGateProof(proof);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.equal(checks.find((c) => c.name === "spend window")!.detail, "1 get_logs page, 1,000 blocks ending at block 5,000,000, no gap, none over 1,000 blocks");
    assert.match(checks.find((c) => c.name === "result recomputed from the recorded responses")!.detail, /calls replayed; every rule and the decision identical$/);
  });

  test("tampering is caught: a hidden transfer, a changed decision, another policy", async () => {
    // A recorded get_logs answer loses a transfer: the replayed window total differs.
    const hidden = await mainnetProof();
    const asked = hidden.transcript.find((m) => m.direction === "client->server" && JSON.stringify(m.message).includes('"name":"get_logs"'))!;
    const id = (asked.message as { id: number }).id;
    const answer = hidden.transcript.find((m) => m.direction === "server->client" && "id" in m.message && m.message.id === id)!;
    const content = (answer.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
    const logs = JSON.parse(content.text) as unknown[];
    assert.equal(logs.length, 4, "the payer's USDC transfers in the window: three out, one to itself");
    content.text = JSON.stringify(logs.slice(1));
    assert.deepEqual(await failing(hidden), ["result recomputed from the recorded responses"]);
    // The decision is flipped.
    const flipped = await mainnetProof();
    (flipped.result as GateRun).decision.allowed = false;
    assert.deepEqual(await failing(flipped), ["result recomputed from the recorded responses"]);
    // The policy in the input is not the one the run used.
    const swapped = await mainnetProof();
    (swapped.input as { policy: Record<string, unknown> }).policy = treasuryPolicy({ from: "00:00", to: "01:00" });
    assert.deepEqual(await failing(swapped), ["result recomputed from the recorded responses"]);
  });
});
