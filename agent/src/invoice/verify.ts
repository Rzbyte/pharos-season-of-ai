// Task 19: checking invoice-payment proofs offline. The invoice is read again and the run replayed through
// the same payInvoice(), which must make exactly the recorded Chain MCP calls and give exactly the recorded
// invoice, checks, payment and verdict. Every state read before the send is at the one block, and a sent
// payment must be exactly the dry-run one at its recorded nonce, signed by the payer.
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigners, signedTransactionsCheck, type Check, type ProofFile } from "../core/proof.js";
import { parsePayees, payInvoice, type InvoicePayment } from "./pay.js";
import { readInvoice } from "./read.js";

interface InvoiceInput {
  invoice?: unknown;
  payees?: unknown;
  from?: `0x${string}`;
  blocks?: number;
  maxInvoice?: number;
}

export async function verifyInvoiceProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as InvoicePayment;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "19", capability: "invoice-payment", network: net });
  const input = proof.input as InvoiceInput;
  let payees;
  try {
    payees = parsePayees(input.payees);
    const again = readInvoice(input.invoice, net, input.maxInvoice);
    const same = JSON.stringify(again) === JSON.stringify(result.invoice);
    checks.push({ name: "invoice", ok: same, detail: same ? `read again: ${again.due.amount} ${again.asset} to ${again.payee.address}` : firstDifference(again, result.invoice) });
  } catch (error) {
    checks.push({ name: "invoice", ok: false, detail: (error as Error).message });
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
  const sent = result.payment.submission ? [result.payment] : [];
  const signer = sent.length ? replaySigners(calls, result.payer.address) : undefined;
  try {
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await payInvoice(String(input.invoice), { chain: new Chain(replay, net), payees, from: input.from, block, blocks: input.blocks, signer, wait: { pollMs: 0 }, maxInvoice: input.maxInvoice, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    checks.push({ name: "payment recomputed from the recorded responses", ok: same && replay.remaining === 0, detail: same ? `${replay.toolCalls} calls replayed; the checks, the payment and the verdict identical` : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "payment recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  if (sent.length) checks.push(await signedTransactionsCheck(calls, net.chainId, sent.map((p) => ({ from: result.payer.address, to: p.dryRun.tx.to, data: p.dryRun.tx.data, value: BigInt(p.dryRun.tx.value), nonce: p.submission!.nonce })), "payment"));
  return checks;
}
