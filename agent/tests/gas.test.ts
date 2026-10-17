// Task 24, Gas Fee Optimizer: plans and stores checked before anything runs; the fee observed block by
// block and kept across runs, a first run filled in from earlier blocks; the decision against the target
// (wait, send, the deadline, a steady fee, a transaction that would revert); the fee settings capped at
// the target and the costs both ways; sending on Atlantic once; proofs, one run and a history.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Chain } from "../src/core/chain.js";
import { ChainMcp, Recorder } from "../src/core/chain-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS, type Network } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { describeTarget, parseGasPlan, type GasPlan } from "../src/gas/config.js";
import { usdcGasPlan } from "../src/gas/presets.js";
import { percentile, runGasPlan, type GasRun } from "../src/gas/run.js";
import { emptyGasStore, parseGasStore, type GasStore } from "../src/gas/store.js";
import { gasHistoryCheck, verifyGasProof } from "../src/gas/verify.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const lower = (a: string) => a.toLowerCase();
const HEAD = 5_000_000n;
const GWEI = 10n ** 9n;
const gwei = (tenths: number) => (BigInt(tenths) * GWEI) / 10n;
const plan = (extra: Record<string, unknown> = {}) => parseGasPlan({ ...usdcGasPlan(), ...extra });

/** Five earlier blocks, 200 apart, and the head: 1.0, 1.1, 1.4, 0.9, 1.2 gwei, then 1.3 gwei now. */
const FEES: Record<string, bigint> = { [String(HEAD - 1000n)]: gwei(10), [String(HEAD - 800n)]: gwei(11), [String(HEAD - 600n)]: gwei(14), [String(HEAD - 400n)]: gwei(9), [String(HEAD - 200n)]: gwei(12), [String(HEAD)]: gwei(13) };

const mainnet = () => startFakeChain(defaultState({ baseFee: GWEI, baseFees: { ...FEES }, priorityFee: gwei(1), native: { [lower(PAYER)]: 10n ** 18n }, tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(PAYER)]: 1_000_000_000n } } } }));

const NOW = new Date("2026-10-17T12:00:00.000Z");

async function run(fake: FakeChain, store: GasStore, p: GasPlan = plan(), input: unknown = usdcGasPlan()): Promise<{ result: GasRun; proof: ProofFile; calls: { name: string; arguments: Record<string, unknown> }[] }> {
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    const result = await runGasPlan(p, store, { chain: official.chain, now: () => NOW });
    const proof = JSON.parse(JSON.stringify(proofFile({ task: "24", capability: "gas-optimizer", about: "test", mcp: official.mcp, network: NETWORKS["pharos-mainnet"], startedAt: new Date(), input: { plan: input, store }, result }))) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    const calls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);
    return { result, proof, calls };
  } finally {
    await official.close();
  }
}

/** The chain `blocks` on, its head's base fee `fee`. */
const advance = (fake: FakeChain, blocks: bigint, fee: bigint) => {
  fake.state.head += blocks;
  fake.state.headTime += blocks;
  fake.state.baseFees![String(fake.state.head)] = fee;
};

