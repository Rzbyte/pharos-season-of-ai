// Task 18: checking recurring-payment proofs offline. The schedule is read again and the run replayed
// through the same runRecurring(), from the store it started with, which must make exactly the recorded
// Chain MCP calls and give exactly the recorded owed payments, flow, store and verdict. Every state read
// before the first send is at the one block, and each sent payment must be exactly its dry-run one, at
// its recorded nonce, signed by the payer. Several proofs of one schedule, in run order, must form one
// history: each run starts from the store the last one left.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigners, signedTransactionsCheck, type Check, type ProofFile } from "../core/proof.js";
import { runRecurring, type RecurringRun } from "./run.js";
import { readSchedule } from "./schedule.js";
import { parseRecurringStore } from "./store.js";

interface RecurringInput {
  schedule?: unknown;
  store?: unknown;
  keep?: boolean;
  from?: `0x${string}`;
  since?: string;
  sinceDefault?: "today" | "month";
  maxPerItem?: number;
  maxPayments?: number;
  maxItems?: number;
}

export async function verifyRecurringProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as RecurringRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "18", capability: "recurring-payments", network: net });
  const input = proof.input as RecurringInput;
  let store;
  try {
    const items = readSchedule(input.schedule, net, input.maxItems);
    store = input.store === null || input.store === undefined ? null : parseRecurringStore(input.store, net.id);
    checks.push({ name: "schedule", ok: true, detail: `${items.length} ${items.length === 1 ? "payment" : "payments"} read again${store ? `, from a store counting since ${store.since}` : ""}` });
  } catch (error) {
    checks.push({ name: "schedule", ok: false, detail: (error as Error).message });
    return checks;
  }
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  const sendStart = calls.findIndex((c) => c.name === "get_transaction_count" && c.args.block === "pending");
  checks.push(pinnedCheck(calls, result.block.number, sendStart >= 0 ? sendStart : calls.length));
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  const sent = result.payments.filter((p) => p.submission);
  const signer = sent.length ? replaySigners(calls, result.payer.address) : undefined;
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await runRecurring(String(input.schedule), { chain: new Chain(replay, net), store, keep: input.keep, from: input.from, since: input.since, sinceDefault: input.sinceDefault, block, signer, wait: { pollMs: 0 }, maxPerItem: input.maxPerItem, maxPayments: input.maxPayments, maxItems: input.maxItems, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    checks.push({ name: "run recomputed from the recorded responses", ok: same && replay.remaining === 0, detail: same ? `${replay.toolCalls} calls replayed; the owed payments, the flow, the store and the verdict identical` : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "run recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  if (sent.length) checks.push(await signedTransactionsCheck(calls, net.chainId, sent.map((p) => ({ from: result.payer.address, to: p.dryRun.tx.to, data: p.dryRun.tx.data, value: BigInt(p.dryRun.tx.value), nonce: p.submission!.nonce })), "payment"));
  return checks;
}

/** Several runs of one schedule, in order: one history, each from the store the last one left, each payment paid once. */
export function recurringHistoryCheck(proofs: readonly ProofFile[]): Check {
  const breaks: string[] = [];
  for (let i = 1; i < proofs.length; i += 1) {
    const expected = (proofs[i - 1]!.result as RecurringRun).store;
    if (expected === null) breaks.push(`run ${i} kept no store`);
    else if (JSON.stringify((proofs[i]!.input as RecurringInput).store) !== JSON.stringify(expected)) breaks.push(`run ${i + 1} did not start from the store run ${i} left`);
  }
  const ids = proofs.flatMap((p) => (p.result as RecurringRun).paid.map((paid) => paid.id));
  const twice = ids.filter((id, k) => ids.indexOf(id) !== k);
  if (twice.length) breaks.push(`paid twice: ${[...new Set(twice)].join(", ")}`);
  return { name: "one history", ok: breaks.length === 0, detail: breaks.length ? breaks.join("; ") : `${proofs.length} runs, each from the store the last one left; ${ids.length} ${ids.length === 1 ? "payment" : "payments"} recorded, each once` };
}
