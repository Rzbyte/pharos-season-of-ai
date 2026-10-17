// Task 27, dApp Support Agent: why a transaction failed, on request.
//
// By hash:
//   1. get_chain_info, then get_transaction: the transaction, or that the network does not know it.
//   2. get_transaction_receipt: succeeded, failed, or still pending; get_block for when.
//   3. When it failed: its call is replayed at the block before its own (eth_call with its sender,
//      target, data and value), which returns the revert data, decoded in errors.ts. get_code: is the
//      target a contract. For a transfer of an official token, the sender's balance there, and for a
//      transferFrom, the allowance too. A receipt that used all the gas it was given ran out of gas.
//   4. The cause, each finding with the tool it came from, and what to do about it.
// By description (a transaction not sent): Task 08's dry run at the newest block, explained the same way.
import { decodeFunctionData, getAddress, maxUint256, parseAbi } from "viem";
import { decodeCall, encodeCall, ERC20 } from "../core/abi.js";
import { formatAmount } from "../core/amounts.js";
import type { Address, Chain, Hex } from "../core/chain.js";
import { knownToken, type Network, type Token } from "../core/networks.js";
import { simulate } from "../core/simulate.js";
import type { Intent } from "../dryrun/intent.js";
import { runDryRun } from "../dryrun/run.js";
import { decodeRevert, type DecodedError } from "./errors.js";

export type ExplainRequest = { kind: "hash"; hash: Hex } | { kind: "intent"; intent: Intent };

export interface Finding {
  check: string;
  seen: string;
  tool: string;
  tone: "cause" | "fine" | "note";
}

export type CauseKind = "revert" | "out-of-gas" | "earlier-in-block" | "cannot-pay";

export interface Explanation {
  schema: "pharos-agent/tx-explanation/1";
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  evaluatedAt: string;
  request: ExplainRequest;
  status: "succeeded" | "failed" | "pending" | "not-found" | "would-succeed" | "would-fail";
  /** The transaction's block, or the block it was dry-run at. */
  block: { number: string; timestamp: string } | null;
  /** The block whose state was read: the one before the transaction's, or the dry run's. */
  readAt: string | null;
  transaction: { hash: Hex | null; from: Address; to: Address | null; value: string; data: Hex; nonce: string | null; gasLimit: string | null; summary: string } | null;
  receipt: { status: "success" | "reverted"; gasUsed: string; fee: string | null; feeShown: string | null; logs: number } | null;
  cause: { kind: CauseKind; text: string; error: DecodedError | null } | null;
  findings: Finding[];
  fix: string | null;
  headline: string;
  toolCalls: number;
}

export interface ExplainOptions {
  chain: Chain;
  now?: () => Date;
}

const CALLS = parseAbi(["function transfer(address to, uint256 amount)", "function transferFrom(address from, address to, uint256 amount)", "function approve(address spender, uint256 amount)"]);
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

type TokenCall = { kind: "transfer"; holder: Address; to: Address; amount: bigint } | { kind: "transferFrom"; holder: Address; to: Address; amount: bigint } | { kind: "approve"; spender: Address; amount: bigint };

