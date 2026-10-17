// Task 11: checking a gatekeeper proof offline. The recorded Chain MCP answers are replayed through the
// same runGate(), which must ask exactly the recorded questions and reach the identical decision. Two
// independent checks: the spend window was read in whole pages ending at the pinned block, and an
// executed run broadcast exactly the dry-run transaction, signed by its sender.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigner, signedTransactionCheck, type Check, type ProofFile, type RecordedCall } from "../core/proof.js";
import { parseDryRun } from "../dryrun/intent.js";
import { runGate, LOG_PAGE, type GateRun } from "./check.js";
import { parsePolicy, type Policy } from "./config.js";

/** Every get_logs page of the gate: at most LOG_PAGE blocks, none past the pinned block, each window read without a gap up to it. */
export function windowCheck(calls: readonly RecordedCall[], policy: Policy, block: string): Check {
  const pinned = BigInt(block);
  const pages = calls.filter((c) => c.name === "get_logs").map((c) => ({ from: BigInt(String(c.args.fromBlock)), to: BigInt(String(c.args.toBlock)) }));
  const windows = policy.rules.filter((r) => r.kind === "max-in-window").length;
  if (pages.length === 0) return { name: "spend window", ok: true, detail: windows ? "no window applied to this request" : "the policy has no window limit" };
  const tooWide = pages.filter((p) => p.to < p.from || p.to - p.from + 1n > LOG_PAGE);
  const late = pages.filter((p) => p.to > pinned);
  // Pages of one window follow each other; a window's last page ends at the pinned block.
  const gaps = pages.filter((p, i) => i > 0 && pages[i - 1]!.to !== pinned && p.from !== pages[i - 1]!.to + 1n);
  const ends = pages.filter((p) => p.to === pinned).length;
  const ok = tooWide.length === 0 && late.length === 0 && gaps.length === 0 && ends >= 1 && pages.at(-1)!.to === pinned;
  const span = pages.reduce((sum, p) => sum + (p.to - p.from + 1n), 0n);
  return {
    name: "spend window",
    ok,
    detail: ok ? `${pages.length} get_logs ${pages.length === 1 ? "page" : "pages"}, ${span.toLocaleString("en-US")} blocks ending at block ${pinned.toLocaleString("en-US")}, no gap, none over ${LOG_PAGE.toLocaleString("en-US")} blocks` : `pages: ${pages.map((p) => `${p.from}-${p.to}`).join(", ")}`,
  };
}

export async function verifyGateProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as GateRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "11", capability: "policy-gatekeeper", network: net });
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  let policy: Policy;
  let request;
  try {
    const input = proof.input as { policy?: unknown; request?: { network?: unknown; intent?: unknown } };
    policy = parsePolicy(input.policy);
    request = parseDryRun(input.request ?? {});
    add("policy and request", policy.network === net.id && request.network === net.id, `${policy.name}: ${policy.rules.length} rules; ${request.intent.kind} on ${request.network}`);
  } catch (error) {
    add("policy and request", false, (error as Error).message);
    return checks;
  }
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  // Everything before an execution starts (its pending-nonce read) is the check, pinned to one block.
  const sendStart = calls.findIndex((c) => c.name === "get_transaction_count" && c.args.block === "pending");
  const checked = sendStart >= 0 ? calls.slice(0, sendStart) : calls;
  checks.push(pinnedCheck(calls, result.block.number, checked.length));
  checks.push(windowCheck(checked, policy, result.block.number));

  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  const signer = result.execution && result.dryRun ? replaySigner(calls, result.dryRun.tx.from) : undefined;
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await runGate(policy, request.intent, { chain: new Chain(replay, net), block, signer, wait: { pollMs: 0 } });
    const same = JSON.stringify(again) === JSON.stringify(result);
    add("result recomputed from the recorded responses", same && replay.remaining === 0, same ? `${replay.toolCalls} calls replayed; every rule and the decision identical` : firstDifference(again, result));
  } catch (error) {
    add("result recomputed from the recorded responses", false, error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`);
  }
  if (result.execution && result.dryRun) {
    const { tx } = result.dryRun;
    checks.push(await signedTransactionCheck(calls, net.chainId, { from: tx.from, to: tx.to, data: tx.data, value: BigInt(tx.value) }, "gated transaction"));
  }
  return checks;
}
