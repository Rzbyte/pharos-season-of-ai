// Task 09: checking watcher proofs offline. Each run is replayed: the same store and the recorded Chain
// MCP answers through the same runWatch() must make exactly the recorded calls and leave exactly the
// recorded store. Several proofs of one watcher, in order, are also checked as one history: each run
// must start from the store the run before it left, which is what persisting across runs means.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigner, signedTransactionCheck, type Check, type ProofFile } from "../core/proof.js";
import { parseWatcher } from "./config.js";
import { runWatch, type TrendRun } from "./run.js";
import { parseStore, type TrendStore } from "./store.js";

interface WatchInput {
  watcher?: unknown;
  store?: unknown;
}

export async function verifyTrendProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as TrendRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "09", capability: "trend-watcher", network: net });
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  let watcher;
  let store: TrendStore;
  try {
    const input = proof.input as WatchInput;
    watcher = parseWatcher(input.watcher);
    store = parseStore(input.store, watcher);
    add("watcher and store", watcher.network === net.id, `${watcher.name}: ${store.observations.length} stored ${store.observations.length === 1 ? "observation" : "observations"} before this run`);
  } catch (error) {
    add("watcher and store", false, (error as Error).message);
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
  // The new observation comes after every stored one; the store is the one before plus it.
  const last = store.observations.at(-1);
  if (result.observation) add("a new observation", !last || BigInt(result.observation.block) > BigInt(last.block), `block ${BigInt(result.observation.block).toLocaleString("en-US")}${last ? `, after the last stored one at ${BigInt(last.block).toLocaleString("en-US")}` : ", the first"}`);

  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  const signer = result.execution && result.action ? replaySigner(calls, result.action.tx.from) : undefined;
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await runWatch(watcher, store, { chain: new Chain(replay, net), block, signer, wait: { pollMs: 0 } });
    const same = JSON.stringify(again) === JSON.stringify(result);
    add("result recomputed from the recorded responses", same && replay.remaining === 0, same ? `${replay.toolCalls} calls replayed; observation, trend, action and store identical` : firstDifference(again, result));
  } catch (error) {
    add("result recomputed from the recorded responses", false, error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`);
  }
  if (result.execution && result.action) {
    const { tx } = result.action;
    checks.push(await signedTransactionCheck(calls, net.chainId, { from: tx.from, to: tx.to, data: tx.data, value: BigInt(tx.value) }, "action"));
  }
  return checks;
}

/** Proofs of one watcher, in run order: each run starts from exactly the store the run before it left. */
export function historyCheck(proofs: readonly ProofFile[]): Check {
  const breaks: string[] = [];
  for (let i = 1; i < proofs.length; i += 1) {
    const before = JSON.stringify((proofs[i]!.input as WatchInput).store);
    const left = JSON.stringify((proofs[i - 1]!.result as TrendRun).store);
    if (before !== left) breaks.push(`run ${i + 1} did not start from the store run ${i} left`);
  }
  const blocks = proofs.map((p) => (p.result as TrendRun).block.number);
  const ordered = blocks.every((b, i) => i === 0 || BigInt(b) > BigInt(blocks[i - 1]!));
  if (!ordered) breaks.push("the runs are not in block order");
  const observations = (proofs.at(-1)!.result as TrendRun).store.observations.length;
  return { name: "one history", ok: breaks.length === 0, detail: breaks.length ? breaks.join("; ") : `${proofs.length} runs, each from the store the last one left; ${observations} observations kept` };
}
