// Task 18, Recurring Payment Agent: a schedule of repeating payments, a line each, read by a small grammar
// (no language model), and the calendar that says when each falls due. Dates are UTC days.
//
//   Rent: 25 USDC to 0x…, monthly on the 1st
//   Payroll: 10 USDC to 0x…, monthly on the last day, from 2026-10-01
//   Design tool: 2 USDC to 0x…, weekly on Monday, until 2027-06-30
//   Gym: 0.01 PROS to 0x…, every 2 weeks on Friday, from 2026-10-02
//   Domain: 12 USDC to 0x…, yearly on March 1
//
// A rule is daily or every N days, weekly or every N weeks on a weekday, monthly or every N months on a
// day (a day past a month's end falls on its last day), or yearly on a month and day. Every N of
// anything but a day counts from its "from" date, which it then needs. A line it cannot read whole is
// refused, saying which part.
import { getAddress, zeroAddress } from "viem";
import { formatAmount, parseAmount } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { knownToken, type Network, type Token } from "../core/networks.js";
import { addressesIn, dateIn } from "../invoice/read.js";

export type Rule =
  | { kind: "daily"; every: number }
  | { kind: "weekly"; every: number; weekday: number }
  | { kind: "monthly"; every: number; day: number | "last" }
  | { kind: "yearly"; month: number; day: number | "last" };

export interface ScheduleItem {
  /** The name in lowercase words joined by "-": what the store records a payment under. */
  id: string;
  name: string;
  to: Address;
  /** The official token; null for the native token. */
  token: Token | null;
  asset: string;
  /** In the asset's units, without grouping. */
  amount: string;
  raw: bigint;
  rule: Rule;
  /** The rule in words: "monthly on the 1st". */
  every: string;
  from: string | null;
  until: string | null;
  line: string;
}

export const MAX_ITEMS = 20;
export const MAX_SCHEDULE = 3000;
const MAX_LINE = 240;
const DAY = 86_400_000;
const bad = (message: string) => new AgentError("usage", message);
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NTH = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const capital = (word: string) => `${word[0]!.toUpperCase()}${word.slice(1)}`;

/** A UTC day as a number of days since 1970-01-01, and back. */
export const dayOf = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
export const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
/** 0 for Monday to 6 for Sunday: 1970-01-01 was a Thursday. */
const weekdayOf = (day: number) => (day + 3) % 7;
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

const weekdayNamed = (word: string) => {
  const w = word.toLowerCase().replace(/s$/, "");
  return w.length >= 3 ? WEEKDAYS.findIndex((name) => name.startsWith(w)) : -1;
};
const monthNamed = (word: string) => {
  const w = word.toLowerCase().replace(/\.$/, "");
  return w.length >= 3 ? MONTHS.findIndex((name) => name.startsWith(w)) : -1;
};
/** "1st", "the 1st", "day 1", "the last day": a day of the month. */
function dayOfMonth(text: string): number | "last" | null {
  const t = text.trim().toLowerCase().replace(/^the\s+/, "");
  if (/^last(?:\s+day)?$/.test(t)) return "last";
  const m = /^(?:day\s+)?(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 31 ? n : null;
}

/** A rule in words, as the schedule may write it; null when it is not one. */
function ruleIn(text: string): Rule | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  let m: RegExpExecArray | null;
  if (/^(?:daily|every day)$/.test(t)) return { kind: "daily", every: 1 };
  if ((m = /^every (\d{1,3}) days$/.exec(t))) return { kind: "daily", every: Number(m[1]) };
  if ((m = /^(?:weekly|every week) on ([a-z]+)$/.exec(t)) && weekdayNamed(m[1]!) >= 0) return { kind: "weekly", every: 1, weekday: weekdayNamed(m[1]!) };
  if ((m = /^every ([a-z]+)$/.exec(t)) && weekdayNamed(m[1]!) >= 0) return { kind: "weekly", every: 1, weekday: weekdayNamed(m[1]!) };
  if ((m = /^every (\d{1,2}) weeks on ([a-z]+)$/.exec(t)) && weekdayNamed(m[2]!) >= 0) return { kind: "weekly", every: Number(m[1]), weekday: weekdayNamed(m[2]!) };
  if ((m = /^(?:monthly|every month) on (.+)$/.exec(t)) && dayOfMonth(m[1]!) !== null) return { kind: "monthly", every: 1, day: dayOfMonth(m[1]!)! };
  if ((m = /^every (\d{1,2}) months on (.+)$/.exec(t)) && dayOfMonth(m[2]!) !== null) return { kind: "monthly", every: Number(m[1]), day: dayOfMonth(m[2]!)! };
  if ((m = /^(?:yearly|annually|every year) on (?:([a-z]+\.?) (.+)|(.+?) (?:of )?([a-z]+\.?))$/.exec(t))) {
    const [month, day] = m[1] ? [monthNamed(m[1]), dayOfMonth(m[2]!)] : [monthNamed(m[4]!), dayOfMonth(m[3]!)];
    if (month >= 0 && day !== null) return { kind: "yearly", month, day };
  }
  return null;
}

