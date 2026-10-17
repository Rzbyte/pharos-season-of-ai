// Task 27: checking explanation proofs offline. The request is replayed: the same hash or description,
// and the recorded Chain MCP answers, through the same explain(), must make exactly the recorded calls and
// give exactly the recorded explanation. Every state read is at one block: the one before the
// transaction's, or the dry run's.
import { Chain } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, type Check, type ProofFile } from "../core/proof.js";
import { parseDryRun } from "../dryrun/intent.js";
import { explain, type Explanation, type ExplainRequest } from "./explain.js";

/** A request from untrusted input: a transaction hash, or a description as Task 08 takes it. */
export function parseExplainRequest(input: unknown, networkId = "pharos-mainnet"): ExplainRequest {
  const r = (input ?? {}) as Record<string, unknown>;
  if (r.kind === "hash") {
    if (typeof r.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.hash)) throw new AgentError("usage", "A transaction hash is 0x and 64 hex characters.");
    return { kind: "hash", hash: r.hash.toLowerCase() as `0x${string}` };
  }
  if (r.kind === "intent") return { kind: "intent", intent: parseDryRun({ network: networkId, intent: r.intent }).intent };
  throw new AgentError("usage", "Explain a transaction hash, or a transaction described as Task 08 takes it.");
}

export async function verifyExplanationProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as Explanation;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "27", capability: "dapp-support", network: net });
  let request: ExplainRequest;
  try {
    request = parseExplainRequest(proof.input, net.id);
    checks.push({ name: "request", ok: true, detail: request.kind === "hash" ? `the transaction ${request.hash}` : "a transaction described, not sent" });
  } catch (error) {
    checks.push({ name: "request", ok: false, detail: (error as Error).message });
    return checks;
  }
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  if (result.readAt) checks.push(pinnedCheck(calls, result.readAt));
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  try {
    const again = await explain(request, { chain: new Chain(replay, net), now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    checks.push({ name: "result recomputed from the recorded responses", ok: same && replay.remaining === 0, detail: same ? `${replay.toolCalls} calls replayed; the cause, every finding and the fix identical` : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "result recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  return checks;
}
