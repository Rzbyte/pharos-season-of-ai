// Proof files: one live run, written as it happened, and checked offline by replaying it.
//
// A proof holds the input, the result, and every JSON-RPC message exchanged with the Chain MCP server.
// The verifier does not trust the result: it feeds the recorded responses back, in order, through the
// same code that produced the result (ReplayMcp), requires that code to make exactly the recorded
// requests, and requires the same result to come out. Separate checks cover what replay cannot:
// that the server was the official one, on the right chain, at the endpoint the proof names.
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { AGENT, type ChainMcp, type RecordedMessage } from "./chain-mcp.js";
import { ToolCallError } from "./errors.js";
import { HOSTED_CHAIN_MCP, type Network } from "./networks.js";
import { parseToolPayload } from "./chain-mcp.js";

export const PROOF_FORMAT = "pharos-agent-proof/1";

export interface ProofFile<Input = unknown, Result = unknown> {
  format: typeof PROOF_FORMAT;
  task: string;
  capability: string;
  about: string;
  agent: { name: string; version: string };
  runtime: { node: string; platform: string };
  chainMcp: { kind: "hosted" | "local"; endpoint: string; server: { name: string; version: string } | null; protocolVersion: string | null };
  network: { id: string; chainId: number };
  startedAt: string;
  finishedAt: string;
  input: Input;
  result: Result;
  transcript: RecordedMessage[];
  /** A run that also asked the Developer Docs MCP (Task 13): its endpoint and every message, in order. */
  docsMcp?: { endpoint: string; transcript: RecordedMessage[] };
}

export function proofFile<Input, Result>(fields: { task: string; capability: string; about: string; mcp: ChainMcp; network: Network; startedAt: Date; input: Input; result: Result }): ProofFile<Input, Result> {
  const { mcp } = fields;
  return {
    format: PROOF_FORMAT,
    task: fields.task,
    capability: fields.capability,
    about: fields.about,
    agent: { ...AGENT },
    runtime: { node: process.version, platform: `${process.platform} ${process.arch}` },
    chainMcp: {
      kind: mcp.endpoint.kind === "hosted" ? "hosted" : "local",
      endpoint: mcp.endpoint.kind === "hosted" ? mcp.endpoint.url : "stdio",
      server: mcp.server ?? null,
      protocolVersion: mcp.protocolVersion ?? null,
    },
    network: { id: fields.network.id, chainId: fields.network.chainId },
    startedAt: fields.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    input: fields.input,
    result: fields.result,
    transcript: fields.mcp.recorder.messages,
  };
}

export interface RecordedCall {
  id: string | number;
  name: string;
  args: Record<string, unknown>;
  /** The tool's payload, parsed as the client parses it. */
  payload: unknown;
  isError: boolean;
}

/** The tools/call requests of a transcript, each paired with its response (by JSON-RPC id), in order. */
export function recordedCalls(transcript: readonly RecordedMessage[]): RecordedCall[] {
  const responses = new Map<string | number, JSONRPCMessage>();
  for (const { direction, message } of transcript) if (direction === "server->client" && "id" in message && message.id !== undefined && !("method" in message)) responses.set(message.id, message);
  const out: RecordedCall[] = [];
  for (const { direction, message } of transcript) {
    if (direction !== "client->server" || !("method" in message) || message.method !== "tools/call" || !("id" in message)) continue;
    const params = (message as { params?: { name?: unknown; arguments?: unknown } }).params ?? {};
    const response = responses.get(message.id as string | number);
    if (!response) throw new Error(`tools/call ${String(params.name)} (id ${String(message.id)}) has no response in the transcript.`);
    if ("error" in response) throw new Error(`tools/call ${String(params.name)} (id ${String(message.id)}) failed at the JSON-RPC level.`);
    const result = (response as { result: { content?: unknown; structuredContent?: unknown; isError?: unknown } }).result;
    out.push({ id: message.id as string | number, name: String(params.name), args: (params.arguments ?? {}) as Record<string, unknown>, payload: parseToolPayload(result), isError: result.isError === true });
  }
  return out;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b))) : v));

