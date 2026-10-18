// The agent over HTTP: one serverless function (GET /api/agent?task=NN&...) for every task the agent
// powers, so the site stays one project within Vercel's function limits. Each task validates its own
// parameters strictly; nothing here signs or holds a key, and the only Chain MCP endpoint is the hosted
// one, the only Developer Docs MCP the official one (tests pass local ones).
import { getAddress, isAddress } from "viem";
import { parseAmount, parseGasPrice } from "./core/amounts.js";
import { Chain } from "./core/chain.js";
import { ChainMcp, Recorder, type RecordedMessage } from "./core/chain-mcp.js";
import { AgentError, errorMessage } from "./core/errors.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "./core/networks.js";
import { parseGuardianConfig } from "./guardian/config.js";
import { PAYOUT_DEFAULTS, payoutGuardian } from "./guardian/presets.js";
import { runGuardian } from "./guardian/run.js";
import { parseDryRun, type DryRunRequest } from "./dryrun/intent.js";
import { runDryRun } from "./dryrun/run.js";
import { runGate } from "./policy/check.js";
import { minutesOf, parsePolicy } from "./policy/config.js";
import { TREASURY_HOURS, treasuryPolicy } from "./policy/presets.js";
import { parseWatcher } from "./trend/config.js";
import { OUTFLOW_DEFAULTS, outflowWatcher } from "./trend/presets.js";
import { runWatch } from "./trend/run.js";
import { observingKey, parseStore } from "./trend/store.js";
import { parseAlertBot } from "./alert/config.js";
import { USDC_ALERT_DEFAULTS, usdcAlerts } from "./alert/presets.js";
import { runAlerts } from "./alert/run.js";
import { botKey, parseAlertStore } from "./alert/store.js";
import { parseWatchlist } from "./whale/config.js";
import { SAMPLE_ADDRESSES, USDC_WHALE_DEFAULTS, usdcWhales } from "./whale/presets.js";
import { runWhales } from "./whale/run.js";
import { parseWhaleStore, watchlistKey } from "./whale/store.js";
import { parseGasPlan } from "./gas/config.js";
import { runGasPlan } from "./gas/run.js";
import { parseGasStore, planKey } from "./gas/store.js";
import { explain } from "./support/explain.js";
import { checkRisk, DEFAULT_BLOCKS } from "./risk/check.js";
import { parsePeriod } from "./audit/period.js";
import { auditAddress, parseAuditAddress } from "./audit/report.js";
import { EXAMPLE_PAYER } from "./guardian/presets.js";
import { parseSubject, subjectName } from "./digest/config.js";
import { runDigest } from "./digest/run.js";
import { digestKey, emptyDigestStore } from "./digest/store.js";
import { DOCS_MCP, DocsMcp } from "./core/docs-mcp.js";
import { docsThenChain, parseQuestion } from "./docs/run.js";
import { parseAction, type ActionInputs } from "./builder/action.js";
import { howTo } from "./builder/run.js";
import { preparePayments } from "./payment/flow.js";
import { parseContacts, parseRequest } from "./payment/request.js";
import { parsePayees, payInvoice } from "./invoice/pay.js";
import { readInvoice } from "./invoice/read.js";
import { runRecurring } from "./recurring/run.js";
import { readSchedule } from "./recurring/schedule.js";

