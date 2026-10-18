// Task 10, Batch Executor: a batch read from its lines (every line, or a refusal that says which), then
// planned through the official Chain MCP server on a fake chain: sends merged, independence shown or the
// batch refused, each transaction dry-run at one block with the reads they share made once, the savings
// counted, one nonce sequence and one fee quote; on Atlantic, with a key, sent back to back and compared.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getAddress } from "viem";
import { EXAMPLE } from "../src/builder/action.js";
import { Chain } from "../src/core/chain.js";
import { ChainMcp } from "../src/core/chain-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { EXAMPLE_BATCH, readBatch } from "../src/batch/read.js";
import { runBatch, type BatchOptions, type BatchRun } from "../src/batch/run.js";
import { verifyBatchProof } from "../src/batch/verify.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const net = NETWORKS["pharos-mainnet"];
const atlantic = NETWORKS["atlantic-testnet"];
const token = (n: typeof net, symbol: string) => getAddress(n.tokens.find((t) => t.symbol === symbol)!.address);
const USDC = token(net, "USDC");
const WPROS = token(net, "WPROS");
const lower = (address: string) => address.toLowerCase();
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const STAFF = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const SPENDER = "0x3333333333333333333333333333333333333333";
const NOW = new Date("2026-10-18T12:00:00.000Z");

describe("reading a batch", () => {
  const read = (text: string) => readBatch(text, net);
  const brief = (text: string) => read(text).map((a) => [a.line, a.kind, a.asset, a.to, a.amount, a.note]);

  test("one action a line: sends of a token or PROS, approvals (max too), revokes, wraps; notes, blank lines and comments", () => {
    assert.deepEqual(brief(`# March\nsend 25 USDC to ${RECIPIENT} # rent\n\nSEND 0.01 pros to ${STAFF}\npay 1,250.5 USDC to ${lower(STAFF)}\napprove 100 USDC for ${SPENDER}\napprove max WETH for ${SPENDER}\nrevoke LINK from ${SPENDER}\nwrap 0.5 PROS`), [
      [2, "send", "USDC", RECIPIENT, "25", "rent"],
      [4, "send", "PROS", STAFF, "0.01", null],
      [5, "send", "USDC", STAFF, "1250.5", null],
      [6, "approve", "USDC", SPENDER, "100", null],
      [7, "approve", "WETH", SPENDER, "max", null],
      [8, "approve", "LINK", SPENDER, "0", null],
      [9, "wrap", "PROS", null, "0.5", null],
    ]);
    const [send, , , , unlimited, , wrap] = read(`send 25 USDC to ${RECIPIENT}\nsend 1 PROS to ${STAFF}\nsend 1 USDC to ${STAFF}\napprove 1 USDC for ${SPENDER}\napprove unlimited USDC for ${STAFF}\nrevoke USDC for ${STAFF}\nwrap 2 PROS`);
    assert.deepEqual([send!.raw, send!.token?.address, unlimited!.raw, wrap!.token?.symbol, wrap!.raw], ["25000000", USDC, (2n ** 256n - 1n).toString(), "WPROS", "2000000000000000000"]);
    assert.equal(readBatch(EXAMPLE_BATCH, net).length, 4);
    assert.equal(readBatch("wrap 1 PHRS", atlantic)[0]!.token?.symbol, "WPHRS");
  });

  test("refused, saying which line and why", () => {
    const refuses = (text: string, pattern: RegExp, max?: number) => assert.throws(() => readBatch(text, net, max), (e: unknown) => e instanceof AgentError && e.kind === "usage" && pattern.test(e.message), text);
    refuses(`send 25 USDC to ${RECIPIENT}\nswap 1 USDC for WETH`, /^Line 2 starts with "swap": a batch takes send, approve, revoke and wrap, one a line/);
    refuses(`send 5 PEPE to ${RECIPIENT}`, /^Line 1: PEPE is not PROS or an official token on Pharos Mainnet \(WPROS, USDC, LINK, WETH\)\.$/);
    refuses(`approve 5 PROS for ${SPENDER}`, /^Line 1: PROS is the native token: it is sent, never approved\.$/);
    refuses("wrap 1 USDC", /^Line 1: a wrap takes the native token, like "wrap 0\.5 PROS"\.$/);
    refuses(`send 0 USDC to ${RECIPIENT}`, /^Line 1: the amount must be more than zero\.$/);
    refuses(`send 1.0000001 USDC to ${RECIPIENT}`, /^Line 1: the amount has more than 6 decimal places/);
    refuses(`send 1 USDC to 0xb2749BD12f19C24a2244176658F3dF3e48e79553`, /^Line 1: 0xb2749BD12f19C24a2244176658F3dF3e48e79553 fails its checksum/);
    refuses(`send 1 USDC ${RECIPIENT}`, /^Line 1 cannot be read: "send 1 USDC 0x[0-9a-fA-F]{40}"\. It looks like "send 25 USDC to 0x…"\.$/);
    refuses(`approve USDC for ${SPENDER}`, /It looks like "approve 100 USDC for 0x… \(or max\)"/);
    refuses("  \n ", /^The batch is empty/);
    refuses("# only a note", /^The batch has only notes/);
    refuses(Array.from({ length: 3 }, () => `send 1 USDC to ${RECIPIENT}`).join("\n"), /^A batch is at most 2 actions here; this one has 3\.$/, 2);
    refuses("#".repeat(4001), /^A batch is at most 4,000 characters\.$/);
  });
});

