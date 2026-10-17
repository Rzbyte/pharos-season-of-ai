// Task 27, dApp Support Agent: revert data decoded in plain language; a transaction explained by its
// hash (a revert replayed before its block, a custom error, out of gas, something earlier in its block,
// a success, an unknown hash, a pending one) and by description (why it would fail if sent now); every
// read at one block; proofs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeErrorResult, encodeFunctionData, parseAbi } from "viem";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { decodeRevert } from "../src/support/errors.js";
import { explain, type Explanation, type ExplainRequest } from "../src/support/explain.js";
import { parseExplainRequest, verifyExplanationProof } from "../src/support/verify.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const VAULT = "0xC0FFEE0000000000000000000000000000000001";
const lower = (a: string) => a.toLowerCase();
const HEAD = 5_000_000n;
const hex = (n: bigint) => `0x${n.toString(16)}` as `0x${string}`;
const ERRORS = parseAbi([
  "error Error(string)",
  "error Panic(uint256)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error OwnableUnauthorizedAccount(address account)",
  "error EnforcedPause()",
]);
const TRANSFER = parseAbi(["function transfer(address to, uint256 amount)"]);
const usdcTransfer = (amount: bigint) => encodeFunctionData({ abi: TRANSFER, functionName: "transfer", args: [RECIPIENT, amount] });

const mainnet = () => startFakeChain(defaultState({ native: { [lower(PAYER)]: 10n ** 18n }, code: { [lower(VAULT)]: "0x6080604052" }, tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(PAYER)]: 50_000_000n } } } }));