describe("gas plans", () => {
  test("every field is checked before anything touches the chain", () => {
    const base = usdcGasPlan();
    const cases: [unknown, RegExp][] = [
      [{ ...base, colour: "red" }, /unknown field "colour"/],
      [{ ...base, transaction: { kind: "swap" } }, /kind must be one of native-transfer, erc20-transfer, erc20-approve, call/],
      [{ ...base, target: { percentile: 0 } }, /target\.percentile must be a whole number from 1 to 100/],
      [{ ...base, target: { gwei: "0" } }, /target\.gwei must be more than 0/],
      [{ ...base, target: { cheapest: true } }, /target is \{ "percentile": 25 \} or \{ "gwei": "1\.1" \}/],
      [{ ...base, window: 1 }, /window must be a whole number from 2 to 48/],
      [{ ...base, backfill: { samples: 0, spacing: 200 } }, /backfill\.samples must be a whole number from 1 to 11/],
      [{ ...base, deadline: 0 }, /deadline must be a whole number from 1 to 100,000/],
      [{ ...base, network: "ethereum" }, /network must be pharos-mainnet or atlantic-testnet/],
    ];
    for (const [input, error] of cases) assert.throws(() => parseGasPlan(input), (e: unknown) => e instanceof AgentError && e.kind === "usage" && error.test(e.message), JSON.stringify(input).slice(0, 100));
    const p = plan();
    assert.deepEqual([p.target, p.window, p.backfill, p.deadline], [{ kind: "percentile", percentile: 25 }, 12, { samples: 5, spacing: 200 }, 2880]);
    assert.deepEqual([1, 2, 3, 11, 22, 25, 50].map((n) => describeTarget({ kind: "percentile", percentile: n }, 12)), ["the 1st percentile of the last 12 observations", "the 2nd percentile of the last 12 observations", "the 3rd percentile of the last 12 observations", "the 11th percentile of the last 12 observations", "the 22nd percentile of the last 12 observations", "the 25th percentile of the last 12 observations", "the 50th percentile of the last 12 observations"]);
    assert.equal(describeTarget(plan({ target: { gwei: "1.1" } }).target, 12), "1.1 gwei");
    assert.deepEqual([25, 50, 100].map((p) => percentile([1n, 2n, 3n, 4n, 5n, 6n], p)), [2n, 3n, 6n], "nearest rank");
  });

  test("a store belongs to one plan, its observations in block order", () => {
    const p = plan();
    const o = { block: "10", timestamp: NOW.toISOString(), fee: "1", source: "base-fee", gasUsed: "1", gasLimit: "2" };
    assert.throws(() => parseGasStore({ ...emptyGasStore(p), plan: "pharos-mainnet:Other" }, p), /belongs to another plan/);
    assert.throws(() => parseGasStore({ ...emptyGasStore(p), observations: [o, { ...o }] }, p), /in block order, one per block/);
    assert.throws(() => parseGasStore({ ...emptyGasStore(p), observations: [{ ...o, fee: "1.5" }] }, p), /observation 1 needs a block, a time, a fee/);
    assert.throws(() => parseGasStore({ ...emptyGasStore(p), sent: { block: "1", tx: "0x12" } }, p), /sent must be \{ block, tx \} or null/);
  });
});

