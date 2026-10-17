// Task 25, Wallet Risk Checker: the counterparty of a planned transaction read at one block (code, nonce,
// balance), its recent Transfer history with the sender (two queries a page), and each signal: a
// lookalike of an address the sender uses, zero-value transfers, a never-used address, an approval to a
// wallet or an unlimited one, tokens sent to a token contract, a contract or delegated recipient, the zero
// address, and a transaction that would fail; the level and verdict; proofs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getAddress } from "viem";
import { AgentError } from "../src/core/errors.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { parseDryRun, type Intent } from "../src/dryrun/intent.js";
import { checkRisk, type RiskReport } from "../src/risk/check.js";
import { verifyRiskProof } from "../src/risk/verify.js";
import { defaultState, startFakeChain, type FakeChain, type FakeTransfer } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const TRADER = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
/** Made up: the first and last four characters of TRADER, nothing else. */
const LOOKALIKE = getAddress(`0x1f35${"0".repeat(32)}c85c`);
const POISONER = "0x2222222222222222222222222222222222222222";
const WALLET = "0x3333333333333333333333333333333333333333";
const VAULT = "0xC0FFEE0000000000000000000000000000000001";
const DELEGATED = "0x4444444444444444444444444444444444444444";
const lower = (a: string) => a.toLowerCase();
const HEAD = 5_000_000n;

/** In the last 2,000 blocks: the sender and its trader three times, and zero-value transfers from a poisoner. */
const HISTORY: FakeTransfer[] = [
  { token: USDC, from: PAYER, to: TRADER, amount: 58_410_000n, block: HEAD - 1500n },
  { token: USDC, from: TRADER, to: PAYER, amount: 58_400_000n, block: HEAD - 900n },
  { token: USDC, from: TRADER, to: PAYER, amount: 58_380_000n, block: HEAD - 20n },
  { token: USDC, from: POISONER, to: PAYER, amount: 0n, block: HEAD - 19n },
  { token: USDC, from: PAYER, to: POISONER, amount: 0n, block: HEAD - 18n },
  { token: USDC, from: PAYER, to: TRADER, amount: 1n, block: HEAD - 3000n }, // before the window
];

const mainnet = () =>
  startFakeChain(
    defaultState({
      native: { [lower(PAYER)]: 10n ** 18n, [lower(TRADER)]: 5n * 10n ** 17n },
      nonces: { [lower(PAYER)]: 50n, [lower(TRADER)]: 12n },
      code: { [lower(VAULT)]: "0x6080604052", [lower(DELEGATED)]: `0xef0100${lower(VAULT).slice(2)}` },
      tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(PAYER)]: 1_000_000_000n } } },
      transfers: structuredClone(HISTORY),
    }),
  );

const NOW = new Date("2026-10-17T12:00:00.000Z");
const transfer = (to: string, amount = "25"): Intent => parseDryRun({ intent: { kind: "erc20-transfer", token: USDC, from: PAYER, to, amount } }).intent;

async function check(fake: FakeChain, intent: Intent, blocks?: number): Promise<{ result: RiskReport; proof: ProofFile; calls: { name: string; arguments: Record<string, unknown> }[] }> {
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    const result = await checkRisk(intent, { chain: official.chain, blocks, now: () => NOW });
    const proof = JSON.parse(JSON.stringify(proofFile({ task: "25", capability: "risk-checker", about: "test", mcp: official.mcp, network: NETWORKS["pharos-mainnet"], startedAt: new Date(), input: { intent, blocks }, result }))) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    const calls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);
    return { result, proof, calls };
  } finally {
    await official.close();
  }
}

const ids = (r: RiskReport) => r.signals.map((s) => [s.id, s.severity]);