export interface WebOptions {
  /** The Chain MCP endpoint; only tests change it. */
  chainMcpUrl?: string;
  /** The Developer Docs MCP endpoint; only tests change it. */
  docsMcpUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export interface WebResponse {
  status: number;
  body: unknown;
  /** Seconds a successful answer may be shared at the edge. */
  maxAge: number;
}

/** One line per Chain MCP call, for the page's proof panel: the tool, its arguments, and whether it answered. */
export interface CallLine {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export function callLines(messages: readonly RecordedMessage[]): CallLine[] {
  const failed = new Set<unknown>();
  for (const { direction, message } of messages) {
    if (direction === "server->client" && "id" in message && ("error" in message || (message as { result?: { isError?: boolean } }).result?.isError === true)) failed.add(message.id);
  }
  return messages
    .filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call")
    .map((m) => {
      const { params, id } = m.message as unknown as { id: unknown; params: { name: string; arguments?: Record<string, unknown> } };
      return { tool: params.name, args: params.arguments ?? {}, ok: !failed.has(id) };
    });
}

const usage = (message: string): WebResponse => ({ status: 400, body: { error: { kind: "usage", message } }, maxAge: 0 });

/** Task 05: the mainnet payout guardian with the page's four inputs. */
async function guardian(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const read = (key: keyof typeof PAYOUT_DEFAULTS) => (params.get(key) ?? PAYOUT_DEFAULTS[key]).trim();
  const inputs = { payer: read("payer"), recipient: read("recipient"), amount: read("amount"), maxGasGwei: read("maxGasGwei") };
  if (!isAddress(inputs.payer, { strict: false })) return usage("The payer must be a 0x address (40 hex characters).");
  if (!isAddress(inputs.recipient, { strict: false })) return usage("The recipient must be a 0x address (40 hex characters).");
  if (inputs.payer.toLowerCase() === inputs.recipient.toLowerCase()) return usage("The payer and the recipient must be different addresses.");
  let amount: bigint;
  let gas: bigint;
  try {
    amount = parseAmount(inputs.amount, 6, "The amount");
    gas = parseGasPrice(`${inputs.maxGasGwei} gwei`);
  } catch (error) {
    return usage(errorMessage(error));
  }
  if (amount <= 0n || amount > 10_000_000_000_000n) return usage("The amount must be more than 0 and at most 10,000,000 USDC.");
  if (gas <= 0n || gas > 10_000_000_000_000n) return usage("The gas cap must be more than 0 and at most 10,000 gwei.");

  const config = parseGuardianConfig(payoutGuardian(inputs));
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 30, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await runGuardian(config, { chain: new Chain(mcp, NETWORKS["pharos-mainnet"]), now: options.now });
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: 15 };
  } finally {
    await mcp.close();
  }
}

/**
 * A mainnet transfer (an official token or PROS) or token approval from a page's inputs: action, asset,
 * from, to (the spender of an approval) and amount ("max" for an unlimited approval). The inputs echo
 * back to the page; a WebResponse is a 400 for the page to show.
 */
function requestFrom(params: URLSearchParams): { inputs: Record<string, string>; request: DryRunRequest } | WebResponse {
  const net = NETWORKS["pharos-mainnet"];
  const get = (key: string, fallback: string) => (params.get(key) ?? fallback).trim();
  const inputs = { action: get("action", "transfer"), asset: get("asset", "USDC"), from: get("from", PAYOUT_DEFAULTS.payer), to: get("to", PAYOUT_DEFAULTS.recipient), amount: get("amount", "25") };
  if (inputs.action !== "transfer" && inputs.action !== "approve") return usage("action must be transfer or approve.");
  const token = net.tokens.find((entry) => entry.symbol === inputs.asset);
  if (!token && inputs.asset !== net.nativeSymbol) return usage(`asset must be ${net.nativeSymbol} or one of ${net.tokens.map((entry) => entry.symbol).join(", ")}.`);
  if (inputs.action === "approve" && !token) return usage(`Only a token can be approved, not ${net.nativeSymbol}.`);
  if (inputs.amount === "max" && inputs.action !== "approve") return usage("Only an approval can be unlimited.");
  const intent =
    inputs.action === "approve"
      ? { kind: "erc20-approve", token: token!.address, from: inputs.from, spender: inputs.to, amount: inputs.amount }
      : token
        ? { kind: "erc20-transfer", token: token.address, from: inputs.from, to: inputs.to, amount: inputs.amount }
        : { kind: "native-transfer", from: inputs.from, to: inputs.to, amount: inputs.amount };
  let request;
  try {
    request = parseDryRun({ network: net.id, intent });
  } catch (error) {
    return usage(errorMessage(error).replace(/^from /, "The sender ").replace(/^(to|spender) /, (word) => (word.trim() === "to" ? "The recipient " : "The spender ")));
  }
  if (inputs.amount !== "max" && Number(inputs.amount) > 1e12) return usage("The amount is too large to check here.");
  return { inputs, request };
}

/** Task 08: a dry run on mainnet of a transfer (an official token or PROS) or a token approval. */
async function dryRun(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const parsed = requestFrom(params);
  if ("status" in parsed) return parsed;
  const { inputs, request } = parsed;
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 30, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await runDryRun(request.intent, { chain: new Chain(mcp, net) });
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: 15 };
  } finally {
    await mcp.close();
  }
}

