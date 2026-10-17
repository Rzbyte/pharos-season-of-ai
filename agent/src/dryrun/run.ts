// Task 08, Dry-Run Executor: what a transaction would do and cost, before it is sent.
//
//   1. Check the chain (get_chain_info) and pin one block.
//   2. Read the state the transaction would change, at that block: balances, an allowance, the code at
//      the addresses involved.
//   3. Simulate it with eth_call at the same block, from its sender.
//   4. Price it: estimate_gas, the latest base fee and priority fee, with the margin and fee cap the
//      agent signs with. The sender must be able to pay the value plus the maximum fee.
//   5. Predict the outcome from what the call means: who ends with how much.
//   6. Only with --submit, on Atlantic: sign locally, broadcast through Chain MCP send_raw_transaction,
//      then read the same values after the receipt and compare them with the prediction.
import { decodeFunctionResult, maxUint256 } from "viem";
import { decodeCall, ERC20, encodeCall, isTrueWord } from "../core/abi.js";
import { formatAmount, formatGwei } from "../core/amounts.js";
import type { Address, BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError, errorMessage } from "../core/errors.js";
import { signAndSend, type Signer } from "../core/execute.js";
import { knownToken, type Network } from "../core/networks.js";
import { quoteGas, simulate, type GasQuote, type Simulation } from "../core/simulate.js";
import { encodeIntent, parseCallSignature, type Intent } from "./intent.js";

export interface Line {
  /** What the value is: a balance of the sender or the recipient, or the allowance the sender gives. */
  role: "sender" | "recipient" | "allowance";
  address: Address;
  spender: Address | null;
  /** The token contract, or null for the native balance. */
  token: Address | null;
  asset: string;
  decimals: number;
  before: string;
  /** The predicted value; null when the transaction would not go through. */
  after: string | null;
  /** The sender's native balance pays gas, so its prediction rests on the gas estimate. */
  approximate: boolean;
  shown: { before: string; after: string | null; change: string | null };
}

export interface Warning {
  code: "self-transfer" | "recipient-contract" | "unlimited-approval" | "spender-not-contract" | "no-contract" | "zero-address";
  message: string;
}

export type Verdict = "would-succeed" | "would-revert" | "cannot-pay";

export interface Comparison {
  what: string;
  predicted: string;
  actual: string;
  match: boolean;
}

export interface Submission {
  txHash: Hex;
  nonce: number;
  status: "success" | "reverted" | "pending";
  blockNumber: string | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  cost: string | null;
  comparisons: Comparison[];
  matched: boolean;
}

export interface DryRun {
  schema: "pharos-agent/dry-run/1";
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: Hex; timestamp: string; source: "latest" | "requested" };
  intent: Intent;
  summary: string;
  tx: { from: Address; to: Address; data: Hex; value: string };
  simulation: Simulation;
  /** What the call returns, decoded, when it succeeds and has a declared result. */
  returns: string | null;
  gas: GasQuote | null;
  /** The sender's native balance against what it must hold: the value plus the maximum fee. */
  funds: { holds: string; needs: string | null; shown: { holds: string; needs: string | null } };
  outcome: Line[];
  warnings: Warning[];
  verdict: Verdict;
  reason: string | null;
  headline: string;
  submission: Submission | null;
  toolCalls: number;
}