/** The call in words, and what it does to an official token when it is a transfer or an approval. */
function readCall(net: Network, from: Address, to: Address | null, data: Hex, value: bigint): { summary: string; token: Token | null; call: TokenCall | null } {
  const native = (raw: bigint) => `${formatAmount(raw, 18, 8)} ${net.nativeSymbol}`;
  if (!to) return { summary: "Create a contract", token: null, call: null };
  if (data === "0x") return { summary: `Send ${native(value)} to ${short(to)}`, token: null, call: null };
  const token = knownToken(net, to) ?? null;
  if (token) {
    try {
      const decoded = decodeFunctionData({ abi: CALLS, data });
      const amount = (raw: bigint) => `${formatAmount(raw, token.decimals, 6)} ${token.symbol}`;
      if (decoded.functionName === "transfer") {
        const [recipient, raw] = decoded.args;
        return { summary: `Transfer ${amount(raw)} to ${short(recipient)}`, token, call: { kind: "transfer", holder: from, to: recipient, amount: raw } };
      }
      if (decoded.functionName === "transferFrom") {
        const [holder, recipient, raw] = decoded.args;
        return { summary: `Transfer ${amount(raw)} from ${short(holder)} to ${short(recipient)}`, token, call: { kind: "transferFrom", holder, to: recipient, amount: raw } };
      }
      const [spender, raw] = decoded.args;
      return { summary: `Approve ${short(spender)} to spend ${raw === maxUint256 ? "unlimited" : amount(raw)}`, token, call: { kind: "approve", spender, amount: raw } };
    } catch {
      // Another function of the token: named by its selector below.
    }
  }
  return { summary: `Call ${data.slice(0, 10)} on ${token ? token.symbol : short(to)}${value > 0n ? ` with ${native(value)}` : ""}`, token, call: null };
}

/** What to do about it, where the cause says. */
function fixFor(kind: CauseKind, error: DecodedError | null): string | null {
  if (kind === "out-of-gas") return "Send it again with a higher gas limit: estimate it first, as Task 08's dry run does, and add a margin.";
  if (kind === "earlier-in-block") return "Look at the transactions before it in the same block, and send it again if it still makes sense.";
  if (kind === "cannot-pay") return "Fund the sender with enough for the value and the gas, or send less.";
  const name = error?.name;
  const message = error?.args.message ?? "";
  if (name === "ERC20InsufficientBalance" || /exceeds balance|insufficient balance/i.test(message)) return "Send no more than the sender holds, or fund it first.";
  if (name === "ERC20InsufficientAllowance" || /allowance/i.test(message)) return "Approve the spender for at least the amount first, from the holder's account.";
  if (name === "EnforcedPause" || /paused/i.test(message)) return "Wait until the contract is unpaused.";
  if (name === "OwnableUnauthorizedAccount" || name === "AccessControlUnauthorizedAccount") return "Send it from the account that is allowed to do this.";
  if (name === "ERC20InvalidReceiver") return "Send to a real recipient, not the zero address.";
  if (name === "Panic" && error?.args.code === "17") return "Check the amounts in the call: one went past what it can hold, or below zero.";
  return null;
}

export async function explain(request: ExplainRequest, options: ExplainOptions): Promise<Explanation> {
  const { chain } = options;
  const net = chain.network;
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  const base = { schema: "pharos-agent/tx-explanation/1" as const, network: { id: net.id, name: net.name, chainId: net.chainId }, evaluatedAt, request };
  const finish = (rest: Omit<Explanation, "schema" | "network" | "chainMcp" | "evaluatedAt" | "request" | "toolCalls">): Explanation => ({ ...base, chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null }, ...rest, toolCalls: chain.mcp.toolCalls });
  return request.kind === "hash" ? byHash(request.hash, chain, finish) : byDescription(request.intent, chain, finish);
}

type Finish = (rest: Omit<Explanation, "schema" | "network" | "chainMcp" | "evaluatedAt" | "request" | "toolCalls">) => Explanation;