/** Task 11: a mainnet transfer or approval checked against the treasury policy, with the page's allowed hours. */
async function gatekeeper(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const parsed = requestFrom(params);
  if ("status" in parsed) return parsed;
  const hours = { from: (params.get("hoursFrom") ?? TREASURY_HOURS.from).trim(), to: (params.get("hoursTo") ?? TREASURY_HOURS.to).trim() };
  for (const [key, value] of Object.entries(hours)) if (Number.isNaN(minutesOf(value))) return usage(`The allowed hours ${key === "from" ? "start" : "end"} at a time like 06:00 (24:00 is the end of the day).`);
  if (minutesOf(hours.from) === minutesOf(hours.to)) return usage("The allowed hours must start and end at different times.");
  const policy = parsePolicy(treasuryPolicy(hours));
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 40, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await runGate(policy, parsed.request.intent, { chain: new Chain(mcp, net) });
    return { status: 200, body: { result, inputs: { ...parsed.inputs, hoursFrom: hours.from, hoursTo: hours.to }, policy, calls: callLines(recorder.messages) }, maxAge: 15 };
  } finally {
    await mcp.close();
  }
}

/** The most earlier observations a page may send with a run. */
export const WEB_SERIES = 20;

/**
 * Task 09: the mainnet USDC watcher with the page's settings. The page keeps the store: it sends its
 * earlier observations ("block:raw:seconds", oldest first) and the block it last acted at, the agent adds
 * one observation through Chain MCP, and the page keeps the store it gets back. Never cached: each answer
 * depends on the store sent.
 */
async function trendWatcher(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const get = (key: string, fallback: string) => (params.get(key) ?? fallback).trim();
  const inputs = { holder: get("holder", OUTFLOW_DEFAULTS.holder), trend: get("trend", OUTFLOW_DEFAULTS.trend), observations: get("observations", String(OUTFLOW_DEFAULTS.observations)), every: get("every", String(OUTFLOW_DEFAULTS.everyBlocks)) };
  if (!isAddress(inputs.holder, { strict: false })) return usage("The holder must be a 0x address (40 hex characters).");
  if (inputs.trend !== "falling" && inputs.trend !== "rising") return usage("trend must be falling or rising.");
  if (!/^\d+$/.test(inputs.observations) || Number(inputs.observations) < 2 || Number(inputs.observations) > 6) return usage("observations must be a whole number from 2 to 6.");
  if (!/^\d+$/.test(inputs.every) || Number(inputs.every) < 1 || Number(inputs.every) > 1000) return usage("every must be a whole number of blocks from 1 to 1,000.");
  const watcher = parseWatcher(outflowWatcher({ holder: inputs.holder, trend: inputs.trend, observations: Number(inputs.observations), everyBlocks: Number(inputs.every) }));
  const series = get("series", "");
  const entries = series ? series.split(",") : [];
  if (entries.length > WEB_SERIES) return usage(`At most ${WEB_SERIES} earlier observations can be sent.`);
  const observations = [];
  for (const entry of entries) {
    const match = /^(\d{1,12}):(\d{1,78}):(\d{1,12})$/.exec(entry);
    if (!match) return usage("series lists earlier observations as block:raw:seconds, separated by commas.");
    observations.push({ block: match[1]!, raw: match[2]!, timestamp: new Date(Number(match[3]) * 1000).toISOString() });
  }
  const actedAt = get("actedAt", "");
  if (actedAt && !/^\d{1,12}$/.test(actedAt)) return usage("actedAt must be a block number.");
  let store;
  try {
    store = parseStore({ schema: "pharos-agent/trend-store/1", observing: observingKey(watcher), observations, actedAt: actedAt || null }, watcher);
  } catch (error) {
    return usage(errorMessage(error));
  }
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 30, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await runWatch(watcher, store, { chain: new Chain(mcp, net) });
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: 0 };
  } finally {
    await mcp.close();
  }
}

/**
 * Task 22: the mainnet USDC alert bot with the page's thresholds. The page keeps the bot's memory: the
 * last block scanned and which state rules held ("id:1,id:0"); the alerts it shows are its own record.
 * Never cached: each answer depends on the memory sent.
 */
