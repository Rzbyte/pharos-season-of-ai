// Task 28: checking digest proofs offline. Each run is replayed: the same subject, cadence and store, and
// the recorded Chain MCP answers, through the same runDigest(), must make exactly the recorded calls and
// give exactly the recorded digests and store. The only state read is at the newest block; every get_logs
// call is inside the blocks the run says it read. Several runs with one store, in order, must form one
// history: each starts from the store the last one left, so every period is digested once.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, scanCheck, type Check, type ProofFile } from "../core/proof.js";
import { parseEvery, parseSubject, subjectName } from "./config.js";
import { runDigest, type DigestRun } from "./run.js";
import { digestKey, emptyDigestStore, parseDigestStore } from "./store.js";

interface DigestInput {
  subject?: unknown;
  every?: unknown;
  periods?: number;
  soFar?: boolean;
  maxBlocks?: number;
  store?: unknown;
}

export async function verifyDigestProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as DigestRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "28", capability: "digest", network: net });
  const input = proof.input as DigestInput;
  let subject;
  let every;
  let store;
  try {
    subject = parseSubject(input.subject, net);
    every = parseEvery(input.every);
    const key = digestKey(net.id, subjectName(subject), every);
    store = input.store === null || input.store === undefined ? emptyDigestStore(key) : parseDigestStore(input.store, key);
    checks.push({ name: "subject and store", ok: true, detail: `${result.subject.label} every ${every}; ${store.digested === null ? "a first run" : `the last digest ended at ${store.digested}`}` });
  } catch (error) {
    checks.push({ name: "subject and store", ok: false, detail: (error as Error).message });
    return checks;
  }
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  checks.push(pinnedCheck(calls, result.head.number));
  checks.push(scanCheck(calls, result.scanned));
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  try {
    const block = result.head.source === "requested" ? BigInt(result.head.number) : undefined;
    const again = await runDigest(subject, every, store, { chain: new Chain(replay, net), periods: input.periods, soFar: input.soFar, maxBlocks: input.maxBlocks, block, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    checks.push({ name: "digests recomputed from the recorded responses", ok: same && replay.remaining === 0, detail: same ? `${replay.toolCalls} calls replayed; every figure, sentence and the store identical` : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "digests recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  return checks;
}

/** Proofs of one digest, in run order: each run starts from the store the last one left. */
export function digestHistoryCheck(proofs: readonly ProofFile[]): Check {
  const breaks: string[] = [];
  for (let i = 1; i < proofs.length; i += 1) {
    const expected = (proofs[i - 1]!.result as DigestRun).store;
    if (JSON.stringify((proofs[i]!.input as DigestInput).store) !== JSON.stringify(expected)) breaks.push(`run ${i + 1} did not start from the store run ${i} left`);
  }
  const digests = proofs.reduce((sum, p) => sum + (p.result as DigestRun).digests.length, 0);
  return { name: "one history", ok: breaks.length === 0, detail: breaks.length ? breaks.join("; ") : `${proofs.length} runs, each from the store the last one left; ${digests} ${digests === 1 ? "period" : "periods"} digested, each once` };
}
