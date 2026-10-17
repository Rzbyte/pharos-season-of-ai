// Task 09: the watcher's memory between runs. A store is JSON: every observation the watcher recorded
// (the block, its time, the raw value) and the block it last acted at. It belongs to one watcher's read
// on one network, so observations of different things are never mixed; it keeps the newest `keep`.
import { AgentError } from "../core/errors.js";
import type { Watcher } from "./config.js";

export interface Observation {
  block: string;
  /** The block's time, ISO 8601. */
  timestamp: string;
  /** The value in base units (a token's smallest unit, wei, a plain integer). */
  raw: string;
}

export interface TrendStore {
  schema: "pharos-agent/trend-store/1";
  /** What is observed, on which network: the store refuses observations of anything else. */
  observing: string;
  observations: Observation[];
  /** The block of the last action: observations up to it do not count toward the next trend. */
  actedAt: string | null;
}

/** The identity of what a watcher observes: its network and its read, as canonical JSON. */
export const observingKey = (watcher: Watcher) => JSON.stringify({ network: watcher.network, observe: watcher.observe });

export const emptyStore = (watcher: Watcher): TrendStore => ({ schema: "pharos-agent/trend-store/1", observing: observingKey(watcher), observations: [], actedAt: null });

const bad = (message: string) => new AgentError("usage", message);
const digits = (value: unknown) => typeof value === "string" && /^\d{1,78}$/.test(value);

/** A store from untrusted JSON (a file, a browser): its shape checked, and that it belongs to this watcher. */
export function parseStore(input: unknown, watcher: Watcher): TrendStore {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("The store is not a trend store (a JSON object).");
  const s = input as Record<string, unknown>;
  if (s.schema !== "pharos-agent/trend-store/1") throw bad('The store is not a trend store (schema "pharos-agent/trend-store/1").');
  if (s.observing !== observingKey(watcher)) throw bad("The store holds observations of something else: another value or network. Use another store for this watcher.");
  if (!Array.isArray(s.observations)) throw bad("The store's observations must be a list.");
  let last = -1n;
  const observations = s.observations.map((raw, index): Observation => {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (!digits(o.block) || !digits(o.raw) || typeof o.timestamp !== "string" || Number.isNaN(Date.parse(o.timestamp))) throw bad(`The store's observation ${index + 1} must have a block, a timestamp and a raw value.`);
    if (BigInt(o.block as string) <= last) throw bad("The store's observations must be in block order, one per block.");
    last = BigInt(o.block as string);
    return { block: o.block as string, timestamp: new Date(o.timestamp).toISOString(), raw: o.raw as string };
  });
  if (s.actedAt !== null && s.actedAt !== undefined && !digits(s.actedAt)) throw bad("The store's actedAt must be a block number or null.");
  return { schema: "pharos-agent/trend-store/1", observing: observingKey(watcher), observations: observations.slice(-watcher.keep), actedAt: (s.actedAt as string | null | undefined) ?? null };
}
