// Task 22: the alert bot's memory between runs: the last block it scanned (the cursor), whether each
// state rule held at the last run (so it alerts when a condition starts, not on every run), and the
// alerts not delivered yet (kept until a delivery succeeds). It belongs to one bot on one network.
import { AgentError } from "../core/errors.js";
import type { AlertBot } from "./config.js";

export interface Alert {
  /** Stable across runs: the rule and the transfer's log, or the rule, the block and the change. */
  id: string;
  rule: string;
  label: string;
  kind: "transfer" | "triggered" | "resolved";
  /** The block the alert is about: the transfer's, or the one the change was seen at. */
  block: string;
  message: string;
  transfer: { tx: string; logIndex: number; from: string; to: string; amount: string; shown: string } | null;
  /** For a state rule: the value seen. */
  observed: string | null;
}

export interface AlertStore {
  schema: "pharos-agent/alert-store/1";
  bot: string;
  cursor: string | null;
  states: Record<string, boolean>;
  pending: Alert[];
}

export const botKey = (bot: AlertBot) => `${bot.network}:${bot.name}`;

export const emptyAlertStore = (bot: AlertBot): AlertStore => ({ schema: "pharos-agent/alert-store/1", bot: botKey(bot), cursor: null, states: {}, pending: [] });

const bad = (message: string) => new AgentError("usage", message);

/** A store from untrusted JSON (a file, a browser): its shape checked, and that it is this bot's. States of rules the bot no longer has are dropped. */
export function parseAlertStore(input: unknown, bot: AlertBot): AlertStore {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("The store is not an alert store (a JSON object).");
  const s = input as Record<string, unknown>;
  if (s.schema !== "pharos-agent/alert-store/1") throw bad('The store is not an alert store (schema "pharos-agent/alert-store/1").');
  if (s.bot !== botKey(bot)) throw bad(`The store belongs to another bot ("${String(s.bot)}"). Use another store for "${bot.name}".`);
  if (s.cursor !== null && (typeof s.cursor !== "string" || !/^\d{1,12}$/.test(s.cursor))) throw bad("The store's cursor must be a block number or null.");
  const states: Record<string, boolean> = {};
  const raw = (s.states ?? {}) as Record<string, unknown>;
  for (const rule of bot.rules) {
    if (rule.kind !== "state" || !(rule.id in raw)) continue;
    if (typeof raw[rule.id] !== "boolean") throw bad(`The store's state for "${rule.id}" must be true or false.`);
    states[rule.id] = raw[rule.id] as boolean;
  }
  if (!Array.isArray(s.pending) || s.pending.length > 500 || !s.pending.every((a) => a && typeof a === "object" && typeof (a as Alert).id === "string" && typeof (a as Alert).message === "string")) throw bad("The store's pending alerts must be a list of at most 500 alerts.");
  return { schema: "pharos-agent/alert-store/1", bot: botKey(bot), cursor: (s.cursor as string | null) ?? null, states, pending: s.pending as Alert[] };
}

/** The store after a delivery: the alerts delivered are no longer pending. */
export const afterDelivery = (store: AlertStore, delivered: readonly string[]): AlertStore => ({ ...store, pending: store.pending.filter((alert) => !delivered.includes(alert.id)) });
