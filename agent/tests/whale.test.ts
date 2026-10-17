// Task 23, Whale-Watching Agent: watchlists and stores checked before anything runs; each address read
// at one block; transfers by tracked addresses found with two get_logs queries a page, each once;
// significant moves surfaced (a transfer of the minimum or more, a native balance change of the minimum
// or more between runs) and the rest summed up; proofs, one run and a history.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentError } from "../src/core/errors.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { parseWatchlist } from "../src/whale/config.js";
import { SAMPLE_ADDRESSES, usdcWhales } from "../src/whale/presets.js";
import { runWhales, type WhaleRun } from "../src/whale/run.js";
import { emptyWhaleStore, parseWhaleStore, type WhaleStore } from "../src/whale/store.js";
import { verifyWhaleProof, whaleHistoryCheck } from "../src/whale/verify.js";
import { defaultState, startFakeChain, type FakeChain, type FakeTransfer } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const WETH = "0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9";
const [BUSIEST, SENDER, TRADER, LARGEST] = SAMPLE_ADDRESSES.map((a) => a.address);
const OTHER = "0x1111111111111111111111111111111111111111";
const lower = (a: string) => a.toLowerCase();
const HEAD = 5_000_000n;
const PROS = 10n ** 18n;
const list = () => parseWatchlist(usdcWhales());

/** In the first run's 1,000 blocks: what is significant, what is only counted, and what is not theirs. */
const HISTORY: FakeTransfer[] = [
  { token: USDC, from: OTHER, to: BUSIEST!, amount: 100_000_000n, block: HEAD - 900n }, // counted, under 250
  { token: USDC, from: SENDER!, to: BUSIEST!, amount: 310_560_000n, block: HEAD - 800n }, // between two tracked: once, the sender's
  { token: USDC, from: BUSIEST!, to: OTHER, amount: 600_000_000n, block: HEAD - 10n }, // significant, out
  { token: USDC, from: BUSIEST!, to: BUSIEST!, amount: 5_000_000_000n, block: HEAD - 9n }, // to itself: counted, nothing moved
  { token: USDC, from: LARGEST!, to: OTHER, amount: 0n, block: HEAD - 8n }, // nothing moved: never significant
  { token: USDC, from: OTHER, to: OTHER, amount: 9_000_000_000n, block: HEAD - 7n }, // not theirs
  { token: USDC, from: OTHER, to: TRADER!, amount: 900_000_000n, block: HEAD - 1000n }, // before the lookback
  { token: WETH, from: OTHER, to: BUSIEST!, amount: 10n ** 21n, block: HEAD - 5n }, // a token not tracked
];

const mainnet = (transfers: FakeTransfer[] = structuredClone(HISTORY)) =>
  startFakeChain(
    defaultState({
      native: { [lower(BUSIEST!)]: 500n * PROS, [lower(SENDER!)]: 2n * PROS },
      nonces: { [lower(BUSIEST!)]: 1_200n },
      code: { [lower(TRADER!)]: "0x6080604052" },
      tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(BUSIEST!)]: 1_234_560_000n, [lower(SENDER!)]: 50_000_000n, [lower(TRADER!)]: 98_765_430_000n } }, [lower(WETH)]: { decimals: 18, balances: {} } },
      transfers,
    }),
  );

const NOW = new Date("2026-10-17T12:00:00.000Z");

async function run(fake: FakeChain, store: WhaleStore): Promise<{ result: WhaleRun; proof: ProofFile; calls: { name: string; arguments: Record<string, unknown> }[] }> {
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    const result = await runWhales(list(), store, { chain: official.chain, now: () => NOW });
    const proof = JSON.parse(JSON.stringify(proofFile({ task: "23", capability: "whale-watcher", about: "test", mcp: official.mcp, network: NETWORKS["pharos-mainnet"], startedAt: new Date(), input: { watchlist: usdcWhales(), store }, result }))) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    const calls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);
    return { result, proof, calls };
  } finally {
    await official.close();
  }
}

