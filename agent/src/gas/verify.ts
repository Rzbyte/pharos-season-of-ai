// Task 24: checking gas optimizer proofs offline. Each run is replayed: the same plan and store, and the
// recorded Chain MCP answers, through the same runGasPlan(), must make exactly the recorded calls and give
// exactly the recorded observations, decision, settings and store. A run that sent its transaction must
// have broadcast exactly the dry-run transaction, signed by its sender, with exactly the recorded fee
// settings. Several runs of one plan, in order, must form one history.
import { parseTransaction } from "viem";
import { Chain, type Hex } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigner, signedTransactionCheck, type Check, type ProofFile } from "../core/proof.js";
import { parseGasPlan, type GasPlan } from "./config.js";
import { runGasPlan, type GasRun } from "./run.js";
import { parseGasStore, type GasStore } from "./store.js";

interface GasInput {
  plan?: unknown;
  store?: unknown;
}

export async function verifyGasProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as GasRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "24", capability: "gas-optimizer", network: net });
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let plan: GasPlan;
  let store: GasStore;
  try {
    const input = proof.input as GasInput;
    plan = parseGasPlan(input.plan);
    store = parseGasStore(input.store, plan);
    add("plan and store", plan.network === net.id, `${plan.name}: ${store.observations.length} ${store.observations.length === 1 ? "observation" : "observations"} kept from earlier runs`);
  } catch (error) {
    add("plan and store", false, (error as Error).message);
    return checks;
  }
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  // Everything before a send (its pending-nonce read) is pinned to one block.
  const sendStart = calls.findIndex((c) => c.name === "get_transaction_count" && c.args.block === "pending");
  checks.push(pinnedCheck(calls, result.block.number, sendStart >= 0 ? sendStart : calls.length));
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  const signer = result.execution ? replaySigner(calls, result.dryRun.tx.from) : undefined;
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await runGasPlan(plan, store, { chain: new Chain(replay, net), block, now: () => new Date(result.evaluatedAt), signer, wait: { pollMs: 0 } });
    const same = JSON.stringify(again) === JSON.stringify(result);
    add("result recomputed from the recorded responses", same && replay.remaining === 0, same ? `${replay.toolCalls} calls replayed; observations, decision, settings and store identical` : firstDifference(again, result));
  } catch (error) {
    add("result recomputed from the recorded responses", false, error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`);
  }
  if (result.execution) {
    const tx = result.dryRun.tx;
    checks.push(await signedTransactionCheck(calls, net.chainId, { from: tx.from, to: tx.to, data: tx.data, value: BigInt(tx.value) }, "dry-run transaction"));
    const raw = calls.find((call) => call.name === "send_raw_transaction")?.args.rawTransaction;
    const sent = typeof raw === "string" ? parseTransaction(raw as Hex) : null;
    const ok = !!sent && !!result.settings && sent.maxFeePerGas === BigInt(result.settings.maxFeePerGas) && sent.maxPriorityFeePerGas === BigInt(result.settings.maxPriorityFeePerGas);
    add("fee settings", ok, ok ? `signed with a fee cap of ${result.settings!.shown.maxFeePerGas} and a priority fee of ${result.settings!.shown.maxPriorityFeePerGas}, as decided` : "the broadcast transaction's fees are not the decided settings");
  }
  return checks;
}

/** Proofs of one plan, in run order: each run starts from the store the last one left. */
export function gasHistoryCheck(proofs: readonly ProofFile[]): Check {
  const breaks: string[] = [];
  for (let i = 1; i < proofs.length; i += 1) {
    if (JSON.stringify((proofs[i]!.input as GasInput).store) !== JSON.stringify((proofs[i - 1]!.result as GasRun).store)) breaks.push(`run ${i + 1} did not start from the store run ${i} left`);
  }
  const decisions = proofs.map((p) => (p.result as GasRun).decision).join(", ");
  return { name: "one history", ok: breaks.length === 0, detail: breaks.length ? breaks.join("; ") : `${proofs.length} runs, each from the store the last one left: ${decisions}` };
}
