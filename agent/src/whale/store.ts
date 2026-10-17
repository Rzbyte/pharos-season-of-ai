// Task 23: the whale watcher's memory between runs: the last block it scanned for transfers (the
// cursor), and each tracked address as it was at the last run (its native balance, nonce, token
// balances, and whether it is a contract), so the next run can say what changed. It belongs to one
// watchlist on one network.
import { AgentError } from "../core/errors.js";
import type { Watchlist } from "./config.js";

export interface Snapshot {
  block: string;
  native: string;
  nonce: string;
  contract: boolean;
  /** Token address (lowercase) → raw balance. */
  tokens: Record<string, string>;
}

export interface WhaleStore {
  schema: "pharos-agent/whale-store/1";
  watchlist: string;
  cursor: string | null;
  /** Tracked address (lowercase) → its snapshot at the last run. */
  snapshots: Record<string, Snapshot>;
}

export const watchlistKey = (list: Watchlist) => `${list.network}:${list.name}`;

export const emptyWhaleStore = (list: Watchlist): WhaleStore => ({ schema: "pharos-agent/whale-store/1", watchlist: watchlistKey(list), cursor: null, snapshots: {} });

const bad = (message: string) => new AgentError("usage", message);
const DIGITS = /^\d{1,78}$/;

/** A store from untrusted JSON (a file, a browser): its shape checked, and that it is this watchlist's. Snapshots of addresses or tokens no longer tracked are dropped. */
export function parseWhaleStore(input: unknown, list: Watchlist): WhaleStore {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("The store is not a whale store (a JSON object).");
  const s = input as Record<string, unknown>;
  if (s.schema !== "pharos-agent/whale-store/1") throw bad('The store is not a whale store (schema "pharos-agent/whale-store/1").');
  if (s.watchlist !== watchlistKey(list)) throw bad(`The store belongs to another watchlist ("${String(s.watchlist)}"). Use another store for "${list.name}".`);
  if (s.cursor !== null && (typeof s.cursor !== "string" || !/^\d{1,12}$/.test(s.cursor))) throw bad("The store's cursor must be a block number or null.");
  const raw = s.snapshots ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw bad("The store's snapshots must be an object.");
  const snapshots: Record<string, Snapshot> = {};
  const tokens = new Set(list.tokens.map((t) => t.token.toLowerCase()));
  for (const { address } of list.addresses) {
    const snap = (raw as Record<string, unknown>)[address.toLowerCase()] as Record<string, unknown> | undefined;
    if (snap === undefined) continue;
    const where = `The store's snapshot of ${address}`;
    if (!snap || typeof snap !== "object" || typeof snap.block !== "string" || !/^\d{1,12}$/.test(snap.block)) throw bad(`${where} needs a block number.`);
    if (typeof snap.native !== "string" || !DIGITS.test(snap.native) || typeof snap.nonce !== "string" || !DIGITS.test(snap.nonce)) throw bad(`${where} needs a native balance and a nonce, as whole numbers.`);
    if (typeof snap.contract !== "boolean") throw bad(`${where} must say whether it is a contract.`);
    const kept: Record<string, string> = {};
    for (const [token, value] of Object.entries((snap.tokens ?? {}) as Record<string, unknown>)) {
      if (!tokens.has(token)) continue;
      if (typeof value !== "string" || !DIGITS.test(value)) throw bad(`${where} has a token balance that is not a whole number.`);
      kept[token] = value;
    }
    snapshots[address.toLowerCase()] = { block: snap.block, native: snap.native, nonce: snap.nonce, contract: snap.contract, tokens: kept };
  }
  return { schema: "pharos-agent/whale-store/1", watchlist: watchlistKey(list), cursor: (s.cursor as string | null) ?? null, snapshots };
}