async function alertBot(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const get = (key: string, fallback: string) => (params.get(key) ?? fallback).trim();
  const inputs = { min: get("min", USDC_ALERT_DEFAULTS.min), holder: get("holder", USDC_ALERT_DEFAULTS.holder), low: get("low", USDC_ALERT_DEFAULTS.low) };
  if (!isAddress(inputs.holder, { strict: false })) return usage("The holder must be a 0x address (40 hex characters).");
  for (const [key, what] of [["min", "The smallest transfer"], ["low", "The low balance"]] as const) {
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(inputs[key])) return usage(`${what} must be an amount of USDC, up to 6 decimals.`);
  }
  let bot;
  try {
    bot = parseAlertBot(usdcAlerts(inputs));
  } catch (error) {
    return usage(errorMessage(error));
  }
  const cursor = get("cursor", "");
  if (cursor && !/^\d{1,12}$/.test(cursor)) return usage("cursor must be a block number.");
  const states: Record<string, boolean> = {};
  const listed = get("states", "");
  for (const entry of listed ? listed.split(",") : []) {
    const match = /^([a-z0-9-]{1,40}):([01])$/.exec(entry);
    if (!match) return usage("states lists rule:1 or rule:0, separated by commas.");
    states[match[1]!] = match[2] === "1";
  }
  const store = parseAlertStore({ schema: "pharos-agent/alert-store/1", bot: botKey(bot), cursor: cursor || null, states, pending: [] }, bot);
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 30, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await runAlerts(bot, store, { chain: new Chain(mcp, net), now: options.now });
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: 0 };
  } finally {
    await mcp.close();
  }
}

/** The most addresses the page tracks in one run (the CLI takes up to 10). */
export const WEB_ADDRESSES = 5;

async function whaleWatcher(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const get = (key: string, fallback: string) => (params.get(key) ?? fallback).trim();
  const inputs = { addresses: get("addresses", USDC_WHALE_DEFAULTS.addresses.map((a) => a.address).join(",")), min: get("min", USDC_WHALE_DEFAULTS.min), native: get("native", USDC_WHALE_DEFAULTS.native) };
  const listed = inputs.addresses.split(",").map((a) => a.trim()).filter(Boolean);
  if (listed.length === 0 || listed.length > WEB_ADDRESSES) return usage(`Track 1 to ${WEB_ADDRESSES} addresses, separated by commas.`);
  for (const address of listed) if (!isAddress(address, { strict: false })) return usage(`${address.slice(0, 50)} is not a 0x address (40 hex characters).`);
  for (const [key, what] of [["min", "The smallest significant transfer"], ["native", "The smallest significant balance change"]] as const) {
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(inputs[key])) return usage(`${what} must be an amount, up to 6 decimals.`);
  }
  const named = new Map(SAMPLE_ADDRESSES.map((a) => [a.address.toLowerCase(), a.label]));
  let list;
  try {
    list = parseWatchlist(usdcWhales({ addresses: listed.map((address) => ({ address, label: named.get(address.toLowerCase()) ?? `${address.slice(0, 6)}…${address.slice(-4)}` })), min: inputs.min, native: inputs.native }));
  } catch (error) {
    return usage(errorMessage(error));
  }
  // The page's memory: the last block scanned and each address as it was, as JSON.
  const sent = get("store", "");
  let memory: { cursor?: unknown; snapshots?: unknown } = {};
  if (sent) {
    if (sent.length > 6000) return usage("store is too long.");
    try {
      memory = JSON.parse(sent);
    } catch {
      return usage("store must be JSON: { cursor, snapshots }.");
    }
    if (!memory || typeof memory !== "object" || Array.isArray(memory) || Object.keys(memory).some((key) => !["cursor", "snapshots"].includes(key))) return usage("store must be JSON: { cursor, snapshots }.");
  }
  const store = parseWhaleStore({ schema: "pharos-agent/whale-store/1", watchlist: watchlistKey(list), cursor: memory.cursor ?? null, snapshots: memory.snapshots ?? {} }, list);
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 40, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await runWhales(list, store, { chain: new Chain(mcp, net), now: options.now });
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: 0 };
  } finally {
    await mcp.close();
  }
}

/** The most earlier fee observations the page sends for Task 24 (its window). */
export const WEB_GAS_SERIES = 12;

