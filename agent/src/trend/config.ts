// Task 09, Trend Watcher: what a watcher observes, the trend it waits for, and what it does then. A
// watcher is JSON, checked here before anything touches the chain:
//
//   observe      one numeric on-chain value (a token or native balance, a view call, the gas price, a nonce)
//   everyBlocks  an observation is recorded only when at least this many blocks have passed since the last
//   keep         how many observations the store keeps
//   trend        falling or rising across the last N observations, a % change over the last N, or a
//                threshold held in each of the last N
//   action       optional: a transfer or approval (as Task 08 dry-runs it), prepared and simulated when
//                the trend holds, and sent on Atlantic with --execute
import { parseSignature } from "../core/abi.js";
import { formatAmount, parseAmount } from "../core/amounts.js";
import { AgentError } from "../core/errors.js";
import { knownToken, NETWORKS, type Network, type NetworkId } from "../core/networks.js";
import { parseDryRun, type Intent } from "../dryrun/intent.js";
import { parseRead, readValueType, type Read } from "../guardian/config.js";

export type Trend =
  | { kind: "falling" | "rising"; observations: number }
  | { kind: "change"; observations: number; percent: string }
  | { kind: "sustained"; observations: number; op: "<" | "<=" | ">" | ">="; value: string };

export interface Watcher {
  name: string;
  network: NetworkId;
  observe: Read;
  /** What the value is, as a noun: "USDC held by 0x912c…f647". */
  label: string;
  everyBlocks: number;
  keep: number;
  trend: Trend;
  action: Intent | null;
}

export const LIMITS = Object.freeze({ observations: 20, keep: 200, everyBlocks: 100_000, name: 60, label: 80 });

const bad = (message: string) => new AgentError("usage", message);
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** The unit a read's value is shown in, where the config alone tells it (a token's decimals are read on chain). */
export function unitOf(read: Read, net: Network): string {
  switch (read.kind) {
    case "erc20-balance":
      return knownToken(net, read.token)?.symbol ?? "tokens";
    case "native-balance":
      return net.nativeSymbol;
    case "gas-price":
      return "gwei";
    default:
      return "";
  }
}

/** A sentence-length name for what is observed, when the watcher gives none. */
function defaultLabel(read: Read, net: Network): string {
  switch (read.kind) {
    case "erc20-balance":
      return `${unitOf(read, net)} held by ${short(read.holder)}`;
    case "native-balance":
      return `${net.nativeSymbol} held by ${short(read.address)}`;
    case "gas-price":
      return "The gas price";
    case "nonce":
      return `Transactions sent by ${short(read.address)}`;
    case "call":
      return `${parseSignature(read.signature).abi.name}() on ${short(read.to)}`;
    default:
      return "The value";
  }
}

const integer = (value: unknown, min: number, max: number, what: string): number => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw bad(`${what} must be a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.`);
  return value as number;
};

function parseTrend(raw: unknown): Trend {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("trend must be an object.");
  const t = raw as Record<string, unknown>;
  const observations = integer(t.observations, 2, LIMITS.observations, "trend.observations");
  switch (t.kind) {
    case "falling":
    case "rising":
      return { kind: t.kind, observations };
    case "change": {
      const percent = String(t.percent ?? "").trim();
      if (!/^[+-]\d{1,3}(\.\d{1,2})?$/.test(percent) || Number(percent) === 0 || Math.abs(Number(percent)) > 1000) throw bad('trend.percent must be signed, like "-5" (fell by at least 5 %) or "+10" (rose by at least 10 %).');
      return { kind: "change", observations, percent };
    }
    case "sustained": {
      if (!["<", "<=", ">", ">="].includes(String(t.op))) throw bad("trend.op must be one of < <= > >=.");
      const value = String(t.value ?? "").trim();
      parseAmount(value, 36, "trend.value");
      return { kind: "sustained", observations, op: t.op as "<" | "<=" | ">" | ">=", value };
    }
    default:
      throw bad("trend.kind must be falling, rising, change or sustained.");
  }
}

/** A watcher from untrusted JSON (a file, a preset, an API query): every field checked. */
export function parseWatcher(input: unknown): Watcher {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("A watcher is a JSON object.");
  const w = input as Record<string, unknown>;
  for (const key of Object.keys(w)) if (!["name", "network", "observe", "label", "everyBlocks", "keep", "trend", "action"].includes(key)) throw bad(`The watcher has an unknown field "${key}".`);
  if (typeof w.name !== "string" || !w.name.trim() || w.name.length > LIMITS.name) throw bad(`name: a name of at most ${LIMITS.name} characters.`);
  const networkId = w.network ?? "pharos-mainnet";
  if (typeof networkId !== "string" || !(networkId in NETWORKS)) throw bad("network must be pharos-mainnet or atlantic-testnet.");
  const net = NETWORKS[networkId as NetworkId];
  const observe = parseRead(w.observe, "observe");
  if (readValueType(observe) !== "number" || observe.kind === "block-age") throw bad("observe must read a number that can trend: erc20-balance, native-balance, a call returning an integer, gas-price or nonce.");
  const label = w.label === undefined ? defaultLabel(observe, net) : String(w.label).trim().slice(0, LIMITS.label);
  const everyBlocks = w.everyBlocks === undefined ? 1 : integer(w.everyBlocks, 1, LIMITS.everyBlocks, "everyBlocks");
  const trend = parseTrend(w.trend);
  const keep = w.keep === undefined ? 50 : integer(w.keep, trend.observations, LIMITS.keep, "keep");
  // The threshold of a sustained trend is in the value's own units; a token's decimals are applied once read.
  if (trend.kind === "sustained" && observe.kind !== "erc20-balance") parseAmount(trend.value, decimalsOf(observe) ?? 0, "trend.value");
  const action = w.action === undefined || w.action === null ? null : parseDryRun({ network: net.id, intent: w.action }).intent;
  if (action?.kind === "call") throw bad("action must be a transfer or an approval: a contract call's outcome cannot be predicted here.");
  return { name: w.name.trim(), network: net.id, observe, label, everyBlocks, keep, trend, action };
}

/** The decimals of a read's value where the config fixes them; null for a token (read on chain). */
export function decimalsOf(read: Read): number | null {
  switch (read.kind) {
    case "native-balance":
      return 18;
    case "gas-price":
      return 9;
    case "call":
      return read.decimals ?? 0;
    case "nonce":
      return 0;
    default:
      return null;
  }
}

/** The trend in words: "Fell across the last 3 observations". */
export function describeTrend(trend: Trend, unit: string, decimals: number): string {
  const n = trend.observations;
  switch (trend.kind) {
    case "falling":
      return `Fell across the last ${n} observations`;
    case "rising":
      return `Rose across the last ${n} observations`;
    case "change":
      return `${trend.percent.startsWith("-") ? "Fell" : "Rose"} by at least ${trend.percent.slice(1)} % over the last ${n} observations`;
    case "sustained": {
      const words = { "<": "Below", "<=": "At most", ">": "Above", ">=": "At least" }[trend.op];
      const value = `${formatAmount(parseAmount(trend.value, decimals), decimals, decimals)}${unit ? ` ${unit}` : ""}`;
      return `${words} ${value} in each of the last ${n} observations`;
    }
  }
}
