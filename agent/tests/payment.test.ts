// Task 17, Natural-Language Payment Agent: a payment request read into payments (every word, or a refusal
// that says which words were not read), then prepared as a flow through the official Chain MCP server on a
// fake chain: each payment dry-run at one block, the totals against the sender's holdings, the nonces in
// order, the transactions to sign and the Skill Engine's commands; on Atlantic, with a key, sent in order.
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
import { preparePayments, type PaymentFlow } from "../src/payment/flow.js";
import { parseContacts, parseRequest } from "../src/payment/request.js";
import { verifyPaymentProof } from "../src/payment/verify.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const net = NETWORKS["pharos-mainnet"];
const atlantic = NETWORKS["atlantic-testnet"];
const USDC = getAddress(net.tokens[1]!.address);
const lower = (address: string) => address.toLowerCase();
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const contacts = parseContacts({ alice: ALICE, bob: BOB });
const NOW = new Date("2026-10-17T12:00:00.000Z");

describe("reading a payment request", () => {
  const read = (text: string, book = contacts) => parseRequest(text, book, net);
  const brief = (text: string, book = contacts) => read(text, book).payments.map((p) => [p.to.name ?? p.to.address, p.amount, p.token?.symbol ?? "PROS", p.share, p.memo]);

  test("one payment, several, each, a split, a note, a sender; the address book by line or JSON", () => {
    assert.deepEqual(brief("Pay alice 25 USDC"), [["alice", "25", "USDC", null, null]]);
    assert.deepEqual(brief("Send 25 USDC to alice for the March invoice"), [["alice", "25", "USDC", null, "the March invoice"]]);
    assert.deepEqual(brief("Pay alice 25 USDC and bob 5 USDC"), [["alice", "25", "USDC", null, null], ["bob", "5", "USDC", null, null]]);
    assert.deepEqual(brief(`Send 5 USDC each to alice, bob and ${CAROL}`), [["alice", "5", "USDC", "each", null], ["bob", "5", "USDC", "each", null], [CAROL, "5", "USDC", "each", null]]);
    assert.deepEqual(brief("Split 10 USDC between alice, bob and 0x3333333333333333333333333333333333333333 for dinner"), [["alice", "3.333334", "USDC", "split", "dinner"], ["bob", "3.333333", "USDC", "split", "dinner"], [CAROL, "3.333333", "USDC", "split", "dinner"]], "the parts add up: the remainder goes to the first");
    assert.deepEqual(brief(`Transfer 0.01 PROS to ${CAROL}; then pay bob 2 usdc`), [[CAROL, "0.01", "PROS", null, null], ["bob", "2", "USDC", null, null]]);
    const polite = read(`Please could you pay alice 1,000 USDC from ${CAROL}, thanks`);
    assert.deepEqual([polite.payments.map((p) => p.amount), polite.from], [["1000"], CAROL]);
    assert.equal(read("Pay alice 25 USDC and bob 5 USDC").payments[1]!.words, "bob 5 USDC");
    assert.deepEqual(parseContacts("alice = 0x1111111111111111111111111111111111111111\nBob: 0x2222222222222222222222222222222222222222"), contacts);
  });

  test("refused, saying why: who, what asset, each or split, words left over; a bad address book", () => {
    const refuses = (text: string, pattern: RegExp) => assert.throws(() => read(text), (e: unknown) => e instanceof AgentError && e.kind === "usage" && pattern.test(e.message), text);
    refuses("Pay carol 5 USDC", /Who is "carol"\? Name an address \(0x…\), or a name in the address book \(alice, bob\)\./);
    refuses("Pay alice 5 PEPE", /PEPE is not PROS or an official Pharos Mainnet token \(WPROS, USDC, LINK, WETH\)\./);
    refuses("Send 5 USDC to alice and bob", /5 USDC to 2 recipients: write "each" to send it to every one, or "split" to share it\./);
    refuses("Pay alice 25 USDC tomorrow", /This is not read as part of a payment: "tomorrow"/);
    refuses("Buy 5 USDC", /This is not read as a payment: "Buy 5 USDC"\. Start with pay, send, transfer, give or split\./);
    refuses("Pay alice", /An amount is missing at the end\./);
    refuses("Pay alice 5", /5 of what\? Name the asset after the amount: PROS or WPROS, USDC, LINK, WETH\./);
    refuses("Split 1 USDC between alice", /A split is between two recipients or more\./);
    refuses("Pay alice 0 USDC", /more than zero/);
    refuses("Pay alice 1.0000001 USDC", /amount/);
    refuses("  ", /Write a payment request/);
    refuses("x".repeat(501), /at most 500 characters/);
    assert.throws(() => parseRequest(Array.from({ length: 11 }, () => "pay alice 1 USDC").join(" and "), contacts, net), /at most 10 payments/);
    assert.throws(() => parseContacts("each = 0x1111111111111111111111111111111111111111"), /"each" cannot be a name in the address book/);
    assert.throws(() => parseContacts("alice = 0x12"), /alice's address must be 0x and 40 hex characters/);
  });
});

describe("the prepared flow", () => {
  let fake: FakeChain;
  before(async () => {
    fake = await startFakeChain(defaultState({ native: { [lower(EXAMPLE.account)]: 10n ** 18n }, nonces: { [lower(EXAMPLE.account)]: 41n }, tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(EXAMPLE.account)]: 100_000_000n } } } }));
  });
  after(() => fake.close());

  async function prepare(request: string): Promise<{ flow: PaymentFlow; proof: ProofFile }> {
    const official = await connectOfficial(fake, net, { budget: 60 });
    try {
      const flow = await preparePayments(request, { chain: official.chain, contacts, now: () => NOW });
      const proof = JSON.parse(JSON.stringify(proofFile({ task: "17", capability: "payment-flow", about: "test", mcp: official.mcp, network: net, startedAt: new Date(), input: { request, contacts }, result: flow }))) as ProofFile;
      proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
      return { flow, proof };
    } finally {
      await official.close();
    }
  }

  test("two payments: each dry-run at one block, the totals covered, the nonces in order, the transactions and commands; the proof verifies", async () => {
    const { flow, proof } = await prepare("Pay alice 25 USDC and send 0.01 PROS to bob for lunch");
    assert.deepEqual([flow.verdict, flow.sender, flow.nonce], ["ready", { address: EXAMPLE.account, from: "example" }, 41]);
    assert.deepEqual(flow.payments.map((p) => [p.n, p.to.name, p.amount, p.asset, p.memo, p.dryRun.verdict, p.tx?.nonce]), [[1, "alice", "25", "USDC", null, "would-succeed", 41], [2, "bob", "0.01", "PROS", "lunch", "would-succeed", 42]]);
    assert.deepEqual(flow.totals.map((t) => [t.asset, t.shown, t.holdsShown, t.covered]), [["USDC", "25 USDC", "100 USDC", true], ["PROS", "0.01 PROS", "1 PROS", true]]);
    assert.deepEqual(flow.payments.map((p) => p.command), [`cast send ${USDC} "transfer(address,uint256)" ${ALICE} 25000000 --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`, `cast send ${BOB} --value 0.01ether --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`]);
    assert.deepEqual([flow.payments[0]!.tx?.to, flow.payments[0]!.tx?.value, flow.payments[1]!.tx?.value, flow.payments[1]!.tx?.data], [USDC, "0", "10000000000000000", "0x"]);
    assert.match(flow.headline, /^The 2 payments, 25 USDC and 0\.01 PROS in all, ready: each dry-runs at block 5,000,000, for about [\d.]+ PROS in gas together\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.deepEqual(flow.steps.map((s) => s.source), ["the request", "Chain MCP · get_transaction_count", "Chain MCP · eth_call · estimate_gas", "Chain MCP · eth_call · estimate_gas", "the flow", "the flow", "Skill Engine · references/transaction.md", "the verdict"]);
    assert.equal(flow.steps[0]!.text, "Read as 2 payments from 0x912c…f647 (the example's): 25 USDC to alice (0x1111…1111); 0.01 PROS to bob (0x2222…2222).");
    assert.deepEqual((await verifyPaymentProof(proof)).filter((c) => !c.ok), []);
  });

  test("each payment fits alone but the flow does not; one that would not go through; a sender only Atlantic lacks", async () => {
    const short = (await prepare("Split 150 USDC between alice and bob")).flow;
    assert.deepEqual([short.verdict, short.payments.map((p) => p.dryRun.verdict), short.totals[0]!.covered], ["short", ["would-succeed", "would-succeed"], false]);
    assert.match(short.headline, /^The 2 payments need 150 USDC, but 0x912c…f647 holds 100 USDC\. Nothing was sent/);
    const fail = (await prepare("Pay alice 500 USDC")).flow;
    assert.deepEqual([fail.verdict, fail.payments[0]!.tx], ["would-fail", null]);
    assert.match(fail.headline, /^Payment 1 \(500 USDC to alice \(0x1111…1111\)\) would not go through: /);
    const official = await connectOfficial(fake, net);
    try {
      await assert.rejects(preparePayments("Pay alice 25 USDC", { chain: new Chain(official.mcp, atlantic), contacts }), /Name the sender/);
    } finally {
      await official.close();
    }
  });

  test("a changed recorded answer fails the proof", async () => {
    const { proof } = await prepare("Pay alice 25 USDC");
    const forged = JSON.parse(JSON.stringify(proof)) as ProofFile;
    const nonceReply = forged.transcript.find((m) => m.direction === "server->client" && JSON.stringify(m.message).includes('\\"nonce\\"'));
    assert.ok(nonceReply, "the nonce answer is in the transcript");
    const content = (nonceReply.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
    content.text = content.text.replace("41", "7");
    assert.deepEqual((await verifyPaymentProof(forged)).filter((c) => !c.ok).map((c) => c.name), ["flow recomputed from the recorded responses"]);
  });
});

