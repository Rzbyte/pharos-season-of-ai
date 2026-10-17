// Task 09, Trend Watcher: one run.
//
//   1. Check the chain (get_chain_info) and pin the newest block.
//   2. Unless the last observation is fewer than `everyBlocks` blocks old: read the value at that block
//      through Chain MCP and add it to the store (the oldest beyond `keep` drop off).
//   3. Judge the trend over the last N observations made since the watcher last acted.
//   4. Only when a new observation makes the trend hold: act. The action is dry-run at the same block
//      (Task 08) and, on Atlantic with --execute, sent if the dry run succeeds. The store remembers the
//      block it acted at, so one trend is acted on once.
import { decodeCall, encodeCall, ERC20, parseSignature } from "../core/abi.js";
import { formatAmount, formatGwei, parseAmount } from "../core/amounts.js";
import type { BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import { knownToken } from "../core/networks.js";
import { runDryRun, submitDryRun, type DryRun, type DryRunOptions, type Submission } from "../dryrun/run.js";
import type { Read } from "../guardian/config.js";
import { decimalsOf, describeTrend, unitOf, type Trend, type Watcher } from "./config.js";
import type { Observation, TrendStore } from "./store.js";

/** An observation as shown: its value in units, and its change from the one before. */
export interface Point extends Observation {
  shown: string;
  change: string | null;
}

export interface TrendJudgement {
  label: string;
  needs: number;
  /** Observations since the watcher last acted: the ones that can make the trend. */
  have: number;
  holds: boolean;
  /** The last `needs` of them, oldest first (fewer while there are not enough). */
  window: Point[];
  detail: string;
}

export interface TrendRun {
  schema: "pharos-agent/trend-run/1";
  watcher: string;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: Hex; timestamp: string; source: "latest" | "requested" };
  observing: { label: string; unit: string; decimals: number };
  /** This run's observation, or null when it was too soon for one. */
  observation: Point | null;
  skipped: string | null;
  trend: TrendJudgement;
  /** The action's dry run, when the trend made the watcher act. */
  action: DryRun | null;
  execution: Submission | null;
  notSent: string | null;
  outcome: "watching" | "fired" | "executed";
  /** The store as this run leaves it. */
  store: TrendStore;
  headline: string;
  toolCalls: number;
}

export interface WatchOptions {
  chain: Chain;
  block?: bigint;
  /** Only to execute, on Atlantic: the action's sender's key. */
  signer?: Signer;
  wait?: DryRunOptions["wait"];
}

/** The value a read gives at `block`, in base units, with the decimals and unit it is shown in. */
async function readValue(chain: Chain, read: Read, block: bigint): Promise<{ raw: bigint; decimals: number; unit: string }> {
  const unit = unitOf(read, chain.network);
  switch (read.kind) {
    case "erc20-balance": {
      const decimals = Number(decodeCall(ERC20.decimals, await chain.call({ to: read.token, data: encodeCall(ERC20.decimals, []) }, block)) as bigint);
      const official = knownToken(chain.network, read.token);
      if (official && official.decimals !== decimals) throw new AgentError("mcp_tool", `${official.symbol} reports ${decimals} decimals; the official token list says ${official.decimals}.`);
      const raw = decodeCall(ERC20.balanceOf, await chain.call({ to: read.token, data: encodeCall(ERC20.balanceOf, [read.holder]) }, block)) as bigint;
      return { raw, decimals, unit };
    }
    case "native-balance":
      return { raw: await chain.balance(read.address, block), decimals: 18, unit };
    case "gas-price":
      return { raw: (await chain.gasPrice()).gasPrice, decimals: 9, unit };
    case "nonce":
      return { raw: await chain.nonce(read.address, block), decimals: 0, unit };
    case "call": {
      const sig = parseSignature(read.signature);
      const value = decodeCall(sig, await chain.call({ to: read.to, data: encodeCall(sig, read.args) }, block));
      if (typeof value !== "bigint") throw new AgentError("mcp_tool", `${sig.text} did not return a number.`);
      return { raw: value, decimals: read.decimals ?? 0, unit };
    }
    default:
      throw new AgentError("usage", `A watcher cannot observe ${read.kind}.`);
  }
}

const show = (raw: bigint, decimals: number, unit: string) => (unit === "gwei" ? formatGwei(raw) : `${formatAmount(raw, decimals, decimals === 18 ? 8 : 6)}${unit ? ` ${unit}` : ""}`);

/** Observations with their shown values and changes, oldest first. */
function points(observations: readonly Observation[], decimals: number, unit: string): Point[] {
  return observations.map((o, i) => {
    const before = i > 0 ? BigInt(observations[i - 1]!.raw) : null;
    const delta = before === null ? null : BigInt(o.raw) - before;
    return { ...o, shown: show(BigInt(o.raw), decimals, unit), change: delta === null ? null : delta === 0n ? "no change" : `${delta > 0n ? "+" : "−"}${show(delta < 0n ? -delta : delta, decimals, unit)}` };
  });
}

