// The agent over HTTP: one serverless function (GET /api/agent?task=NN&...) for every task the agent
// powers, so the site stays one project within Vercel's function limits. Each task validates its own
// parameters strictly; nothing here signs or holds a key, and the only Chain MCP endpoint is the hosted
// one (tests pass a local one).
import { isAddress } from "viem";
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

export interface WebOptions {
  /** The Chain MCP endpoint; only tests change it. */
  chainMcpUrl?: string;
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
      case "22":
        return await alertBot(url.searchParams, options);
      default:
        return usage("Unknown task. Use ?task=05, 08, 09, 11 or 22.");
    }
  } catch (error) {
    if (error instanceof AgentError) {
      const status = error.kind === "usage" ? 400 : error.kind === "mcp_connection" || error.kind === "mcp_tool" || error.kind === "wrong_chain" || error.kind === "budget" ? 502 : 500;
      return { status, body: { error: { kind: error.kind, message: error.message, hint: error.hint ?? null } }, maxAge: 0 };
    }
    return { status: 500, body: { error: { kind: "unexpected", message: errorMessage(error) } }, maxAge: 0 };
  }
}
