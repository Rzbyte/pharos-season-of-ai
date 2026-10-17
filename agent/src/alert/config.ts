// Task 22, On-Chain Alert Bot: what the bot watches for, as JSON, checked before anything touches the
// chain. Two kinds of rule:
//
//   state     a guardian condition (Task 05): a value read at the newest block against a threshold, like
//             a balance below 100 USDC, the gas price above 5 gwei or paused() = true. It alerts when the
//             condition starts to hold, and says when it stops.
//   transfer  a token's Transfer logs: from and to filters, and a smallest amount. Every matching
//             transfer since the last run is an alert, once.
import { getAddress, isAddress } from "viem";
import { parseAmount } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { knownToken, NETWORKS, type Network, type NetworkId } from "../core/networks.js";
import { parseCondition, type Condition } from "../guardian/config.js";

export interface TransferRule {
  kind: "transfer";
  id: string;
  label: string;
  token: Address;
  /** The smallest amount that alerts, in the token's units ("0" for every transfer). */
  min: string;
  from: Address | null;
  to: Address | null;
}

export type AlertRule = { kind: "state"; id: string; label: string; condition: Condition } | TransferRule;

export interface AlertBot {
  name: string;
  network: NetworkId;
  /** Blocks of logs a first run looks back over (it has no cursor yet). */
  lookback: number;
  /** The most blocks of logs one run scans; a run further behind skips the oldest, and says so. */
  maxScan: number;
  rules: AlertRule[];
}

export const LIMITS = Object.freeze({ rules: 12, lookback: 2000, maxScan: 10_000, name: 60, label: 90 });

const bad = (message: string) => new AgentError("usage", message);
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const address = (value: unknown, what: string): Address => {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw bad(`${what} must be a 0x address (40 hex characters).`);
  return getAddress(value);
};

/** A transfer rule in words: "A USDC transfer of 500 or more", "Any USDC transfer from 0x912c…f647". */
export function describeTransfer(net: Network, rule: Pick<TransferRule, "token" | "min" | "from" | "to">): string {
  const symbol = knownToken(net, rule.token)?.symbol ?? `token ${short(rule.token)}`;
  const any = /^0+(\.0+)?$/.test(rule.min);
  const size = any ? "" : ` of ${rule.min.replace(/^\d+/, (whole) => BigInt(whole).toLocaleString("en-US"))} or more`;
  return `${any ? "Any" : "A"} ${symbol} transfer${size}${rule.from ? ` from ${short(rule.from)}` : ""}${rule.to ? ` to ${short(rule.to)}` : ""}`;
}

/** An alert bot from untrusted JSON (a file, a preset, an API query): every rule checked. */
export function parseAlertBot(input: unknown): AlertBot {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("An alert bot is a JSON object.");
  const b = input as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!["name", "network", "lookback", "maxScan", "rules"].includes(key)) throw bad(`The alert bot has an unknown field "${key}".`);
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > LIMITS.name) throw bad(`name: a name of at most ${LIMITS.name} characters.`);
  const networkId = b.network ?? "pharos-mainnet";
  if (typeof networkId !== "string" || !(networkId in NETWORKS)) throw bad("network must be pharos-mainnet or atlantic-testnet.");
  const net = NETWORKS[networkId as NetworkId];
  const whole = (value: unknown, fallback: number, max: number, what: string) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw bad(`${what} must be a whole number of blocks from 1 to ${max.toLocaleString("en-US")}.`);
    return value as number;
  };
  const lookback = whole(b.lookback, 100, LIMITS.lookback, "lookback");
  const maxScan = whole(b.maxScan, 2000, LIMITS.maxScan, "maxScan");
  if (!Array.isArray(b.rules) || b.rules.length === 0 || b.rules.length > LIMITS.rules) throw bad(`rules must list 1 to ${LIMITS.rules} rules.`);
  const ids = new Set<string>();
  const rules = b.rules.map((raw, index): AlertRule => {
    const where = `rules[${index}]`;
    const r = (raw ?? {}) as Record<string, unknown>;
    if (r.kind === "state") {
      const condition = parseCondition(r, where, ids, ["kind"]);
      return { kind: "state", id: condition.id, label: condition.label, condition };
    }
    if (r.kind !== "transfer") throw bad(`${where}.kind must be state or transfer.`);
    for (const key of Object.keys(r)) if (!["kind", "id", "label", "token", "min", "from", "to"].includes(key)) throw bad(`${where} has an unknown field "${key}".`);
    if (typeof r.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(r.id)) throw bad(`${where}.id must be lowercase letters, digits and dashes.`);
    if (ids.has(r.id)) throw bad(`Two rules share the id "${r.id}".`);
    ids.add(r.id);
    const token = address(r.token, `${where}.token`);
    const min = String(r.min ?? "0").trim();
    parseAmount(min, knownToken(net, token)?.decimals ?? 36, `${where}.min`);
    const rule = { token, min, from: r.from === undefined || r.from === null ? null : address(r.from, `${where}.from`), to: r.to === undefined || r.to === null ? null : address(r.to, `${where}.to`) };
    const label = r.label === undefined ? describeTransfer(net, rule) : String(r.label).trim().slice(0, LIMITS.label);
    return { kind: "transfer", id: r.id, label, ...rule };
  });
  return { name: b.name.trim(), network: net.id, lookback, maxScan, rules };
}
