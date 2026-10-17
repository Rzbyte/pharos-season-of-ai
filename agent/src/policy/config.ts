// Task 11, Policy Gatekeeper: the policy a requested action is checked against, as JSON. Everything is
// checked here, before anything touches the chain: rule kinds, assets, addresses, amounts, the window,
// the hours.
//
// Rule kinds:
//   asset-allowlist         only these assets may move (the native symbol or official token symbols)
//   counterparty-allowlist  the recipient of a transfer, or the spender of an approval, is one of these
//   max-per-action          one action moves or approves at most this much of an asset
//   max-in-window           the sender's own transfers of a token over the last N blocks, read from its
//                           Transfer logs, plus this action, stay within a cap
//   time-window             the pinned block's time falls on these days, between these hours
//   max-gas-price           the gas price is at most this
//   simulates               the transaction succeeds in a dry run (Task 08)
import { getAddress, isAddress } from "viem";
import { parseAmount, parseGasPrice } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { NETWORKS, type Network, type NetworkId } from "../core/networks.js";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

interface RuleBase {
  id: string;
  /** Shown instead of the generated description. */
  label?: string;
}

export type Rule =
  | (RuleBase & { kind: "asset-allowlist"; assets: string[] })
  | (RuleBase & { kind: "counterparty-allowlist"; addresses: Address[] })
  | (RuleBase & { kind: "max-per-action"; asset: string; amount: string })
  | (RuleBase & { kind: "max-in-window"; asset: string; amount: string; blocks: number })
  | (RuleBase & { kind: "time-window"; days: Day[]; from: string; to: string; utcOffset: string })
  | (RuleBase & { kind: "max-gas-price"; gwei: string })
  | (RuleBase & { kind: "simulates" });

export type RuleKind = Rule["kind"];

export interface Policy {
  name: string;
  network: NetworkId;
  rules: Rule[];
}

export const KINDS: readonly RuleKind[] = ["asset-allowlist", "counterparty-allowlist", "max-per-action", "max-in-window", "time-window", "max-gas-price", "simulates"];

export const LIMITS = Object.freeze({ rules: 20, assets: 20, addresses: 200, windowBlocks: 10_000 });

const bad = (message: string) => new AgentError("usage", message);

/** The decimals of an asset of `net` by symbol: its native symbol, or one of its official tokens. */
export function assetDecimals(net: Network, symbol: string): number | null {
  if (symbol === net.nativeSymbol) return 18;
  return net.tokens.find((token) => token.symbol === symbol)?.decimals ?? null;
}

const asset = (net: Network, value: unknown, where: string): string => {
  if (typeof value !== "string" || assetDecimals(net, value) === null) throw bad(`${where}: an asset is ${net.nativeSymbol} or an official ${net.name} token (${net.tokens.map((t) => t.symbol).join(", ")}), got ${JSON.stringify(value)}.`);
  return value;
};

/** "HH:MM" from 00:00 to 24:00, as minutes after midnight. */
export function minutesOf(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return Number.NaN;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes > 0)) return Number.NaN;
  return hours * 60 + minutes;
}

/** "+07:00" or "-03:30" as seconds east of UTC. */
export function offsetSeconds(offset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) return Number.NaN;
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60;
  return Number(match[3]) > 59 || seconds > 14 * 3600 ? Number.NaN : (match[1] === "-" ? -seconds : seconds);
}

