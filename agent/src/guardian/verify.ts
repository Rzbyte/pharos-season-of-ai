// Task 05: checking a guardian proof offline. The recorded Chain MCP responses are replayed through the
// same runGuardian(), which must ask for exactly the recorded calls and produce exactly the recorded
// result. Independent checks confirm the pinning and, for an executed run, the signed transaction.
import { Chain } from "../core/chain.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigner, signedTransactionCheck, type Check, type ProofFile } from "../core/proof.js";
import { network } from "../core/networks.js";
import { parseGuardianConfig } from "./config.js";
import { runGuardian, type GuardianRun } from "./run.js";

export async function verifyGuardianProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as GuardianRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "05", capability: "threshold-guardian", network: net });
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  let config;
  try {
    config = parseGuardianConfig(proof.input);
    add("guardian input", true, `${config.name}: ${config.conditions.length} conditions, rule ${result.rule}`);
  } catch (error) {
    add("guardian input", false, (error as Error).message);
    return checks;
  }

  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  // Pinning: before any execution (its re-check reads the newest block), every state read names the
  // block the result reports.
  const firstSend = calls.findIndex((c) => c.name === "send_raw_transaction");
  const recheckStart = result.execution ? calls.findIndex((c, i) => i > 0 && c.name === "get_block_number" && calls.slice(0, i).some((p) => p.name === "estimate_gas")) : -1;
  checks.push(pinnedCheck(calls, result.block.number, recheckStart >= 0 ? recheckStart : firstSend >= 0 ? firstSend : calls.length));

  // Replay: the same code on the recorded answers must ask the same questions and reach the same result.
  const signer = result.execution && result.action ? replaySigner(calls, result.action.tx.from) : undefined;
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  // The clock as the live run read it: once for the evaluation, once more for an execution's re-check.
  const times = [result.evaluatedAt, result.execution?.recheck.evaluatedAt].filter((t): t is string => typeof t === "string");
  const now = () => new Date(times.length > 1 ? times.shift()! : times[0]!);
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await runGuardian(config, { chain: new Chain(replay, net), block, now, signer, wait: { pollMs: 0 } });
    const same = JSON.stringify(again) === JSON.stringify(result);
    add("result recomputed from the recorded responses", same && replay.remaining === 0, same ? `${replay.toolCalls} calls replayed; decision, values and action identical` : firstDifference(again, result));
  } catch (error) {
    add("result recomputed from the recorded responses", false, error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`);
  }

  // Execution: the broadcast transaction is the prepared action, signed by its payer, on this chain.
  if (result.execution?.sent && result.action) {
    const { tx } = result.action;
    checks.push(await signedTransactionCheck(calls, net.chainId, { from: tx.from, to: tx.to, data: tx.data, value: BigInt(tx.value) }, "action"));
  }
  return checks;
}
