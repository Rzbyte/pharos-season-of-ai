// Task 09, Trend Watcher: watchers checked before anything runs; the trend judged over observations
// kept across runs; a run that fires once per trend; execution on Atlantic; proofs, one run and a history.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Chain } from "../src/core/chain.js";
import { ChainMcp } from "../src/core/chain-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS, type Network } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { parseWatcher, type Trend } from "../src/trend/config.js";
import { outflowWatcher } from "../src/trend/presets.js";
import { judgeTrend, runWatch, type Point, type TrendRun } from "../src/trend/run.js";
import { emptyStore, parseStore, type TrendStore } from "../src/trend/store.js";
import { historyCheck, verifyTrendProof } from "../src/trend/verify.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const lower = (a: string) => a.toLowerCase();
const watcher = () => parseWatcher(outflowWatcher());

const points = (values: number[]): Point[] => values.map((value, i) => ({ block: String(100 + i * 10), timestamp: new Date(1_790_000_000_000 + i * 10_000).toISOString(), raw: String(value), shown: `${value}`, change: null }));
const judge = (trend: Trend, values: number[]) => judgeTrend(trend, points(values), 0, "");

describe("watchers", () => {
  test("every field is checked before anything touches the chain", () => {
    const base = outflowWatcher();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...base, observe: { kind: "has-code", address: PAYER } }, /observe must read a number that can trend/],
      [{ ...base, observe: { kind: "block-age" } }, /observe must read a number that can trend/],
      [{ ...base, trend: { kind: "falling", observations: 1 } }, /trend\.observations must be a whole number from 2 to 20/],
      [{ ...base, trend: { kind: "sideways", observations: 3 } }, /trend\.kind must be falling, rising, change or sustained/],
      [{ ...base, trend: { kind: "change", observations: 3, percent: "5" } }, /trend\.percent must be signed/],
      [{ ...base, trend: { kind: "sustained", observations: 3, op: "==", value: "1" } }, /trend\.op must be one of < <= > >=/],
      [{ ...base, everyBlocks: 0 }, /everyBlocks must be a whole number from 1 to 100,000/],
      [{ ...base, keep: 2 }, /keep must be a whole number from 3 to 200/],
      [{ ...base, action: { kind: "call", from: PAYER, to: RECIPIENT, signature: "ping()" } }, /action must be a transfer or an approval/],
      [{ ...base, colour: "blue" }, /unknown field "colour"/],
    ];
    for (const [input, error] of cases) assert.throws(() => parseWatcher(input), (e: unknown) => e instanceof AgentError && e.kind === "usage" && error.test(e.message), JSON.stringify(input));
    assert.equal(watcher().label, "USDC held by 0x912c…f647");
  });

  test("a store belongs to one watcher's value, in block order", () => {
    const w = watcher();
    const good = { ...emptyStore(w), observations: [{ block: "10", timestamp: "2026-10-17T00:00:00.000Z", raw: "5" }] };
    assert.deepEqual(parseStore(good, w).observations.length, 1);
    const other = parseWatcher(outflowWatcher({ holder: RECIPIENT, trend: "falling", observations: 3, everyBlocks: 10 }));
    assert.throws(() => parseStore(good, other), /observations of something else/);
    assert.throws(() => parseStore({ ...good, observations: [...good.observations, { block: "10", timestamp: "2026-10-17T00:00:10.000Z", raw: "6" }] }, w), /in block order, one per block/);
    assert.throws(() => parseStore({ ...good, schema: "x" }, w), /not a trend store/);
  });
});

describe("judging a trend", () => {
  test("falling and rising: every step across the last N observations", () => {
    assert.deepEqual([judge({ kind: "falling", observations: 3 }, [9, 7, 5]).holds, judge({ kind: "falling", observations: 3 }, [9, 7, 5]).detail], [true, "2 of 2 steps down"]);
    assert.deepEqual([judge({ kind: "falling", observations: 3 }, [9, 9, 5]).holds, judge({ kind: "falling", observations: 3 }, [9, 9, 5]).detail], [false, "1 of 2 steps down"]);
    assert.equal(judge({ kind: "falling", observations: 3 }, [1, 9, 7, 5]).holds, true, "only the last N count");
    assert.deepEqual([judge({ kind: "rising", observations: 2 }, [5]).holds, judge({ kind: "rising", observations: 2 }, [5]).detail], [false, "1 of 2 observations so far"]);
    assert.equal(judge({ kind: "rising", observations: 4 }, [1, 2, 3, 4]).label, "Rose across the last 4 observations");
  });

  test("a change in percent from the first to the last of N, exact", () => {
    const drop = { kind: "change", observations: 3, percent: "-5" } as const;
    assert.deepEqual([judge(drop, [1000, 990, 950]).holds, judge(drop, [1000, 990, 950]).detail], [true, "−5.00 % (needs −5 %)"]);
    assert.deepEqual([judge(drop, [1000, 990, 951]).holds, judge(drop, [1000, 990, 951]).detail], [false, "−4.90 % (needs −5 %)"]);
    assert.equal(judge({ kind: "change", observations: 2, percent: "+10" }, [200, 221]).holds, true);
    assert.deepEqual([judge(drop, [0, 5, 3]).holds, judge(drop, [0, 5, 3]).detail], [false, "starts at 0, so there is no percentage"]);
    assert.equal(judge(drop, [1000, 990, 950]).label, "Fell by at least 5 % over the last 3 observations");
  });

  test("a threshold held in each of the last N, in the value's units", () => {
    const below = { kind: "sustained", observations: 3, op: "<", value: "1.5" } as const;
    const usdc = (values: number[]) => judgeTrend(below, points(values), 6, "USDC");
    assert.deepEqual([usdc([1_400_000, 1_000_000, 1_499_999]).holds, usdc([1_400_000, 1_000_000, 1_499_999]).detail], [true, "3 of 3 observations"]);
    assert.equal(usdc([1_400_000, 1_500_000, 1_000_000]).holds, false);
    assert.equal(usdc([1]).label, "Below 1.5 USDC in each of the last 3 observations");
  });
});

