// Task 24: the gas optimizer's memory between runs: the fees it observed (block by block, oldest first),
// the block it started waiting at, and the transaction once it is sent, so a plan is sent once. It
// belongs to one plan on one network.
import { AgentError } from "../core/errors.js";
import type { GasPlan } from "./config.js";

export interface GasObservation {
  block: string;
  timestamp: string;
  /** The block's base fee, or the node's gas price where blocks carry no base fee. */
  fee: string;
  source: "base-fee" | "gas-price";
  gasUsed: string;
  gasLimit: string;
}

export interface GasStore {
  schema: "pharos-agent/gas-store/1";
  plan: string;
  observations: GasObservation[];
  /** The block of the first run that decided to wait, since the last send decision. */
  waitingSince: string | null;
  /** The plan's transaction, once sent (Atlantic, with --execute). */
  sent: { block: string; tx: string } | null;
}

export const planKey = (plan: GasPlan) => `${plan.network}:${plan.name}`;

export const emptyGasStore = (plan: GasPlan): GasStore => ({ schema: "pharos-agent/gas-store/1", plan: planKey(plan), observations: [], waitingSince: null, sent: null });

const bad = (message: string) => new AgentError("usage", message);
const DIGITS = /^\d{1,40}$/;
const BLOCK = /^\d{1,12}$/;

/** A store from untrusted JSON (a file, a browser): its shape checked, its observations in block order, and that it is this plan's. */
export function parseGasStore(input: unknown, plan: GasPlan): GasStore {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("The store is not a gas store (a JSON object).");
  const s = input as Record<string, unknown>;
  if (s.schema !== "pharos-agent/gas-store/1") throw bad('The store is not a gas store (schema "pharos-agent/gas-store/1").');
  if (s.plan !== planKey(plan)) throw bad(`The store belongs to another plan ("${String(s.plan)}"). Use another store for "${plan.name}".`);
  if (!Array.isArray(s.observations) || s.observations.length > 500) throw bad("The store's observations must be a list of at most 500.");
  const observations = s.observations.map((raw, index): GasObservation => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const ok = typeof o.block === "string" && BLOCK.test(o.block) && typeof o.timestamp === "string" && !Number.isNaN(Date.parse(o.timestamp)) && typeof o.fee === "string" && DIGITS.test(o.fee) && (o.source === "base-fee" || o.source === "gas-price") && typeof o.gasUsed === "string" && DIGITS.test(o.gasUsed) && typeof o.gasLimit === "string" && DIGITS.test(o.gasLimit);
    if (!ok) throw bad(`The store's observation ${index + 1} needs a block, a time, a fee, its source, and the gas used and limit.`);
    return { block: o.block as string, timestamp: o.timestamp as string, fee: o.fee as string, source: o.source as GasObservation["source"], gasUsed: o.gasUsed as string, gasLimit: o.gasLimit as string };
  });
  for (let i = 1; i < observations.length; i += 1) if (BigInt(observations[i]!.block) <= BigInt(observations[i - 1]!.block)) throw bad("The store's observations must be in block order, one per block.");
  if (s.waitingSince !== null && s.waitingSince !== undefined && (typeof s.waitingSince !== "string" || !BLOCK.test(s.waitingSince))) throw bad("The store's waitingSince must be a block number or null.");
  let sent: GasStore["sent"] = null;
  if (s.sent !== null && s.sent !== undefined) {
    const x = s.sent as Record<string, unknown>;
    if (typeof x.block !== "string" || !BLOCK.test(x.block) || typeof x.tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x.tx)) throw bad("The store's sent must be { block, tx } or null.");
    sent = { block: x.block, tx: x.tx };
  }
  return { schema: "pharos-agent/gas-store/1", plan: planKey(plan), observations, waitingSince: (s.waitingSince as string | null | undefined) ?? null, sent };
}