/** A policy from untrusted JSON; every field checked. */
export function parsePolicy(input: unknown): Policy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("A policy is a JSON object.");
  const p = input as Record<string, unknown>;
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 80) throw bad("name: a short name for the policy.");
  const networkId = p.network ?? "pharos-mainnet";
  if (typeof networkId !== "string" || !(networkId in NETWORKS)) throw bad("network: pharos-mainnet or atlantic-testnet.");
  const net = NETWORKS[networkId as NetworkId];
  if (!Array.isArray(p.rules) || p.rules.length === 0 || p.rules.length > LIMITS.rules) throw bad(`rules: a list of 1 to ${LIMITS.rules} rules.`);
  const ids = new Set<string>();
  const rules = p.rules.map((raw, index): Rule => {
    if (!raw || typeof raw !== "object") throw bad(`rules[${index}]: a rule is an object.`);
    const r = raw as Record<string, unknown>;
    const where = `rules[${index}]`;
    if (typeof r.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(r.id)) throw bad(`${where}.id: lowercase letters, digits and dashes, like "per-action".`);
    if (ids.has(r.id)) throw bad(`${where}.id: "${r.id}" is used twice.`);
    ids.add(r.id);
    const base: RuleBase = { id: r.id, ...(r.label === undefined ? {} : { label: String(r.label).slice(0, 120) }) };
    const at = `${where} (${r.id})`;
    switch (r.kind) {
      case "asset-allowlist": {
        if (!Array.isArray(r.assets) || r.assets.length === 0 || r.assets.length > LIMITS.assets) throw bad(`${at}.assets: a list of 1 to ${LIMITS.assets} assets.`);
        return { ...base, kind: r.kind, assets: r.assets.map((value) => asset(net, value, `${at}.assets`)) };
      }
      case "counterparty-allowlist": {
        if (!Array.isArray(r.addresses) || r.addresses.length === 0 || r.addresses.length > LIMITS.addresses) throw bad(`${at}.addresses: a list of 1 to ${LIMITS.addresses} addresses.`);
        return {
          ...base,
          kind: r.kind,
          addresses: r.addresses.map((value) => {
            if (typeof value !== "string" || !isAddress(value, { strict: false })) throw bad(`${at}.addresses: ${JSON.stringify(value)} is not a 0x address.`);
            return getAddress(value);
          }),
        };
      }
      case "max-per-action":
      case "max-in-window": {
        const symbol = asset(net, r.asset, `${at}.asset`);
        const amount = String(r.amount ?? "").trim();
        if (parseAmount(amount, assetDecimals(net, symbol)!, `${at}.amount`) <= 0n) throw bad(`${at}.amount: more than 0.`);
        if (r.kind === "max-per-action") return { ...base, kind: r.kind, asset: symbol, amount };
        if (symbol === net.nativeSymbol) throw bad(`${at}: a window limit is for tokens, whose transfers leave logs; native ${net.nativeSymbol} transfers do not.`);
        if (!Number.isInteger(r.blocks) || (r.blocks as number) < 1 || (r.blocks as number) > LIMITS.windowBlocks) throw bad(`${at}.blocks: a whole number of blocks from 1 to ${LIMITS.windowBlocks.toLocaleString("en-US")}.`);
        return { ...base, kind: r.kind, asset: symbol, amount, blocks: r.blocks as number };
      }
      case "time-window": {
        const days = r.days ?? [...DAYS];
        if (!Array.isArray(days) || days.length === 0 || !days.every((day) => DAYS.includes(day as Day))) throw bad(`${at}.days: some of ${DAYS.join(", ")}.`);
        const from = String(r.from ?? "");
        const to = String(r.to ?? "");
        if (Number.isNaN(minutesOf(from)) || Number.isNaN(minutesOf(to))) throw bad(`${at}: from and to are times like "06:00" and "22:00" (24:00 is the end of the day).`);
        if (minutesOf(from) === minutesOf(to)) throw bad(`${at}: from and to must differ (a window over midnight, like 22:00 to 06:00, is allowed).`);
        const utcOffset = String(r.utcOffset ?? "+00:00");
        if (Number.isNaN(offsetSeconds(utcOffset))) throw bad(`${at}.utcOffset: like "+00:00" or "+07:00", at most 14 hours.`);
        return { ...base, kind: r.kind, days: DAYS.filter((day) => days.includes(day)), from, to, utcOffset };
      }
      case "max-gas-price": {
        const gwei = String(r.gwei ?? "").trim();
        if (parseGasPrice(`${gwei} gwei`) <= 0n) throw bad(`${at}.gwei: more than 0.`);
        return { ...base, kind: r.kind, gwei };
      }
      case "simulates":
        return { ...base, kind: r.kind };
      default:
        throw bad(`${at}.kind: one of ${KINDS.join(", ")}.`);
    }
  });
  return { name: p.name.trim(), network: net.id, rules };
}

const DAY_NAMES: Record<Day, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** "every day", "Mon–Fri", or "Mon, Wed, Fri". */
export function daysText(days: readonly Day[]): string {
  if (days.length === 7) return "every day";
  const indexes = days.map((day) => DAYS.indexOf(day));
  const contiguous = indexes.every((value, i) => i === 0 || value === indexes[i - 1]! + 1);
  if (contiguous && days.length > 2) return `${DAY_NAMES[days[0]!]}–${DAY_NAMES[days.at(-1)!]}`;
  return days.map((day) => DAY_NAMES[day]).join(", ");
}

export const zoneText = (offset: string) => (offsetSeconds(offset) === 0 ? "UTC" : `UTC${offset}`);

/** An amount as written, its whole part grouped: "1,000.5 USDC". */
export const amountText = (value: string, symbol: string) => `${value.replace(/^\d+/, (whole) => BigInt(whole).toLocaleString("en-US"))} ${symbol}`;

/** What a rule means, in one line; the counterparty is named for the request when it is known. */
export function describeRule(rule: Rule, net: Network, counterparty: "recipient" | "spender" | null = null): string {
  if (rule.label) return rule.label;
  const amount = amountText;
  switch (rule.kind) {
    case "asset-allowlist":
      return `Only ${rule.assets.length === 1 ? rule.assets[0] : `${rule.assets.slice(0, -1).join(", ")} or ${rule.assets.at(-1)}`}`;
    case "counterparty-allowlist":
      return `The ${counterparty ?? "recipient or spender"} is one of ${rule.addresses.length} allowed ${rule.addresses.length === 1 ? "address" : "addresses"}`;
    case "max-per-action":
      return `At most ${amount(rule.amount, rule.asset)} per action`;
    case "max-in-window":
      return `At most ${amount(rule.amount, rule.asset)} sent in ${rule.blocks.toLocaleString("en-US")} blocks`;
    case "time-window":
      return `Between ${rule.from} and ${rule.to} ${zoneText(rule.utcOffset)}, ${daysText(rule.days)}`;
    case "max-gas-price":
      return `Gas costs at most ${rule.gwei} gwei`;
    case "simulates":
      return `It succeeds in a dry run on ${net.name}`;
  }
}
