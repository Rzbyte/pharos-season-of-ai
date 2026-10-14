import { formatUnits, getAddress } from "viem";
import { EXPECTED_CHAIN_ID, HOSTED_ENDPOINT, MAX_BLOCK_RANGE, TOOL_NAME, TOOLS, TRANSFER_TOPIC, WATCHED_TOKEN } from "./constants.js";
import { classify } from "./transfer.js";
import { TRANSCRIPT_FORMAT } from "./transcript.js";

// Checks a proof run (proof/mcp-transcript.json + proof/report.json + sample-output/live-run.txt)
// from the raw MCP messages, not from what the report says about itself. The decoding is redone
// here independently of transfer.ts (plain string slicing of topics and data), so a decoder bug
// cannot vouch for itself.

type Json = Record<string, any>;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProofEvidence {
  finishedAt: string;
  server: string;
  chainId: number;
  startHead: string | null;
  scanned: { fromBlock: string; toBlock: string } | null;
  polls: number;
  getLogsCalls: number;
  events: number;
  eventsAfterStart: number;
  /** One event line from the run, for the README. */
  example: string | null;
}

export interface ProofResult {
  ok: boolean;
  checks: Check[];
  evidence: ProofEvidence | null;
}

interface Call {
  seq: number;
  name: string;
  args: Json;
  /** Parsed JSON payload of the response, when it succeeded. */
  payload?: unknown;
  failed: boolean;
}

const HEX_QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;

