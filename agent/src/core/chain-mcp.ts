// The agent's one way to the chain: the Pharos Chain MCP server, through the official MCP SDK.
//
//   hosted     https://mcp.pharos.xyz/mcp over Streamable HTTP (mainnet, read-only)
//   local      the official server (vendor/pharos-mcp, unmodified) started over stdio for a network the
//              hosted endpoint does not serve, or to broadcast a transaction signed here
//   transport  any MCP transport (tests run the official server in-process this way)
//
// Every JSON-RPC message in either direction is recorded, never an HTTP header, so a transcript can be
// published as proof. The private key never reaches this module: only already-signed transactions do.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type JSONRPCMessage, type MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { AgentError, errorMessage, shorten, ToolCallError, transportError } from "./errors.js";
import type { Network } from "./networks.js";

export const AGENT = Object.freeze({ name: "pharos-agent", version: "0.1.0" });

/** Tool errors that mean the server's upstream RPC failed (network or HTTP), as the official server words them. */
const UPSTREAM_DOWN = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|TimeoutError|The operation was aborted|RPC HTTP (?:429|5\d\d)/i;

export interface RecordedMessage {
  seq: number;
  direction: "client->server" | "server->client";
  /** Milliseconds since the recorder was created. */
  atMs: number;
  message: JSONRPCMessage;
}

/** An ordered, verbatim copy of every JSON-RPC message of one run. */
export class Recorder {
  readonly messages: RecordedMessage[] = [];
  private readonly t0 = performance.now();

  record(direction: RecordedMessage["direction"], message: JSONRPCMessage): void {
    this.messages.push({ seq: this.messages.length + 1, direction, atMs: Math.round(performance.now() - this.t0), message: JSON.parse(JSON.stringify(message)) as JSONRPCMessage });
  }
}

/** Forwards to the real transport and records each JSON-RPC message on the way through. */
class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: Transport,
    private readonly recorder: Recorder,
  ) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    this.inner.onmessage = <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => {
      this.recorder.record("server->client", message);
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => this.onclose?.();
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.recorder.record("client->server", message);
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/**
 * fetch that never opens the optional standalone GET event stream (as in Tasks 01 and 02). Against the
 * hosted endpoint, requests sent while that stream was open went unanswered; MCP makes it optional, and
 * every tool result arrives on its own POST. The GET is answered locally with 405 ("no GET stream").
 */
export const fetchWithoutStandaloneSse: FetchLike = (url, init) => {
  const headers = new Headers(init?.headers);
  const standalone = (init?.method ?? "GET").toUpperCase() === "GET" && (headers.get("accept") ?? "").includes("text/event-stream") && !headers.has("last-event-id");
  return standalone ? Promise.resolve(new Response(null, { status: 405 })) : fetch(url, init);
};

export type ChainMcpEndpoint =
  | { kind: "hosted"; url: string }
  | { kind: "local"; network: Network; broadcast: boolean }
  | { kind: "transport"; label: string; transport: Transport };

export interface ChainMcpOptions {
  /** Per request; the hosted server can take a few seconds to initialize a session. */
  timeoutMs?: number;
  /** At most this many tool calls in one run (the hosted endpoint allows 120 requests a minute per IP). */
  budget?: number;
  /**
   * Waits, rather than fails, to start at most `calls` tool calls in any `windowMs` (default a minute):
   * for runs longer than the hosted endpoint's 120 requests a minute.
   */
  pace?: { calls: number; windowMs?: number };
  recorder?: Recorder;
  trace?: (line: string) => void;
}

/** Where the official server's entry point is once built (dist/vendor/pharos-mcp/src/index.js). */
export const OFFICIAL_SERVER_ENTRY = fileURLToPath(new URL("../../vendor/pharos-mcp/src/index.js", import.meta.url));

/** Environment for the official server: its own documented settings, and nothing else of ours (never a key). */
export function officialServerEnv(net: Network, broadcast: boolean): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    MCP_TRANSPORT: "stdio",
    PHAROS_RPC_URL: net.rpcUrl,
    PHAROS_CHAIN_ID: String(net.chainId),
    PHAROS_NATIVE_SYMBOL: net.nativeSymbol,
    ENABLE_SEND_RAW_TRANSACTION: broadcast ? "true" : "false",
  };
}

export class ChainMcp {
  readonly recorder: Recorder;
  server?: { name: string; version: string };
  protocolVersion?: string;
  private calls = 0;
  /** When each recent call started, for `pace`. */
  private starts: number[] = [];

  private constructor(
    private readonly client: Client,
    private readonly http: StreamableHTTPClientTransport | null,
    readonly endpoint: ChainMcpEndpoint,
    readonly where: string,
    private readonly options: Required<Pick<ChainMcpOptions, "timeoutMs" | "budget">> & ChainMcpOptions,
    recorder: Recorder,
  ) {
    this.recorder = recorder;
  }