describe("timing a transaction", () => {
  test("a first run: five earlier blocks read; the fee now is above the cheapest quarter, so wait, with the cap at the target", async () => {
    const fake = await mainnet();
    try {
      const { result, calls } = await run(fake, emptyGasStore(plan()));
      assert.deepEqual(result.window.map((o) => [o.block, o.fee]), Object.entries(FEES).map(([block, fee]) => [block, fee.toString()]));
      const blocks = calls.filter((c) => c.name === "get_block").map((c) => String(c.arguments.block));
      assert.deepEqual(blocks, [HEAD, HEAD - 1000n, HEAD - 800n, HEAD - 600n, HEAD - 400n, HEAD - 200n].map((n) => `0x${n.toString(16)}`).concat("latest"), "the head, the five earlier blocks, and the dry run's latest");
      assert.deepEqual([result.fee.shown.now, result.fee.shown.tip, result.stats.shown.min, result.stats.shown.median, result.stats.shown.max], ["1.3 gwei", "0.1 gwei", "0.9 gwei", "1.1 gwei", "1.4 gwei"]);
      assert.deepEqual([result.target.shown, result.target.how], ["1 gwei", "the 25th percentile of the last 12 observations"]);
      assert.equal(result.decision, "wait");
      assert.equal(result.reason, "The base fee, 1.3 gwei, is above the target, 1 gwei (the 25th percentile of the last 12 observations). Waiting for it would save about 0.00001537 PROS on this transaction.");
      assert.deepEqual(result.settings?.shown, { maxFeePerGas: "1.1 gwei", maxPriorityFeePerGas: "0.1 gwei" }, "a transaction with this cap waits for the target");
      assert.deepEqual(result.costs?.shown, { now: "0.00007172 PROS", atTarget: "0.00005635 PROS", saving: "0.00001537 PROS", standardMax: "0.00016599 PROS", cappedMax: "0.00006762 PROS" });
      assert.deepEqual([result.store.observations.length, result.store.waitingSince, result.store.sent], [6, "5000000", null]);
      assert.equal(result.notSent, "Nothing was signed or sent: on Pharos Mainnet the optimizer only advises.");
      assert.equal(result.headline, "Wait: Send 25 USDC from 0x912c…f647 to 0xB274…9553. The base fee, 1.3 gwei, is above the target, 1 gwei (the 25th percentile of the last 12 observations). Waiting for it would save about 0.00001537 PROS on this transaction.");
    } finally {
      await fake.close();
    }
  });

  test("run to run: the fee comes down to the target, so send, capped at it; the proofs are one history", async () => {
    const fake = await mainnet();
    try {
      const first = await run(fake, emptyGasStore(plan()));
      advance(fake, 10n, 95n * GWEI / 100n);
      const second = await run(fake, first.result.store);
      assert.equal(second.calls.filter((c) => c.name === "get_block").length, 2, "no earlier blocks read once there are observations");
      assert.deepEqual([second.result.observed.length, second.result.window.length], [1, 7]);
      assert.deepEqual([second.result.decision, second.result.target.shown, second.result.reason], ["send", "0.95 gwei", "The base fee, 0.95 gwei, is at or below the target, 0.95 gwei (the 25th percentile of the last 12 observations)."]);
      assert.deepEqual(second.result.settings?.shown, { maxFeePerGas: "1.05 gwei", maxPriorityFeePerGas: "0.1 gwei" });
      assert.equal(second.result.store.waitingSince, null);
      // The same block again: nothing new is observed, and the decision stands.
      const same = await run(fake, second.result.store);
      assert.deepEqual([same.result.observed, same.result.decision], [[], "send"]);
      for (const proof of [first, second, same].map((r) => r.proof)) assert.deepEqual((await verifyGasProof(proof)).filter((c) => !c.ok), []);
      const history = gasHistoryCheck([first, second, same].map((r) => r.proof));
      assert.deepEqual([history.ok, history.detail], [true, "3 runs, each from the store the last one left: wait, send, send"]);
      assert.equal(gasHistoryCheck([first, same].map((r) => r.proof)).ok, false);
    } finally {
      await fake.close();
    }
  });

  test("past the deadline it sends at the fee of the moment; a steady fee is sent at once; the window keeps the newest", async () => {
    const fake = await mainnet();
    try {
      const p = plan({ deadline: 5, window: 6 });
      const first = await run(fake, emptyGasStore(p), p);
      assert.equal(first.result.decision, "wait");
      advance(fake, 10n, gwei(15));
      const late = await run(fake, first.result.store, p);
      assert.deepEqual([late.result.decision, late.result.reason], ["send", "The base fee, 1.5 gwei, is above the target, 1.1 gwei, but the plan has waited 10 blocks, its deadline."], "the target moves with the window");
      assert.deepEqual(late.result.settings?.shown, { maxFeePerGas: "1.6 gwei", maxPriorityFeePerGas: "0.1 gwei" });
      assert.deepEqual(late.result.window.map((o) => o.block), ["4999200", "4999400", "4999600", "4999800", "5000000", "5000010"], "the newest 6");
      fake.state.baseFees = {};
      const steady = await run(fake, emptyGasStore(p), p);
      assert.deepEqual([steady.result.decision, steady.result.reason, steady.result.stats.steady], ["send", "The base fee has held at 1 gwei across 6 observations, so waiting saves nothing.", true]);
      assert.equal(steady.result.costs?.saving, "0");
    } finally {
      await fake.close();
    }
  });

  test("a transaction that would revert is not sent at any fee; a fixed target in gwei", async () => {
    const fake = await mainnet();
    try {
      const p = plan({ transaction: { kind: "erc20-transfer", token: USDC, from: PAYER, to: RECIPIENT, amount: "5000" } });
      const store = { ...emptyGasStore(p), waitingSince: "4999990" };
      const { result } = await run(fake, store, p);
      assert.equal(result.decision, "blocked");
      assert.match(result.reason, /^The transaction would revert: .*\. It is not sent at any fee\.$/);
      assert.deepEqual([result.settings, result.store.waitingSince], [null, "4999990"], "still waiting, nothing to send");
      const fixed = plan({ target: { gwei: "1.35" } });
      const { result: under } = await run(fake, emptyGasStore(fixed), fixed);
      assert.deepEqual([under.decision, under.target.how, under.settings?.shown.maxFeePerGas], ["send", "1.35 gwei", "1.45 gwei"]);
    } finally {
      await fake.close();
    }
  });
});

