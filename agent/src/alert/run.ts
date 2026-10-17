// Task 22, On-Chain Alert Bot: one run.
//
//   1. Check the chain (get_chain_info) and pin the newest block.
//   2. Transfer rules: scan the blocks after the last run's (the cursor) up to the pinned one with
//      get_logs, in pages of at most 1,000 blocks, filtered by token, sender and recipient. Every
//      matching transfer of at least the rule's amount is one alert; the next run starts after this
//      block, so none is reported twice. A first run looks back `lookback` blocks; a run more than
//      `maxScan` blocks behind scans the newest `maxScan` and says which it skipped.
//   3. State rules: read at the pinned block, as a guardian reads its conditions, and compared with the
//      last run. A condition that starts to hold is an alert ("triggered"); one that stops holding is
//      "resolved"; a value that cannot be read changes nothing.
//   4. The new alerts join the store's pending ones. Delivering them is the caller's: stdout, a
//      webhook, the page.
import { getAddress, pad } from "viem";
import { decodeCall, encodeCall, ERC20 } from "../core/abi.js";
import { formatAmount, parseAmount } from "../core/amounts.js";
import type { BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { knownToken } from "../core/networks.js";
import { readConditions } from "../guardian/run.js";
import { LOG_PAGE, TRANSFER_TOPIC } from "../policy/check.js";
import type { AlertBot, TransferRule } from "./config.js";
import type { Alert, AlertStore } from "./store.js";

export interface RuleReport {
  id: string;
  label: string;
  kind: "state" | "transfer";
  /** A state rule's condition now: holds, clear, or unreadable. Null for a transfer rule. */
  state: "holds" | "clear" | "unreadable" | null;
  observed: string | null;
  threshold: string | null;
  tool: string;
  error: string | null;
  /** A transfer rule's matching transfers this run. Null for a state rule. */
  matches: number | null;
}

export interface AlertRun {
  schema: "pharos-agent/alert-run/1";
  bot: string;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: Hex; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  /** The blocks the transfer rules scanned this run, or null when there were none new. */
  scanned: { from: string; to: string; pages: number } | null;
  /** Blocks not scanned because the run was too far behind. */
  skipped: { from: string; to: string } | null;
  rules: RuleReport[];
  alerts: Alert[];
  /** Matching transfers beyond the most one run reports (MAX_ALERTS). */
  truncated: number;
  store: AlertStore;
  headline: string;
  toolCalls: number;
}

export interface AlertOptions {
  chain: Chain;
  block?: bigint;
  now?: () => Date;
}

/** The most transfers one run reports (a condition's alerts are never cut), and the most alerts a store keeps waiting for delivery. */
export const MAX_ALERTS = 100;
export const MAX_PENDING = 500;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const addressOf = (topic: string) => getAddress(`0x${topic.slice(-40)}`);

/** Every transfer matching `rule` in blocks from..to, oldest first, as alerts. */
async function transfers(chain: Chain, rule: TransferRule, from: bigint, to: bigint, decimals: number): Promise<{ alerts: Alert[]; pages: number }> {
  const symbol = knownToken(chain.network, rule.token)?.symbol ?? "tokens";
  const min = parseAmount(rule.min, decimals);
  const topics: (Hex | null)[] = [TRANSFER_TOPIC as Hex, rule.from ? pad(rule.from.toLowerCase() as Hex, { size: 32 }) : null, rule.to ? pad(rule.to.toLowerCase() as Hex, { size: 32 }) : null];
  while (topics.at(-1) === null) topics.pop();
  const alerts: Alert[] = [];
  let pages = 0;
  for (let start = from; start <= to; start += LOG_PAGE) {
    const end = start + LOG_PAGE - 1n < to ? start + LOG_PAGE - 1n : to;
    pages += 1;
    for (const log of await chain.logs({ address: rule.token, topics, fromBlock: start, toBlock: end })) {
      // An ERC-20 Transfer has the two addresses as topics and the amount as data; anything else is not one.
      if (log.removed || log.topics.length !== 3 || typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
      const amount = BigInt(log.data);
      if (amount < min) continue;
      const [sender, recipient] = [addressOf(log.topics[1]!), addressOf(log.topics[2]!)];
      const block = BigInt(log.blockNumber);
      const shown = `${formatAmount(amount, decimals, 6)} ${symbol}`;
      alerts.push({
        id: `${rule.id}:${log.transactionHash}:${Number(log.logIndex)}`,
        rule: rule.id,
        label: rule.label,
        kind: "transfer",
        block: block.toString(),
        message: `${shown} from ${short(sender)} to ${short(recipient)} at block ${block.toLocaleString("en-US")}`,
        transfer: { tx: log.transactionHash, logIndex: Number(log.logIndex), from: sender, to: recipient, amount: amount.toString(), shown },
        observed: null,
      });
    }
  }
  return { alerts, pages };
}

export async function runAlerts(bot: AlertBot, store: AlertStore, options: AlertOptions): Promise<AlertRun> {
  const { chain } = options;
  const net = chain.network;
  if (net.id !== bot.network) throw new AgentError("usage", `The alert bot is for ${bot.network}; this chain is ${net.id}.`);
  const now = (options.now ?? (() => new Date()))();
  await chain.expectChain();
  const pinned: BlockHeader = await chain.block(options.block ?? (await chain.blockNumber()));
  const at = pinned.number.toLocaleString("en-US");

  // The blocks this run is responsible for: after the cursor, at most maxScan of them.
  const to = pinned.number;
  let from = store.cursor === null ? (to - BigInt(bot.lookback) + 1n > 0n ? to - BigInt(bot.lookback) + 1n : 0n) : BigInt(store.cursor) + 1n;
  let skipped: AlertRun["skipped"] = null;
  if (from <= to && to - from + 1n > BigInt(bot.maxScan)) {
    skipped = { from: from.toString(), to: (to - BigInt(bot.maxScan)).toString() };
    from = to - BigInt(bot.maxScan) + 1n;
  }
  const scanning = from <= to;

  const reports: RuleReport[] = [];
  let found: Alert[] = [];
  const changes: Alert[] = [];
  let pages = 0;
  const states = { ...store.states };
  const stateRules = bot.rules.filter((r) => r.kind === "state");
  const outcomes = stateRules.length ? await readConditions(chain, stateRules.map((r) => r.condition), pinned, now) : [];
  for (const rule of bot.rules) {
    if (rule.kind === "transfer") {
      if (!scanning) {
        reports.push({ id: rule.id, label: rule.label, kind: "transfer", state: null, observed: null, threshold: null, tool: "get_logs", error: null, matches: 0 });
        continue;
      }
      const decimals = knownToken(net, rule.token)?.decimals ?? Number(decodeCall(ERC20.decimals, await chain.call({ to: rule.token, data: encodeCall(ERC20.decimals, []) }, pinned.number)) as bigint);
      const scan = await transfers(chain, rule, from, to, decimals);
      pages += scan.pages;
      found = found.concat(scan.alerts);
      reports.push({ id: rule.id, label: rule.label, kind: "transfer", state: null, observed: null, threshold: null, tool: "get_logs", error: null, matches: scan.alerts.length });
      continue;
    }
    const o = outcomes[stateRules.indexOf(rule)]!;
    const before = store.states[rule.id];
    reports.push({ id: rule.id, label: rule.label, kind: "state", state: o.passed === null ? "unreadable" : o.passed ? "holds" : "clear", observed: o.observed, threshold: `${o.op} ${o.threshold}`, tool: o.tool, error: o.error, matches: null });
    if (o.passed === null) continue;
    states[rule.id] = o.passed;
    if (o.passed && before !== true) changes.push({ id: `${rule.id}:${pinned.number}:triggered`, rule: rule.id, label: rule.label, kind: "triggered", block: pinned.number.toString(), message: `${o.observed} at block ${at}`, transfer: null, observed: o.observed });
    else if (!o.passed && before === true) changes.push({ id: `${rule.id}:${pinned.number}:resolved`, rule: rule.id, label: rule.label, kind: "resolved", block: pinned.number.toString(), message: `no longer holds: ${o.observed} at block ${at}`, transfer: null, observed: o.observed });
  }

  // At most MAX_ALERTS transfers, the oldest first; every change of a condition, whose new state is stored either way.
  const alerts = [...found.slice(0, MAX_ALERTS), ...changes];
  const after: AlertStore = { ...store, cursor: to > BigInt(store.cursor ?? -1) ? to.toString() : store.cursor, states, pending: [...store.pending, ...alerts].slice(-MAX_PENDING) };
  const headline = alerts.length
    ? `${alerts.length} new ${alerts.length === 1 ? "alert" : "alerts"} at block ${at}: ${alerts[0]!.label}: ${alerts[0]!.message}${alerts.length > 1 ? " …" : "."}`
    : `No new alerts at block ${at}${scanning ? `; blocks ${from.toLocaleString("en-US")}–${at} scanned` : "; no new blocks"}.`;
  return {
    schema: "pharos-agent/alert-run/1",
    bot: bot.name,
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: pinned.number.toString(), hash: pinned.hash, timestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), source: options.block === undefined ? "latest" : "requested" },
    evaluatedAt: now.toISOString(),
    scanned: scanning && bot.rules.some((r) => r.kind === "transfer") ? { from: from.toString(), to: to.toString(), pages } : null,
    skipped,
    rules: reports,
    alerts,
    truncated: Math.max(0, found.length - MAX_ALERTS),
    store: after,
    headline,
    toolCalls: chain.mcp.toolCalls,
  };
}