/** Task 24: one transaction (as Task 08 takes it) timed against the fees observed so far, which the page keeps. */
async function gasOptimizer(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const parsed = requestFrom(params);
  if ("status" in parsed) return parsed;
  const { inputs: tx, request } = parsed;
  const get = (key: string, fallback: string) => (params.get(key) ?? fallback).trim();
  const percentile = get("percentile", "25");
  if (!["10", "25", "50", "75"].includes(percentile)) return usage("percentile must be 10, 25, 50 or 75.");
  // Earlier observations, oldest first: block:fee:gasUsed:gasLimit:seconds:source (b for a base fee, g for a gas price).
  const series = get("series", "");
  const entries = series ? series.split(",") : [];
  if (entries.length > WEB_GAS_SERIES) return usage(`At most ${WEB_GAS_SERIES} earlier observations can be sent.`);
  const observations = [];
  for (const entry of entries) {
    const match = /^(\d{1,12}):(\d{1,30}):(\d{1,20}):(\d{1,20}):(\d{1,12}):([bg])$/.exec(entry);
    if (!match) return usage("series lists earlier observations as block:fee:gasUsed:gasLimit:seconds:b, separated by commas.");
    observations.push({ block: match[1], fee: match[2], gasUsed: match[3], gasLimit: match[4], timestamp: new Date(Number(match[5]) * 1000).toISOString(), source: match[6] === "b" ? "base-fee" : "gas-price" });
  }
  const waitingSince = get("waitingSince", "");
  if (waitingSince && !/^\d{1,12}$/.test(waitingSince)) return usage("waitingSince must be a block number.");
  let plan;
  try {
    plan = parseGasPlan({ name: "Timed transaction", network: net.id, transaction: request.intent, target: { percentile: Number(percentile) }, window: WEB_GAS_SERIES, backfill: { samples: 5, spacing: 200 }, deadline: null });
  } catch (error) {
    return usage(errorMessage(error));
  }
  const store = parseGasStore({ schema: "pharos-agent/gas-store/1", plan: planKey(plan), observations, waitingSince: waitingSince || null, sent: null }, plan);
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 40, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await runGasPlan(plan, store, { chain: new Chain(mcp, net), now: options.now });
    return { status: 200, body: { result, inputs: { ...tx, percentile }, calls: callLines(recorder.messages) }, maxAge: 0 };
  } finally {
    await mcp.close();
  }
}

/** Task 27: why a mainnet transaction failed (by its hash), or why one described would fail if sent now. */
async function supportAgent(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const hash = (params.get("hash") ?? "").trim();
  let request;
  let inputs: Record<string, string>;
  if (hash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return usage("A transaction hash is 0x and 64 hex characters.");
    request = { kind: "hash" as const, hash: hash.toLowerCase() as `0x${string}` };
    inputs = { hash };
  } else {
    const parsed = requestFrom(params);
    if ("status" in parsed) return parsed;
    request = { kind: "intent" as const, intent: parsed.request.intent };
    inputs = parsed.inputs;
  }
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 30, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await explain(request, { chain: new Chain(mcp, net), now: options.now });
    // A mined transaction's explanation does not change; one still pending, or a description, does.
    const settled = result.status === "succeeded" || result.status === "failed";
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: settled ? 300 : 0 };
  } finally {
    await mcp.close();
  }
}

/** Task 25: the risks of a planned transfer or approval, from the counterparty's history (the default 2,000 blocks). */
async function riskChecker(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const parsed = requestFrom(params);
  if ("status" in parsed) return parsed;
  const { inputs, request } = parsed;
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 40, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await checkRisk(request.intent, { chain: new Chain(mcp, net), blocks: DEFAULT_BLOCKS, now: options.now });
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: 0 };
  } finally {
    await mcp.close();
  }
}

/** The most blocks one page report reads: 40 get_logs calls, inside the hosted endpoint's 120 a minute. */
export const WEB_AUDIT_BLOCKS = 20_000;

/** Task 26: what an address did over a period (the last hour by default), in plain language. */
async function auditLog(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  let address;
  let period;
  try {
    address = parseAuditAddress(params.get("address") ?? EXAMPLE_PAYER);
    const field = (name: string) => params.get(name) ?? undefined;
    period = parsePeriod({ hours: field("hours"), since: field("since"), until: field("until"), fromBlock: field("fromBlock"), toBlock: field("toBlock") });
  } catch (error) {
    if (error instanceof AgentError) return usage(error.message);
    throw error;
  }
  const inputs: Record<string, string> = { address, ...(period.kind === "hours" ? { hours: String(period.hours) } : period.kind === "time" ? { since: period.since, ...(period.until ? { until: period.until } : {}) } : { fromBlock: period.from, toBlock: period.to }) };
  const recorder = new Recorder();
  // 40 get_logs at most, a search that rarely needs more than 6 block reads (48 at worst), 18 other reads.
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 110, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await auditAddress(address, period, { chain: new Chain(mcp, net), maxBlocks: WEB_AUDIT_BLOCKS, now: options.now });
    // A period that ended before the newest block does not change; the last N hours do.
    const settled = result.period.to.number !== result.head.number;
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: settled ? 300 : 0 };
  } finally {
    await mcp.close();
  }
}