/**
 * A Chain MCP client that answers from a recorded run. Each call must be exactly the next recorded call
 * (same tool, same arguments), so the code under replay has to ask for precisely what the live run asked.
 */
export class ReplayMcp {
  private next = 0;

  constructor(
    private readonly calls: readonly RecordedCall[],
    readonly where: string,
    readonly server: { name: string; version: string } | undefined,
  ) {}

  get toolCalls(): number {
    return this.next;
  }

  get remaining(): number {
    return this.calls.length - this.next;
  }

  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const recorded = this.calls[this.next];
    if (!recorded) throw new ReplayMismatch(`The code asked for ${name} ${canonical(args)}, but the recorded run made no more calls.`);
    if (recorded.name !== name || canonical(recorded.args) !== canonical(args)) {
      throw new ReplayMismatch(`Call ${this.next + 1}: the code asked for ${name} ${canonical(args)}; the recorded run asked for ${recorded.name} ${canonical(recorded.args)}.`);
    }
    this.next += 1;
    if (recorded.isError) throw ToolCallError.fromPayload(name, recorded.payload);
    return recorded.payload as T;
  }
}

export class ReplayMismatch extends Error {
  override name = "ReplayMismatch";
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Checks every proof gets, whatever the capability: format, agent, server identity, endpoint and chain. */
export function commonChecks(proof: ProofFile, expected: { task: string; capability: string; network: Network }): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add("proof format", proof.format === PROOF_FORMAT && proof.task === expected.task && proof.capability === expected.capability, `${proof.format}, task ${proof.task}, ${proof.capability}`);
  add("network", proof.network.id === expected.network.id && proof.network.chainId === expected.network.chainId, `${proof.network.id} (${proof.network.chainId})`);
  const init = proof.transcript.find((m) => m.direction === "server->client" && "result" in m.message && (m.message as { result?: { serverInfo?: unknown } }).result?.serverInfo);
  const serverInfo = (init?.message as { result?: { serverInfo?: { name?: string; version?: string } } } | undefined)?.result?.serverInfo;
  add("official Chain MCP server", serverInfo?.name === "pharos-mcp-server", `initialize answered by ${serverInfo?.name ?? "nobody"} ${serverInfo?.version ?? ""}`.trim());
  if (expected.network.hostedChainMcp) {
    add("hosted endpoint", proof.chainMcp.kind === "hosted" && proof.chainMcp.endpoint === HOSTED_CHAIN_MCP, `${proof.chainMcp.kind} ${proof.chainMcp.endpoint}`);
  } else {
    add("official server run locally", proof.chainMcp.kind === "local" && proof.chainMcp.endpoint === "stdio", `${proof.chainMcp.kind} ${proof.chainMcp.endpoint}`);
  }
  let calls: RecordedCall[] = [];
  try {
    calls = recordedCalls(proof.transcript);
    add("every request answered", calls.length > 0, `${calls.length} tools/call requests, each with its response`);
  } catch (error) {
    add("every request answered", false, (error as Error).message);
  }
  const first = calls[0];
  const chainId = first?.name === "get_chain_info" ? (first.payload as { chainId?: unknown } | null)?.chainId : undefined;
  add("chain checked first", chainId === expected.network.chainId, first ? `${first.name} reported chain ${String(chainId)}` : "no calls");
  const text = JSON.stringify(proof);
  add("no key material", !/private[_ ]?key/i.test(text), "no private key field anywhere in the proof");
  return checks;
}

/** Tools whose reads name a block, so a pinned run must pass its block to every one of them. */
export const PINNABLE = new Set(["eth_call", "get_balance", "get_code", "get_transaction_count", "get_storage_at"]);

/**
 * Every get_logs call inside the blocks the run says it scanned (`scanned.pages` of them), none over
 * 1,000 blocks; none at all when it says it scanned nothing.
 */