export interface DryRunOptions {
  chain: Chain;
  block?: bigint;
  /** A block the caller already pinned, on a chain it already checked: the dry run reads there and asks for neither again. */
  at?: { header: BlockHeader; source: "latest" | "requested" };
  /** Present only to submit, on Atlantic: its address must be the sender. */
  signer?: Signer;
  wait?: { polls?: number; pollMs?: number };
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const ZERO = "0x0000000000000000000000000000000000000000";

/** The token's decimals at `block`, cross-checked with the official list; an address that is not a token is a usage error. */
async function tokenDecimals(chain: Chain, token: Address, block: bigint): Promise<number> {
  const code = await chain.code(token, block);
  if (code === "0x" || code.length <= 2) throw new AgentError("usage", `There is no contract at ${token} on ${chain.network.name}, so it is not a token.`);
  let decimals: number;
  try {
    decimals = Number(decodeCall(ERC20.decimals, await chain.call({ to: token, data: encodeCall(ERC20.decimals, []) }, block)) as bigint);
  } catch (error) {
    if (error instanceof AgentError && error.kind === "mcp_connection") throw error;
    throw new AgentError("usage", `${token} does not answer decimals() like an ERC-20 token (${errorMessage(error).split("\n")[0]}).`);
  }
  const official = knownToken(chain.network, token);
  if (official && official.decimals !== decimals) throw new AgentError("mcp_tool", `${official.symbol} reports ${decimals} decimals; the official token list says ${official.decimals}.`);
  return decimals;
}

/** An amount of `asset` for people; an allowance of 2^256 − 1 is the unlimited one. */
const shownAmount = (value: bigint, decimals: number, asset: string, role: Line["role"]) => (role === "allowance" && value === maxUint256 ? `unlimited ${asset}` : `${formatAmount(value, decimals, decimals === 18 ? 8 : 6)} ${asset}`);

function line(role: Line["role"], address: Address, token: Address | null, asset: string, decimals: number, before: bigint, after: bigint | null, approximate = false, spender: Address | null = null): Line {
  const fmt = (value: bigint) => shownAmount(value, decimals, asset, role);
  const change = after === null ? null : after - before;
  return {
    role,
    address,
    spender,
    token,
    asset,
    decimals,
    before: before.toString(),
    after: after === null ? null : after.toString(),
    approximate,
    shown: {
      before: fmt(before),
      after: after === null ? null : `${approximate ? "about " : ""}${fmt(after)}`,
      // An approval sets the allowance; it does not add to it.
      change: change === null ? null : change === 0n ? "no change" : role === "allowance" ? `set to ${fmt(after!)}` : `${change > 0n ? "+" : "−"}${fmt(change < 0n ? -change : change)}`,
    },
  };
}

const hasCode = async (chain: Chain, address: Address, block: bigint) => {
  const code = await chain.code(address, block);
  return code !== "0x" && code.length > 2;
};

/** The values the transaction would change, read at `block`, in the order they are shown. */
async function readState(chain: Chain, intent: Intent, decimals: number | null, block: bigint) {
  const net = chain.network;
  const sender = await chain.balance(intent.from, block);
  const values: { role: Line["role"]; address: Address; spender: Address | null; token: Address | null; asset: string; decimals: number; before: bigint }[] = [];
  const warnings: Warning[] = [];
  if (intent.kind === "erc20-transfer" || intent.kind === "erc20-approve") {
    const symbol = knownToken(net, intent.token)?.symbol ?? "tokens";
    if (intent.kind === "erc20-transfer") {
      const balanceOf = async (holder: Address) => decodeCall(ERC20.balanceOf, await chain.call({ to: intent.token, data: encodeCall(ERC20.balanceOf, [holder]) }, block)) as bigint;
      values.push({ role: "sender", address: intent.from, spender: null, token: intent.token, asset: symbol, decimals: decimals!, before: await balanceOf(intent.from) });
      if (intent.to.toLowerCase() === intent.from.toLowerCase()) warnings.push({ code: "self-transfer", message: "The sender and the recipient are the same address: nothing moves but the gas." });
      else {
        values.push({ role: "recipient", address: intent.to, spender: null, token: intent.token, asset: symbol, decimals: decimals!, before: await balanceOf(intent.to) });
        if (intent.to.toLowerCase() === ZERO) warnings.push({ code: "zero-address", message: "The recipient is the zero address." });
        else if (await hasCode(chain, intent.to, block)) warnings.push({ code: "recipient-contract", message: `The recipient is a contract. ${symbol} sent to a contract that cannot move it stays there.` });
      }
    } else {
      const allowance = decodeCall(ERC20.allowance, await chain.call({ to: intent.token, data: encodeCall(ERC20.allowance, [intent.from, intent.spender]) }, block)) as bigint;
      values.push({ role: "allowance", address: intent.from, spender: intent.spender, token: intent.token, asset: symbol, decimals: decimals!, before: allowance });
      if (intent.amount === "max") warnings.push({ code: "unlimited-approval", message: `This approves the spender for every ${symbol} the sender will ever hold.` });
      if (!(await hasCode(chain, intent.spender, block))) warnings.push({ code: "spender-not-contract", message: "The spender is not a contract: an approval is usually for a contract, such as a DEX router or a vault." });
    }
  } else if (intent.kind === "native-transfer") {
    if (intent.to.toLowerCase() === intent.from.toLowerCase()) warnings.push({ code: "self-transfer", message: "The sender and the recipient are the same address: nothing moves but the gas." });
    else {
      values.push({ role: "recipient", address: intent.to, spender: null, token: null, asset: net.nativeSymbol, decimals: 18, before: await chain.balance(intent.to, block) });
      if (intent.to.toLowerCase() === ZERO) warnings.push({ code: "zero-address", message: "The recipient is the zero address: whatever is sent there is gone." });
      else if (await hasCode(chain, intent.to, block)) warnings.push({ code: "recipient-contract", message: `The recipient is a contract: it may reject ${net.nativeSymbol} or keep it.` });
    }
  } else if (!(await hasCode(chain, intent.to, block))) {
    warnings.push({ code: "no-contract", message: "There is no contract at this address: the call would succeed and do nothing." });
  }
  return { sender, values, warnings };
}

export async function runDryRun(intent: Intent, options: DryRunOptions): Promise<DryRun> {
  const { chain } = options;
  const net = chain.network;
  if (!options.at) await chain.expectChain();
  const pinned: BlockHeader = options.at?.header ?? (await chain.block(options.block ?? (await chain.blockNumber())));
  const decimals = intent.kind === "erc20-transfer" || intent.kind === "erc20-approve" ? await tokenDecimals(chain, intent.token, pinned.number) : null;
  const tx = encodeIntent(intent, decimals);
  const { sender, values, warnings } = await readState(chain, intent, decimals, pinned.number);

  const simulation = await simulate(chain, { from: tx.from, to: tx.to, data: tx.data === "0x" ? undefined : tx.data, value: tx.value }, pinned.number);
  let returns: string | null = null;
  let verdict: Verdict = "would-succeed";
  let reason: string | null = null;
  let gas: GasQuote | null = null;
  if (!simulation.ok) {
    verdict = "would-revert";
    reason = `It reverts: ${simulation.reason}.`;
  } else {
    if (intent.kind === "erc20-transfer" || intent.kind === "erc20-approve") {
      if (simulation.returned !== "0x" && !isTrueWord(simulation.returned ?? "0x")) {
        returns = "false";
        verdict = "would-revert";
        reason = `The token returns false: the ${intent.kind === "erc20-transfer" ? "transfer" : "approval"} would not happen.`;
      } else returns = simulation.returned === "0x" ? "nothing (the token returns no value)" : "true";
    } else if (intent.kind === "call") {
      const abi = parseCallSignature(intent.signature);
      if (abi.outputs.length && simulation.returned && simulation.returned !== "0x") {
        try {
          const value = decodeFunctionResult({ abi: [abi], functionName: abi.name, data: simulation.returned }) as unknown;
          returns = JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
        } catch {
          returns = simulation.returned;
        }
      }
    }
    if (verdict === "would-succeed") {
      const quoted = await quoteGas(chain, { from: tx.from, to: tx.to, data: tx.data === "0x" ? undefined : tx.data, value: tx.value });
      if (quoted.quote === null) {
        verdict = "would-revert";
        reason = `Gas estimation reverts: ${quoted.reason}.`;
      } else gas = quoted.quote;
    }
  }

  const needs = gas ? tx.value + BigInt(gas.maxCost) : null;
  if (verdict === "would-succeed" && needs !== null && sender < needs) {
    verdict = "cannot-pay";
    reason = `The sender holds ${formatAmount(sender, 18, 8)} ${net.nativeSymbol} but needs up to ${formatAmount(needs, 18, 8)} ${net.nativeSymbol}: the value plus the maximum fee.`;
  }

  // The predicted outcome, only for a transaction that would go through. A transfer to oneself moves
  // nothing but its gas.
  const succeeds = verdict === "would-succeed";
  const self = selfTransfer(intent);
  const expectedCost = gas ? BigInt(gas.expectedCost) : 0n;
  const outcome: Line[] = [];
  for (const value of values) {
    let after: bigint | null = null;
    if (succeeds) {
      if (value.role === "allowance") after = tx.amountRaw;
      else if (self) after = value.before;
      else if (value.role === "sender") after = value.before - tx.amountRaw;
      else after = value.before + tx.amountRaw;
    }
    outcome.push(line(value.role, value.address, value.token, value.asset, value.decimals, value.before, after, false, value.spender));
  }
  const nativeOut = self && intent.kind === "native-transfer" ? 0n : tx.value;
  outcome.push(line("sender", intent.from, null, net.nativeSymbol, 18, sender, succeeds ? sender - nativeOut - expectedCost : null, succeeds));

  const summary = describeIntent(intent, net);
  const verdictWord = verdict === "would-succeed" ? "Would succeed" : verdict === "would-revert" ? "Would revert" : "Cannot pay";
  let submission: Submission | null = null;
  if (options.signer) {
    if (net.id !== "atlantic-testnet") throw new AgentError("execution", "Submitting is limited to the Atlantic testnet; on mainnet the dry run is the whole job.");
    if (options.signer.address.toLowerCase() !== intent.from.toLowerCase()) throw new AgentError("execution", `The key's address ${options.signer.address} is not the sender ${intent.from}.`);
    if (verdict === "would-succeed" && gas) submission = await submit(chain, options.signer, options.wait, tx, gas, outcome, nativeOut);
  }
  const headline = `${verdictWord}: ${summary}${reason ? `. ${reason}` : gas ? `, for about ${formatAmount(expectedCost, 18, 8)} ${net.nativeSymbol} in gas.` : "."}`;
  return {
    schema: "pharos-agent/dry-run/1",
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: pinned.number.toString(), hash: pinned.hash, timestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), source: options.at?.source ?? (options.block === undefined ? "latest" : "requested") },
    intent,
    summary,
    tx: { from: tx.from, to: tx.to, data: tx.data, value: tx.value.toString() },
    simulation,
    returns,
    gas,
    funds: { holds: sender.toString(), needs: needs?.toString() ?? null, shown: { holds: `${formatAmount(sender, 18, 8)} ${net.nativeSymbol}`, needs: needs === null ? null : `${formatAmount(needs, 18, 8)} ${net.nativeSymbol}` } },
    outcome,
    warnings,
    verdict,
    reason,
    headline,
    submission,
    toolCalls: chain.mcp.toolCalls,
  };
}