/** Hours one page digest covers at most, besides the hour so far; and the blocks it may read. */
export const WEB_DIGEST_HOURS = 5;
export const WEB_DIGEST_BLOCKS = 20_000;

/**
 * Task 28: a token's or a wallet's activity, hour by hour: the last complete hours (3 by default) and
 * the hour so far. A day's or a week's digest reads more blocks than one request may; the CLI makes those.
 */
async function digest(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  let subject;
  let periods;
  try {
    subject = parseSubject(params.get("subject") ?? "usdc", net);
    const hours = params.get("hours") ?? "3";
    if (!/^\d$/.test(hours) || Number(hours) < 1 || Number(hours) > WEB_DIGEST_HOURS) throw new AgentError("usage", `hours must be a whole number from 1 to ${WEB_DIGEST_HOURS}.`);
    periods = Number(hours);
  } catch (error) {
    if (error instanceof AgentError) return usage(error.message);
    throw error;
  }
  const inputs = { subject: subject.kind === "token" ? subject.token.symbol : subject.address, hours: String(periods) };
  const recorder = new Recorder();
  // 40 get_logs at most (a wallet's two queries a page), about 20 block reads, 6 reads at the newest block.
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 110, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const store = emptyDigestStore(digestKey(net.id, subjectName(subject), "hour"));
    const result = await runDigest(subject, "hour", store, { chain: new Chain(mcp, net), periods, soFar: true, maxBlocks: WEB_DIGEST_BLOCKS, now: options.now });
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: 0 };
  } finally {
    await mcp.close();
  }
}

export const DEFAULT_QUESTION = "What is the USDC token address on Pharos Mainnet?";

/**
 * Task 13: a question about a Pharos contract, answered by the Developer Docs MCP, then checked on Pharos
 * Mainnet through Chain MCP. The docs calls are listed beside the chain calls.
 */
async function docsChain(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  let question;
  try {
    question = parseQuestion(params.get("q") ?? DEFAULT_QUESTION);
  } catch (error) {
    if (error instanceof AgentError) return usage(error.message);
    throw error;
  }
  const recorder = new Recorder();
  // An askQuestion answer took about 8 s live (Task 04's proof); then at most two pages and 24 chain reads.
  const docs = new DocsMcp(options.docsMcpUrl ?? DOCS_MCP, { budget: 4, timeoutMs: options.timeoutMs ?? 25_000 });
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 40, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await docsThenChain(question, { docs, chain: new Chain(mcp, net), now: options.now });
    return { status: 200, body: { result, inputs: { q: question }, calls: callLines(recorder.messages), docsCalls: callLines(docs.recorder.messages) }, maxAge: 60 };
  } finally {
    await mcp.close();
  }
}

export const DEFAULT_HOW_TO = "How do I send USDC to another wallet on Pharos Mainnet?";

/**
 * Task 29: how to do something on Pharos Mainnet, answered by the Developer Docs MCP, then prepared:
 * set beside the Skill Engine's values, dry-run through Chain MCP, and written as the Skill Engine's cast
 * commands. Nothing is sent: the page holds no key and the hosted Chain MCP is read-only.
 */
async function builder(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  let question;
  const inputs: ActionInputs = {};
  try {
    question = parseQuestion(params.get("q") ?? DEFAULT_HOW_TO);
    for (const key of ["from", "to", "amount", "token"] as const) {
      const value = params.get(key)?.trim();
      if (value) inputs[key] = value;
    }
    parseAction(question, inputs, net);
  } catch (error) {
    if (error instanceof AgentError) return usage(error.message);
    throw error;
  }
  const recorder = new Recorder();
  // askQuestion took about 8 s live (Task 04's proof); then a page or two and a dry run's 10 to 20 reads.
  const docs = new DocsMcp(options.docsMcpUrl ?? DOCS_MCP, { budget: 4, timeoutMs: options.timeoutMs ?? 25_000 });
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 50, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await howTo(question, { docs, chain: new Chain(mcp, net), inputs, now: options.now });
    return { status: 200, body: { result, inputs: { q: question, ...inputs }, calls: callLines(recorder.messages), docsCalls: callLines(docs.recorder.messages) }, maxAge: 15 };
  } finally {
    await mcp.close();
  }
}

