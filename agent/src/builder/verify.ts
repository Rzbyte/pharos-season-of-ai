// Task 29: checking how-to proofs offline. A proof holds two transcripts, the Developer Docs MCP's and
// the Chain MCP's; both are replayed, in order, through the same howTo(), which must ask exactly what the
// live run asked and give exactly the recorded action, grounding, dry run and verdict. The docs endpoint
// must be the official one, every state read before a send must be at the one block, and a sent
// transaction must be exactly the dry-run one, signed by its sender.
import { Chain } from "../core/chain.js";
import { DOCS_MCP, ReplayDocs } from "../core/docs-mcp.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, replaySigner, signedTransactionCheck, type Check, type ProofFile } from "../core/proof.js";
import { parseQuestion } from "../docs/run.js";
import type { ActionInputs } from "./action.js";
import { howTo, type HowToResult } from "./run.js";

export async function verifyHowToProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as HowToResult;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "29", capability: "how-to", network: net });
  const docs = proof.docsMcp;
  const asked = docs?.transcript.filter((m) => m.direction === "client->server").length ?? 0;
  checks.push({ name: "Developer Docs MCP", ok: docs?.endpoint === DOCS_MCP, detail: docs ? `${docs.endpoint}${docs.endpoint === DOCS_MCP ? "" : ` (not the official ${DOCS_MCP})`}: ${asked} ${asked === 1 ? "call" : "calls"}` : "the proof has no Developer Docs MCP transcript" });
  const input = proof.input as { question?: unknown; inputs?: ActionInputs };
  let question;
  try {
    question = parseQuestion(input.question);
    checks.push({ name: "question", ok: true, detail: question });
  } catch (error) {
    checks.push({ name: "question", ok: false, detail: (error as Error).message });
    return checks;
  }
  if (!docs) return checks;
  let calls;
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  // State is read at one block, up to a send (its pending-nonce read), after which the receipt's blocks are read.
  const sendStart = calls.findIndex((c) => c.name === "get_transaction_count" && c.args.block === "pending");
  checks.push(pinnedCheck(calls, result.block.number, sendStart >= 0 ? sendStart : calls.length));
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  const sent = result.prepared?.submission ?? null;
  const signer = sent ? replaySigner(calls, result.prepared!.tx.from) : undefined;
  try {
    const docsReplay = new ReplayDocs(docs.transcript, docs.endpoint);
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await howTo(question, { docs: docsReplay, chain: new Chain(replay, net), inputs: input.inputs ?? {}, block, signer, wait: { pollMs: 0 }, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    const all = replay.remaining === 0 && docsReplay.remaining === 0;
    checks.push({ name: "answer recomputed from the recorded responses", ok: same && all, detail: same ? (all ? `${docsReplay.calls} docs and ${replay.toolCalls} chain calls replayed; the action, grounding, dry run and verdict identical` : "calls were recorded that the replay did not make") : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "answer recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  if (sent) checks.push(await signedTransactionCheck(calls, net.chainId, { from: result.prepared!.tx.from, to: result.prepared!.tx.to, data: result.prepared!.tx.data, value: BigInt(result.prepared!.tx.value) }, "dry-run transaction"));
  return checks;
}