const selfTransfer = (intent: Intent) => (intent.kind === "erc20-transfer" || intent.kind === "native-transfer") && intent.to.toLowerCase() === intent.from.toLowerCase();

/**
 * Send the transaction a dry run prepared, exactly as it was simulated, then compare the receipt with its
 * prediction (Atlantic only). For a caller that decides between the dry run and the send, such as the
 * policy gatekeeper.
 */
export async function submitDryRun(chain: Chain, run: DryRun, signer: Signer, wait?: DryRunOptions["wait"]): Promise<Submission> {
  if (chain.network.id !== "atlantic-testnet") throw new AgentError("execution", "Submitting is limited to the Atlantic testnet; on mainnet the dry run is the whole job.");
  if (signer.address.toLowerCase() !== run.tx.from.toLowerCase()) throw new AgentError("execution", `The key's address ${signer.address} is not the sender ${run.tx.from}.`);
  if (run.verdict !== "would-succeed" || !run.gas) throw new AgentError("execution", `Only a transaction that would succeed is sent; this one ${run.verdict === "cannot-pay" ? "cannot pay its fee" : "would revert"}.`);
  const nativeOut = selfTransfer(run.intent) && run.intent.kind === "native-transfer" ? 0n : BigInt(run.tx.value);
  return submit(chain, signer, wait, { to: run.tx.to, data: run.tx.data, value: BigInt(run.tx.value) }, run.gas, run.outcome, nativeOut);
}