export function verifyProof(transcript: unknown, report: unknown, output: string): ProofResult {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => void checks.push({ name, ok, detail });
  const done = (evidence: ProofEvidence | null): ProofResult => ({ ok: checks.every((entry) => entry.ok), checks, evidence });

  const t = asObject(transcript);
  const r = asObject(report);
  if (!t || !r) {
    check("files", false, "transcript or report is missing or not a JSON object");
    return done(null);
  }

  check("transcript format", t.format === TRANSCRIPT_FORMAT && t.tool?.name === TOOL_NAME, `${String(t.format)}, written by ${String(t.tool?.name)}`);
  check("hosted endpoint", t.endpoint === HOSTED_ENDPOINT && r.endpoint === HOSTED_ENDPOINT, `transcript ${String(t.endpoint)}, report ${String(r.endpoint)}`);
  const server = t.server ? `${t.server.name} ${t.server.version}` : "";
  check("MCP server answered", server !== "", server || "no serverInfo in the transcript");
  check("run succeeded", t.outcome?.ok === true && r.ok === true, `transcript outcome ok=${String(t.outcome?.ok)}, report ok=${String(r.ok)}`);
  check(
    "report matches transcript",
    JSON.stringify(t.outcome?.report?.events) === JSON.stringify(r.events) && JSON.stringify(t.outcome?.report?.polls) === JSON.stringify(r.polls),
    "report.json events and polls are the ones recorded in the transcript outcome",
  );

  const calls = toolCalls(t);
  const methods = new Set((Array.isArray(t.messages) ? t.messages : []).map((entry: Json) => entry?.message?.method).filter(Boolean));
  const extraMethods = [...methods].filter((method) => !["initialize", "notifications/initialized", "tools/call"].includes(String(method)));
  const extraTools = [...new Set(calls.map((call) => call.name))].filter((name) => !(TOOLS as readonly string[]).includes(name));
  check(
    "only Chain MCP tool calls",
    extraMethods.length === 0 && extraTools.length === 0 && calls.length > 0,
    extraTools.length || extraMethods.length
      ? `unexpected: ${[...extraTools, ...extraMethods].join(", ")}`
      : `${calls.length} tools/call requests, all of ${TOOLS.join(", ")}; no other JSON-RPC methods`,
  );

  const chainInfo = calls.find((call) => call.name === "get_chain_info" && !call.failed);
  const chainId = asObject(chainInfo?.payload)?.chainId;
  check(
    "chain ID 1672",
    chainId === EXPECTED_CHAIN_ID && asObject(chainInfo?.payload)?.chainIdMatches !== false && calls[0]?.name === "get_chain_info",
    chainInfo ? `get_chain_info reported chainId ${String(chainId)} before any other tool call` : "no successful get_chain_info",
  );

  // get_logs filter and ranges
  const logCalls = calls.filter((call) => call.name === "get_logs");
  const filterProblems: string[] = [];
  const rangeProblems: string[] = [];
  let lastHead: bigint | undefined;
  let previousOk: { from: bigint; to: bigint } | undefined;
  let pendingRetryFrom: bigint | undefined;
  for (const call of calls) {
    if (call.name === "get_block_number" && !call.failed) {
      const head = asObject(call.payload)?.blockNumber;
      if (typeof head === "string" && /^\d+$/.test(head)) lastHead = BigInt(head);
      continue;
    }
    if (call.name !== "get_logs") continue;
    const { address, topics, fromBlock, toBlock } = call.args;
    const keys = Object.keys(call.args).sort().join(",");
    if (keys !== "address,fromBlock,toBlock,topics") filterProblems.push(`#${call.seq} has arguments ${keys}`);
    if (address !== WATCHED_TOKEN.address) filterProblems.push(`#${call.seq} address ${String(address)}`);
    if (!Array.isArray(topics) || topics.length !== 1 || topics[0] !== TRANSFER_TOPIC) filterProblems.push(`#${call.seq} topics ${JSON.stringify(topics)}`);
    if (typeof fromBlock !== "string" || typeof toBlock !== "string" || !HEX_QUANTITY.test(fromBlock) || !HEX_QUANTITY.test(toBlock)) {
      rangeProblems.push(`#${call.seq} has a non-explicit range ${JSON.stringify(fromBlock)}..${JSON.stringify(toBlock)}`);
      continue;
    }
    const from = BigInt(fromBlock);
    const to = BigInt(toBlock);
    if (to < from || to - from + 1n > MAX_BLOCK_RANGE) rangeProblems.push(`#${call.seq} spans ${to - from + 1n} blocks`);
    if (lastHead === undefined || to > lastHead) rangeProblems.push(`#${call.seq} ends at ${to}, past the resolved head ${String(lastHead)}`);
    if (pendingRetryFrom !== undefined && from !== pendingRetryFrom) rangeProblems.push(`#${call.seq} starts at ${from}, but the failed range started at ${pendingRetryFrom}`);
    if (previousOk && from !== previousOk.to + 1n && pendingRetryFrom === undefined) rangeProblems.push(`#${call.seq} starts at ${from}, not right after ${previousOk.to}`);
    if (call.failed) {
      pendingRetryFrom = from;
    } else {
      pendingRetryFrom = undefined;
      previousOk = { from, to };
    }
  }
  check(
    "exact address and Transfer topic filter",
    logCalls.length > 0 && filterProblems.length === 0,
    filterProblems.length ? filterProblems.slice(0, 5).join("; ") : `all ${logCalls.length} get_logs calls: address ${WATCHED_TOKEN.address}, topics [${TRANSFER_TOPIC}]`,
  );
  check(
    "explicit ranges of at most 1,000 blocks, contiguous",
    logCalls.length > 0 && rangeProblems.length === 0,
    rangeProblems.length
      ? rangeProblems.slice(0, 5).join("; ")
      : `${logCalls.length} hex ranges, each within the resolved head, no gaps or overlaps; failed ranges repeated from the same block`,
  );

  // Every event in the report, re-derived from the raw logs.
  const rawLogs = new Map<string, Json>();
  for (const call of logCalls) {
    if (call.failed || !Array.isArray(call.payload) || !HEX_QUANTITY.test(String(call.args.fromBlock)) || !HEX_QUANTITY.test(String(call.args.toBlock))) continue;
    const from = BigInt(call.args.fromBlock);
    const to = BigInt(call.args.toBlock);
    for (const log of call.payload as Json[]) {
      const key = rawKey(log);
      const block = typeof log?.blockNumber === "string" && HEX_QUANTITY.test(log.blockNumber) ? BigInt(log.blockNumber) : undefined;
      if (!key || block === undefined || block < from || block > to) continue;
      // A removed log is never an event; one reported earlier stays here so its report entry still checks out.
      if (log.removed === true) continue;
      if (!rawLogs.has(key)) rawLogs.set(key, log);
    }
  }
  const events: Json[] = Array.isArray(r.events) ? r.events : [];
  const decodeProblems: string[] = [];
  for (const event of events) {
    const log = rawLogs.get(String(event.key));
    if (!log) {
      decodeProblems.push(`${String(event.key)} has no matching raw log in a successful get_logs response`);
      continue;
    }
    const problem = compareEvent(event, log);
    if (problem) decodeProblems.push(`${String(event.key)}: ${problem}`);
  }
  check(
    "decoded fields match raw topics and data",
    events.length > 0 && decodeProblems.length === 0,
    decodeProblems.length
      ? decodeProblems.slice(0, 5).join("; ")
      : `${events.length} events: from = topic1, to = topic2, amount = data (uint256, ${WATCHED_TOKEN.decimals} decimals), tx hash, block and log index as in the log`,
  );

  const keys = events.map((event) => String(event.key));
  const unique = new Set(keys);
  const reportedKeys = new Set(keys);
  const missed = [...rawLogs.keys()].filter((key) => !reportedKeys.has(key) && isWellFormedTransfer(rawLogs.get(key)!));
  check(
    "dedup by transactionHash + logIndex, nothing missed",
    r.dedupKey === "transactionHash:logIndex" && unique.size === keys.length && missed.length === 0 && (r.truncated?.events ?? 0) === 0,
    unique.size !== keys.length
      ? `${keys.length - unique.size} duplicate key(s) in the report`
      : missed.length
        ? `${missed.length} raw Transfer log(s) not reported, e.g. ${missed[0]}`
        : `${unique.size} unique keys, one per well-formed Transfer log returned`,
  );

  const printed = printedEvents(output);
  const printedKeys = printed.map((entry) => `${entry.tx}:${entry.logIndex}`);
  check(
    "no duplicate event output",
    printed.length === keys.length && new Set(printedKeys).size === printedKeys.length && printedKeys.every((key) => reportedKeys.has(key)),
    `${printed.length} events printed in the saved output, ${new Set(printedKeys).size} distinct, ${keys.length} in the report`,
  );

  const afterStart = events.filter((event) => event.afterStart === true).length;
  check("caught at least one real Transfer event", events.length >= 1, `${events.length} events (${afterStart} in blocks mined after the monitor started)`);

  const example = events[events.length - 1];
  return done({
    finishedAt: String(t.finishedAt),
    server,
    chainId: Number(chainId),
    startHead: r.startHead ?? null,
    scanned: r.scanned ?? null,
    polls: Number(r.totals?.polls ?? 0),
    getLogsCalls: logCalls.length,
    events: events.length,
    eventsAfterStart: afterStart,
    example: example ? String(example.summary) : null,
  });
}

