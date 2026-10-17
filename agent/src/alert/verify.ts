// Task 22: checking alert bot proofs offline. Each run is replayed: the same store and the recorded
// Chain MCP answers through the same runAlerts() must make exactly the recorded calls and give exactly
// the recorded alerts and store. The delivery is recorded beside the run (a webhook is not Chain MCP and
// is not replayed). Several runs of one bot, in order, must form one history: each starts from the store
// the last one left, minus the alerts it delivered.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, scanCheck, type Check, type ProofFile } from "../core/proof.js";
import { parseAlertBot, type AlertBot } from "./config.js";
import type { Delivery } from "./deliver.js";
import { runAlerts, type AlertRun } from "./run.js";
import { afterDelivery, parseAlertStore, type AlertStore } from "./store.js";

/** A run as the CLI records it: the run, and how its alerts were delivered. */
export type RecordedAlertRun = AlertRun & { delivery?: Delivery };

interface AlertInput {
  bot?: unknown;
  store?: unknown;
}

export async function verifyAlertProof(proof: ProofFile): Promise<Check[]> {
  const { delivery, ...result } = proof.result as RecordedAlertRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "22", capability: "alert-bot", network: net });
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let bot: AlertBot;
  let store: AlertStore;
  try {
    const input = proof.input as AlertInput;
    bot = parseAlertBot(input.bot);
    store = parseAlertStore(input.store, bot);
    add("bot and store", bot.network === net.id, `${bot.name}: ${bot.rules.length} rules; ${store.cursor === null ? "a first run" : `the last run scanned up to block ${BigInt(store.cursor).toLocaleString("en-US")}`}`);
  } catch (error) {
    add("bot and store", false, (error as Error).message);
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
    const again = await runAlerts(bot, store, { chain: new Chain(replay, net), block, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    add("result recomputed from the recorded responses", same && replay.remaining === 0, same ? `${replay.toolCalls} calls replayed; every alert and the store identical` : firstDifference(again, result));
  } catch (error) {
    add("result recomputed from the recorded responses", false, error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`);
  }
  if (delivery) {
    const known = new Set(result.store.pending.map((a) => a.id));
    const stray = [...delivery.delivered, ...delivery.failed.map((f) => f.id)].filter((id) => !known.has(id));
    add("delivery", stray.length === 0, stray.length ? `${stray.length} delivered alerts the run did not have` : `${delivery.delivered.length} delivered (${delivery.channel})${delivery.failed.length ? `, ${delivery.failed.length} kept to retry` : ""}`);
  }
  return checks;
}

/**
 * Proofs of one bot, in run order: each run starts from the store the last one left, minus what it
 * delivered. That is the whole check. The cursor in each store never goes back, so the blocks scanned
 * follow on run to run; the pinned blocks need not (one node behind the hosted endpoint can be a block
 * behind another, and that run scans nothing). A run that left the store as it found it changes nothing
 * a later run depends on.
 */
export function alertHistoryCheck(proofs: readonly ProofFile[]): Check {
  const breaks: string[] = [];
  for (let i = 1; i < proofs.length; i += 1) {
    const previous = proofs[i - 1]!.result as RecordedAlertRun;
    const expected = afterDelivery(previous.store, previous.delivery?.delivered ?? []);
    if (JSON.stringify((proofs[i]!.input as AlertInput).store) !== JSON.stringify(expected)) breaks.push(`run ${i + 1} did not start from the store run ${i} left`);
  }
  const alerts = proofs.reduce((sum, p) => sum + (p.result as AlertRun).alerts.length, 0);
  return { name: "one history", ok: breaks.length === 0, detail: breaks.length ? breaks.join("; ") : `${proofs.length} runs, each from the store the last one left; ${alerts} ${alerts === 1 ? "alert" : "alerts"} in all` };
}