/** The rule back in words. */
function words(rule: Rule): string {
  const day = (d: number | "last") => (d === "last" ? "the last day" : `the ${NTH(d)}`);
  switch (rule.kind) {
    case "daily":
      return rule.every === 1 ? "daily" : `every ${rule.every} days`;
    case "weekly":
      return rule.every === 1 ? `weekly on ${capital(WEEKDAYS[rule.weekday]!)}` : `every ${rule.every} weeks on ${capital(WEEKDAYS[rule.weekday]!)}`;
    case "monthly":
      return rule.every === 1 ? `monthly on ${day(rule.day)}` : `every ${rule.every} months on ${day(rule.day)}`;
    case "yearly":
      return `yearly on ${capital(MONTHS[rule.month]!)} ${rule.day === "last" ? "the last day" : rule.day}`;
  }
}

/** The asset a word names on `net`: null for the native token. */
function assetNamed(net: Network, word: string): Token | null {
  const w = word.toLowerCase();
  if (w === net.nativeSymbol.toLowerCase()) return null;
  const token = net.tokens.find((t) => t.symbol.toLowerCase() === w);
  if (!token) throw bad(`"${word}" is not ${net.nativeSymbol} or an official ${net.name} token (${net.tokens.map((t) => t.symbol).join(", ")}).`);
  return { ...token, address: getAddress(token.address) };
}

/** One line: "<name>: <amount> <asset> to <0x…>, <rule>[, from <date>][, until <date>]". */
function itemIn(line: string, net: Network): ScheduleItem {
  if (line.length > MAX_LINE) throw bad(`A schedule line is at most ${MAX_LINE} characters.`);
  const colon = line.indexOf(":");
  if (colon <= 0) throw bad(`A schedule line starts with a name and a colon, like "Rent: 25 USDC to 0x…, monthly on the 1st". Got "${line.slice(0, 60)}".`);
  const name = line.slice(0, colon).trim().replace(/\s+/g, " ");
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!/[a-z]/.test(id) || name.length > 40) throw bad(`"${name.slice(0, 50)}" cannot be a payment's name: it needs a letter, and at most 40 characters.`);
  // Parts are split at a comma before a word: "1,500 USDC" and "Oct 17, 2026" keep theirs.
  const [what, ...rest] = line.slice(colon + 1).split(/,\s*(?=[A-Za-z])/).map((part) => part.trim());
  const pay = /^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([A-Za-z]+)\s+to\s+(0x\S+)$/i.exec(what ?? "");
  if (!pay) throw bad(`${name}: "${(what ?? "").slice(0, 60)}" is not read as "<amount> <asset> to 0x…".`);
  const token = assetNamed(net, pay[2]!);
  const decimals = token?.decimals ?? 18;
  const raw = parseAmount(pay[1]!.replaceAll(",", ""), decimals, `${name}'s amount`);
  if (raw === 0n) throw bad(`${name}: the amount must be more than zero.`);
  const [to] = addressesIn(pay[3]!);
  if (!to || pay[3]!.length !== 42) throw bad(`${name}: "${pay[3]!.slice(0, 50)}" is not an address: 0x and 40 hex characters.`);
  if (to === zeroAddress || knownToken(net, to)) throw bad(`${name}: ${to === zeroAddress ? "the zero address" : "a token contract"} cannot be paid: whatever is sent there is lost.`);
  let rule: Rule | null = null;
  let every = "";
  let from: string | null = null;
  let until: string | null = null;
  for (const part of rest) {
    const date = /^(from|until|starting|ending)\s+(.+)$/i.exec(part);
    if (date) {
      const iso = dateIn(date[2]!);
      if (iso === null) throw bad(`${name}: "${date[2]}" is not a date the agent reads. Write it as 2026-11-01.`);
      if (/^(?:from|starting)$/i.test(date[1]!)) from = iso;
      else until = iso;
      continue;
    }
    if (rule) throw bad(`${name}: "${part}" is not read: one rule a line, then "from" or "until" a date.`);
    rule = ruleIn(part);
    if (!rule) throw bad(`${name}: "${part}" is not a rule the agent reads, like "monthly on the 1st", "weekly on Friday", "every 14 days" or "yearly on March 1".`);
    every = words(rule);
  }
  if (!rule) throw bad(`${name}: say how often, like "monthly on the 1st" or "weekly on Monday".`);
  if (rule.kind !== "yearly" && rule.every > 1 && !from) throw bad(`${name}: "${every}" counts from a start: add "from" a date.`);
  if (rule.kind !== "yearly" && (rule.every < 1 || (rule.kind === "daily" && rule.every > 366) || (rule.kind === "weekly" && rule.every > 52) || (rule.kind === "monthly" && rule.every > 12))) throw bad(`${name}: "${every}" is out of range (at most every 366 days, 52 weeks or 12 months).`);
  if (rule.kind === "yearly" && rule.day !== "last" && rule.day > lastDayOf(2024, rule.month)) throw bad(`${name}: ${capital(MONTHS[rule.month]!)} has no ${NTH(rule.day)}.`);
  if (from && until && until < from) throw bad(`${name}: it ends (${until}) before it starts (${from}).`);
  return { id, name, to, token, asset: token?.symbol ?? net.nativeSymbol, amount: formatAmount(raw, decimals, decimals).replaceAll(",", ""), raw, rule, every, from, until, line };
}