/** Compare one reported event with its raw log, field by field, without transfer.ts. */
function compareEvent(event: Json, log: Json): string | undefined {
  const topics: unknown[] = Array.isArray(log.topics) ? log.topics : [];
  if (String(log.address).toLowerCase() !== WATCHED_TOKEN.address.toLowerCase()) return "raw log is from another address";
  if (topics.length !== 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) return "raw log is not a 3-topic Transfer";
  const from = `0x${String(topics[1]).slice(-40)}`.toLowerCase();
  const to = `0x${String(topics[2]).slice(-40)}`.toLowerCase();
  if (String(event.from).toLowerCase() !== from) return `from ${String(event.from)} != topic1 ${from}`;
  if (String(event.to).toLowerCase() !== to) return `to ${String(event.to)} != topic2 ${to}`;
  if (event.from !== getAddress(from) || event.to !== getAddress(to)) return "from/to are not checksummed";
  const raw = BigInt(String(log.data)).toString();
  if (event.amount?.raw !== raw) return `amount ${String(event.amount?.raw)} != data ${raw}`;
  if (String(event.amount?.formatted).replace(/,/g, "") !== formatUnits(BigInt(raw), WATCHED_TOKEN.decimals)) return `formatted amount ${String(event.amount?.formatted)} is wrong`;
  if (event.transactionHash !== String(log.transactionHash).toLowerCase()) return "transaction hash differs";
  if (event.blockNumber !== BigInt(String(log.blockNumber)).toString()) return "block number differs";
  if (event.logIndex !== Number(BigInt(String(log.logIndex)))) return "log index differs";
  if (event.type !== classify(getAddress(from), getAddress(to))) return `type ${String(event.type)} does not follow from/to`;
  return undefined;
}

