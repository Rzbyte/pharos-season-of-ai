// Task 25: checking risk check proofs offline. The check is replayed: the same transaction, and the
// recorded Chain MCP answers, through the same checkRisk(), must make exactly the recorded calls and give
// exactly the recorded signals, level and verdict. Every state read is at the pinned block, and every
// get_logs call inside the history the report says it scanned.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, scanCheck, type Check, type ProofFile } from "../core/proof.js";
import { parseDryRun } from "../dryrun/intent.js";
import { checkRisk, type RiskReport } from "./check.js";

interface RiskInput {
  intent?: unknown;
  blocks?: number;
}

export async function verifyRiskProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as RiskReport;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "25", capability: "risk-checker", network: net });
  const input = proof.input as RiskInput;
  let intent;
  try {
    intent = parseDryRun({ network: net.id, intent: input.intent }).intent;
    checks.push({ name: "transaction", ok: true, detail: result.transaction.summary });
  } catch (error) {
    checks.push({ name: "transaction", ok: false, detail: (error as Error).message });
    return checks;
  }
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  checks.push(pinnedCheck(calls, result.block.number));
  checks.push(scanCheck(calls, result.history ? { from: result.history.from, to: result.history.to, pages: result.history.pages } : null));
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await checkRisk(intent, { chain: new Chain(replay, net), blocks: input.blocks, block, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    checks.push({ name: "result recomputed from the recorded responses", ok: same && replay.remaining === 0, detail: same ? `${replay.toolCalls} calls replayed; every signal, the level and the verdict identical` : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "result recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  return checks;
}
