// Task 13: checking docs-and-chain proofs offline. A proof holds two transcripts: the Developer Docs MCP's
// and the Chain MCP's. Both are replayed, in order, through the same docsThenChain(), which must ask the
// docs and the chain exactly what the live run asked and give exactly the recorded answer, readings and
// verdict. The docs endpoint must be the official one, and every state read must be at the one block.
import { Chain } from "../core/chain.js";
import { DOCS_MCP, ReplayDocs } from "../core/docs-mcp.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, pinnedCheck, recordedCalls, ReplayMcp, ReplayMismatch, type Check, type ProofFile } from "../core/proof.js";
import { docsThenChain, parseQuestion, type DocsChainResult } from "./run.js";

export async function verifyDocsChainProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as DocsChainResult;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "13", capability: "docs-chain", network: net });
  const docs = proof.docsMcp;
  const asked = docs?.transcript.filter((m) => m.direction === "client->server").length ?? 0;
  checks.push({ name: "Developer Docs MCP", ok: docs?.endpoint === DOCS_MCP, detail: docs ? `${docs.endpoint}${docs.endpoint === DOCS_MCP ? "" : ` (not the official ${DOCS_MCP})`}: ${asked} ${asked === 1 ? "call" : "calls"}` : "the proof has no Developer Docs MCP transcript" });
  let question;
  try {
    question = parseQuestion((proof.input as { question?: unknown }).question);
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
  checks.push(pinnedCheck(calls, result.block.number));
  const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
  try {
    const docsReplay = new ReplayDocs(docs.transcript, docs.endpoint);
    const block = result.block.source === "requested" ? BigInt(result.block.number) : undefined;
    const again = await docsThenChain(question, { docs: docsReplay, chain: new Chain(replay, net), block, now: () => new Date(result.evaluatedAt) });
    const same = JSON.stringify(again) === JSON.stringify(result);
    const all = replay.remaining === 0 && docsReplay.remaining === 0;
    checks.push({ name: "answer recomputed from the recorded responses", ok: same && all, detail: same ? (all ? `${docsReplay.calls} docs and ${replay.toolCalls} chain calls replayed; the answer, every reading and the verdict identical` : "calls were recorded that the replay did not make") : firstDifference(again, result) });
  } catch (error) {
    checks.push({ name: "answer recomputed from the recorded responses", ok: false, detail: error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}` });
  }
  return checks;
}
