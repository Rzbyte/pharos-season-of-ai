// Task 05: checking a guardian proof offline. The recorded Chain MCP responses are replayed through the
// same runGuardian(), which must ask for exactly the recorded calls and produce exactly the recorded
// result. Independent checks confirm the pinning and, for an executed run, the signed transaction.
import { parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { Chain } from "../core/chain.js";
import { commonChecks, recordedCalls, ReplayMcp, ReplayMismatch, type Check, type ProofFile } from "../core/proof.js";
import { network } from "../core/networks.js";
import { parseGuardianConfig } from "./config.js";
import { runGuardian, type GuardianRun } from "./run.js";
import type { Signer } from "../core/execute.js";

const PINNABLE = new Set(["eth_call", "get_balance", "get_code", "get_transaction_count", "get_storage_at"]);

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
  // Pinning: before any execution, every state read names the block the result reports.
  const pinned = `0x${BigInt(result.block.number).toString(16)}`;
  const firstSend = calls.findIndex((c) => c.name === "send_raw_transaction");
  const recheckStart = result.execution ? calls.findIndex((c, i) => i > 0 && c.name === "get_block_number" && calls.slice(0, i).some((p) => p.name === "estimate_gas")) : -1;
  const evaluation = calls.slice(0, recheckStart >= 0 ? recheckStart : firstSend >= 0 ? firstSend : calls.length);
  const unpinned = evaluation.filter((c) => PINNABLE.has(c.name) && c.args.block !== pinned);
  add("one pinned block", unpinned.length === 0, unpinned.length ? `${unpinned.length} reads not at ${pinned}` : `every state read before execution is at block ${result.block.number}`);

  // Replay: the same code on the recorded answers must ask the same questions and reach the same result.
  const signer = replaySigner(calls.find((c) => c.name === "send_raw_transaction")?.args.rawTransaction as Hex | undefined, result);
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
  if (result.execution?.sent) {
    const raw = calls.find((c) => c.name === "send_raw_transaction")?.args.rawTransaction as Hex | undefined;
    if (!raw) add("signed transaction", false, "no send_raw_transaction in the transcript");
    else {
      const tx = parseTransaction(raw);
      const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
      const action = result.action!;
      const matches = tx.chainId === net.chainId && tx.to?.toLowerCase() === action.tx.to.toLowerCase() && (tx.data ?? "0x") === action.tx.data && (tx.value ?? 0n) === BigInt(action.tx.value) && from.toLowerCase() === action.tx.from.toLowerCase();
      add("signed transaction", matches, matches ? `chain ${tx.chainId}, signed by ${from}, exactly the prepared action` : "the broadcast transaction is not the prepared action");
    }
  }
  return checks;
}

/** For replay only: a signer that "signs" by returning the recorded transaction, for the recorded payer. */
function replaySigner(raw: Hex | undefined, result: GuardianRun): Signer | undefined {
  if (!result.execution || !result.action) return undefined;
  return { address: result.action.tx.from, sign: async () => raw ?? "0x" };
}

function firstDifference(a: unknown, b: unknown, path = "result"): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return "";
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const diff = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (diff) return diff;
    }
  }
  return `${path} differs: recomputed ${JSON.stringify(a)?.slice(0, 120)}, recorded ${JSON.stringify(b)?.slice(0, 120)}`;
}