describe("sending on Atlantic", () => {
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" }); // Hardhat/Anvil public test key #1
  const TUSDC = NETWORKS["atlantic-testnet"].tokens[0]!.address;
  const atlanticPlan = () => ({ name: "Atlantic test", network: "atlantic-testnet", transaction: { kind: "erc20-transfer", token: TUSDC, from: signer.address, to: RECIPIENT, amount: "1" }, target: { percentile: 50 }, window: 6, backfill: { samples: 2, spacing: 10 } });

  test("when the decision is to send it is sent once, with the decided cap; the proof checks the signed fees", async () => {
    const fake = await startFakeChain(defaultState({ chainId: 688689, baseFee: GWEI, baseFees: { [String(HEAD - 20n)]: gwei(12), [String(HEAD - 10n)]: gwei(8) }, priorityFee: gwei(1), native: { [lower(signer.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: { decimals: 6, balances: { [lower(signer.address)]: 5_000_000n } } } }));
    const net: Network = { ...NETWORKS["atlantic-testnet"], rpcUrl: fake.url };
    const p = parseGasPlan(atlanticPlan());
    const once = async (store: GasStore) => {
      const recorder = new Recorder();
      const mcp = await ChainMcp.connect({ kind: "local", network: net, broadcast: true }, { recorder, timeoutMs: 15_000 });
      try {
        const result = await runGasPlan(p, store, { chain: new Chain(mcp, net), signer, wait: { pollMs: 10 }, now: () => NOW });
        return { result, proof: JSON.parse(JSON.stringify(proofFile({ task: "24", capability: "gas-optimizer", about: "test", mcp, network: net, startedAt: new Date(), input: { plan: atlanticPlan(), store }, result }))) as ProofFile };
      } finally {
        await mcp.close();
      }
    };
    try {
      const first = await once(emptyGasStore(p));
      assert.deepEqual([first.result.decision, first.result.target.shown, first.result.settings?.shown.maxFeePerGas], ["send", "1 gwei", "1.1 gwei"], "1 gwei now, the median of 1.2, 0.8 and 1");
      assert.equal(first.result.execution?.matched, true);
      assert.equal(fake.state.tokens[lower(TUSDC)]!.balances[lower(RECIPIENT)], 1_000_000n);
      assert.deepEqual(first.result.store.sent, { block: "5000000", tx: first.result.execution!.txHash });
      const checks = await verifyGasProof(first.proof);
      assert.deepEqual(checks.filter((c) => !c.ok), []);
      assert.equal(checks.find((c) => c.name === "fee settings")?.detail, "signed with a fee cap of 1.1 gwei and a priority fee of 0.1 gwei, as decided");
      // Never twice.
      const again = await once(first.result.store);
      assert.deepEqual([again.result.decision, again.result.execution, again.result.notSent], ["sent", null, "Already sent: nothing was sent again."]);
    } finally {
      await fake.close();
    }
  });

  test("never on mainnet", async () => {
    const fake = await mainnet();
    try {
      const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
      try {
        await assert.rejects(runGasPlan(plan(), emptyGasStore(plan()), { chain: official.chain, signer }), /limited to the Atlantic testnet/);
        assert.equal(official.mcp.toolCalls, 0);
      } finally {
        await official.close();
      }
    } finally {
      await fake.close();
    }
  });
});