export const DEFAULT_PAYMENT = "Pay alice 25 USDC and send 0.01 PROS to bob for lunch";
/** The example address book: the agent's example recipient (Tasks 05, 08, 11) and a sample address from Task 23. */
export const DEFAULT_CONTACTS = "alice = 0xB2749BD12f19C24a2244176658F3dF3e48e79553\nbob = 0x1F3546a29EeC2102c8d52E21a45114124014c85C";
export const WEB_MAX_PAYMENTS = 5;

/**
 * Task 17: a payment request in plain words, prepared on Pharos Mainnet as a flow: each payment dry-run
 * at one block, the totals against the sender's holdings, the transactions to sign in nonce order, the
 * Skill Engine's commands. Nothing is sent: the page holds no key and the hosted Chain MCP is read-only.
 */
async function paymentFlow(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const request = params.get("request") ?? DEFAULT_PAYMENT;
  const contactsText = params.get("contacts") ?? DEFAULT_CONTACTS;
  const fromText = params.get("from")?.trim() || undefined;
  let contacts;
  try {
    contacts = parseContacts(contactsText);
    if (fromText !== undefined && !isAddress(fromText, { strict: false })) throw new AgentError("usage", "from must be a 0x address (40 hex characters).");
    parseRequest(request, contacts, net, WEB_MAX_PAYMENTS);
  } catch (error) {
    if (error instanceof AgentError) return usage(error.message);
    throw error;
  }
  const recorder = new Recorder();
  // Each payment is a dry run of about ten reads; five payments, the nonce and the block fit in sixty.
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 60, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const flow = await preparePayments(request, { chain: new Chain(mcp, net), contacts, from: fromText ? getAddress(fromText) : undefined, maxPayments: WEB_MAX_PAYMENTS, now: options.now });
    return { status: 200, body: { result: flow, inputs: { request, contacts: contactsText, ...(fromText ? { from: fromText } : {}) }, calls: callLines(recorder.messages) }, maxAge: 15 };
  } finally {
    await mcp.close();
  }
}

/** The example invoice: from a sample studio, paid at the agent's example recipient (Tasks 05, 08, 11, 17). */
export const DEFAULT_INVOICE = `Invoice: INV-1042
From: Example Studio
Bill to: Example Shop
Issued: 2026-10-15
Terms: Net 30

Design work (10 h)        15.00 USDC
Hosting, October           5.00 USDC

Subtotal: 20 USDC
Total: 20 USDC
Amount due: 20 USDC

Pay to: 0xB2749BD12f19C24a2244176658F3dF3e48e79553
Network: Pharos Mainnet`;
export const DEFAULT_PAYEES = "Example Studio = 0xB2749BD12f19C24a2244176658F3dF3e48e79553";
export const WEB_MAX_INVOICE = 2000;

/**
 * Task 19: an invoice (or a payment link) read into the payment it asks for, every figure checked, the
 * payee against your payees and the payer's last 2,000 blocks of the token, then prepared on Pharos
 * Mainnet as Task 17's flow, with its EIP-681 link. Nothing is sent: the page holds no key and the hosted
 * Chain MCP is read-only.
 */
async function invoicePayment(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const invoice = params.get("invoice") ?? DEFAULT_INVOICE;
  const payeesText = params.get("payees") ?? DEFAULT_PAYEES;
  const fromText = params.get("from")?.trim() || undefined;
  let payees;
  try {
    payees = parsePayees(payeesText);
    if (fromText !== undefined && !isAddress(fromText, { strict: false })) throw new AgentError("usage", "from must be a 0x address (40 hex characters).");
    readInvoice(invoice, net, WEB_MAX_INVOICE);
  } catch (error) {
    if (error instanceof AgentError) return usage(error.message);
    throw error;
  }
  const recorder = new Recorder();
  // Two pages of the payer's transfers, the nonce and one dry run: about sixteen reads.
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 40, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await payInvoice(invoice, { chain: new Chain(mcp, net), payees, from: fromText ? getAddress(fromText) : undefined, maxInvoice: WEB_MAX_INVOICE, now: options.now });
    return { status: 200, body: { result, inputs: { invoice, payees: payeesText, ...(fromText ? { from: fromText } : {}) }, calls: callLines(recorder.messages) }, maxAge: 15 };
  } finally {
    await mcp.close();
  }
}