function isWellFormedTransfer(log: Json): boolean {
  const topics: unknown[] = Array.isArray(log.topics) ? log.topics : [];
  return (
    topics.length === 3 &&
    topics.slice(1).every((topic) => typeof topic === "string" && /^0x0{24}[0-9a-f]{40}$/i.test(topic)) &&
    typeof log.data === "string" &&
    /^0x[0-9a-f]{64}$/i.test(log.data)
  );
}

function rawKey(log: Json): string | undefined {
  if (typeof log?.transactionHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash)) return undefined;
  if (typeof log.logIndex !== "string" || !HEX_QUANTITY.test(log.logIndex)) return undefined;
  return `${log.transactionHash.toLowerCase()}:${BigInt(log.logIndex).toString()}`;
}

/** (tx hash, log index) of every event block in the saved text output. */
export function printedEvents(output: string): Array<{ tx: string; logIndex: number }> {
  const found: Array<{ tx: string; logIndex: number }> = [];
  const pattern = /^\s+Tx hash\s+(0x[0-9a-f]{64})\n\s+Block\s+\d+ \(log index (\d+)\)$/gm;
  for (const match of output.matchAll(pattern)) found.push({ tx: match[1]!, logIndex: Number(match[2]) });
  return found;
}

/** Pair each tools/call request with its response, in request order. */
function toolCalls(transcript: Json): Call[] {
  const messages: Json[] = Array.isArray(transcript.messages) ? transcript.messages : [];
  const responses = new Map<unknown, Json>();
  for (const entry of messages) {
    const message = entry?.message;
    if (entry?.direction === "server->client" && message && "id" in message && !("method" in message)) responses.set(message.id, message);
  }
  const calls: Call[] = [];
  for (const entry of messages) {
    const message = entry?.message;
    if (entry?.direction !== "client->server" || message?.method !== "tools/call") continue;
    const response = responses.get(message.id);
    const result = response?.result;
    const failed = !result || result.isError === true;
    let payload: unknown;
    if (!failed) {
      const text = Array.isArray(result.content) ? result.content.find((item: Json) => item?.type === "text")?.text : undefined;
      try {
        payload = typeof text === "string" ? JSON.parse(text) : result.structuredContent;
      } catch {
        payload = text;
      }
    }
    calls.push({ seq: Number(entry.seq), name: String(message.params?.name), args: asObject(message.params?.arguments) ?? {}, payload, failed });
  }
  return calls;
}

function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

// ---------------------------------------------------------------------------
// README

export const MARKERS = {
  statusStart: "<!-- proof-status:start -->",
  statusEnd: "<!-- proof-status:end -->",
  outputStart: "<!-- live-output:start -->",
  outputEnd: "<!-- live-output:end -->",
  requirement4: "<!-- req-4 -->",
} as const;

/** Write a verified proof run into the README's marked sections. Throws if a marker is missing. */
export function applyProof(readme: string, result: ProofResult, output: string, links: { transcript: string; report: string; output: string }): string {
  if (!result.ok || !result.evidence) throw new Error("the proof did not verify, so the README is left unchanged");
  const evidence = result.evidence;
  const when = evidence.finishedAt.replace(/\.\d+Z$/, "Z");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(output) + 1));
  const scanned = evidence.scanned ? `blocks ${evidence.scanned.fromBlock}..${evidence.scanned.toBlock}` : "no blocks";

  const status = [
    `**Live proof:** captured ${when} against \`${HOSTED_ENDPOINT}\` (${evidence.server}, chain ID ${evidence.chainId}). ` +
      `${evidence.polls} polls checked ${scanned} with ${evidence.getLogsCalls} \`get_logs\` calls and reported ` +
      `**${evidence.events} Transfer event${evidence.events === 1 ? "" : "s"}** (${evidence.eventsAfterStart} mined after the monitor started).`,
    "",
    `Verified by \`npm run verify-proof\` from the raw MCP messages in [${links.transcript}](${links.transcript}) ` +
      `and [${links.report}](${links.report}):`,
    "",
    ...result.checks.map((entry) => `- [x] ${entry.name}: ${entry.detail}`),
  ].join("\n");

  const block = [`Saved as [${links.output}](${links.output}), from the same run.`, "", `${fence}text`, output.replace(/\s+$/, ""), fence].join("\n");

  let next = replaceBetween(readme, MARKERS.statusStart, MARKERS.statusEnd, status);
  next = replaceBetween(next, MARKERS.outputStart, MARKERS.outputEnd, block);
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