/** A transaction in words: "Send 25 USDC from 0x912c…f647 to 0xB274…9553". */
export function describeIntent(intent: Intent, net: Network): string {
  switch (intent.kind) {
    case "native-transfer":
      return `Send ${intent.amount} ${net.nativeSymbol} from ${short(intent.from)} to ${short(intent.to)}`;
    case "erc20-transfer":
      return `Send ${intent.amount} ${knownToken(net, intent.token)?.symbol ?? "tokens"} from ${short(intent.from)} to ${short(intent.to)}`;
    case "erc20-approve":
      return `Approve ${short(intent.spender)} to spend ${intent.amount === "max" ? "unlimited" : intent.amount} ${knownToken(net, intent.token)?.symbol ?? "tokens"} of ${short(intent.from)}`;
    case "call":
      return `Call ${parseCallSignature(intent.signature).name}(…) on ${short(intent.to)} from ${short(intent.from)}`;
  }
}

/**
 * Send it, then compare. Every predicted value is read again just before and just after the receipt's
 * block, so other activity before it does not count: token balances must change by exactly the
 * predicted amount, an allowance must be exactly the approved one, and the sender's native balance
 * must drop by exactly the value plus the fee the receipt reports.
 */
async function submit(chain: Chain, signer: Signer, wait: DryRunOptions["wait"], tx: { to: Address; data: Hex; value: bigint }, gas: GasQuote, outcome: Line[], nativeOut: bigint): Promise<Submission> {
  const sent = await signAndSend(chain, signer, { to: tx.to, data: tx.data === "0x" ? undefined : tx.data, value: tx.value, gasEstimate: BigInt(gas.gas) }, wait);
  const base: Submission = { txHash: sent.hash, nonce: sent.nonce, status: "pending", blockNumber: null, gasUsed: null, effectiveGasPrice: null, cost: null, comparisons: [], matched: false };
  const receipt = sent.receipt;
  if (!receipt) return base;
  const block = receipt.blockNumber;
  const cost = receipt.gasUsed * (receipt.effectiveGasPrice ?? BigInt(gas.expectedFeePerGas));
  const comparisons: Comparison[] = [{ what: "Status", predicted: "success", actual: receipt.status, match: receipt.status === "success" }];
  for (const predicted of outcome) {
    const name = `${predicted.role === "allowance" ? "Allowance" : predicted.role === "sender" ? "Sender" : "Recipient"} ${predicted.asset}`;
    const fmt = (value: bigint) => `${value < 0n ? "−" : value > 0n ? "+" : ""}${formatAmount(value < 0n ? -value : value, predicted.decimals, 8)} ${predicted.asset}`;
    const after = await readAgain(chain, predicted, block);
    if (predicted.role === "allowance") {
      comparisons.push({ what: name, predicted: predicted.shown.after ?? "", actual: shownAmount(after, predicted.decimals, predicted.asset, "allowance"), match: predicted.after !== null && BigInt(predicted.after) === after });
      continue;
    }
    const change = after - (await readAgain(chain, predicted, block - 1n));
    if (predicted.token === null && predicted.role === "sender") {
      // The native balance pays the fee: it must drop by the value sent plus the fee the receipt reports.
      const exact = -(nativeOut + cost);
      comparisons.push({ what: name, predicted: `${fmt(-(nativeOut + BigInt(gas.expectedCost)))} (fee estimated)`, actual: `${fmt(change)} (fee ${formatAmount(cost, 18, 8)})`, match: change === exact });
    } else {
      const expected = BigInt(predicted.after ?? predicted.before) - BigInt(predicted.before);
      comparisons.push({ what: name, predicted: fmt(expected), actual: fmt(change), match: change === expected });
    }
  }
  comparisons.push({ what: "Gas used", predicted: `estimate ${BigInt(gas.gas).toLocaleString("en-US")}, limit ${BigInt(gas.gasLimit).toLocaleString("en-US")}`, actual: receipt.gasUsed.toLocaleString("en-US"), match: receipt.gasUsed <= BigInt(gas.gasLimit) });
  comparisons.push({ what: "Fee per gas", predicted: `about ${formatGwei(BigInt(gas.expectedFeePerGas))}, at most ${formatGwei(BigInt(gas.maxFeePerGas))}`, actual: receipt.effectiveGasPrice === null ? "not reported" : formatGwei(receipt.effectiveGasPrice), match: receipt.effectiveGasPrice === null || receipt.effectiveGasPrice <= BigInt(gas.maxFeePerGas) });
  return { ...base, status: receipt.status, blockNumber: block.toString(), gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null, cost: cost.toString(), comparisons, matched: comparisons.every((c) => c.match) };
}

/** One predicted value, read again at `block`. */
async function readAgain(chain: Chain, predicted: Line, block: bigint): Promise<bigint> {
  if (predicted.token === null) return chain.balance(predicted.address, block);
  if (predicted.role === "allowance") return decodeCall(ERC20.allowance, await chain.call({ to: predicted.token, data: encodeCall(ERC20.allowance, [predicted.address, predicted.spender!]) }, block)) as bigint;
  return decodeCall(ERC20.balanceOf, await chain.call({ to: predicted.token, data: encodeCall(ERC20.balanceOf, [predicted.address]) }, block)) as bigint;
}