  static async connect(endpoint: ChainMcpEndpoint, options: ChainMcpOptions = {}): Promise<ChainMcp> {
    const opts = { timeoutMs: 25_000, budget: 60, ...options };
    const recorder = opts.recorder ?? new Recorder();
    let inner: Transport;
    let where: string;
    if (endpoint.kind === "hosted") {
      inner = new StreamableHTTPClientTransport(new URL(endpoint.url), { fetch: fetchWithoutStandaloneSse });
      where = endpoint.url;
    } else if (endpoint.kind === "local") {
      inner = new StdioClientTransport({ command: process.execPath, args: [OFFICIAL_SERVER_ENTRY], env: officialServerEnv(endpoint.network, endpoint.broadcast), stderr: "pipe" });
      where = `the official Pharos Chain MCP server (stdio) on ${endpoint.network.rpcUrl}`;
    } else {
      inner = endpoint.transport;
      where = endpoint.label;
    }
    const client = new Client({ name: AGENT.name, version: AGENT.version });
    client.onerror = (error) => opts.trace?.(`transport notice: ${shorten(errorMessage(error), 160)}`);
    const transport = new RecordingTransport(inner, recorder);
    const mcp = new ChainMcp(client, inner instanceof StreamableHTTPClientTransport ? inner : null, endpoint, where, opts, recorder);
    try {
      await client.connect(transport, { timeout: opts.timeoutMs });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw transportError(error, where, opts.timeoutMs);
    }
    const info = client.getServerVersion();
    if (info) mcp.server = { name: info.name, version: info.version };
    mcp.protocolVersion = inner instanceof StreamableHTTPClientTransport ? inner.protocolVersion : undefined;
    opts.trace?.(`connected to ${info ? `${info.name} ${info.version}` : "the MCP server"} at ${where}`);
    return mcp;
  }

  get toolCalls(): number {
    return this.calls;
  }

  /** Call one Chain MCP tool by name and return its JSON payload; a tool error throws ToolCallError. */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.calls >= this.options.budget) throw new AgentError("budget", `This run reached its limit of ${this.options.budget} Chain MCP calls.`);
    if (this.options.pace) await this.paced(this.options.pace.calls, this.options.pace.windowMs ?? 60_000);
    this.calls += 1;
    const started = performance.now();
    this.options.trace?.(`-> ${name} ${JSON.stringify(args)}`);
    let result: { content?: unknown; structuredContent?: unknown; isError?: unknown };
    try {
      result = (await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.options.timeoutMs })) as typeof result;
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams) throw new ToolCallError(name, shorten(error.message), error.code);
      throw transportError(error, this.where, this.options.timeoutMs);
    }
    const payload = parseToolPayload(result);
    this.options.trace?.(`<- ${name}${result.isError === true ? " ERROR" : ""} ${shorten(JSON.stringify(payload) ?? "undefined", 200)} (${Math.round(performance.now() - started)} ms)`);
    if (result.isError === true) {
      const error = ToolCallError.fromPayload(name, payload);
      // The server could not reach its own RPC: an outage, not an answer about this call.
      if (UPSTREAM_DOWN.test(error.detail) && !error.isRevert) {
        const rpc = this.endpoint.kind === "local" ? ` (${this.endpoint.network.rpcUrl})` : "";
        throw new AgentError("mcp_connection", `The Chain MCP server could not reach its Pharos RPC${rpc}: ${error.detail}.`, "Retry; if it persists, the RPC is down or unreachable from here.", error);
      }
      throw error;
    }
    return payload as T;
  }

  private async paced(calls: number, windowMs: number): Promise<void> {
    this.starts = this.starts.filter((at) => performance.now() - at < windowMs);
    if (this.starts.length >= calls) {
      const wait = windowMs - (performance.now() - this.starts[0]!) + 20;
      this.options.trace?.(`pacing: ${calls} calls in ${windowMs / 1000} s, waiting ${(wait / 1000).toFixed(1)} s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      this.starts.shift();
    }
    this.starts.push(performance.now());
  }

  /** Best effort: end the HTTP session (frees the server's slot), then close the transport. */
  async close(): Promise<void> {
    if (this.http?.sessionId) await withTimeout(this.http.terminateSession(), 3_000).catch(() => undefined);
    await this.client.close().catch(() => undefined);
  }
}

/**
 * The official server returns each result as JSON text in the first text content item
 * (structuredContent is preferred if a later version sends it). Non-JSON text is returned as is.
 */
export function parseToolPayload(result: { content?: unknown; structuredContent?: unknown }): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null && typeof result.structuredContent === "object") return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((item): item is { type: "text"; text: string } => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
