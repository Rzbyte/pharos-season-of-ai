// Task 28: what a digest keeps between runs: where the last digested period ended, and the last digests
// (each period is compared with the one before). One store belongs to one subject, cadence and network.
import { AgentError } from "../core/errors.js";
import type { Every } from "./calendar.js";
import type { PeriodDigest } from "./run.js";

export interface DigestStore {
  schema: "pharos-agent/digest-store/1";
  /** network:subject:cadence, lowercase. */
  key: string;
  /** The end (exclusive) of the last period digested, as ISO 8601; null before the first run. */
  digested: string | null;
  /** The newest digests, oldest first, at most KEEP. */
  digests: PeriodDigest[];
}

export const KEEP = 12;

export const digestKey = (network: string, subject: string, every: Every) => `${network}:${subject}:${every}`.toLowerCase();

export const emptyDigestStore = (key: string): DigestStore => ({ schema: "pharos-agent/digest-store/1", key, digested: null, digests: [] });

/** A store from untrusted JSON: its shape checked, and that it belongs to this digest. */
export function parseDigestStore(raw: unknown, key: string): DigestStore {
  const store = raw as Partial<DigestStore> | null;
  if (!store || typeof store !== "object" || store.schema !== "pharos-agent/digest-store/1") throw new AgentError("usage", "The store is not a digest store (pharos-agent/digest-store/1).");
  if (store.key !== key) throw new AgentError("usage", `The store belongs to another digest (${String(store.key)}), not ${key}.`);
  if (store.digested !== null && (typeof store.digested !== "string" || !Number.isFinite(Date.parse(store.digested)))) throw new AgentError("usage", "The store's last digested time is not a time.");
  if (!Array.isArray(store.digests) || store.digests.length > KEEP) throw new AgentError("usage", `The store's digests must be a list of at most ${KEEP}.`);
  for (const d of store.digests) if (!d || typeof d.start !== "string" || typeof d.end !== "string" || typeof d.figures !== "object") throw new AgentError("usage", "A digest in the store is malformed.");
  return { schema: store.schema, key, digested: store.digested ?? null, digests: store.digests };
}
