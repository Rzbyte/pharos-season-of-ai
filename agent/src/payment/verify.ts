// Task 17: checking payment-flow proofs offline. The request is read again and the flow replayed through
// the same preparePayments(), which must make exactly the recorded Chain MCP calls and give exactly the
// recorded payments, totals and verdict. Every state read before the first send is at the one block, and
// each sent transaction, in order, must be exactly the dry-run one at its recorded nonce, signed by the sender.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigners, signedTransactionsCheck, type Check, type ProofFile } from "../core/proof.js";
import { preparePayments, type PaymentFlow } from "./flow.js";
import { parseContacts } from "./request.js";

interface FlowInput {
  request?: unknown;
  contacts?: unknown;
  from?: `0x${string}`;
  maxPayments?: number;
}

export async function verifyPaymentProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as PaymentFlow;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "17", capability: "payment-flow", network: net });
  const input = proof.input as FlowInput;
  let contacts;
  try {
    contacts = parseContacts(input.contacts);
    checks.push({ name: "request", ok: typeof input.request === "string", detail: typeof input.request === "string" ? input.request : "no request" });
  } catch (error) {
    checks.push({ name: "request", ok: false, detail: (error as Error).message });
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
  const sent = result.payments.filter((p) => p.submission);
  const signer = sent.length ? replaySigners(calls, result.sender.address) : undefined;
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await preparePayments(String(input.request), { chain: new Chain(replay, net), contacts, from: input.from, block, signer, wait: { pollMs: 0 }, maxPayments: input.maxPayments, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    checks.push({ name: "flow recomputed from the recorded responses", ok: same && replay.remaining === 0, detail: same ? `${replay.toolCalls} calls replayed; every payment, the totals and the verdict identical` : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "flow recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  if (sent.length) checks.push(await signedTransactionsCheck(calls, net.chainId, sent.map((p) => ({ from: result.sender.address, to: p.dryRun.tx.to, data: p.dryRun.tx.data, value: BigInt(p.dryRun.tx.value), nonce: p.submission!.nonce })), "payment"));
  return checks;
}
