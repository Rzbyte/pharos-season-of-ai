// Task 10: checking batch proofs offline. The batch is read again and the run replayed through the same
// runBatch(), shared reads and all, which must make exactly the recorded Chain MCP calls and give exactly
// the recorded plan, independence checks, savings and verdict. Every state read of the plan is at the one
// block, and each transaction sent, in order, must be exactly the planned one at its nonce, signed by the
// sender.
import { getAddress } from "viem";
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigners, signedTransactionsCheck, type Check, type ProofFile } from "../core/proof.js";
import { readBatch } from "./read.js";
import { runBatch, type BatchRun } from "./run.js";

interface BatchInput {
  batch?: unknown;
  from?: `0x${string}`;
  merge?: boolean;
  maxActions?: number;
}

export async function verifyBatchProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as BatchRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "10", capability: "batch-executor", network: net });
  const input = proof.input as BatchInput;
  try {
    const actions = readBatch(String(input.batch ?? ""), net, input.maxActions);
    checks.push({ name: "batch", ok: typeof input.batch === "string" && input.batch === result.batch, detail: `${actions.length} ${actions.length === 1 ? "action" : "actions"}, read again` });
  } catch (error) {
    checks.push({ name: "batch", ok: false, detail: (error as Error).message });
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
  const sent = result.txs.filter((t) => t.submission && t.submission.status !== "refused");
  const signer = result.execution ? replaySigners(calls, result.sender.address) : undefined;
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const from = input.from ? getAddress(input.from) : undefined;
    const again = await runBatch(String(input.batch), { chain: new Chain(replay, net), from, block, merge: input.merge, signer, wait: { pollMs: 0 }, maxActions: input.maxActions, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    checks.push({ name: "batch recomputed from the recorded responses", ok: same && replay.remaining === 0, detail: same ? `${replay.toolCalls} calls replayed; the plan, the independence checks, the savings and the verdict identical` : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "batch recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  // The savings are counts of this very transcript: the calls the plan made must be the calls recorded before any send.
  const planCalls = sendStart >= 0 ? sendStart : calls.length;
  checks.push({ name: "calls counted", ok: result.savings.calls === planCalls && result.savings.oneByOne >= 0, detail: `${planCalls} calls before any send, as the result counts them; its dry runs, one by one, ask ${result.savings.oneByOne}` });
  if (result.execution) {
    const refusedAt = result.txs.findIndex((t) => t.submission?.status === "refused");
    const attempted = result.txs.filter((t) => t.submission);
    checks.push(await signedTransactionsCheck(calls, net.chainId, attempted.map((t) => ({ from: result.sender.address, to: t.tx!.to, data: t.tx!.data, value: BigInt(t.tx!.value), nonce: t.submission!.nonce })), "transaction"));
    checks.push({ name: "sent back to back", ok: sentBackToBack(calls), detail: `${sent.length} sent${refusedAt >= 0 ? ", then one refused" : ""}, with no receipt asked between two sends` });
  }
  return checks;
}

/** Every send of the transcript comes before any receipt is asked for: the batch did not wait between them. */
function sentBackToBack(calls: ReturnType<typeof recordedCalls>): boolean {
  const sends = calls.flatMap((c, k) => (c.name === "send_raw_transaction" ? [k] : []));
  const firstReceipt = calls.findIndex((c) => c.name === "get_transaction_receipt");
  return sends.length > 0 && (firstReceipt < 0 || sends.every((k) => k < firstReceipt));
}