/** The example schedule: rent and a tool to the agent's example recipient, payroll to a sample address from Task 23. */
export const DEFAULT_SCHEDULE = `Rent: 25 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, monthly on the 1st
Payroll: 10 USDC to 0x1F3546a29EeC2102c8d52E21a45114124014c85C, monthly on the 15th
Design tool: 2 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, weekly on Monday`;
export const WEB_MAX_SCHEDULE = 8;
export const WEB_MAX_RECURRING = 6;

/**
 * Task 18: a schedule of repeating payments on Pharos Mainnet, from the first of the block's month (or a
 * day given): what fell due by the block's day, the oldest taken (at most 3 of one payment, 6 in all),
 * prepared as Task 17's flow. The page keeps nothing between runs and sends nothing: nothing it shows is
 * recorded as paid. The CLI's store does that, and sends on Atlantic.
 */
async function recurringPayments(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const net = NETWORKS["pharos-mainnet"];
  const schedule = params.get("schedule") ?? DEFAULT_SCHEDULE;
  const since = params.get("since")?.trim() || undefined;
  const fromText = params.get("from")?.trim() || undefined;
  try {
    readSchedule(schedule, net, WEB_MAX_SCHEDULE);
    if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new AgentError("usage", "since must be a day as YYYY-MM-DD.");
    if (fromText !== undefined && !isAddress(fromText, { strict: false })) throw new AgentError("usage", "from must be a 0x address (40 hex characters).");
  } catch (error) {
    if (error instanceof AgentError) return usage(error.message);
    throw error;
  }
  const recorder = new Recorder();
  // Six payments of about ten reads each, the nonce and the block fit in eighty.
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 80, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await runRecurring(schedule, { chain: new Chain(mcp, net), from: fromText ? getAddress(fromText) : undefined, since, sinceDefault: "month", maxItems: WEB_MAX_SCHEDULE, maxPayments: WEB_MAX_RECURRING, now: options.now });
    return { status: 200, body: { result, inputs: { schedule, ...(since ? { since } : {}), ...(fromText ? { from: fromText } : {}) }, calls: callLines(recorder.messages) }, maxAge: 15 };
  } finally {
    await mcp.close();
  }
}

export async function handle(url: URL, options: WebOptions = {}): Promise<WebResponse> {
  try {
    switch (url.searchParams.get("task")) {
      case "05":
        return await guardian(url.searchParams, options);
      case "08":
        return await dryRun(url.searchParams, options);
      case "09":
        return await trendWatcher(url.searchParams, options);
      case "11":
        return await gatekeeper(url.searchParams, options);
      case "13":
        return await docsChain(url.searchParams, options);
      case "17":
        return await paymentFlow(url.searchParams, options);
      case "18":
        return await recurringPayments(url.searchParams, options);
      case "19":
        return await invoicePayment(url.searchParams, options);
      case "22":
        return await alertBot(url.searchParams, options);
      case "23":
        return await whaleWatcher(url.searchParams, options);
      case "24":
        return await gasOptimizer(url.searchParams, options);
      case "25":
        return await riskChecker(url.searchParams, options);
      case "26":
        return await auditLog(url.searchParams, options);
      case "27":
        return await supportAgent(url.searchParams, options);
      case "28":
        return await digest(url.searchParams, options);
      case "29":
        return await builder(url.searchParams, options);
      default:
        return usage("Unknown task. Use ?task=05, 08, 09, 11, 13, 17 to 19, 22 to 29.");
    }
  } catch (error) {
    if (error instanceof AgentError) {
      const status = error.kind === "usage" ? 400 : error.kind === "mcp_connection" || error.kind === "mcp_tool" || error.kind === "wrong_chain" || error.kind === "budget" ? 502 : 500;
      return { status, body: { error: { kind: error.kind, message: error.message, hint: error.hint ?? null } }, maxAge: 0 };
    }
    return { status: 500, body: { error: { kind: "unexpected", message: errorMessage(error) } }, maxAge: 0 };
  }
}