/** The schedule in `text`: one payment a line. Refuses, saying why, a line it cannot read whole. */
export function readSchedule(text: unknown, net: Network, max = MAX_ITEMS): ScheduleItem[] {
  const whole = typeof text === "string" ? text.replace(/\r\n?/g, "\n").trim() : "";
  if (!whole) throw bad('Write a schedule: one payment a line, like "Rent: 25 USDC to 0x…, monthly on the 1st".');
  if (whole.length > MAX_SCHEDULE) throw bad(`A schedule is at most ${MAX_SCHEDULE.toLocaleString("en-US")} characters.`);
  const lines = whole.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (lines.length > max) throw bad(`A schedule holds at most ${max} payments here.`);
  const items = lines.map((line) => itemIn(line, net));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw bad(`Two payments are named "${item.name}": each needs its own name, which its payments are recorded under.`);
    seen.add(item.id);
  }
  return items;
}

/** Whether `item` falls due on `day` (days since 1970-01-01, UTC). */
export function dueOn(item: ScheduleItem, day: number): boolean {
  const iso = isoOf(day);
  if ((item.from && iso < item.from) || (item.until && iso > item.until)) return false;
  const rule = item.rule;
  const anchor = item.from ? dayOf(item.from) : 0;
  const date = new Date(day * DAY);
  const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
  const monthDay = (want: number | "last") => (want === "last" ? lastDayOf(y, m) : Math.min(want, lastDayOf(y, m)));
  switch (rule.kind) {
    case "daily":
      return rule.every === 1 || (day - anchor) % rule.every === 0;
    case "weekly": {
      if (weekdayOf(day) !== rule.weekday) return false;
      if (rule.every === 1) return true;
      const first = anchor + ((rule.weekday - weekdayOf(anchor) + 7) % 7);
      return (day - first) % (7 * rule.every) === 0;
    }
    case "monthly": {
      if (d !== monthDay(rule.day)) return false;
      if (rule.every === 1) return true;
      const start = new Date(anchor * DAY);
      return (y * 12 + m - (start.getUTCFullYear() * 12 + start.getUTCMonth())) % rule.every === 0;
    }
    case "yearly":
      return m === rule.month && d === monthDay(rule.day);
  }
}

/** Every day `item` falls due from `start` to `end`, both included, as YYYY-MM-DD. */
export function occurrences(item: ScheduleItem, start: string, end: string): string[] {
  const out: string[] = [];
  for (let day = dayOf(start); day <= dayOf(end); day += 1) if (dueOn(item, day)) out.push(isoOf(day));
  return out;
}

/** The first day after `after` that `item` falls due, within a year and a half; null when it has ended. */
export function nextDue(item: ScheduleItem, after: string): string | null {
  for (let day = dayOf(after) + 1, last = dayOf(after) + 550; day <= last; day += 1) {
    if (item.until && isoOf(day) > item.until) return null;
    if (dueOn(item, day)) return isoOf(day);
  }
  return null;
}
