// Task 11, Policy Gatekeeper: one requested action checked against a policy, at one pinned block.
//
//   1. Check the chain (get_chain_info) and pin one block (get_block_number, get_block).
//   2. Evaluate every rule in the policy's order, never stopping at the first that fails, so a denial
//      lists everything that is wrong:
//      - the allowlists and the per-action limit, from the request itself;
//      - the window limit, from the sender's own Transfer logs (get_logs, in pages of at most 1,000
//        blocks, ending at the pinned block), plus this action;
//      - the time window, from the pinned block's timestamp;
//      - the gas cap, from get_gas_price;
//      - the simulation, from a dry run at the pinned block (Task 08).
//   3. Allow only when every rule holds. A value that cannot be read never counts as holding.
//   4. Only with --execute, on Atlantic, and only when allowed: send the dry-run transaction exactly as it
//      was simulated, signed locally and broadcast through Chain MCP send_raw_transaction.
import { maxUint256, pad } from "viem";
import { formatAmount, formatGwei, parseAmount, parseGasPrice } from "../core/amounts.js";
import type { Address, BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError, errorMessage, ToolCallError } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import { knownToken, type Network } from "../core/networks.js";
import type { Intent } from "../dryrun/intent.js";
import { describeIntent, runDryRun, submitDryRun, type DryRun, type DryRunOptions, type Submission } from "../dryrun/run.js";
import { amountText, assetDecimals, DAYS, daysText, describeRule, minutesOf, offsetSeconds, zoneText, type Policy, type Rule, type RuleKind } from "./config.js";

export interface RuleOutcome {
  id: string;
  kind: RuleKind;
  label: string;
  /** Where the value came from: a Chain MCP tool, or "request" for what the request itself says. */
  tool: string;
  /** What was found, or null where nothing applied or nothing could be read. */
  observed: string | null;
  limit: string;
  /** null when the value could not be read: never counted as holding. */
  passed: boolean | null;
  /** More about the value: what a window counted, why a rule does not apply. */
  note: string | null;
  error: string | null;
}

export interface GateDecision {
  allowed: boolean;
  passed: number;
  total: number;
  failed: string[];
  unreadable: string[];
}

export interface GateRun {
  schema: "pharos-agent/policy-check/1";
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: Hex; timestamp: string; source: "latest" | "requested" };
  policy: { name: string; rules: number };
  request: Intent;
  summary: string;
  rules: RuleOutcome[];
  decision: GateDecision;
  /** The dry run of the request at the pinned block: what it would do and cost; null if it could not be read. */
  dryRun: DryRun | null;
  /** Only with --execute on Atlantic, when allowed: the transaction sent and its receipt against the prediction. */
  execution: Submission | null;
  /** Why an allowed request was not sent with --execute: it would not succeed. */
  notSent: string | null;
  outcome: "allowed" | "denied" | "executed";
  headline: string;
  toolCalls: number;
}