/** A mainnet chain the watcher reads: the payer's USDC balance moves; the example recipient can top it up. */
const mainnet = () =>
  startFakeChain(defaultState({ native: { [lower(PAYER)]: 10n ** 18n, [lower(RECIPIENT)]: 10n ** 18n }, tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(PAYER)]: 1_000_000_000n, [lower(RECIPIENT)]: 600_000_000n } } } }));

/** One run against the official server, like one CLI invocation; its proof is returned with it. */
async function run(fake: FakeChain, store: TrendStore, w = watcher()): Promise<{ result: TrendRun; proof: ProofFile; calls: string[] }> {
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    const result = await runWatch(w, store, { chain: official.chain });
    const proof = JSON.parse(JSON.stringify(proofFile({ task: "09", capability: "trend-watcher", about: "test", mcp: official.mcp, network: NETWORKS["pharos-mainnet"], startedAt: new Date(), input: { watcher: outflowWatcher(), store }, result }))) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    const calls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string } }).params.name);
    return { result, proof, calls };
  } finally {
    await official.close();
  }
}
const advance = (fake: FakeChain, blocks: bigint, usdc?: bigint) => {
  fake.state.head += blocks;
  fake.state.headTime += blocks;
  if (usdc !== undefined) fake.state.tokens[lower(USDC)]!.balances[lower(PAYER)] = usdc;
};