async function byHash(hash: Hex, chain: Chain, finish: Finish): Promise<Explanation> {
  const net = chain.network;
  await chain.expectChain();
  const found = await chain.transaction(hash);
  if (!found) {
    return finish({ status: "not-found", block: null, readAt: null, transaction: null, receipt: null, cause: null, findings: [{ check: "Transaction", seen: "not known to the network", tool: "get_transaction", tone: "note" }], fix: "Check the hash, and that it is a Pharos Mainnet transaction.", headline: `No transaction ${short(hash)} on ${net.name}. It may be on another network, or not seen yet.` });
  }
  // Addresses as the node gives them can be lowercase: checksummed, as everywhere else.
  const tx = { ...found, from: getAddress(found.from), to: found.to ? getAddress(found.to) : null };
  const { summary, token, call } = readCall(net, tx.from, tx.to, tx.input, tx.value);
  const transaction = { hash, from: tx.from, to: tx.to, value: tx.value.toString(), data: tx.input, nonce: tx.nonce.toString(), gasLimit: tx.gas.toString(), summary };
  const receipt = tx.blockNumber === null ? null : await chain.receipt(hash);
  if (tx.blockNumber === null || !receipt) {
    return finish({ status: "pending", block: null, readAt: null, transaction, receipt: null, cause: null, findings: [{ check: "Block", seen: "none yet: it is pending", tool: "get_transaction", tone: "note" }], fix: null, headline: `${summary}: still pending, in no block yet. There is nothing to explain until it is mined or dropped.` });
  }
  const header = await chain.block(receipt.blockNumber);
  const at = receipt.blockNumber.toLocaleString("en-US");
  const fee = receipt.effectiveGasPrice === null ? null : receipt.gasUsed * receipt.effectiveGasPrice;
  const receiptOut = { status: receipt.status, gasUsed: receipt.gasUsed.toString(), fee: fee?.toString() ?? null, feeShown: fee === null ? null : `${formatAmount(fee, 18, 8)} ${net.nativeSymbol}`, logs: receipt.logs.length };
  const share = tx.gas > 0n ? Number((receipt.gasUsed * 1000n) / tx.gas) / 10 : 0;
  const findings: Finding[] = [
    { check: "Status", seen: receipt.status === "success" ? `succeeded in block ${at}` : `failed in block ${at}`, tool: "get_transaction_receipt", tone: receipt.status === "success" ? "fine" : "cause" },
    { check: "Gas", seen: `${receipt.gasUsed.toLocaleString("en-US")} of the ${tx.gas.toLocaleString("en-US")} it was given (${share}%)${fee !== null ? `, ${receiptOut.feeShown} paid` : ""}`, tool: "get_transaction · get_transaction_receipt", tone: "note" },
  ];
  const block = { number: receipt.blockNumber.toString(), timestamp: iso(header.timestamp) };
  if (receipt.status === "success") {
    return finish({ status: "succeeded", block, readAt: null, transaction, receipt: receiptOut, cause: null, findings, fix: null, headline: `It did not fail: it succeeded in block ${at}. ${summary}.` });
  }

  // It failed: what the call does against the state just before its block.
  const parent = receipt.blockNumber - 1n;
  const replay = tx.to ? await simulate(chain, { from: tx.from, to: tx.to, data: tx.input, value: tx.value }, parent) : null;
  const error = replay && !replay.ok ? decodeRevert(replay.returned, token) : null;
  if (replay) findings.push({ check: "Replayed before its block", seen: replay.ok ? `succeeds at block ${parent.toLocaleString("en-US")}` : `reverts at block ${parent.toLocaleString("en-US")}${error?.name ? `: ${error.name}` : replay.reason ? `: ${replay.reason}` : ""}`, tool: "eth_call", tone: replay.ok ? "fine" : "cause" });
  if (tx.to) {
    const code = await chain.code(tx.to, parent);
    findings.push({ check: "Target", seen: /^0x0*$/.test(code) ? `${short(tx.to)} has no code` : `${short(tx.to)} is a contract${token ? ` (${token.symbol})` : ""}`, tool: "get_code", tone: "note" });
  }
  if (token && call && call.kind !== "approve") {
    const balance = decodeCall(ERC20.balanceOf, await chain.call({ to: token.address as Address, data: encodeCall(ERC20.balanceOf, [call.holder]) }, parent)) as bigint;
    const fmt = (raw: bigint) => `${formatAmount(raw, token.decimals, 6)} ${token.symbol}`;
    findings.push({ check: "Sender's balance", seen: `${short(call.holder)} held ${fmt(balance)}, and it sends ${fmt(call.amount)}`, tool: "eth_call", tone: balance < call.amount ? "cause" : "fine" });
    if (call.kind === "transferFrom") {
      const allowance = decodeCall(ERC20.allowance, await chain.call({ to: token.address as Address, data: encodeCall(ERC20.allowance, [call.holder, tx.from]) }, parent)) as bigint;
      findings.push({ check: "Allowance", seen: `${short(tx.from)} was approved for ${fmt(allowance)} of ${short(call.holder)}'s`, tool: "eth_call", tone: allowance < call.amount ? "cause" : "fine" });
    }
  }
  const outOfGas = receipt.gasUsed >= tx.gas;
  let cause: Explanation["cause"];
  if (replay && !replay.ok) cause = { kind: "revert", text: error ? error.meaning : `It reverted: ${replay.reason ?? "no reason given"}.`, error };
  else if (outOfGas) cause = { kind: "out-of-gas", text: `It ran out of gas: it used all ${tx.gas.toLocaleString("en-US")} it was given, and the same call succeeds with more.`, error: null };
  else cause = { kind: "earlier-in-block", text: `The same call succeeds against the state before block ${at}, so what made it fail happened in that block, before it: another transaction changed what it depended on.`, error: null };
  return finish({ status: "failed", block, readAt: parent.toString(), transaction, receipt: receiptOut, cause, findings, fix: fixFor(cause.kind, cause.error), headline: `It failed in block ${at}: ${summary}. ${cause.text}` });
}

