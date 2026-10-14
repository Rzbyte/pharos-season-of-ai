import { getAddress, isAddress, toHex } from "viem";
import { HOSTED_ENDPOINT } from "./constants.js";
import { CALLDATA, fieldsFor } from "./erc20.js";
import { TRANSCRIPT_FORMAT } from "./transcript.js";

// The README's live sections are written only by `npm run proof`, from a run that succeeded
// against the hosted endpoint. That keeps the README sample output and the committed proof
// files from the same run, so the README can never show hand-written or stale numbers.

export const MARKERS = {
  statusStart: "<!-- live-status:start -->",
  statusEnd: "<!-- live-status:end -->",
  outputStart: "<!-- live-output:start -->",
  outputEnd: "<!-- live-output:end -->",
  requirement4: "<!-- req-4 -->",
} as const;

export interface LiveRunEvidence {
  finishedAt: string;
  blockNumber: string;
  contract: string;
  ethCalls: number;
  output: string;
}

type Json = Record<string, unknown>;

/** Validate a transcript + saved output pair. Throws with the reason when they cannot serve as proof. */
export function evidenceFromRun(transcript: unknown, output: string): LiveRunEvidence {
  const t = asObject(transcript, "transcript");
  if (t.format !== TRANSCRIPT_FORMAT) throw new Error(`unexpected transcript format: ${String(t.format)}`);
  if (t.endpoint !== HOSTED_ENDPOINT) {
    throw new Error(`the run used ${String(t.endpoint)}, not the hosted endpoint ${HOSTED_ENDPOINT}`);
  }
  const outcome = asObject(t.outcome, "outcome");
  if (outcome.ok !== true) throw new Error("the run failed, so there is no live output to publish");

  const report = asObject(outcome.report, "outcome.report");
  const blockNumber = report.blockNumber;
  if (typeof blockNumber !== "string" || !/^\d+$/.test(blockNumber)) throw new Error("the report has no block number");
  const contract = asObject(report.contract, "outcome.report.contract").address;
  if (typeof contract !== "string" || !isAddress(contract, { strict: false })) throw new Error("the report has no contract address");

  // Every eth_call request must carry the block the report claims, and enough of them must have succeeded.
  const messages = Array.isArray(t.messages) ? (t.messages as Json[]) : [];
  const requests = messages.map((entry) => entry.message as Json).filter((m) => m?.method === "tools/call");
  const ethCallRequests = requests.filter((m) => asOptionalObject(m.params)?.name === "eth_call");
  const blockHex = toHex(BigInt(blockNumber));
  const unpinned = ethCallRequests.filter((m) => asOptionalObject(asOptionalObject(m.params)?.arguments)?.block !== blockHex);
  if (unpinned.length > 0) throw new Error(`${unpinned.length} eth_call request(s) were not pinned to block ${blockNumber}`);
  if (!requests.some((m) => asOptionalObject(m.params)?.name === "get_block_number")) throw new Error("the transcript has no get_block_number call");

  // Each required read of this contract (fieldsFor: the four ERC-20 reads, and paused() for the Task 01
  // contract) needs at least one successful response, whatever the report says about itself. A failed
  // first attempt that was retried at the same block is fine; a read that never succeeded is not.
  const ethCallIds = new Set(ethCallRequests.map((m) => m.id));
  const succeededIds = new Set(
    messages
      .map((entry) => entry.message as Json)
      .filter((m) => ethCallIds.has(m?.id) && asOptionalObject(m.result) !== undefined && asOptionalObject(m.result)?.isError !== true)
      .map((m) => m.id),
  );
  const readSelectors = new Set(
    ethCallRequests
      .filter((m) => succeededIds.has(m.id))
      .map((m) => String(asOptionalObject(asOptionalObject(asOptionalObject(m.params)?.arguments)?.transaction)?.data ?? "").slice(0, 10).toLowerCase()),
  );
  const missing = fieldsFor(getAddress(contract.toLowerCase())).filter((field) => !readSelectors.has(CALLDATA[field])).map((field) => `${field}()`);
  if (missing.length > 0) throw new Error(`required read(s) without a successful eth_call response: ${missing.join(", ")}`);
  const okResponses = [...succeededIds];

  if (!output.includes(contract)) throw new Error("the saved output does not show the contract address from the transcript");
  if (!output.includes(blockNumber)) throw new Error("the saved output does not show the block number from the transcript");
  if (!output.includes(HOSTED_ENDPOINT)) throw new Error("the saved output was not produced against the hosted endpoint");

  return { finishedAt: String(t.finishedAt), blockNumber, contract, ethCalls: okResponses.length, output };
}

/** Write the live-run evidence into the README's marked sections. Throws if a marker is missing. */
export function applyLiveRun(readme: string, evidence: LiveRunEvidence, links: { transcript: string; output: string }): string {
  const when = evidence.finishedAt.replace(/\.\d+Z$/, "Z");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(evidence.output) + 1));

  const status =
    `**Live run:** captured ${when} against \`${HOSTED_ENDPOINT}\`, contract \`${evidence.contract}\`, block ${evidence.blockNumber}. ` +
    `Output in [Live Sample Output](#live-sample-output), raw MCP messages in [${links.transcript}](${links.transcript}).`;

  const output = [
    `Captured by \`npm run proof\` at ${when} against \`${HOSTED_ENDPOINT}\`: block ${evidence.blockNumber}, ` +
      `${evidence.ethCalls} successful \`eth_call\` reads. Saved as [${links.output}](${links.output}); the raw MCP ` +
      `messages from the same run are in [${links.transcript}](${links.transcript}).`,
    "",
    `${fence}text`,
    evidence.output.replace(/\s+$/, ""),
    fence,
  ].join("\n");

  let next = replaceBetween(readme, MARKERS.statusStart, MARKERS.statusEnd, status);
  next = replaceBetween(next, MARKERS.outputStart, MARKERS.outputEnd, output);

  const lines = next.split("\n");
  const index = lines.findIndex((line) => line.includes(MARKERS.requirement4));
  if (index === -1) throw new Error(`README is missing the ${MARKERS.requirement4} marker`);
  lines[index] = lines[index]!.replace(/^(\s*)- \[ \]/, "$1- [x]");
  return lines.join("\n");
}

function replaceBetween(text: string, start: string, end: string, content: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) throw new Error(`README is missing the ${start} ... ${end} markers`);
  return `${text.slice(0, from + start.length)}\n${content}\n${text.slice(to)}`;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

function asObject(value: unknown, label: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing or not an object`);
  return value as Json;
}

function asOptionalObject(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}