/** Whether the trend holds over the observations that count (oldest first), and why. Pure: the run and its replay judge alike. */
export function judgeTrend(trend: Trend, counted: readonly Point[], decimals: number, unit: string): TrendJudgement {
  const label = describeTrend(trend, unit, decimals);
  const needs = trend.observations;
  const window = counted.slice(-needs);
  const base = { label, needs, have: counted.length, window };
  if (window.length < needs) return { ...base, holds: false, detail: `${window.length} of ${needs} observations so far` };
  const raws = window.map((p) => BigInt(p.raw));
  switch (trend.kind) {
    case "falling":
    case "rising": {
      const steps = raws.slice(1).filter((value, i) => (trend.kind === "falling" ? value < raws[i]! : value > raws[i]!)).length;
      return { ...base, holds: steps === needs - 1, detail: `${steps} of ${needs - 1} steps ${trend.kind === "falling" ? "down" : "up"}` };
    }
    case "change": {
      const [first, last] = [raws[0]!, raws.at(-1)!];
      if (first === 0n) return { ...base, holds: false, detail: "starts at 0, so there is no percentage" };
      // In hundredths of a percent, cut toward zero: exact, and the same on every replay.
      const bps = ((last - first) * 10_000n) / first;
      const want = BigInt(Math.round(Number(trend.percent) * 100));
      const holds = want < 0n ? bps <= want : bps >= want;
      const pct = `${bps < 0n ? "−" : "+"}${(Number(bps < 0n ? -bps : bps) / 100).toFixed(2)} %`;
      return { ...base, holds, detail: `${pct} (needs ${trend.percent.startsWith("-") ? "−" : "+"}${trend.percent.slice(1)} %)` };
    }
    case "sustained": {
      const threshold = parseAmount(trend.value, decimals);
      const ok = raws.filter((value) => ({ "<": value < threshold, "<=": value <= threshold, ">": value > threshold, ">=": value >= threshold })[trend.op]).length;
      return { ...base, holds: ok === needs, detail: `${ok} of ${needs} observations` };
    }
  }
}

export async function runWatch(watcher: Watcher, store: TrendStore, options: WatchOptions): Promise<TrendRun> {
  const { chain } = options;
  const net = chain.network;
  if (net.id !== watcher.network) throw new AgentError("usage", `The watcher is for ${watcher.network}; this chain is ${net.id}.`);
  if (options.signer && net.id !== "atlantic-testnet") throw new AgentError("execution", "Executing is limited to the Atlantic testnet; on mainnet the watcher prepares and simulates only.");
  await chain.expectChain();
  const pinned: BlockHeader = await chain.block(options.block ?? (await chain.blockNumber()));
  const source = options.block === undefined ? "latest" : "requested";

  // Too soon for another observation, or not after the last one: nothing is read or recorded.
  const last = store.observations.at(-1);
  const since = last ? pinned.number - BigInt(last.block) : null;
  let skipped: string | null = null;
  if (since !== null && since <= 0n) skipped = `Block ${pinned.number.toLocaleString("en-US")} is not after the last observation (block ${BigInt(last!.block).toLocaleString("en-US")}).`;
  else if (since !== null && since < BigInt(watcher.everyBlocks)) skipped = `The last observation is ${since} ${since === 1n ? "block" : "blocks"} old; this watcher records one every ${watcher.everyBlocks.toLocaleString("en-US")} blocks.`;

  let decimals = decimalsOf(watcher.observe);
  let unit = unitOf(watcher.observe, net);
  let observations = store.observations;
  if (!skipped) {
    const read = await readValue(chain, watcher.observe, pinned.number);
    decimals = read.decimals;
    unit = read.unit;
    observations = [...observations, { block: pinned.number.toString(), timestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), raw: read.raw.toString() }].slice(-watcher.keep);
  } else if (decimals === null) {
    // A skipped run on a token still shows the stored values: the token's decimals, from the official list or the chain.
    const read = watcher.observe as Extract<Read, { kind: "erc20-balance" }>;
    decimals = knownToken(net, read.token)?.decimals ?? Number(decodeCall(ERC20.decimals, await chain.call({ to: read.token, data: encodeCall(ERC20.decimals, []) }, pinned.number)) as bigint);
  }
  const all = points(observations, decimals!, unit);
  const counted = all.filter((p) => store.actedAt === null || BigInt(p.block) > BigInt(store.actedAt));
  const trend = judgeTrend(watcher.trend, counted, decimals!, unit);
  const observation = skipped ? null : all.at(-1)!;

  // Act only on a trend that this run's observation completed.
  let action: DryRun | null = null;
  let execution: Submission | null = null;
  let notSent: string | null = null;
  const fires = !skipped && trend.holds;
  if (fires && watcher.action) {
    action = await runDryRun(watcher.action, { chain, at: { header: pinned, source } });
    if (options.signer) {
      if (action.verdict === "would-succeed") execution = await submitDryRun(chain, action, options.signer, options.wait);
      else notSent = `The dry run says it ${action.verdict === "cannot-pay" ? "cannot pay its fee" : "would revert"}: ${action.reason}`;
    }
  }
  const after: TrendStore = { ...store, observations, actedAt: fires ? pinned.number.toString() : store.actedAt };
  const outcome = execution ? "executed" : fires ? "fired" : "watching";
  const now = observation ? `${watcher.label} is ${observation.shown} at block ${pinned.number.toLocaleString("en-US")}` : `No new observation: ${skipped}`;
  const headline =
    outcome === "watching"
      ? `Watching. ${now}. ${trend.label}: ${trend.detail}.`
      : `Fired. ${now}. ${trend.label}: ${trend.detail}.${action ? ` ${action.headline}` : ""}${execution ? ` Sent as ${execution.txHash}.` : notSent ? ` Not sent: ${notSent}` : ""}`;
  return {
    schema: "pharos-agent/trend-run/1",
    watcher: watcher.name,
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: pinned.number.toString(), hash: pinned.hash, timestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), source },
    observing: { label: watcher.label, unit, decimals: decimals! },
    observation,
    skipped,
    trend,
    action,
    execution,
    notSent,
    outcome,
    store: after,
    headline,
    toolCalls: chain.mcp.toolCalls,
  };
}