export function scanCheck(calls: readonly RecordedCall[], scanned: { from: string; to: string; pages: number } | null): Check {
  const pages = calls.filter((c) => c.name === "get_logs").map((c) => ({ from: BigInt(String(c.args.fromBlock)), to: BigInt(String(c.args.toBlock)) }));
  if (!scanned) return { name: "scanned blocks", ok: pages.length === 0, detail: pages.length ? `${pages.length} get_logs calls, but the run says it scanned nothing` : "no new blocks to scan" };
  const [from, to] = [BigInt(scanned.from), BigInt(scanned.to)];
  const outside = pages.filter((p) => p.from < from || p.to > to || p.to < p.from || p.to - p.from + 1n > 1000n);
  return { name: "scanned blocks", ok: outside.length === 0 && pages.length === scanned.pages, detail: outside.length ? `${outside.length} get_logs pages outside blocks ${from}–${to}` : `${pages.length} get_logs ${pages.length === 1 ? "call" : "calls"} within blocks ${from.toLocaleString("en-US")}–${to.toLocaleString("en-US")}` };
}

/** The first path where two results differ, with both values, for a failed replay. */
export function firstDifference(a: unknown, b: unknown, path = "result"): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return "";
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const diff = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (diff) return diff;
    }
  }
  return `${path} differs: recomputed ${JSON.stringify(a)?.slice(0, 120)}, recorded ${JSON.stringify(b)?.slice(0, 120)}`;
}

/**
 * For replay only: a signer that "signs" by returning the transaction the live run broadcast, so the
 * replayed code sends exactly the recorded send_raw_transaction. Its address is the recorded sender.
 */
export function replaySigner(calls: readonly RecordedCall[], address: `0x${string}`): { address: `0x${string}`; sign: () => Promise<Hex> } {
  const raw = calls.find((call) => call.name === "send_raw_transaction")?.args.rawTransaction;
  return { address, sign: async () => (typeof raw === "string" ? (raw as Hex) : "0x") };
}

/** The broadcast transaction is exactly `expected`, on `chainId`, signed by `expected.from`. */
export async function signedTransactionCheck(calls: readonly RecordedCall[], chainId: number, expected: { from: string; to: string; data: string; value: bigint }, what = "transaction"): Promise<Check> {
  const raw = calls.find((call) => call.name === "send_raw_transaction")?.args.rawTransaction;
  if (typeof raw !== "string") return { name: "signed transaction", ok: false, detail: "no send_raw_transaction in the transcript" };
  const tx = parseTransaction(raw as Hex);
  const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
  const ok = tx.chainId === chainId && tx.to?.toLowerCase() === expected.to.toLowerCase() && (tx.data ?? "0x") === expected.data && (tx.value ?? 0n) === expected.value && from.toLowerCase() === expected.from.toLowerCase();
  return { name: "signed transaction", ok, detail: ok ? `chain ${tx.chainId}, signed by ${from}, exactly the prepared ${what}` : `the broadcast transaction is not the prepared ${what}` };
}

/** Every state read before the first send names the pinned block (or one of them, for a report read at two). */
export function pinnedCheck(calls: readonly RecordedCall[], block: string | readonly string[], until: number = calls.length): Check {
  const blocks = typeof block === "string" ? [block] : block;
  const pinned = blocks.map((b) => `0x${BigInt(b).toString(16)}`);
  const unpinned = calls.slice(0, until).filter((call) => PINNABLE.has(call.name) && !pinned.includes(String(call.args.block)));
  if (blocks.length > 1) return { name: "pinned blocks", ok: unpinned.length === 0, detail: unpinned.length ? `${unpinned.length} reads not at ${pinned.join(" or ")}` : `every state read is at block ${blocks.join(" or ")}` };
  return { name: "one pinned block", ok: unpinned.length === 0, detail: unpinned.length ? `${unpinned.length} reads not at ${pinned[0]}` : `every state read before execution is at block ${block}` };
}