describe("watching across runs", () => {
  test("observations accumulate run by run; the watcher acts once, when a new observation makes the trend, then starts over", async () => {
    const fake = await mainnet();
    try {
      const first = await run(fake, emptyStore(watcher()));
      assert.equal(first.result.outcome, "watching");
      assert.deepEqual([first.result.observation?.shown, first.result.trend.detail], ["1,000 USDC", "1 of 3 observations so far"]);
      assert.deepEqual(first.calls, ["get_chain_info", "get_block_number", "get_block", "eth_call", "eth_call"]);

      advance(fake, 10n, 990_000_000n);
      const second = await run(fake, first.result.store);
      assert.deepEqual([second.result.observation?.change, second.result.trend.detail, second.result.outcome], ["−10 USDC", "2 of 3 observations so far", "watching"]);

      advance(fake, 10n, 975_500_000n);
      const third = await run(fake, second.result.store);
      assert.equal(third.result.outcome, "fired");
      assert.deepEqual([third.result.trend.holds, third.result.trend.detail, third.result.trend.window.map((p) => p.shown)], [true, "2 of 2 steps down", ["1,000 USDC", "990 USDC", "975.5 USDC"]]);
      assert.equal(third.result.action?.summary, "Send 100 USDC from 0xB274…9553 to 0x912c…f647");
      assert.equal(third.result.action?.verdict, "would-succeed");
      assert.equal(third.result.store.actedAt, "5000020");
      assert.match(third.result.headline, /^Fired\. USDC held by 0x912c…f647 is 975\.5 USDC at block 5,000,020\. Fell across the last 3 observations: 2 of 2 steps down\. Would succeed: Send 100 USDC/);

      // The same fall continues, but this trend was acted on: only observations after it count.
      advance(fake, 10n, 960_000_000n);
      const fourth = await run(fake, third.result.store);
      assert.deepEqual([fourth.result.outcome, fourth.result.trend.have, fourth.result.trend.detail], ["watching", 1, "1 of 3 observations so far"]);
      assert.equal(fourth.result.store.observations.length, 4, "the store keeps every observation; acting only moves the start of the next trend");

      // Each run is verified alone, and the four as one history.
      for (const proof of [first, second, third, fourth].map((r) => r.proof)) assert.deepEqual((await verifyTrendProof(proof)).filter((c) => !c.ok), []);
      const history = historyCheck([first, second, third, fourth].map((r) => r.proof));
      assert.deepEqual([history.ok, history.detail], [true, "4 runs, each from the store the last one left; 4 observations kept"]);
      assert.equal(historyCheck([first, third, second].map((r) => r.proof)).ok, false, "out of order");
      assert.equal(historyCheck([first, third].map((r) => r.proof)).ok, false, "a run is missing");
    } finally {
      await fake.close();
    }
  });

  test("too soon: no read, nothing recorded, no action; the stored values are still judged", async () => {
    const fake = await mainnet();
    try {
      const first = await run(fake, emptyStore(watcher()));
      advance(fake, 9n, 1n);
      const soon = await run(fake, first.result.store);
      assert.equal(soon.result.observation, null);
      assert.equal(soon.result.skipped, "The last observation is 9 blocks old; this watcher records one every 10 blocks.");
      assert.deepEqual(soon.calls, ["get_chain_info", "get_block_number", "get_block"], "nothing read: the official decimals show the stored values");
      assert.deepEqual(soon.result.store, first.result.store);
      const same = await run(fake, soon.result.store, parseWatcher({ ...outflowWatcher(), everyBlocks: 1 }));
      assert.equal(same.result.observation?.block, "5000009");
      const again = await run(fake, same.result.store, parseWatcher({ ...outflowWatcher(), everyBlocks: 1 }));
      assert.equal(again.result.skipped, "Block 5,000,009 is not after the last observation (block 5,000,009).");
    } finally {
      await fake.close();
    }
  });

  test("a failed read stops the run: nothing is judged or recorded on stale values", async () => {
    const fake = await mainnet();
    try {
      fake.state.failures.eth_call = { code: -32000, message: "header not found" };
      await assert.rejects(run(fake, emptyStore(watcher())), /header not found/);
    } finally {
      await fake.close();
    }
  });

  test("a changed answer in a proof, or a changed store, fails its replay", async () => {
    const fake = await mainnet();
    try {
      const first = await run(fake, emptyStore(watcher()));
      advance(fake, 10n, 990_000_000n);
      const { proof } = await run(fake, first.result.store);
      const store = (proof.input as { store: TrendStore }).store;
      store.observations[0]!.raw = "980000000";
      const checks = await verifyTrendProof(proof);
      assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.name), ["result recomputed from the recorded responses"]);
    } finally {
      await fake.close();
    }
  });
});

describe("executing on Atlantic", () => {
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" }); // Hardhat/Anvil public test key #1
  const TUSDC = NETWORKS["atlantic-testnet"].tokens[0]!.address;
  const atlanticWatcher = () =>
    parseWatcher({ name: "Atlantic test", network: "atlantic-testnet", observe: { kind: "native-balance", address: RECIPIENT }, everyBlocks: 1, trend: { kind: "falling", observations: 2 }, action: { kind: "erc20-transfer", token: TUSDC, from: signer.address, to: RECIPIENT, amount: "1" } });

  test("a trend that holds sends the action through Chain MCP, and the receipt matches the dry run", async () => {
    const fake = await startFakeChain(defaultState({ chainId: 688689, native: { [lower(signer.address)]: 10n ** 18n, [lower(RECIPIENT)]: 5n * 10n ** 17n }, tokens: { [lower(TUSDC)]: { decimals: 6, balances: { [lower(signer.address)]: 5_000_000n } } } }));
    const net: Network = { ...NETWORKS["atlantic-testnet"], rpcUrl: fake.url };
    try {
      const once = async (store: TrendStore) => {
        const mcp = await ChainMcp.connect({ kind: "local", network: net, broadcast: true }, { timeoutMs: 15_000 });
        try {
          return await runWatch(atlanticWatcher(), store, { chain: new Chain(mcp, net), signer, wait: { pollMs: 10 } });
        } finally {
          await mcp.close();
        }
      };
      const first = await once(emptyStore(atlanticWatcher()));
      assert.equal(first.outcome, "watching");
      advance(fake, 1n);
      fake.state.native[lower(RECIPIENT)] = 4n * 10n ** 17n;
      const second = await once(first.store);
      assert.equal(second.outcome, "executed");
      assert.equal(second.execution?.matched, true);
      assert.equal(fake.state.tokens[lower(TUSDC)]!.balances[lower(RECIPIENT)], 1_000_000n);
    } finally {
      await fake.close();
    }
  });

  test("never on mainnet", async () => {
    const fake = await mainnet();
    try {
      const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
      try {
        await assert.rejects(runWatch(watcher(), emptyStore(watcher()), { chain: official.chain, signer }), /limited to the Atlantic testnet/);
        assert.equal(official.mcp.toolCalls, 0);
      } finally {
        await official.close();
      }
    } finally {
      await fake.close();
    }
  });
});
