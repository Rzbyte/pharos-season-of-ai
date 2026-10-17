// Task 24, Gas Fee Optimizer: one run.
//
//   1. Check the chain (get_chain_info), pin the newest block, and read the node's gas price and
//      priority fee (get_gas_price). The block's base fee is the observation (the gas price, on a chain
//      whose blocks carry none).
//   2. With no observations yet, read the base fee of a few earlier blocks (backfill), so a first run has
//      something to judge by. Keep the newest `window` observations.
//   3. The target: a percentile of the observed fees, or a fixed fee.
//   4. Dry-run the transaction at the pinned block (Task 08): would it succeed, and how much gas.
//   5. Decide: send when the fee is at or below the target, or the plan has waited past its deadline;
//      otherwise wait. Price it both ways, and give the fee settings to send it with: a cap of the
//      target (never more), plus the priority fee.
//   6. On Atlantic with a signer, send it when the decision is to send, with those settings, once.
import { formatAmount, formatGwei } from "../core/amounts.js";
import type { BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import { runDryRun, submitDryRun, type DryRun, type DryRunOptions, type Submission } from "../dryrun/run.js";
import { describeTarget, type GasPlan } from "./config.js";
import type { GasObservation, GasStore } from "./store.js";

export type GasDecision = "send" | "wait" | "blocked" | "sent";

export interface GasRun {
  schema: "pharos-agent/gas-run/1";
  plan: string;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: Hex; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  /** This run's new observations: earlier blocks read to fill in a first run, then the pinned block. */
  observed: GasObservation[];
  /** The observations judged, oldest first: the newest `window`. */
  window: GasObservation[];
  fee: { now: string; source: GasObservation["source"]; tip: string; shown: { now: string; tip: string } };
  stats: { min: string; median: string; max: string; steady: boolean; shown: { min: string; median: string; max: string } };
  target: { fee: string; shown: string; how: string };
  decision: GasDecision;
  reason: string;
  /** The fee settings to send it with: capped at the target (at the fee of the moment past the deadline). Null when it is not to be sent. */
  settings: { maxFeePerGas: string; maxPriorityFeePerGas: string; shown: { maxFeePerGas: string; maxPriorityFeePerGas: string } } | null;
  /** In the native token, from the dry run's gas: now, at the target, what waiting saves, and the most each fee cap could cost. */
  costs: { gas: string; gasLimit: string; now: string; atTarget: string; saving: string; standardMax: string; cappedMax: string; shown: { now: string; atTarget: string; saving: string; standardMax: string; cappedMax: string } } | null;
  dryRun: DryRun;
  execution: Submission | null;
  notSent: string | null;
  store: GasStore;
  headline: string;
  toolCalls: number;
}

export interface GasOptions {
  chain: Chain;
  block?: bigint;
  now?: () => Date;
  /** Present only to send, on Atlantic: its address must be the transaction's sender. */
  signer?: Signer;
  wait?: DryRunOptions["wait"];
}

/** The nearest-rank percentile of `values` (sorted ascending). */
export function percentile(sorted: readonly bigint[], p: number): bigint {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

export async function runGasPlan(plan: GasPlan, store: GasStore, options: GasOptions): Promise<GasRun> {
  const { chain } = options;
  const net = chain.network;
  if (net.id !== plan.network) throw new AgentError("usage", `The gas plan is for ${plan.network}; this chain is ${net.id}.`);
  if (options.signer && net.id !== "atlantic-testnet") throw new AgentError("usage", "Sending is limited to the Atlantic testnet; on Pharos Mainnet the optimizer only advises.");
  const evaluatedAt = (options.now ?? (() => new Date()))();
  await chain.expectChain();
  const pinned: BlockHeader = await chain.block(options.block ?? (await chain.blockNumber()));
  const at = pinned.number;
  const { gasPrice, priorityFee } = await chain.gasPrice();
  const source: GasObservation["source"] = pinned.baseFeePerGas !== null ? "base-fee" : "gas-price";
  const fee = pinned.baseFeePerGas ?? gasPrice;
  const observe = (header: BlockHeader, value: bigint): GasObservation => ({ block: header.number.toString(), timestamp: iso(header.timestamp), fee: value.toString(), source, gasUsed: header.gasUsed.toString(), gasLimit: header.gasLimit.toString() });

  // Observations of one kind: a store of the other kind starts over.
  const kept = store.observations.filter((o) => o.source === source);
  const observed: GasObservation[] = [];
  if (kept.length === 0 && plan.backfill && source === "base-fee") {
    for (let k = plan.backfill.samples; k >= 1; k -= 1) {
      const earlier = at - BigInt(k * plan.backfill.spacing);
      if (earlier < 0n) continue;
      const header = await chain.block(earlier);
      if (header.baseFeePerGas !== null) observed.push(observe(header, header.baseFeePerGas));
    }
  }
  const last = kept.at(-1);
  if (!last || at > BigInt(last.block)) observed.push(observe(pinned, fee));
  const window = [...kept, ...observed].slice(-plan.window);

  const sorted = window.map((o) => BigInt(o.fee)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const [min, median, max] = [sorted[0]!, percentile(sorted, 50), sorted.at(-1)!];
  const steady = sorted.length >= 2 && min === max;
  const target = plan.target.kind === "fee" ? BigInt(plan.target.fee) : percentile(sorted, plan.target.percentile);
  const how = describeTarget(plan.target, plan.window);

  const dryRun = await runDryRun(plan.transaction, { chain, at: { header: pinned, source: options.block === undefined ? "latest" : "requested" } });

  // Fees: with a base fee, the priority fee comes on top; a gas price already includes it.
  const tip = source === "base-fee" ? priorityFee : 0n;
  const what = source === "base-fee" ? "The base fee" : "The gas price";
  const g = dryRun.gas ? BigInt(dryRun.gas.gas) : null;
  const saving = g !== null && fee > target ? g * (fee - target) : 0n;
  const native = (wei: bigint) => `${formatAmount(wei, 18, 8)} ${net.nativeSymbol}`;
  let decision: GasDecision;
  let reason: string;
  if (store.sent) {
    decision = "sent";
    reason = `It was sent at block ${BigInt(store.sent.block).toLocaleString("en-US")}; a plan is sent once.`;
  } else if (dryRun.verdict !== "would-succeed" || g === null) {
    decision = "blocked";
    reason = `The transaction ${dryRun.verdict === "cannot-pay" ? "cannot pay its fee" : "would revert"}${dryRun.reason ? `: ${dryRun.reason}` : ""}. It is not sent at any fee.`;
  } else if (fee <= target) {
    decision = "send";
    reason = steady ? `${what} has held at ${formatGwei(fee)} across ${window.length} observations, so waiting saves nothing.` : `${what}, ${formatGwei(fee)}, is at or below the target, ${formatGwei(target)} (${how}).`;
  } else if (plan.deadline !== null && store.waitingSince !== null && at - BigInt(store.waitingSince) >= BigInt(plan.deadline)) {
    decision = "send";
    reason = `${what}, ${formatGwei(fee)}, is above the target, ${formatGwei(target)}, but the plan has waited ${(at - BigInt(store.waitingSince)).toLocaleString("en-US")} blocks, its deadline.`;
  } else {
    decision = "wait";
    reason = `${what}, ${formatGwei(fee)}, is above the target, ${formatGwei(target)} (${how}). Waiting for it would save about ${native(saving)} on this transaction.`;
  }

  // The cap: the target while waiting (a transaction with it waits until the fee comes down), and at
  // least the fee of the moment when sending.
  let settings: GasRun["settings"] = null;
  let maxFeePerGas = 0n;
  let maxPriorityFeePerGas = 0n;
  if (decision === "send" || decision === "wait") {
    maxFeePerGas = (decision === "send" && fee > target ? fee : target) + tip;
    maxPriorityFeePerGas = priorityFee < maxFeePerGas ? priorityFee : maxFeePerGas;
    settings = { maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString(), shown: { maxFeePerGas: formatGwei(maxFeePerGas), maxPriorityFeePerGas: formatGwei(maxPriorityFeePerGas) } };
  }
  let costs: GasRun["costs"] = null;
  if (dryRun.gas && g !== null) {
    const limit = BigInt(dryRun.gas.gasLimit);
    const now = g * (fee + tip);
    const atTarget = g * ((fee < target ? fee : target) + tip);
    const standardMax = limit * (source === "base-fee" ? fee * 2n + priorityFee : fee * 2n);
    // The most it can cost: with the settings given, or else with a cap at the higher of the fee and the target.
    const cappedMax = limit * (settings ? maxFeePerGas : (fee > target ? fee : target) + tip);
    costs = { gas: g.toString(), gasLimit: limit.toString(), now: now.toString(), atTarget: atTarget.toString(), saving: saving.toString(), standardMax: standardMax.toString(), cappedMax: cappedMax.toString(), shown: { now: native(now), atTarget: native(atTarget), saving: native(saving), standardMax: native(standardMax), cappedMax: native(cappedMax) } };
  }

  let execution: Submission | null = null;
  let notSent: string | null;
  if (options.signer && decision === "send") {
    execution = await submitDryRun(chain, dryRun, options.signer, options.wait, { maxFeePerGas, maxPriorityFeePerGas });
    notSent = null;
  } else if (options.signer) notSent = decision === "wait" ? "Waiting for a lower fee: nothing was sent." : decision === "blocked" ? "The transaction would not succeed: nothing was sent." : "Already sent: nothing was sent again.";
  else notSent = net.id === "atlantic-testnet" ? "Nothing was sent: run with --execute to send it when the fee is right." : "Nothing was signed or sent: on Pharos Mainnet the optimizer only advises.";

  const after: GasStore = {
    ...store,
    observations: window,
    waitingSince: decision === "wait" ? (store.waitingSince ?? at.toString()) : decision === "blocked" ? store.waitingSince : null,
    sent: execution ? { block: at.toString(), tx: execution.txHash } : store.sent,
  };
  const word = execution ? "Sent" : { send: "Send now", wait: "Wait", blocked: "Not sendable", sent: "Already sent" }[decision];
  const headline = `${word}: ${dryRun.summary}. ${reason}${decision === "send" && costs ? ` About ${costs.shown.now} in gas.` : ""}`;
  return {
    schema: "pharos-agent/gas-run/1",
    plan: plan.name,
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: at.toString(), hash: pinned.hash, timestamp: iso(pinned.timestamp), source: options.block === undefined ? "latest" : "requested" },
    evaluatedAt: evaluatedAt.toISOString(),
    observed,
    window,
    fee: { now: fee.toString(), source, tip: tip.toString(), shown: { now: formatGwei(fee), tip: formatGwei(tip) } },
    stats: { min: min.toString(), median: median.toString(), max: max.toString(), steady, shown: { min: formatGwei(min), median: formatGwei(median), max: formatGwei(max) } },
    target: { fee: target.toString(), shown: formatGwei(target), how },
    decision,
    reason,
    settings,
    costs,
    dryRun,
    execution,
    notSent,
    store: after,
    headline,
    toolCalls: chain.mcp.toolCalls,
  };
}