describe("sending the flow on Atlantic", () => {
  // The well-known Hardhat/Anvil test key #1: public, only ever used here on a fake chain.
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
  const TUSDC = getAddress(atlantic.tokens[0]!.address);

  test("with a key, the payments are signed here and sent in order, each against its receipt; the proof verifies both", async () => {
    const chainFake = await startFakeChain(defaultState({ chainId: 688689, native: { [lower(signer.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: { decimals: 6, balances: { [lower(signer.address)]: 5_000_000n } } } }));
    const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: chainFake.url }, broadcast: true }, { timeoutMs: 15_000 });
    const request = "Pay alice 1.5 USDC and bob 0.5 USDC";
    let proof: ProofFile;
    try {
      const flow = await preparePayments(request, { chain: new Chain(mcp, atlantic), contacts, from: signer.address, signer, wait: { pollMs: 10 }, now: () => NOW });
      assert.deepEqual([flow.verdict, flow.payments.map((p) => [p.submission?.status, p.submission?.matched])], ["sent", [["success", true], ["success", true]]]);
      assert.deepEqual([chainFake.state.tokens[lower(TUSDC)]!.balances[lower(ALICE)], chainFake.state.tokens[lower(TUSDC)]!.balances[lower(BOB)]], [1_500_000n, 500_000n]);
      assert.equal(flow.headline, "The 2 payments, 2 USDC in all, sent and checked against their receipts.");
      proof = JSON.parse(JSON.stringify(proofFile({ task: "17", capability: "payment-flow", about: "test", mcp, network: atlantic, startedAt: new Date(), input: { request, contacts, from: signer.address }, result: flow }))) as ProofFile;
    } finally {
      await mcp.close();
      await chainFake.close();
    }
    const checks = await verifyPaymentProof(proof);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.equal(checks.find((c) => c.name === "signed transactions")!.detail, "2 on chain 688689, each signed by its sender, each exactly the prepared payment, in order");
    // A sent payment recorded at another nonce than its signed transaction's fails.
    const renonced = JSON.parse(JSON.stringify(proof)) as ProofFile;
    (renonced.result as { payments: { submission: { nonce: number } }[] }).payments[1]!.submission.nonce += 1;
    assert.deepEqual((await verifyPaymentProof(renonced)).find((c) => c.name === "signed transactions"), { name: "signed transactions", ok: false, detail: "broadcast 2 is not the prepared payment 2" });
  });
});