describe("planning a batch on Pharos Mainnet", () => {
  let fake: FakeChain;
  const sender = lower(EXAMPLE.account);
  before(async () => {
    fake = await startFakeChain(defaultState({ native: { [sender]: 10n ** 18n }, nonces: { [sender]: 41n }, tokens: { [lower(USDC)]: { decimals: 6, balances: { [sender]: 100_000_000n } }, [lower(WPROS)]: { decimals: 18, wrapsNative: true, balances: {} } } }));
  });
  after(() => fake.close());

  async function plan(text: string, options: Partial<BatchOptions> = {}): Promise<{ run: BatchRun; proof: ProofFile }> {
    const official = await connectOfficial(fake, net, { budget: 80 });
    try {
      const run = await runBatch(text, { chain: official.chain, now: () => NOW, ...options });
      const input = { batch: text, ...(options.from ? { from: options.from } : {}), merge: options.merge !== false };
      const proof = JSON.parse(JSON.stringify(proofFile({ task: "10", capability: "batch-executor", about: "test", mcp: official.mcp, network: net, startedAt: new Date(), input, result: run }))) as ProofFile;
      proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
      return { run, proof };
    } finally {
      await official.close();
    }
  }

  test("the example: two sends to one address merged, independence shown, one nonce sequence and one fee quote, the shared reads counted; the proof verifies", async () => {
    const { run, proof } = await plan(EXAMPLE_BATCH);
    assert.deepEqual([run.verdict, run.sender, run.nonce, run.merge], ["ready", { address: EXAMPLE.account, from: "example" }, 41, true]);
    assert.deepEqual(run.merged, [{ lines: [1, 3], into: 1, what: "Send 30 USDC to 0xB274…9553" }]);
    assert.deepEqual(run.txs.map((t) => [t.n, t.lines, t.summary, t.notes, t.state, t.dryRun.verdict, t.tx?.nonce]), [
      [1, [1, 3], "Send 30 USDC to 0xB274…9553", ["rent", "utilities"], "planned", "would-succeed", 41],
      [2, [2], "Send 10 USDC to 0x1F35…c85C", ["payroll"], "planned", "would-succeed", 42],
      [3, [4], "Send 0.01 PROS to 0x1F35…c85C", ["gas money"], "planned", "would-succeed", 43],
    ]);
    assert.deepEqual(new Set(run.txs.map((t) => `${t.tx!.maxFeePerGas}/${t.tx!.maxPriorityFeePerGas}`)).size, 1, "one fee quote for all");
    assert.deepEqual(run.txs.map((t) => [t.tx!.to, t.tx!.value]), [[USDC, "0"], [USDC, "0"], [STAFF, "10000000000000000"]]);
    assert.deepEqual(run.independence.map((c) => [c.what, c.ok]), [["One sender", true], ["Alone at the block", true], ["USDC", true], ["PROS", true]]);
    assert.equal(run.independence[2]!.detail, "The 2 sends take 40 USDC in all; 0x912c…f647 holds 100 USDC, enough in any order.");
    assert.match(run.independence[3]!.detail, /^The batch takes 0\.01 PROS sent or wrapped and up to [\d.]+ PROS of gas; 0x912c…f647 holds 1 PROS, enough in any order\.$/);
    // Measured: the plan's own calls (the chain, the block, the nonce, then what no dry run had asked
    // before), against what the three dry runs ask when each runs alone, as Task 08 runs it.
    assert.deepEqual(run.savings, { calls: 21, oneByOne: 36, lines: 4, transactions: 3, merged: 1, leftOut: 0 });
    assert.equal(run.toolCalls, 21);
    assert.match(run.headline, /^Ready: 4 actions in 3 transactions \(lines 1 and 3 merged\), independent, each dry-run at block 5,000,000, in one nonce sequence for about [\d.]+ PROS of gas\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.deepEqual(run.steps.map((s) => s.source), ["the batch", "the plan", "Chain MCP · get_transaction_count", "Chain MCP · eth_call · estimate_gas", "Chain MCP · eth_call · estimate_gas", "Chain MCP · eth_call · estimate_gas", "the independence check", "the independence check", "the independence check", "the independence check", "the plan", "the savings", "the verdict"]);
    assert.equal(run.steps[1]!.text, "Lines 1 and 3 merged into one transaction: Send 30 USDC to 0xB274…9553, 1 transaction fewer.");
    assert.equal(run.steps.at(-2)!.text, "21 Chain MCP calls for the whole plan; the same 3 dry runs, each run on its own as Task 08 runs it, ask 36. 1 transaction fewer by merging.");
    const checks = await verifyBatchProof(proof);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.equal(checks.find((c) => c.name === "calls counted")!.detail, "21 calls before any send, as the result counts them; its dry runs, one by one, ask 36");
  });

  test("--no-merge keeps every send its own transaction; a changed recorded answer fails the proof", async () => {
    const { run, proof } = await plan(EXAMPLE_BATCH, { merge: false });
    assert.deepEqual([run.verdict, run.txs.length, run.merged, run.savings.merged, run.txs.map((t) => t.tx?.nonce)], ["ready", 4, [], 0, [41, 42, 43, 44]]);
    assert.deepEqual((await verifyBatchProof(proof)).filter((c) => !c.ok), []);
    const forged = JSON.parse(JSON.stringify(proof)) as ProofFile;
    const nonceReply = forged.transcript.find((m) => m.direction === "server->client" && JSON.stringify(m.message).includes('\\"nonce\\"'));
    const content = (nonceReply!.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
    content.text = content.text.replace("41", "7");
    assert.deepEqual((await verifyBatchProof(forged)).filter((c) => !c.ok).map((c) => c.name), ["batch recomputed from the recorded responses"]);
  });

  test("one that would revert alone is left out, the rest still go; every one failing; a batch the balance cannot cover in any order", async () => {
    const partial = (await plan(`send 25 USDC to ${RECIPIENT}\nsend 500 USDC to ${STAFF}\nsend 0.01 PROS to ${STAFF}`)).run;
    assert.deepEqual([partial.verdict, partial.txs.map((t) => [t.state, t.tx?.nonce ?? null])], ["partial", [["planned", 41], ["left-out", null], ["planned", 42]]]);
    assert.equal(partial.txs[1]!.reason, "It reverts: ERC20: transfer amount exceeds balance.");
    assert.match(partial.headline, /^Ready, 2 of 3: line 2 left out \(it reverts: ERC20: transfer amount exceeds balance\); the others do not depend on it\. 2 transactions in one nonce sequence/);
    assert.equal(partial.independence[1]!.detail, "2 transactions would go through on their own; transaction 2 (line 2) would revert, so it is left out, and the others do not depend on it.");
    assert.equal(partial.savings.leftOut, 1);
    const fail = (await plan(`send 500 USDC to ${RECIPIENT}`)).run;
    assert.deepEqual([fail.verdict, fail.txs[0]!.tx, fail.fees], ["would-fail", null, null]);
    assert.match(fail.headline, /^Nothing to send: the action would revert on its own\. Line 1 left out \(it reverts: ERC20: transfer amount exceeds balance\)\. Nothing was sent/);
    const short = (await plan(`send 60 USDC to ${RECIPIENT}\nsend 60 USDC to ${STAFF}`)).run;
    assert.deepEqual([short.verdict, short.txs.map((t) => [t.dryRun.verdict, t.tx])], ["short", [["would-succeed", null], ["would-succeed", null]]]);
    assert.match(short.headline, /^Short: The 2 sends take 120 USDC in all, but 0x912c…f647 holds 100 USDC: 20 USDC short\. Nothing was sent/);
  });

  test("not independent: two approvals of one allowance (refused before any dry run), a send that needs the wrap first", async () => {
    const twice = (await plan(`approve 100 USDC for ${SPENDER}\nsend 1 USDC to ${RECIPIENT}\nrevoke USDC for ${SPENDER}`)).run;
    assert.deepEqual([twice.verdict, twice.txs, twice.nonce, twice.toolCalls], ["dependent", [], null, 3]);
    assert.equal(twice.headline, "Not a batch: lines 1 and 3 both set 0x3333…3333's USDC allowance, so the one sent last wins and their order matters. A batch takes actions whose order does not matter: keep one of them. Nothing was sent: the hosted Chain MCP is read-only.");
    const { run: wrap, proof } = await plan(`wrap 0.5 PROS\nsend 0.5 WPROS to ${RECIPIENT}`);
    assert.deepEqual([wrap.verdict, wrap.txs.map((t) => [t.summary, t.state])], ["dependent", [["Wrap 0.5 PROS into WPROS", "planned"], ["Send 0.5 WPROS to 0xB274…9553", "dependent"]]]);
    assert.equal(wrap.txs[1]!.reason, "It needs line 1 first: 0x912c…f647 holds 0 WPROS, and the rest comes from the wrap.");
    assert.match(wrap.headline, /^Not a batch: transaction 2 \(line 2\) depends on the order\. It needs line 1 first: .* A batch takes actions whose order does not matter: send these one after the other instead\./);
    assert.deepEqual((await verifyBatchProof(proof)).filter((c) => !c.ok), []);
    // Holding the WPROS already, the same two lines are independent.
    fake.state.tokens[lower(WPROS)]!.balances[sender] = 10n ** 18n;
    try {
      const held = (await plan(`wrap 0.5 PROS\nsend 0.5 WPROS to ${RECIPIENT}`)).run;
      assert.deepEqual([held.verdict, held.independence.map((c) => [c.what, c.ok])], ["ready", [["One sender", true], ["Alone at the block", true], ["WPROS", true], ["PROS", true]]]);
    } finally {
      delete fake.state.tokens[lower(WPROS)]!.balances[sender];
    }
  });

  test("refused before anything is asked: a send to the sender itself; on Atlantic, a sender is needed", async () => {
    const official = await connectOfficial(fake, net);
    try {
      await assert.rejects(runBatch(`send 1 USDC to ${EXAMPLE.account}`, { chain: official.chain }), /Line 1 sends to the sender itself \(0x912c…f647\): nothing would move but its gas\./);
      await assert.rejects(runBatch(`send 1 USDC to ${RECIPIENT}`, { chain: new Chain(official.mcp, atlantic) }), /Name the sender with --from/);
      assert.equal(official.mcp.toolCalls, 0);
    } finally {
      await official.close();
    }
  });
});

describe("sending a batch on Atlantic", () => {
  // The well-known Hardhat/Anvil test key #1: public, only ever used here on a fake chain.
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
  const TUSDC = token(atlantic, "USDC");
  const WPHRS = token(atlantic, "WPHRS");
  const BATCH = `send 1.5 USDC to ${RECIPIENT}\nsend 0.5 USDC to ${STAFF}\napprove 2 USDC for ${SPENDER}\nwrap 0.1 PHRS\nsend 0.25 USDC to ${RECIPIENT}`;
  const world = (mineOnPoll: boolean) => defaultState({ chainId: 688689, mineOnPoll, native: { [lower(signer.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: { decimals: 6, balances: { [lower(signer.address)]: 5_000_000n } }, [lower(WPHRS)]: { decimals: 18, wrapsNative: true, balances: {} } } });

  async function send(fake: FakeChain, text: string): Promise<{ run: BatchRun; proof: ProofFile }> {
    const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: fake.url }, broadcast: true }, { timeoutMs: 15_000 });
    try {
      const run = await runBatch(text, { chain: new Chain(mcp, atlantic), signer, wait: { pollMs: 10 }, now: () => NOW });
      const proof = JSON.parse(JSON.stringify(proofFile({ task: "10", capability: "batch-executor", about: "test", mcp, network: atlantic, startedAt: new Date(), input: { batch: text, merge: true }, result: run }))) as ProofFile;
      return { run, proof };
    } finally {
      await mcp.close();
    }
  }

  test("signed here, sent back to back, all in one block; every balance and allowance as predicted; the proof verifies", async () => {
    const fake = await startFakeChain(world(true));
    let proof: ProofFile;
    try {
      const sent = await send(fake, BATCH);
      const run = sent.run;
      proof = sent.proof;
      assert.equal(run.verdict, "sent", run.headline);
      assert.deepEqual(run.txs.map((t) => [t.summary, t.submission?.status, t.submission?.nonce, t.submission?.blockNumber]), [
        ["Send 1.75 USDC to 0xB274…9553", "success", 0, "5000001"],
        ["Send 0.5 USDC to 0x1F35…c85C", "success", 1, "5000001"],
        ["Approve 0x3333…3333 to spend 2 USDC", "success", 2, "5000001"],
        ["Wrap 0.1 PHRS into WPHRS", "success", 3, "5000001"],
      ]);
      assert.deepEqual([run.execution!.sent, run.execution!.receipts, run.execution!.blocks], [4, 4, { first: "5000001", last: "5000001", span: 1 }]);
      assert.deepEqual(run.execution!.comparisons.map((c) => [c.what, c.match]), [["Sender PHRS", true], ["Sender USDC", true], ["0xB274…9553 USDC", true], ["0x1F35…c85C USDC", true], ["Allowance of 0x3333…3333 USDC", true], ["Sender WPHRS", true]]);
      assert.equal(run.execution!.comparisons[1]!.actual, "−2.25 USDC");
      assert.equal(run.headline, "Sent: 4 transactions back to back, nonces 0 to 3, all in block 5,000,001; one by one, each sent after the last one's receipt, they take at least 4 blocks. Every balance and allowance the batch changed matches the prediction.");
      const tokens = fake.state.tokens;
      assert.deepEqual([tokens[lower(TUSDC)]!.balances[lower(RECIPIENT)], tokens[lower(TUSDC)]!.allowances?.[lower(signer.address)]?.[lower(SPENDER)], tokens[lower(WPHRS)]!.balances[lower(signer.address)]], [1_750_000n, 2_000_000n, 10n ** 17n]);
    } finally {
      await fake.close();
    }
    const checks = await verifyBatchProof(proof);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.equal(checks.find((c) => c.name === "signed transactions")!.detail, "4 on chain 688689, each signed by its sender, each exactly the prepared transaction, in order");
    assert.equal(checks.find((c) => c.name === "sent back to back")!.detail, "4 sent, with no receipt asked between two sends");
    const renonced = JSON.parse(JSON.stringify(proof)) as ProofFile;
    (renonced.result as BatchRun).txs[2]!.submission!.nonce += 1;
    assert.deepEqual((await verifyBatchProof(renonced)).filter((c) => !c.ok).map((c) => c.name), ["batch recomputed from the recorded responses", "signed transactions"]);
  });

  test("on a chain that mines each at once, the blocks it took are said as they were", async () => {
    const fake = await startFakeChain(world(false));
    try {
      const { run } = await send(fake, `send 1 USDC to ${RECIPIENT}\nsend 1 USDC to ${STAFF}`);
      assert.deepEqual([run.verdict, run.execution!.blocks], ["sent", { first: "5000001", last: "5000002", span: 2 }]);
      assert.match(run.headline, /^Sent: 2 transactions back to back, nonces 0 to 1, in blocks 5,000,001 to 5,000,002 \(2 blocks\); one by one, each sent after the last one's receipt, they take at least 2 blocks\./);
    } finally {
      await fake.close();
    }
  });

  test("a send the node refuses stops the rest, which would wait behind its nonce; what was sent is still compared, and the proof verifies", async () => {
    const fake = await startFakeChain(world(true));
    let sends = 0;
    fake.onRequest = (method) => {
      if (method === "eth_sendRawTransaction" && (sends += 1) === 2) fake.state.failures.eth_sendRawTransaction = { code: -32000, message: "replacement transaction underpriced" };
    };
    let proof: ProofFile;
    try {
      const sent = await send(fake, `send 1 USDC to ${RECIPIENT}\nsend 1 USDC to ${STAFF}\nsend 1 USDC to ${SPENDER}`);
      proof = sent.proof;
      const run = sent.run;
      assert.deepEqual([run.verdict, run.txs.map((t) => t.submission?.status ?? null)], ["partly-sent", ["success", "refused", null]]);
      assert.equal(run.headline, "1 of 3 sent; transaction 2 was refused by the node (replacement transaction underpriced), so nothing after it was sent: its nonce would have held the rest back.");
      assert.deepEqual(run.execution!.comparisons.map((c) => [c.what, c.match]), [["Sender PHRS", true], ["Sender USDC", true], ["0xB274…9553 USDC", true]]);
    } finally {
      await fake.close();
    }
    assert.deepEqual((await verifyBatchProof(proof)).filter((c) => !c.ok), []);
  });

  test("only on Atlantic, and only from the key's own address", async () => {
    const fake = await startFakeChain(world(true));
    try {
      const official = await connectOfficial(fake, net);
      try {
        await assert.rejects(runBatch(`send 1 USDC to ${RECIPIENT}`, { chain: official.chain, signer }), /limited to the Atlantic testnet/);
      } finally {
        await official.close();
      }
      const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: fake.url }, broadcast: true }, { timeoutMs: 15_000 });
      try {
        await assert.rejects(runBatch(`send 1 USDC to ${RECIPIENT}`, { chain: new Chain(mcp, atlantic), signer, from: getAddress(STAFF) }), /The key's address 0x7099.* is not the sender 0x1F35/);
      } finally {
        await mcp.close();
      }
    } finally {
      await fake.close();
    }
  });
});
