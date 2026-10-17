// Task 23, Whale-Watching Agent: which addresses are tracked and what counts as significant, as JSON,
// checked before anything touches the chain.
//
//   addresses  up to 10, each with a label
//   tokens     official tokens of the network (the Skill Engine's list), each with the smallest transfer
//              that is significant
//   native     the smallest change of an address's native balance between two runs that is significant
//              (native transfers leave no logs, so they are seen as balance changes); null to only show it
import { getAddress, isAddress } from "viem";
import { parseAmount } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { knownToken, NETWORKS, type NetworkId } from "../core/networks.js";

export interface Tracked {
  address: Address;
  label: string;
}

export interface TrackedToken {
  token: Address;
  symbol: string;
  decimals: number;
  /** The smallest transfer that is significant, in the token's units. */
  min: string;
}

export interface Watchlist {
  name: string;
  network: NetworkId;
  addresses: Tracked[];
  tokens: TrackedToken[];
  native: { min: string } | null;
  /** Blocks of logs a first run looks back over. */
  lookback: number;
  /** The most blocks of logs one run scans; a run further behind skips the oldest, and says so. */
  maxScan: number;
}

export const LIMITS = Object.freeze({ addresses: 10, tokens: 4, lookback: 2000, maxScan: 10_000, name: 60, label: 40 });

const bad = (message: string) => new AgentError("usage", message);
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** A watchlist from untrusted JSON (a file, a preset, an API query): every field checked. */
export function parseWatchlist(input: unknown): Watchlist {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("A watchlist is a JSON object.");
  const w = input as Record<string, unknown>;
  for (const key of Object.keys(w)) if (!["name", "network", "addresses", "tokens", "native", "lookback", "maxScan"].includes(key)) throw bad(`The watchlist has an unknown field "${key}".`);
  if (typeof w.name !== "string" || !w.name.trim() || w.name.length > LIMITS.name) throw bad(`name: a name of at most ${LIMITS.name} characters.`);
  const networkId = w.network ?? "pharos-mainnet";
  if (typeof networkId !== "string" || !(networkId in NETWORKS)) throw bad("network must be pharos-mainnet or atlantic-testnet.");
  const net = NETWORKS[networkId as NetworkId];
  const whole = (value: unknown, fallback: number, max: number, what: string) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw bad(`${what} must be a whole number of blocks from 1 to ${max.toLocaleString("en-US")}.`);
    return value as number;
  };

  if (!Array.isArray(w.addresses) || w.addresses.length === 0 || w.addresses.length > LIMITS.addresses) throw bad(`addresses must list 1 to ${LIMITS.addresses} addresses.`);
  const seen = new Set<string>();
  const addresses = w.addresses.map((raw, index): Tracked => {
    const entry = typeof raw === "string" ? { address: raw } : ((raw ?? {}) as Record<string, unknown>);
    for (const key of Object.keys(entry)) if (!["address", "label"].includes(key)) throw bad(`addresses[${index}] has an unknown field "${key}".`);
    if (typeof entry.address !== "string" || !isAddress(entry.address, { strict: false })) throw bad(`addresses[${index}] must be a 0x address (40 hex characters).`);
    const address = getAddress(entry.address);
    if (seen.has(address)) throw bad(`${address} is listed twice.`);
    seen.add(address);
    const label = entry.label === undefined ? short(address) : String(entry.label).trim().slice(0, LIMITS.label);
    return { address, label: label || short(address) };
  });

  const tokensRaw = w.tokens ?? [];
  if (!Array.isArray(tokensRaw) || tokensRaw.length > LIMITS.tokens) throw bad(`tokens must list at most ${LIMITS.tokens} tokens.`);
  const tokens = tokensRaw.map((raw, index): TrackedToken => {
    const t = (raw ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(t)) if (!["token", "min"].includes(key)) throw bad(`tokens[${index}] has an unknown field "${key}".`);
    if (typeof t.token !== "string" || !isAddress(t.token, { strict: false })) throw bad(`tokens[${index}].token must be a 0x address.`);
    const official = knownToken(net, t.token);
    if (!official) throw bad(`tokens[${index}]: ${t.token} is not on ${net.name}'s official token list (${net.tokens.map((k) => k.symbol).join(", ")}).`);
    const min = String(t.min ?? "0").trim();
    parseAmount(min, official.decimals, `tokens[${index}].min`);
    return { token: getAddress(official.address), symbol: official.symbol, decimals: official.decimals, min };
  });
  if (new Set(tokens.map((t) => t.token)).size !== tokens.length) throw bad("A token is listed twice.");

  let native: Watchlist["native"] = null;
  if (w.native !== undefined && w.native !== null) {
    const n = w.native as Record<string, unknown>;
    if (typeof n !== "object" || Object.keys(n).some((key) => key !== "min")) throw bad('native is { "min": "<amount>" } or null.');
    const min = String(n.min ?? "").trim();
    parseAmount(min, 18, "native.min");
    native = { min };
  }
  return { name: w.name.trim(), network: net.id, addresses, tokens, native, lookback: whole(w.lookback, 1000, LIMITS.lookback, "lookback"), maxScan: whole(w.maxScan, 2000, LIMITS.maxScan, "maxScan") };
}
