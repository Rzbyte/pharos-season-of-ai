// Task 08: checking a dry-run proof offline. The recorded Chain MCP answers are replayed through the same
// runDryRun(), which must ask exactly the recorded questions and reach the identical prediction; for a
// submitted run, the broadcast transaction must be exactly the dry-run one, signed by its sender.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigner, signedTransactionCheck, type Check, type ProofFile } from "../core/proof.js";
import { parseDryRun } from "./intent.js";
import { runDryRun, type DryRun } from "./run.js";

export async function verifyDryRunProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as DryRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "08", capability: "dry-run-executor", network: net });
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  let request;
  try {
    request = parseDryRun(proof.input as { network?: unknown; intent?: unknown });
    add("dry-run input", request.network === net.id, `${request.intent.kind} on ${request.network}`);
  } catch (error) {
    add("dry-run input", false, (error as Error).message);
    return checks;
  }
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks;
  }
  // The dry run is everything before a submission starts (its pending-nonce read); it is pinned to one
  // block (estimate_gas and the fee market take no block).
  const submissionStart = calls.findIndex((c) => c.name === "get_transaction_count" && c.args.block === "pending");
  checks.push(pinnedCheck(calls, result.block.number, submissionStart >= 0 ? submissionStart : calls.length));

  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  const signer = result.submission ? replaySigner(calls, result.tx.from) : undefined;
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await runDryRun(request.intent, { chain: new Chain(replay, net), block, signer, wait: { pollMs: 0 } });
    const same = JSON.stringify(again) === JSON.stringify(result);
    add("result recomputed from the recorded responses", same && replay.remaining === 0, same ? `${replay.toolCalls} calls replayed; prediction, cost and verdict identical` : firstDifference(again, result));
  } catch (error) {
    add("result recomputed from the recorded responses", false, error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`);
  }
  if (result.submission) {
    checks.push(await signedTransactionCheck(calls, net.chainId, { from: result.tx.from, to: result.tx.to, data: result.tx.data, value: BigInt(result.tx.value) }, "dry-run transaction"));
  }
  return checks;
}
