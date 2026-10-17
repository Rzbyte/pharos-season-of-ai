// Task 23: checking whale watcher proofs offline. Each run is replayed: the same watchlist and store,
// and the recorded Chain MCP answers, through the same runWhales(), must make exactly the recorded calls
// and give exactly the recorded moves, reports and store. Several runs of one watchlist, in order, must
// form one history: each starts from the store the last one left.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, scanCheck, type Check, type ProofFile } from "../core/proof.js";
import { parseWatchlist, type Watchlist } from "./config.js";
import { runWhales, type WhaleRun } from "./run.js";
import { parseWhaleStore, type WhaleStore } from "./store.js";

interface WhaleInput {
  watchlist?: unknown;
  store?: unknown;
}

export async function verifyWhaleProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as WhaleRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "23", capability: "whale-watcher", network: net });
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let list: Watchlist;
  let store: WhaleStore;
  try {
    const input = proof.input as WhaleInput;
    list = parseWatchlist(input.watchlist);
    store = parseWhaleStore(input.store, list);
    add("watchlist and store", list.network === net.id, `${list.name}: ${list.addresses.length} ${list.addresses.length === 1 ? "address" : "addresses"}; ${store.cursor === null ? "a first run" : `the last run scanned up to block ${BigInt(store.cursor).toLocaleString("en-US")}`}`);
  } catch (error) {
    add("watchlist and store", false, (error as Error).message);
    return checks;
  }
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  checks.push(pinnedCheck(calls, result.block.number));
  checks.push(scanCheck(calls, result.scanned));
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await runWhales(list, store, { chain: new Chain(replay, net), block, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    add("result recomputed from the recorded responses", same && replay.remaining === 0, same ? `${replay.toolCalls} calls replayed; every move, report and the store identical` : firstDifference(again, result));
  } catch (error) {
    add("result recomputed from the recorded responses", false, error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`);
  }
  return checks;
}

/** Proofs of one watchlist, in run order: each run starts from the store the last one left. */
export function whaleHistoryCheck(proofs: readonly ProofFile[]): Check {
  const breaks: string[] = [];
  for (let i = 1; i < proofs.length; i += 1) {
    const expected = (proofs[i - 1]!.result as WhaleRun).store;
    if (JSON.stringify((proofs[i]!.input as WhaleInput).store) !== JSON.stringify(expected)) breaks.push(`run ${i + 1} did not start from the store run ${i} left`);
  }
  const moves = proofs.reduce((sum, p) => sum + (p.result as WhaleRun).events.length, 0);
  return { name: "one history", ok: breaks.length === 0, detail: breaks.length ? breaks.join("; ") : `${proofs.length} runs, each from the store the last one left; ${moves} significant ${moves === 1 ? "move" : "moves"} in all` };
}
