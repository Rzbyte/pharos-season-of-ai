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
  let pendingRetry: { from: bigint; to: bigint } | undefined;
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
    if (pendingRetry && (from !== pendingRetry.from || to !== pendingRetry.to)) {
      rangeProblems.push(`#${call.seq} asks for ${from}..${to}, but the failed range ${pendingRetry.from}..${pendingRetry.to} was not repeated exactly`);
    }
    if (!pendingRetry && previousOk && from !== previousOk.to + 1n) rangeProblems.push(`#${call.seq} starts at ${from}, not right after ${previousOk.to}`);
    if (logsFailed(call)) {
      pendingRetry = { from, to };
    } else {
      pendingRetry = undefined;
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
      : `${logCalls.length} hex ranges, each within the resolved head, no gaps or overlaps; a failed range repeated with the same fromBlock and toBlock`,
  );

  // Replay the monitor's policy over the raw responses, in order: what should have been reported,
  // and what retracted. Then hold the report and the printed output to exactly that.
  const expected = expectedFromRaw(logCalls);
  const events: Json[] = Array.isArray(r.events) ? r.events : [];
  const decodeProblems: string[] = [];
  events.forEach((event, index) => {
    const want = expected.events[index];
    if (want && want.key === event.key) {
      const problem = compareEvent(event, want.log);
      if (problem) decodeProblems.push(`${String(event.key)}: ${problem}`);
    }
  });
  check(
    "decoded fields match raw topics and data",
    events.length > 0 && decodeProblems.length === 0,
    decodeProblems.length
      ? decodeProblems.slice(0, 5).join("; ")
      : `${events.length} events: from = topic1, to = topic2, amount = data (uint256, ${WATCHED_TOKEN.decimals} decimals), tx hash, block and log index as in the log`,
  );

  const keys = events.map((event) => String(event.key));
  const wantKeys = expected.events.map((entry) => entry.key);
  const firstDiff = wantKeys.findIndex((key, index) => keys[index] !== key);
  const sameSequence = keys.length === wantKeys.length && firstDiff === -1;
  check(
    "dedup by transactionHash + logIndex, nothing missed",
    r.dedupKey === "transactionHash:logIndex" && sameSequence && (r.truncated?.events ?? 0) === 0,
    sameSequence
      ? `${keys.length} events, one per well-formed Transfer log returned (a key again only after its retraction)`
      : `the report has ${keys.length} events where the raw responses call for ${wantKeys.length}` +
          (firstDiff !== -1 ? `; first difference at #${firstDiff + 1}: expected ${wantKeys[firstDiff]}, got ${String(keys[firstDiff])}` : ""),
  );

  const retracted: string[] = (Array.isArray(r.retractions) ? r.retractions : []).map((entry: Json) => String(entry?.key));
  check(
    "removed logs never reported, retracted when shown before",
    JSON.stringify(retracted) === JSON.stringify(expected.retractions),
    `${expected.removed} removed log(s) in the responses; ${expected.retractions.length} retraction(s) expected, ${retracted.length} in the report`,
  );

  const printed = printedEvents(output).map((entry) => `${entry.tx}:${entry.logIndex}`);
  check(
    "no duplicate event output",
    JSON.stringify(printed) === JSON.stringify(keys),
    `${printed.length} events printed in the saved output, in the report's order, ${new Set(printed).size} distinct`,
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

/** A get_logs call the monitor would have retried: an error, or a payload that is not a log array. */
function logsFailed(call: Call): boolean {
  return call.failed || !Array.isArray(call.payload);
}

/**
 * The monitor's policy, replayed over the successful get_logs responses in order: each response's
 * logs by block, then logIndex; another address or topic0 is ignored; a removed log retracts a
 * reported key (whatever its block) and is otherwise only counted; a log outside its call's range
 * waits for its own range; a well-formed Transfer log is reported unless its key already was.
 */
function expectedFromRaw(logCalls: Call[]): { events: Array<{ key: string; log: Json }>; retractions: string[]; removed: number } {
  const reported = new Set<string>();
  const events: Array<{ key: string; log: Json }> = [];
  const retractions: string[] = [];
  let removed = 0;
  for (const call of logCalls) {
    if (logsFailed(call) || !HEX_QUANTITY.test(String(call.args.fromBlock)) || !HEX_QUANTITY.test(String(call.args.toBlock))) continue;
    const from = BigInt(call.args.fromBlock);
    const to = BigInt(call.args.toBlock);
    for (const log of [...(call.payload as unknown[])].sort(byPosition) as Json[]) {
      if (asObject(log) === undefined) continue;
      const topics: unknown[] = Array.isArray(log.topics) ? log.topics : [];
      if (String(log.address).toLowerCase() !== WATCHED_TOKEN.address.toLowerCase() || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
      const block = typeof log.blockNumber === "string" && HEX_QUANTITY.test(log.blockNumber) ? BigInt(log.blockNumber) : undefined;
      if (block === undefined) continue;
      const key = rawKey(log);
      if (log.removed === true) {
        removed += 1;
        if (key && reported.delete(key)) retractions.push(key);
        continue;
      }
      if (block < from || block > to || (log.removed !== undefined && log.removed !== false)) continue;
      if (!key || !isWellFormedTransfer(log) || reported.has(key)) continue;
      reported.add(key);
      events.push({ key, log });
    }
  }
  return { events, retractions, removed };
}

function isWellFormedTransfer(log: Json): boolean {
  const topics: unknown[] = Array.isArray(log.topics) ? log.topics : [];
  return (
    /^0x[0-9a-f]{40}$/i.test(String(log.address)) &&
    topics.length === 3 &&
    topics.slice(1).every((topic) => typeof topic === "string" && /^0x0{24}[0-9a-f]{40}$/i.test(topic)) &&
    typeof log.data === "string" &&
    /^0x[0-9a-f]{64}$/i.test(log.data)
  );
}

/** Block, then logIndex, as the monitor orders a response; entries without a position first, in order. */
function byPosition(a: unknown, b: unknown): number {
  const position = (log: unknown): [bigint, bigint] => {
    const entry = asObject(log);
    const block = typeof entry?.blockNumber === "string" && HEX_QUANTITY.test(entry.blockNumber) ? BigInt(entry.blockNumber) : -1n;
    const index = typeof entry?.logIndex === "string" && /^0x[0-9a-f]+$/i.test(entry.logIndex) ? BigInt(entry.logIndex) : -1n;
    return [block, index];
  };
  const [blockA, indexA] = position(a);
  const [blockB, indexB] = position(b);
  if (blockA !== blockB) return blockA < blockB ? -1 : 1;
  return indexA === indexB ? 0 : indexA < indexB ? -1 : 1;
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

/**
 * Pair each tools/call request with its response, in request order, session by session: JSON-RPC
 * ids restart in every MCP session, and watch mode opens a new session (a new initialize) after a
 * lost connection, so ids are not unique across the transcript.
 */
function toolCalls(transcript: Json): Call[] {
  const messages: Json[] = Array.isArray(transcript.messages) ? transcript.messages : [];
  const calls: Call[] = [];
  const open = new Map<unknown, Call[]>();
  for (const entry of messages) {
    const message = entry?.message;
    if (!message || typeof message !== "object") continue;
    // A new session: requests the old one never answered stay failed, and ids start over.
    if (entry.direction === "client->server" && message.method === "initialize") open.clear();
    if (entry.direction === "client->server" && message.method === "tools/call") {
      const call: Call = { seq: Number(entry.seq), name: String(message.params?.name), args: asObject(message.params?.arguments) ?? {}, failed: true };
      calls.push(call);
      open.set(message.id, [...(open.get(message.id) ?? []), call]);
      continue;
    }
    if (entry.direction !== "server->client" || "method" in message || !("id" in message)) continue;
    const waiting = open.get(message.id);
    const call = waiting?.shift();
    if (!call) continue;
    const result = message.result;
    call.failed = !result || result.isError === true;
    if (!call.failed) {
      const text = Array.isArray(result.content) ? result.content.find((item: Json) => item?.type === "text")?.text : undefined;
      try {
        call.payload = typeof text === "string" ? JSON.parse(text) : result.structuredContent;
      } catch {
        call.payload = text;
      }
    }
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
