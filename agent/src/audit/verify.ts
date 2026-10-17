// Task 26: checking audit report proofs offline. The report is replayed: the same address and period, and
// the recorded Chain MCP answers, through the same auditAddress(), must make exactly the recorded calls and
// give exactly the recorded report. Every state read is at the period's last block or the one before its
// first, and every get_logs call inside the blocks the report says it read.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, scanCheck, type Check, type ProofFile } from "../core/proof.js";
import { parsePeriod, type PeriodRequest } from "./period.js";
import { auditAddress, parseAuditAddress, type AuditReport } from "./report.js";

interface AuditInput {
  address?: unknown;
  period?: PeriodRequest;
  maxBlocks?: number;
}

/** The period from a proof's input, checked as if it came from a user. */
function periodOf(period: PeriodRequest | undefined): PeriodRequest {
  if (period?.kind === "hours") return parsePeriod({ hours: String(period.hours) });
  if (period?.kind === "time") return parsePeriod({ since: period.since, until: period.until ?? undefined });
  if (period?.kind === "blocks") return parsePeriod({ fromBlock: period.from, toBlock: period.to });
  throw new Error("the proof's input has no period");
}

export async function verifyAuditProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as AuditReport;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "26", capability: "audit-log", network: net });
  const input = proof.input as AuditInput;
  let address;
  let period;
  try {
    address = parseAuditAddress(input.address);
    period = periodOf(input.period);
    checks.push({ name: "address and period", ok: true, detail: `${result.address} ${result.period.description}` });
  } catch (error) {
    checks.push({ name: "address and period", ok: false, detail: (error as Error).message });
    return checks;
  }
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  const from = BigInt(result.period.from.number);
  checks.push(pinnedCheck(calls, from > 0n ? [result.period.to.number, (from - 1n).toString()] : [result.period.to.number]));
  checks.push(scanCheck(calls, result.scanned));
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  try {
    const block = result.head.source === "requested" ? BigInt(result.head.number) : undefined;
    const again = await auditAddress(address, period, { chain: new Chain(replay, net), maxBlocks: input.maxBlocks, block, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    checks.push({ name: "report recomputed from the recorded responses", ok: same && replay.remaining === 0, detail: same ? `${replay.toolCalls} calls replayed; every figure and sentence identical` : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "report recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  return checks;
}