async function byDescription(intent: Intent, chain: Chain, finish: Finish): Promise<Explanation> {
  const net = chain.network;
  const dry = await runDryRun(intent, { chain });
  const token = intent.kind === "erc20-transfer" || intent.kind === "erc20-approve" ? (knownToken(net, intent.token) ?? null) : null;
  const transaction = { hash: null, from: dry.tx.from, to: dry.tx.to, value: dry.tx.value, data: dry.tx.data, nonce: null, gasLimit: dry.gas?.gasLimit ?? null, summary: dry.summary };
  const at = BigInt(dry.block.number).toLocaleString("en-US");
  const findings: Finding[] = [{ check: "Simulated", seen: dry.simulation.ok ? `succeeds at block ${at}` : `reverts at block ${at}${dry.simulation.reason ? `: ${dry.simulation.reason}` : ""}`, tool: "eth_call", tone: dry.simulation.ok ? "fine" : "cause" }];
  for (const line of dry.outcome.filter((l) => l.role === "sender" && l.token !== null)) findings.push({ check: `Sender's ${line.asset}`, seen: `holds ${line.shown.before}`, tool: "eth_call", tone: "note" });
  findings.push({ check: "Funds for gas", seen: dry.funds.shown.needs ? `holds ${dry.funds.shown.holds}, needs ${dry.funds.shown.needs}` : `holds ${dry.funds.shown.holds}`, tool: "get_balance · estimate_gas", tone: dry.verdict === "cannot-pay" ? "cause" : "note" });
  const block = { number: dry.block.number, timestamp: dry.block.timestamp };
  if (dry.verdict === "would-succeed") {
    return finish({ status: "would-succeed", block, readAt: dry.block.number, transaction, receipt: null, cause: null, findings, fix: null, headline: `It would succeed if sent now: ${dry.summary}. Nothing to explain.` });
  }
  let cause: NonNullable<Explanation["cause"]>;
  if (dry.verdict === "cannot-pay") cause = { kind: "cannot-pay", text: dry.reason ?? "The sender cannot pay for it.", error: null };
  else {
    const error = decodeRevert(dry.simulation.returned, token);
    cause = { kind: "revert", text: error ? error.meaning : `It would revert: ${dry.simulation.reason ?? "no reason given"}.`, error };
  }
  return finish({ status: "would-fail", block, readAt: dry.block.number, transaction, receipt: null, cause, findings, fix: fixFor(cause.kind, cause.error), headline: `It would fail if sent now: ${dry.summary}. ${cause.text}` });
}
