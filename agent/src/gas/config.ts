// Task 24, Gas Fee Optimizer: a plan for one transaction, as JSON, checked before anything touches the
// chain: the transaction (as Task 08 dry-runs it), when its fee is low enough to send (the target), how
// many observations of the fee to judge by, how a first run fills them in, and how long to wait at most.
//
//   target    { "percentile": 25 }: at or below the 25th percentile of the fees observed (the cheapest
//             quarter of the window), or { "gwei": "1.1" }: at or below a fixed fee
//   window    the newest observations judged, and kept between runs (2 to 48)
//   backfill  { "samples": 5, "spacing": 200 }: with no observations yet, read the fee of 5 earlier
//             blocks, 200 apart, so a first run has something to judge by; null to wait for runs
//   deadline  blocks of waiting after which the transaction is sent at the fee of the moment; null: none
import { formatGwei, parseGasPrice } from "../core/amounts.js";
import { AgentError } from "../core/errors.js";
import { NETWORKS, type NetworkId } from "../core/networks.js";
import { parseDryRun, type Intent } from "../dryrun/intent.js";

/** A percentile of the observed fees, or a fixed fee (in wei). */
export type GasTarget = { kind: "percentile"; percentile: number } | { kind: "fee"; fee: string };

export interface GasPlan {
  name: string;
  network: NetworkId;
  transaction: Intent;
  target: GasTarget;
  window: number;
  backfill: { samples: number; spacing: number } | null;
  deadline: number | null;
}

export const LIMITS = Object.freeze({ name: 60, window: 48, samples: 12, spacing: 10_000, deadline: 100_000 });

const bad = (message: string) => new AgentError("usage", message);

/** A plan from untrusted JSON (a file, a preset, an API query): every field checked. */
export function parseGasPlan(input: unknown): GasPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("A gas plan is a JSON object.");
  const p = input as Record<string, unknown>;
  for (const key of Object.keys(p)) if (!["name", "network", "transaction", "target", "window", "backfill", "deadline"].includes(key)) throw bad(`The gas plan has an unknown field "${key}".`);
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > LIMITS.name) throw bad(`name: a name of at most ${LIMITS.name} characters.`);
  const networkId = p.network ?? "pharos-mainnet";
  if (typeof networkId !== "string" || !(networkId in NETWORKS)) throw bad("network must be pharos-mainnet or atlantic-testnet.");
  const { intent } = parseDryRun({ network: networkId, intent: p.transaction });
  const whole = (value: unknown, min: number, max: number, what: string) => {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw bad(`${what} must be a whole number from ${min} to ${max.toLocaleString("en-US")}.`);
    return value as number;
  };

  const t = (p.target ?? { percentile: 25 }) as Record<string, unknown>;
  let target: GasTarget;
  if (typeof t !== "object" || Object.keys(t).length !== 1) throw bad('target is { "percentile": 25 } or { "gwei": "1.1" }.');
  if ("percentile" in t) target = { kind: "percentile", percentile: whole(t.percentile, 1, 100, "target.percentile") };
  else if ("gwei" in t) {
    const fee = parseGasPrice(String(t.gwei));
    if (fee === 0n) throw bad("target.gwei must be more than 0.");
    target = { kind: "fee", fee: fee.toString() };
  } else throw bad('target is { "percentile": 25 } or { "gwei": "1.1" }.');

  const window = p.window === undefined ? 12 : whole(p.window, 2, LIMITS.window, "window");
  let backfill: GasPlan["backfill"] = { samples: 5, spacing: 200 };
  if (p.backfill === null) backfill = null;
  else if (p.backfill !== undefined) {
    const b = p.backfill as Record<string, unknown>;
    if (typeof b !== "object" || Object.keys(b).some((key) => !["samples", "spacing"].includes(key))) throw bad('backfill is { "samples": 5, "spacing": 200 } or null.');
    backfill = { samples: whole(b.samples, 1, Math.min(LIMITS.samples, window - 1), "backfill.samples"), spacing: whole(b.spacing, 1, LIMITS.spacing, "backfill.spacing") };
  }
  if (backfill && backfill.samples > window - 1) backfill = { ...backfill, samples: window - 1 };
  const deadline = p.deadline === undefined || p.deadline === null ? null : whole(p.deadline, 1, LIMITS.deadline, "deadline");
  return { name: p.name.trim(), network: networkId as NetworkId, transaction: intent, target, window, backfill, deadline };
}

/** The target in words: "the 25th percentile of the last 12 observations", "1.1 gwei". */
export function describeTarget(target: GasTarget, window: number): string {
  if (target.kind === "fee") return formatGwei(BigInt(target.fee));
  const n = target.percentile;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return n === 100 ? `the highest of the last ${window} observations` : `the ${n}${suffix} percentile of the last ${window} observations`;
}