describe("checking a counterparty before a transaction", () => {
  test("an address the sender already deals with: its history read in two queries a page, low risk", async () => {
    const fake = await mainnet();
    try {
      const { result, proof, calls } = await check(fake, transfer(TRADER));
      assert.deepEqual(result.counterparty, { address: TRADER, code: "none", delegate: null, nonce: "12", balance: "500000000000000000", balanceShown: "0.5 PROS", token: null });
      assert.deepEqual(result.history, { from: "4998001", to: "5000000", pages: 4, token: "USDC", transfers: 5, withSender: 3, zeroValue: 0, lookalikes: [] });
      assert.deepEqual(ids(result), [["known", "info"]]);
      assert.deepEqual([result.level, result.verdict, result.headline], ["low", "looks-fine", "Low risk: nothing suspicious found. Send 25 USDC from 0x912c…f647 to 0x1F35…c85C."]);
      const either = [PAYER, TRADER].map((a) => `0x${"0".repeat(24)}${lower(a).slice(2)}`);
      assert.deepEqual(calls.filter((c) => c.name === "get_logs").slice(0, 2).map((c) => c.arguments.topics), [["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", either], ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null, either]]);
      assert.deepEqual((await verifyRiskProof(proof)).filter((c) => !c.ok), []);
    } finally {
      await fake.close();
    }
  });

  test("a lookalike of an address the sender uses, never used itself: high risk, do not send", async () => {
    const fake = await mainnet();
    try {
      const { result, proof } = await check(fake, transfer(LOOKALIKE));
      assert.deepEqual(ids(result), [["lookalike", "high"], ["never-used", "medium"]]);
      // Checksummed, the lookalike's letters differ in case: the eye skips that too.
      assert.equal(result.signals[0]!.detail, "0x1f35…c85c starts and ends like 0x1F35…c85C, which the sender dealt with 3 times in the last 2,000 blocks, but it is a different address. Address poisoning copies the start and end of an address its victim uses.");
      assert.deepEqual(result.history?.lookalikes, [{ address: TRADER, times: 3 }]);
      assert.deepEqual([result.level, result.verdict], ["high", "do-not-send"]);
      assert.match(result.headline, /^High risk: do not send\. Send 25 USDC from 0x912c…f647 to 0x1f35…c85c\. 0x1f35…c85c starts and ends like/);
      assert.deepEqual((await verifyRiskProof(proof)).filter((c) => !c.ok), []);
    } finally {
      await fake.close();
    }
  });

  test("zero-value transfers with the sender: the trace address poisoning leaves", async () => {
    const fake = await mainnet();
    try {
      const { result } = await check(fake, transfer(POISONER));
      assert.deepEqual(ids(result).slice(0, 1), [["zero-value", "high"]]);
      assert.equal(result.signals[0]!.detail, "2 USDC transfers of nothing between the sender and 0x2222…2222 in the last 2,000 blocks: that is how address poisoning plants a lookalike in a wallet's history.");
      assert.equal(result.history?.withSender, 0, "transfers of nothing are not dealings");
    } finally {
      await fake.close();
    }
  });

  test("an unlimited approval to a wallet; tokens sent to the token's own contract", async () => {
    const fake = await mainnet();
    try {
      const approve = parseDryRun({ intent: { kind: "erc20-approve", token: USDC, from: PAYER, spender: WALLET, amount: "max" } }).intent;
      const { result } = await check(fake, approve);
      assert.deepEqual(ids(result), [["approve-wallet", "high"], ["never-used", "medium"], ["unlimited", "medium"]]);
      assert.deepEqual([result.transaction.role, result.verdict], ["spender", "do-not-send"]);
      const toToken = (await check(fake, transfer(USDC))).result;
      assert.deepEqual(ids(toToken).slice(0, 1), [["to-token", "high"]]);
      assert.equal(toToken.counterparty.token, "USDC");
    } finally {
      await fake.close();
    }
  });

  test("a contract recipient, a delegated wallet, the zero address, a transfer that would fail", async () => {
    const fake = await mainnet();
    try {
      assert.deepEqual(ids((await check(fake, transfer(VAULT))).result), [["to-contract", "medium"]]);
      const delegated = (await check(fake, transfer(DELEGATED))).result;
      assert.deepEqual([delegated.counterparty.code, delegated.counterparty.delegate, ids(delegated)], ["delegated", getAddress(VAULT), [["delegated", "low"]]]);
      assert.equal(delegated.verdict, "looks-fine", "a low signal is worth reading, not stopping for");
      const zero = (await check(fake, transfer("0x0000000000000000000000000000000000000000"))).result;
      assert.deepEqual(ids(zero).slice(0, 1), [["zero-address", "high"]]);
      const fails = (await check(fake, transfer(TRADER, "5000"))).result;
      assert.deepEqual(ids(fails), [["would-fail", "medium"], ["known", "info"]]);
      assert.equal(fails.signals[0]!.detail, fails.dryRun.reason);
      assert.equal(fails.verdict, "check-first");
    } finally {
      await fake.close();
    }
  });

  test("the history window is bounded; a changed answer fails the replay", async () => {
    const fake = await mainnet();
    try {
      const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
      try {
        await assert.rejects(checkRisk(transfer(TRADER), { chain: official.chain, blocks: 0 }), (e: unknown) => e instanceof AgentError && /blocks must be a whole number from 1 to 10,000/.test(e.message));
      } finally {
        await official.close();
      }
      const { result, proof } = await check(fake, transfer(TRADER), 500);
      assert.deepEqual([result.history?.from, result.history?.pages, result.history?.withSender], ["4999501", 2, 1]);
      const asked = proof.transcript.find((m) => m.direction === "client->server" && JSON.stringify(m.message).includes('"name":"get_transaction_count"'))!;
      const id = (asked.message as { id: number }).id;
      const answer = proof.transcript.find((m) => m.direction === "server->client" && "id" in m.message && m.message.id === id)!;
      const content = (answer.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
      content.text = content.text.replace(/"nonce":\s*"12"/, '"nonce": "0"');
      assert.deepEqual((await verifyRiskProof(proof)).filter((c) => !c.ok).map((c) => c.name), ["result recomputed from the recorded responses"]);
    } finally {
      await fake.close();
    }
  });
});