/** A mined transaction the fake chain knows, with its receipt. */
function mined(fake: FakeChain, n: number, tx: { to: string; data: `0x${string}`; gas: bigint; status: "0x0" | "0x1"; gasUsed: bigint; block?: bigint | null }): `0x${string}` {
  const hash = `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
  const block = tx.block === undefined ? HEAD : tx.block;
  fake.transactions.set(hash, { hash, from: lower(PAYER), to: lower(tx.to), input: tx.data, value: "0x0", gas: hex(tx.gas), nonce: "0x7", blockNumber: block === null ? null : hex(block), type: "0x2" });
  if (block !== null) fake.receipts.set(hash, { transactionHash: hash, blockNumber: hex(block), status: tx.status, gasUsed: hex(tx.gasUsed), effectiveGasPrice: hex(10n ** 9n), from: lower(PAYER) as `0x${string}`, to: lower(tx.to) as `0x${string}`, logs: [], cumulativeGasUsed: hex(tx.gasUsed), type: "0x2" });
  return hash;
}

const NOW = new Date("2026-10-17T12:00:00.000Z");

async function ask(fake: FakeChain, request: ExplainRequest): Promise<{ result: Explanation; proof: ProofFile; calls: { name: string; arguments: Record<string, unknown> }[] }> {
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    const result = await explain(request, { chain: official.chain, now: () => NOW });
    const proof = JSON.parse(JSON.stringify(proofFile({ task: "27", capability: "dapp-support", about: "test", mcp: official.mcp, network: NETWORKS["pharos-mainnet"], startedAt: new Date(), input: request, result }))) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    const calls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);
    return { result, proof, calls };
  } finally {
    await official.close();
  }
}

const verified = async (proof: ProofFile) => (await verifyExplanationProof(proof)).filter((c) => !c.ok);

describe("revert data in plain language", () => {
  test("Error, Panic, OpenZeppelin's errors with token amounts, and an unknown selector", () => {
    const usdc = { symbol: "USDC", decimals: 6 };
    const decode = (errorName: string, args: unknown[] = []) => decodeRevert(encodeErrorResult({ abi: ERRORS, errorName: errorName as never, args: args as never }), usdc);
    assert.equal(decodeRevert(null), null);
    assert.equal(decodeRevert("0x"), null);
    assert.deepEqual(decode("Error", ["ERC20: transfer amount exceeds balance"]), { name: "Error", selector: "0x08c379a0", args: { message: "ERC20: transfer amount exceeds balance" }, meaning: 'It stopped with the message "ERC20: transfer amount exceeds balance". The sender did not hold enough.' });
    assert.equal(decode("Panic", [0x11n])!.meaning, "It hit an arithmetic overflow or underflow: an amount went past what its type can hold, or below zero (panic 0x11).");
    assert.equal(decode("ERC20InsufficientBalance", [PAYER, 50_000_000n, 100_000_000n])!.meaning, "0x912c…f647 held 50 USDC and needed 100 USDC.");
    assert.equal(decode("ERC20InsufficientAllowance", [RECIPIENT, 0n, 25_000_000n])!.meaning, "0xB274…9553 was approved for 0 USDC and needed 25 USDC.");
    assert.equal(decode("OwnableUnauthorizedAccount", [PAYER])!.meaning, "Only the contract's owner can do this, and 0x912c…f647 is not it.");
    assert.equal(decode("EnforcedPause")!.meaning, "The contract is paused.");
    assert.deepEqual(decodeRevert("0xdeadbeef00"), { name: null, selector: "0xdeadbeef", args: {}, meaning: "It stopped with a custom error the agent does not know (selector 0xdeadbeef)." });
  });

  test("a request is a hash or a description, checked before anything runs", () => {
    assert.throws(() => parseExplainRequest({ kind: "hash", hash: "0x12" }), /0x and 64 hex characters/);
    assert.throws(() => parseExplainRequest({ kind: "intent", intent: { kind: "swap" } }), /kind must be one of/);
    assert.throws(() => parseExplainRequest({}), /Explain a transaction hash, or a transaction described/);
    assert.deepEqual(parseExplainRequest({ kind: "hash", hash: `0x${"AB".repeat(32)}` }), { kind: "hash", hash: `0x${"ab".repeat(32)}` });
  });
});

describe("explaining a transaction by its hash", () => {
  test("a revert: replayed at the block before its own, decoded, with the sender's balance and what to do", async () => {
    const fake = await mainnet();
    try {
      const hash = mined(fake, 1, { to: USDC, data: usdcTransfer(100_000_000n), gas: 100_000n, status: "0x0", gasUsed: 31_000n });
      const { result, proof, calls } = await ask(fake, { kind: "hash", hash });
      assert.deepEqual([result.status, result.readAt, result.cause?.kind, result.cause?.error?.name], ["failed", "4999999", "revert", "Error"]);
      assert.equal(result.headline, 'It failed in block 5,000,000: Transfer 100 USDC to 0xB274…9553. It stopped with the message "ERC20: transfer amount exceeds balance". The sender did not hold enough.');
      assert.deepEqual(result.findings.map((f) => [f.check, f.seen, f.tool, f.tone]), [
        ["Status", "failed in block 5,000,000", "get_transaction_receipt", "cause"],
        ["Gas", "31,000 of the 100,000 it was given (31%), 0.000031 PROS paid", "get_transaction · get_transaction_receipt", "note"],
        ["Replayed before its block", "reverts at block 4,999,999: Error", "eth_call", "cause"],
        ["Target", "0xC879…1815 is a contract (USDC)", "get_code", "note"],
        ["Sender's balance", "0x912c…f647 held 50 USDC, and it sends 100 USDC", "eth_call", "cause"],
      ]);
      assert.equal(result.fix, "Send no more than the sender holds, or fund it first.");
      assert.deepEqual(calls.filter((c) => c.name === "eth_call").map((c) => c.arguments.block), ["0x4c4b3f", "0x4c4b3f"], "both reads at the block before");
      assert.deepEqual(await verified(proof), []);
    } finally {
      await fake.close();
    }
  });

  test("a contract's custom error, out of gas, and a failure caused earlier in its block", async () => {
    const fake = await mainnet();
    try {
      fake.state.reverts = { [lower(VAULT)]: encodeErrorResult({ abi: ERRORS, errorName: "OwnableUnauthorizedAccount", args: [PAYER] }) };
      const custom = (await ask(fake, { kind: "hash", hash: mined(fake, 2, { to: VAULT, data: "0x3ccfd60b", gas: 80_000n, status: "0x0", gasUsed: 24_000n }) })).result;
      assert.deepEqual([custom.transaction?.summary, custom.cause?.error?.name, custom.cause?.text, custom.fix], ["Call 0x3ccfd60b on 0xC0FF…0001", "OwnableUnauthorizedAccount", "Only the contract's owner can do this, and 0x912c…f647 is not it.", "Send it from the account that is allowed to do this."]);
      const gas = (await ask(fake, { kind: "hash", hash: mined(fake, 3, { to: USDC, data: usdcTransfer(10_000_000n), gas: 30_000n, status: "0x0", gasUsed: 30_000n }) })).result;
      assert.deepEqual([gas.cause?.kind, gas.cause?.text], ["out-of-gas", "It ran out of gas: it used all 30,000 it was given, and the same call succeeds with more."]);
      assert.match(gas.fix!, /higher gas limit/);
      assert.equal(gas.findings.find((f) => f.check === "Sender's balance")?.tone, "fine");
      const earlier = (await ask(fake, { kind: "hash", hash: mined(fake, 4, { to: USDC, data: usdcTransfer(10_000_000n), gas: 90_000n, status: "0x0", gasUsed: 41_000n }) })).result;
      assert.deepEqual([earlier.cause?.kind, earlier.cause?.text], ["earlier-in-block", "The same call succeeds against the state before block 5,000,000, so what made it fail happened in that block, before it: another transaction changed what it depended on."]);
    } finally {
      await fake.close();
    }
  });

  test("a success, an unknown hash, and a pending transaction are each said plainly", async () => {
    const fake = await mainnet();
    try {
      const ok = await ask(fake, { kind: "hash", hash: mined(fake, 5, { to: USDC, data: usdcTransfer(10_000_000n), gas: 90_000n, status: "0x1", gasUsed: 49_871n }) });
      assert.deepEqual([ok.result.status, ok.result.cause, ok.result.headline], ["succeeded", null, "It did not fail: it succeeded in block 5,000,000. Transfer 10 USDC to 0xB274…9553."]);
      assert.equal(ok.calls.filter((c) => c.name === "eth_call").length, 0, "nothing to replay");
      assert.deepEqual(await verified(ok.proof), []);
      const unknown = (await ask(fake, { kind: "hash", hash: `0x${"9".repeat(64)}` })).result;
      assert.deepEqual([unknown.status, unknown.headline], ["not-found", "No transaction 0x9999…9999 on Pharos Mainnet. It may be on another network, or not seen yet."]);
      const pending = (await ask(fake, { kind: "hash", hash: mined(fake, 6, { to: USDC, data: usdcTransfer(1n), gas: 90_000n, status: "0x1", gasUsed: 0n, block: null }) })).result;
      assert.deepEqual([pending.status, pending.headline], ["pending", "Transfer 0.000001 USDC to 0xB274…9553: still pending, in no block yet. There is nothing to explain until it is mined or dropped."]);
    } finally {
      await fake.close();
    }
  });
});

describe("explaining a transaction described, not sent", () => {
  test("why it would fail if sent now, and when it would not", async () => {
    const fake = await mainnet();
    try {
      const intent = (amount: string) => parseExplainRequest({ kind: "intent", intent: { kind: "erc20-transfer", token: USDC, from: PAYER, to: RECIPIENT, amount } });
      const fails = await ask(fake, intent("5000"));
      assert.deepEqual([fails.result.status, fails.result.readAt, fails.result.cause?.kind], ["would-fail", "5000000", "revert"]);
      assert.equal(fails.result.headline, 'It would fail if sent now: Send 5000 USDC from 0x912c…f647 to 0xB274…9553. It stopped with the message "ERC20: transfer amount exceeds balance". The sender did not hold enough.');
      assert.deepEqual(fails.result.findings.map((f) => [f.check, f.tone]), [["Simulated", "cause"], ["Sender's USDC", "note"], ["Funds for gas", "note"]]);
      assert.equal(fails.result.findings[1]!.seen, "holds 50 USDC");
      assert.deepEqual(await verified(fails.proof), []);
      const fine = (await ask(fake, intent("10"))).result;
      assert.deepEqual([fine.status, fine.cause, fine.headline], ["would-succeed", null, "It would succeed if sent now: Send 10 USDC from 0x912c…f647 to 0xB274…9553. Nothing to explain."]);
      fake.state.native[lower(PAYER)] = 0n;
      const broke = (await ask(fake, intent("10"))).result;
      assert.deepEqual([broke.status, broke.cause?.kind, broke.fix], ["would-fail", "cannot-pay", "Fund the sender with enough for the value and the gas, or send less."]);
    } finally {
      await fake.close();
    }
  });
});
