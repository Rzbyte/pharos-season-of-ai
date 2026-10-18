// Task 18: what a recurring schedule keeps between runs: the day it counts from, the payments it has paid
// (each due day of each payment once, with its transaction), and its last run. What is owed is not kept:
// each run works it out again, every due day since the start that is not paid, so a payment that did not
// go through is owed until one does. One sent but not yet in a block is kept as pending, never paid again
// while it may still land: the next run reads its receipt. One store belongs to one payer on one network.
import type { Address, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";

export interface PaidPayment {
  /** "<payment>@<due day>": rent@2026-10-01. */
  id: string;
  tx: Hex;
  /** Its block; null while it was sent but not yet in a block (pending): the next run reads its receipt. */
  block: string | null;
  status: "success" | "pending";
}

export interface RecurringStore {
  schema: "pharos-agent/recurring-store/1";
  network: string;
  payer: Address;
  /** The first day counted, YYYY-MM-DD: a payment that fell due before it is not owed. */
  since: string;
  lastRun: { block: string; day: string } | null;
  paid: PaidPayment[];
}

export const MAX_PAID = 2000;
const bad = (message: string) => new AgentError("usage", message);

export const emptyRecurringStore = (network: string, payer: Address, since: string): RecurringStore => ({ schema: "pharos-agent/recurring-store/1", network, payer, since, lastRun: null, paid: [] });

/** A store from untrusted JSON: its shape checked, and that it belongs to this network (and payer, when one is given). */
export function parseRecurringStore(raw: unknown, network: string, payer?: Address): RecurringStore {
  const store = raw as Partial<RecurringStore> | null;
  if (!store || typeof store !== "object" || store.schema !== "pharos-agent/recurring-store/1") throw bad("The store is not a recurring payment store (pharos-agent/recurring-store/1).");
  if (store.network !== network) throw bad(`The store is for ${String(store.network)}, not ${network}.`);
  if (typeof store.payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(store.payer)) throw bad("The store's payer is not an address.");
  if (payer && store.payer.toLowerCase() !== payer.toLowerCase()) throw bad(`The store belongs to the payer ${store.payer}, not ${payer}: one store a payer.`);
  if (typeof store.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(store.since)) throw bad("The store's start day is not a YYYY-MM-DD day.");
  if (store.lastRun !== null && (typeof store.lastRun !== "object" || !/^\d+$/.test(String(store.lastRun?.block)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(store.lastRun?.day)))) throw bad("The store's last run is malformed.");
  if (!Array.isArray(store.paid) || store.paid.length > MAX_PAID) throw bad(`The store's paid payments must be a list of at most ${MAX_PAID.toLocaleString("en-US")}: start a new store from a later day.`);
  const ids = new Set<string>();
  for (const p of store.paid) {
    if (!p || typeof p.id !== "string" || !/^[a-z0-9-]+@\d{4}-\d{2}-\d{2}$/.test(p.id) || typeof p.tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.tx) || !((p.status === "success" && /^\d+$/.test(String(p.block))) || (p.status === "pending" && p.block === null))) throw bad("A paid payment in the store is malformed.");
    if (ids.has(p.id)) throw bad(`The store records ${p.id} as paid twice.`);
    ids.add(p.id);
  }
  return { schema: store.schema, network, payer: store.payer as Address, since: store.since, lastRun: store.lastRun ?? null, paid: store.paid };
}