describe("watchlists", () => {
  test("every field is checked before anything touches the chain", () => {
    const base = usdcWhales() as Record<string, unknown>;
    const with_ = (extra: Record<string, unknown>) => ({ ...base, ...extra });
    const cases: [unknown, RegExp][] = [
      [with_({ addresses: [] }), /addresses must list 1 to 10 addresses/],
      [with_({ addresses: Array.from({ length: 11 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`) }), /addresses must list 1 to 10 addresses/],
      [with_({ addresses: ["0x12"] }), /addresses\[0\] must be a 0x address/],
      [with_({ addresses: [BUSIEST, lower(BUSIEST!)] }), /is listed twice/],
      [with_({ tokens: [{ token: OTHER, min: "1" }] }), /is not on Pharos Mainnet's official token list \(WPROS, USDC, LINK, WETH\)/],
      [with_({ tokens: [{ token: USDC, min: "1.1234567" }] }), /more than 6 decimal places/],
      [with_({ tokens: [{ token: USDC }, { token: lower(USDC) }] }), /A token is listed twice/],
      [with_({ native: { min: "-1" } }), /native\.min must be a plain non-negative number/],
      [with_({ native: { at: "1" } }), /native is \{ "min": "<amount>" \} or null/],
      [with_({ lookback: 0 }), /lookback must be a whole number of blocks from 1 to 2,000/],
      [with_({ colour: "blue" }), /unknown field "colour"/],
    ];
    for (const [input, error] of cases) assert.throws(() => parseWatchlist(input), (e: unknown) => e instanceof AgentError && e.kind === "usage" && error.test(e.message), JSON.stringify(input).slice(0, 120));
    const parsed = list();
    assert.deepEqual(parsed.addresses.map((a) => a.label), ["Busiest in the sample", "Sent the most", "Trades with the busiest", "Sent the largest transfer"]);
    assert.deepEqual(parsed.tokens, [{ token: USDC, symbol: "USDC", decimals: 6, min: "250" }]);
    assert.deepEqual([parsed.native, parsed.lookback, parsed.maxScan], [{ min: "100" }, 1000, 2000]);
    assert.equal(parseWatchlist({ name: "n", addresses: [lower(BUSIEST!)] }).addresses[0]!.label, "0x912c…f647", "an address with no label is shown short");
  });

  test("a store belongs to one watchlist; addresses and tokens no longer tracked are dropped", () => {
    const l = list();
    const snap = { block: "10", native: "1", nonce: "2", contract: false, tokens: { [lower(USDC)]: "5", [lower(WETH)]: "7" } };
    const store = { ...emptyWhaleStore(l), cursor: "10", snapshots: { [lower(BUSIEST!)]: snap, [lower(OTHER)]: snap } };
    assert.deepEqual(parseWhaleStore(store, l).snapshots, { [lower(BUSIEST!)]: { ...snap, tokens: { [lower(USDC)]: "5" } } });
    assert.throws(() => parseWhaleStore({ ...store, watchlist: "pharos-mainnet:Other" }, l), /belongs to another watchlist/);
    assert.throws(() => parseWhaleStore({ ...store, snapshots: { [lower(BUSIEST!)]: { ...snap, native: "-1" } } }, l), /needs a native balance and a nonce, as whole numbers/);
    assert.throws(() => parseWhaleStore({ ...store, snapshots: { [lower(BUSIEST!)]: { ...snap, contract: "no" } } }, l), /must say whether it is a contract/);
  });
});

describe("watching whales", () => {
  test("a first run: every address at the pinned block, the last 1,000 blocks scanned with two queries, the significant moves surfaced", async () => {
    const fake = await mainnet();
    try {
      const { result, calls } = await run(fake, emptyWhaleStore(list()));
      assert.deepEqual(result.scanned, { from: "4999001", to: "5000000", pages: 2 });
      assert.equal(result.transfers, 5, "every transfer by a tracked address in the blocks scanned, to itself and of nothing included");
      assert.deepEqual(result.events.map((e) => [e.kind, e.address, e.direction, e.counterpartyLabel, e.message]), [
        ["transfer", SENDER, "out", "Busiest in the sample", "Sent the most sent 310.56 USDC to Busiest in the sample at block 4,999,200"],
        ["transfer", BUSIEST, "out", null, "Busiest in the sample sent 600 USDC to 0x1111…1111 at block 4,999,990"],
      ]);
      const busiest = result.addresses[0]!;
      assert.deepEqual([busiest.contract, busiest.native.shown, busiest.native.change, busiest.nonce, busiest.sent, busiest.since, busiest.significant], [false, "500 PROS", null, "1200", null, null, 1]);
      assert.deepEqual(busiest.tokens.map((t) => [t.shown, t.change, t.in.count, t.in.shown, t.out.count, t.out.shown]), [["1,234.56 USDC", null, 2, "410.56 USDC", 1, "600 USDC"]]);
      assert.deepEqual(result.addresses.map((a) => [a.label, a.contract, a.tokens[0]!.shown, a.significant]), [
        ["Busiest in the sample", false, "1,234.56 USDC", 1],
        ["Sent the most", false, "50 USDC", 1],
        ["Trades with the busiest", true, "98,765.43 USDC", 0],
        ["Sent the largest transfer", false, "0 USDC", 0],
      ]);
      assert.deepEqual(result.store.snapshots[lower(TRADER!)], { block: "5000000", native: "0", nonce: "0", contract: true, tokens: { [lower(USDC)]: "98765430000" } });
      assert.equal(result.store.cursor, "5000000");
      assert.equal(result.headline, "2 significant moves at block 5,000,000: Sent the most sent 310.56 USDC to Busiest in the sample at block 4,999,200 …");
      // Two get_logs calls a page, whatever the number of addresses: sent by any of them, received by any.
      const logs = calls.filter((c) => c.name === "get_logs").map((c) => c.arguments.topics as unknown[]);
      const tracked = SAMPLE_ADDRESSES.map((a) => `0x${"0".repeat(24)}${lower(a.address).slice(2)}`);
      assert.deepEqual(logs, [["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", tracked], ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null, tracked]]);
      assert.deepEqual(calls.filter((c) => c.name === "get_code").length, 4, "code is read the first time an address is seen");
    } finally {
      await fake.close();
    }
  });

  test("run to run: what changed since the last run, transactions sent, a native balance change surfaced once; the proofs are one history", async () => {
    const fake = await mainnet();
    try {
      const first = await run(fake, emptyWhaleStore(list()));
      fake.state.head += 10n;
      fake.state.headTime += 10n;
      fake.state.native[lower(BUSIEST!)] = 350n * PROS; // −150 PROS: significant
      fake.state.native[lower(SENDER!)] = 3n * PROS; // +1 PROS: under 100
      fake.state.nonces[lower(BUSIEST!)] = 1_202n;
      fake.state.transfers.push({ token: USDC, from: TRADER!, to: OTHER, amount: 250_000_000n, block: HEAD + 3n }); // exactly the minimum
      fake.state.tokens[lower(USDC)]!.balances[lower(TRADER!)] = 98_515_430_000n;
      const second = await run(fake, first.result.store);
      assert.deepEqual(second.result.scanned, { from: "5000001", to: "5000010", pages: 2 });
      assert.deepEqual(second.result.events.map((e) => [e.kind, e.direction, e.message]), [
        ["transfer", "out", "Trades with the busiest sent 250 USDC to 0x1111…1111 at block 5,000,003"],
        ["native", "out", "Busiest in the sample's PROS balance fell by 150 PROS since block 5,000,000, to 350 PROS"],
      ]);
      const [busiest, sender, trader] = second.result.addresses;
      assert.deepEqual([busiest!.native.changeShown, busiest!.sent, busiest!.since], ["−150 PROS", 2, "5000000"]);
      assert.deepEqual([sender!.native.changeShown, sender!.sent], ["+1 PROS", 0]);
      assert.deepEqual([trader!.tokens[0]!.changeShown, trader!.tokens[0]!.out.count], ["−250 USDC", 1]);
      assert.equal(second.calls.filter((c) => c.name === "get_code").length, 0, "known addresses are not read for code again");
      // The same block again: nothing new, and the balance change is not surfaced twice.
      const same = await run(fake, second.result.store);
      assert.deepEqual([same.result.scanned, same.result.events, same.result.headline], [null, [], "No significant moves at block 5,000,010; no new blocks."]);
      assert.equal(same.result.addresses[0]!.native.changeShown, "±0 PROS");
      for (const proof of [first, second, same].map((r) => r.proof)) assert.deepEqual((await verifyWhaleProof(proof)).filter((c) => !c.ok), []);
      const history = whaleHistoryCheck([first, second, same].map((r) => r.proof));
      assert.deepEqual([history.ok, history.detail], [true, "3 runs, each from the store the last one left; 4 significant moves in all"]);
      assert.equal(whaleHistoryCheck([first, same].map((r) => r.proof)).detail, "run 2 did not start from the store run 1 left");
    } finally {
      await fake.close();
    }
  });

  test("far behind: the newest 2,000 blocks scanned, two queries a page; a snapshot from a later block is kept, not compared", async () => {
    const fake = await mainnet([{ token: USDC, from: BUSIEST!, to: OTHER, amount: 700_000_000n, block: HEAD - 1500n }]);
    try {
      const l = list();
      const ahead = { block: "5000005", native: "1", nonce: "1", contract: false, tokens: { [lower(USDC)]: "1" } };
      const store = { ...emptyWhaleStore(l), cursor: (HEAD - 5000n).toString(), snapshots: { [lower(BUSIEST!)]: ahead } };
      const { result, calls } = await run(fake, store);
      assert.deepEqual(result.skipped, { from: "4995001", to: "4998000" });
      assert.deepEqual(result.scanned, { from: "4998001", to: "5000000", pages: 4 });
      assert.deepEqual(calls.filter((c) => c.name === "get_logs").map((c) => [BigInt(String(c.arguments.fromBlock)), BigInt(String(c.arguments.toBlock))]), [[HEAD - 1999n, HEAD - 1000n], [HEAD - 1999n, HEAD - 1000n], [HEAD - 999n, HEAD], [HEAD - 999n, HEAD]]);
      assert.equal(result.events[0]!.block, "4998500");
      const busiest = result.addresses[0]!;
      assert.deepEqual([busiest.native.change, busiest.sent, busiest.since], [null, null, null], "nothing is compared with a later block");
      assert.deepEqual(result.store.snapshots[lower(BUSIEST!)], ahead, "and the later snapshot is kept");
    } finally {
      await fake.close();
    }
  });

  test("a changed balance in a proof fails its replay", async () => {
    const fake = await mainnet();
    try {
      const { proof } = await run(fake, emptyWhaleStore(list()));
      const asked = proof.transcript.find((m) => m.direction === "client->server" && JSON.stringify(m.message).includes('"name":"get_balance"'))!;
      const id = (asked.message as { id: number }).id;
      const answer = proof.transcript.find((m) => m.direction === "server->client" && "id" in m.message && m.message.id === id)!;
      const content = (answer.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
      assert.match(content.text, /"balanceWei":\s*"500000000000000000000"/);
      content.text = content.text.replace(/"balanceWei":\s*"\d+"/, '"balanceWei": "1"');
      assert.deepEqual((await verifyWhaleProof(proof)).filter((c) => !c.ok).map((c) => c.name), ["result recomputed from the recorded responses"]);
    } finally {
      await fake.close();
    }
  });
});