export interface GateOptions {
  chain: Chain;
  block?: bigint;
  /** Only to execute, on Atlantic: the sender's key. */
  signer?: Signer;
  wait?: DryRunOptions["wait"];
}

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** The widest block range one get_logs call may cover (the official server's limit). */
export const LOG_PAGE = 1000n;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** What a request means to the rules: the asset it moves or approves, how much, and to whom. */
interface Facts {
  asset: string;
  /** In the asset's units; "max" for an unlimited approval. */
  amount: string;
  /** The amount in base units: 2^256 − 1 for "max", null for a token outside the official list. */
  raw: bigint | null;
  counterparty: Address;
  role: "recipient" | "spender";
}

function factsOf(intent: Intent, net: Network): Facts {
  if (intent.kind === "call") throw new AgentError("usage", "The gatekeeper checks transfers and approvals: what a contract call spends cannot be read from the request.");
  const asset = intent.kind === "native-transfer" ? net.nativeSymbol : (knownToken(net, intent.token)?.symbol ?? intent.token);
  const decimals = assetDecimals(net, asset);
  const raw = intent.amount === "max" ? maxUint256 : decimals === null ? null : parseAmount(intent.amount, decimals, "amount");
  return intent.kind === "erc20-approve" ? { asset, amount: intent.amount, raw, counterparty: intent.spender, role: "spender" } : { asset, amount: intent.amount, raw, counterparty: intent.to, role: "recipient" };
}

const assetShown = (asset: string) => (asset.startsWith("0x") ? `token ${short(asset)}` : asset);
const actionAmount = (facts: Facts) => (facts.amount === "max" ? `unlimited ${facts.asset}` : amountText(facts.amount, assetShown(facts.asset)));

interface Context {
  chain: Chain;
  net: Network;
  pinned: BlockHeader;
  intent: Intent;
  facts: Facts;
  /** The dry run, run once, when first needed. */
  dryRun: () => Promise<DryRun>;
}

/** The tool behind a rule's value, for a rule that could not be read. */
const TOOL: Record<RuleKind, string> = { "asset-allowlist": "request", "counterparty-allowlist": "request", "max-per-action": "request", "max-in-window": "get_logs", "time-window": "get_block", "max-gas-price": "get_gas_price", simulates: "eth_call" };

/** A failure that leaves one rule unreadable; anything else (the connection, the budget, a refused request) stops the run. */
const unreadable = (error: unknown) => !(error instanceof AgentError) || error.kind === "mcp_tool";

type Found = Pick<RuleOutcome, "tool" | "observed" | "limit" | "passed" | "note">;

/** A limit on one asset says nothing about another. */
const notApplicable = (rule: { asset: string }, facts: Facts, limit: string): Found => ({ tool: "request", observed: null, limit, passed: true, note: `Applies to ${rule.asset} only; this is ${assetShown(facts.asset)}.` });

async function evaluate(rule: Rule, ctx: Context): Promise<Found> {
  const { chain, net, pinned, facts } = ctx;
  switch (rule.kind) {
    case "asset-allowlist":
      return { tool: "request", observed: assetShown(facts.asset), limit: `one of ${rule.assets.join(", ")}`, passed: rule.assets.includes(facts.asset), note: null };
    case "counterparty-allowlist": {
      const passed = rule.addresses.some((address) => address.toLowerCase() === facts.counterparty.toLowerCase());
      return { tool: "request", observed: facts.counterparty, limit: `${rule.addresses.length} allowed`, passed, note: passed ? null : `The ${facts.role} is not on the list.` };
    }
    case "max-per-action": {
      const limit = `≤ ${amountText(rule.amount, rule.asset)}`;
      if (facts.asset !== rule.asset) return notApplicable(rule, facts, limit);
      const cap = parseAmount(rule.amount, assetDecimals(net, rule.asset)!);
      return { tool: "request", observed: actionAmount(facts), limit, passed: facts.raw !== null && facts.raw <= cap, note: facts.amount === "max" ? "An unlimited approval is more than any limit." : null };
    }
    case "max-in-window": {
      const limit = `≤ ${amountText(rule.amount, rule.asset)}`;
      if (facts.asset !== rule.asset) return notApplicable(rule, facts, limit);
      const decimals = assetDecimals(net, rule.asset)!;
      const token = net.tokens.find((entry) => entry.symbol === rule.asset)!.address;
      const to = pinned.number;
      const from = to - BigInt(rule.blocks) + 1n > 0n ? to - BigInt(rule.blocks) + 1n : 0n;
      let spent = 0n;
      let transfers = 0;
      const sender = pad(ctx.intent.from.toLowerCase() as Hex, { size: 32 });
      for (let start = from; start <= to; start += LOG_PAGE) {
        const end = start + LOG_PAGE - 1n < to ? start + LOG_PAGE - 1n : to;
        const logs = await chain.logs({ address: token, topics: [TRANSFER_TOPIC, sender], fromBlock: start, toBlock: end });
        for (const log of logs) {
          // A transfer back to the sender moves nothing out.
          if (log.removed || log.topics[2]?.toLowerCase() === sender) continue;
          if (typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) throw new ToolCallError("get_logs", `a Transfer log with no amount (${String(log.data).slice(0, 20)})`);
          spent += BigInt(log.data);
          transfers += 1;
        }
      }
      const opened = await chain.block(from);
      const minutes = Math.round(Number(pinned.timestamp - opened.timestamp) / 60);
      const fmt = (value: bigint) => `${formatAmount(value, decimals, decimals === 18 ? 8 : 6)} ${rule.asset}`;
      const total = facts.raw === null ? null : spent + facts.raw;
      const cap = parseAmount(rule.amount, decimals);
      return {
        tool: "get_logs",
        observed: facts.amount === "max" ? `unlimited ${rule.asset}` : fmt(total!),
        limit,
        passed: total !== null && facts.amount !== "max" && total <= cap,
        note: `${fmt(spent)} sent in ${transfers} ${transfers === 1 ? "transfer" : "transfers"} over blocks ${from.toLocaleString("en-US")}–${to.toLocaleString("en-US")} (${minutes} min), plus ${actionAmount(facts)} now.`,
      };
    }
    case "time-window": {
      const local = Number(pinned.timestamp) + offsetSeconds(rule.utcOffset);
      const day = DAYS[(((Math.floor(local / 86_400) + 3) % 7) + 7) % 7]!; // 1 January 1970 was a Thursday
      const minute = Math.floor((((local % 86_400) + 86_400) % 86_400) / 60);
      const [from, to] = [minutesOf(rule.from), minutesOf(rule.to)];
      const inHours = from < to ? minute >= from && minute < to : minute >= from || minute < to;
      const onDay = rule.days.includes(day);
      const clock = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      return {
        tool: "get_block",
        observed: `${day[0]!.toUpperCase()}${day.slice(1)} ${clock} ${zoneText(rule.utcOffset)}`,
        limit: `${daysText(rule.days)}, ${rule.from}–${rule.to}`,
        passed: onDay && inHours,
        note: !onDay ? "Not an allowed day." : !inHours ? "Outside the allowed hours." : null,
      };
    }
    case "max-gas-price": {
      const { gasPrice } = await chain.gasPrice();
      return { tool: "get_gas_price", observed: formatGwei(gasPrice), limit: `≤ ${rule.gwei} gwei`, passed: gasPrice <= parseGasPrice(`${rule.gwei} gwei`), note: null };
    }
    case "simulates": {
      const run = await ctx.dryRun();
      const cost = run.gas ? `, about ${formatAmount(BigInt(run.gas.expectedCost), 18, 8)} ${net.nativeSymbol} in gas` : "";
      const observed = run.verdict === "would-succeed" ? `succeeds${cost}` : run.verdict === "would-revert" ? "reverts" : "cannot pay the fee";
      return { tool: "eth_call", observed, limit: "must succeed", passed: run.verdict === "would-succeed", note: run.reason };
    }
  }
}

export async function runGate(policy: Policy, intent: Intent, options: GateOptions): Promise<GateRun> {
  const { chain } = options;
  const net = chain.network;
  if (net.id !== policy.network) throw new AgentError("usage", `The policy is for ${policy.network}; this chain is ${net.id}.`);
  const facts = factsOf(intent, net);
  await chain.expectChain();
  const pinned = await chain.block(options.block ?? (await chain.blockNumber()));
  const source = options.block === undefined ? "latest" : "requested";
  let dry: Promise<DryRun> | null = null;
  const ctx: Context = { chain, net, pinned, intent, facts, dryRun: () => (dry ??= runDryRun(intent, { chain, at: { header: pinned, source } })) };

  const rules: RuleOutcome[] = [];
  for (const rule of policy.rules) {
    const base = { id: rule.id, kind: rule.kind, label: describeRule(rule, net, facts.role) };
    try {
      rules.push({ ...base, ...(await evaluate(rule, ctx)), error: null });
    } catch (error) {
      if (!unreadable(error)) throw error;
      rules.push({ ...base, tool: error instanceof ToolCallError ? error.tool : TOOL[rule.kind], observed: null, limit: "", passed: null, note: null, error: error instanceof ToolCallError ? error.detail : errorMessage(error).split("\n")[0]! });
    }
  }
  // Always dry-run, even without a simulates rule: the outcome and the cost are part of the answer.
  const run = await ctx.dryRun().catch((error: unknown) => {
    if (!unreadable(error)) throw error;
    return null;
  });
  const failed = rules.filter((r) => r.passed === false).map((r) => r.id);
  const unreadableIds = rules.filter((r) => r.passed === null).map((r) => r.id);
  const decision: GateDecision = { allowed: failed.length === 0 && unreadableIds.length === 0, passed: rules.filter((r) => r.passed === true).length, total: rules.length, failed, unreadable: unreadableIds };

  let execution: Submission | null = null;
  let notSent: string | null = null;
  if (options.signer) {
    if (net.id !== "atlantic-testnet") throw new AgentError("execution", "Executing is limited to the Atlantic testnet; on mainnet the gatekeeper decides only.");
    // Allowed is not enough to send: only a transaction whose dry run succeeds is ever signed.
    if (decision.allowed && run?.verdict === "would-succeed") execution = await submitDryRun(chain, run, options.signer, options.wait);
    else if (decision.allowed) notSent = run ? `The dry run says it ${run.verdict === "cannot-pay" ? "cannot pay its fee" : "would revert"}: ${run.reason}` : "The dry run could not be read.";
  }
  const summary = run?.summary ?? describeIntent(intent, net);
  const outcome = execution ? "executed" : decision.allowed ? "allowed" : "denied";
  const why = [...failed, ...unreadableIds].map((id) => rules.find((r) => r.id === id)!.label);
  const headline = decision.allowed
    ? `Allowed: ${summary}; all ${decision.total} rules hold${execution ? `. Sent as ${execution.txHash}` : notSent ? `. Not sent: ${notSent}` : ""}.`
    : `Denied: ${summary}. ${why.length} of ${decision.total} rules ${why.length === 1 ? "does" : "do"} not hold: ${why.join("; ")}.`;
  return {
    schema: "pharos-agent/policy-check/1",
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: pinned.number.toString(), hash: pinned.hash, timestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), source },
    policy: { name: policy.name, rules: policy.rules.length },
    request: intent,
    summary,
    rules,
    decision,
    dryRun: run,
    execution,
    notSent,
    outcome,
    headline,
    toolCalls: chain.mcp.toolCalls,
  };
}
