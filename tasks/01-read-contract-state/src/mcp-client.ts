import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type JSONRPCMessage, type MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_NAME, VERSION } from "./constants.js";
import { errorMessage, isUnknownToolMessage, missingToolError, shorten, toTransportError, ToolCallError } from "./errors.js";

/** The one capability the contract reader needs: call an MCP tool, get its JSON payload back. */
export interface ToolCaller {
  call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface RecordedMessage {
  seq: number;
  direction: "client->server" | "server->client";
  /** Milliseconds since the recorder was created. */
  atMs: number;
  message: JSONRPCMessage;
}

/** Verbatim, ordered copy of every JSON-RPC message in one run. Feeds proof/mcp-transcript.json. */
export class McpRecorder {
  readonly startedAt = new Date();
  readonly messages: RecordedMessage[] = [];
  server?: { name: string; version: string };
  protocolVersion?: string;
  /** Only a prefix is kept: enough to show the server issued a session, useless to anyone else. */
  sessionIdPrefix?: string;
  sessionTerminated = false;
  private readonly t0 = performance.now();

  record(direction: RecordedMessage["direction"], message: JSONRPCMessage): void {
    this.messages.push({
      seq: this.messages.length + 1,
      direction,
      atMs: Math.round(performance.now() - this.t0),
      message: JSON.parse(JSON.stringify(message)) as JSONRPCMessage,
    });
  }
}

/**
 * Transport decorator: forwards everything to the real Streamable HTTP transport and records each
 * JSON-RPC message on the way through. Only message bodies are recorded, never HTTP headers, so a
 * bearer token can never end up in a transcript.
 */
class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: StreamableHTTPClientTransport,
    private readonly recorder: McpRecorder,
  ) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion(version);
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
 * fetch for the MCP transport that never opens the optional standalone GET event stream.
 *
 * Right after initialization, the SDK's StreamableHTTPClientTransport opens a GET SSE stream for
 * server messages that are not tied to a request. MCP makes that stream optional for clients
 * ("The client MAY issue an HTTP GET"), and this CLI needs nothing from it: the server may not
 * send a response on it, so every tool result arrives on its own POST's SSE stream. Against the
 * hosted Pharos endpoint, every request sent while that GET was open went unanswered, and the same
 * calls completed once it was not opened. SDK 1.32.1 has no option to skip the stream, so this is
 * done through its supported `fetch` option: the standalone GET is answered here with 405, which
 * the spec and the SDK treat as "this server offers no GET stream", and never reaches the network.
 * A GET with Last-Event-ID (resuming an interrupted stream), any other GET, every POST and the DELETE
 * go out unchanged.
 */
export const fetchWithoutStandaloneSse: FetchLike = (url, init) => {
  const headers = new Headers(init?.headers);
  const standaloneSse =
    (init?.method ?? "GET").toUpperCase() === "GET" && (headers.get("accept") ?? "").includes("text/event-stream") && !headers.has("last-event-id");
  return standaloneSse ? Promise.resolve(new Response(null, { status: 405 })) : fetch(url, init);
};

export interface PharosMcpOptions {
  timeoutMs: number;
  recorder: McpRecorder;
  /** Only needed for self-hosted servers started with MCP_AUTH_TOKEN. */
  bearerToken?: string;
  /** Receives one line per MCP request/response when --verbose is on. */
  trace?: (line: string) => void;
}

/**
 * Thin wrapper around the MCP SDK client, pointed at the Pharos Chain MCP server over
 * Streamable HTTP. Every chain read in this CLI goes through call(). Tools are called by their
 * known names without a tools/list round trip: MCP does not require listing before calling, and
 * a live run against the hosted server got no answer to tools/list.
 */
export class PharosMcp implements ToolCaller {
  private readonly client: Client;
  private readonly http: StreamableHTTPClientTransport;
  private readonly recorder: McpRecorder;
  private connected = false;
  private calls = 0;

  constructor(
    readonly endpoint: URL,
    private readonly options: PharosMcpOptions,
  ) {
    const headers: Record<string, string> = {};
    if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;
    this.recorder = options.recorder;
    this.http = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers }, fetch: fetchWithoutStandaloneSse });
    this.client = new Client({ name: TOOL_NAME, version: VERSION });
    // Background stream hiccups (the optional GET event stream) are not fatal; surface them only when tracing.
    this.client.onerror = (error) => options.trace?.(`transport notice: ${shorten(errorMessage(error), 160)}`);
  }

  get toolCalls(): number {
    return this.calls;
  }

  /** "name version" as reported by the server during initialize. */
  get serverLabel(): string | undefined {
    const info = this.client.getServerVersion();
    return info ? `${info.name} ${info.version}`.trim() : undefined;
  }

  async connect(): Promise<void> {
    const started = performance.now();
    try {
      await this.client.connect(new RecordingTransport(this.http, this.recorder), { timeout: this.options.timeoutMs });
    } catch (error) {
      throw toTransportError(error, this.endpoint, this.options.timeoutMs, "connect");
    }
    this.connected = true;

    const info = this.client.getServerVersion();
    if (info) this.recorder.server = { name: info.name, version: info.version };
    this.recorder.protocolVersion = this.http.protocolVersion;
    this.recorder.sessionIdPrefix = this.http.sessionId?.slice(0, 8);

    const session = this.recorder.sessionIdPrefix ? ` session ${this.recorder.sessionIdPrefix}...` : "";
    this.options.trace?.(`connected to ${this.serverLabel ?? "MCP server"}${session} (${elapsed(started)})`);
  }

  async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls += 1;
    const started = performance.now();
    this.options.trace?.(`-> ${name} ${JSON.stringify(args)}`);

    let result: { content?: unknown; structuredContent?: unknown; isError?: unknown };
    try {
      result = (await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.options.timeoutMs,
      })) as typeof result;
    } catch (error) {
      // Some servers reject an unknown tool with a JSON-RPC error rather than isError, and a server
      // without any tools answers tools/call itself with -32601.
      if (error instanceof McpError && (error.code === ErrorCode.MethodNotFound || isUnknownToolMessage(name, error.message))) {
        throw missingToolError(name, this.endpoint, error);
      }
      throw toTransportError(error, this.endpoint, this.options.timeoutMs, "call");
    }

    const payload = parseToolPayload(result);
    const failed = result.isError === true;
    this.options.trace?.(`<- ${name}${failed ? " ERROR" : ""} ${shorten(JSON.stringify(payload) ?? "undefined", 200)} (${elapsed(started)})`);
    if (failed) {
      const error = ToolCallError.fromPayload(name, payload);
      if (isUnknownToolMessage(name, error.detail)) throw missingToolError(name, this.endpoint, error);
      throw error;
    }
    return payload as T;
  }

  /** Best effort: end the server-side session (frees its slot), then drop the transport. */
  async close(): Promise<void> {
    if (this.connected) {
      try {
        await withTimeout(this.http.terminateSession(), 3_000);
        this.recorder.sessionTerminated = true;
        this.options.trace?.("session terminated");
      } catch {
        // The server evicts idle sessions on its own; nothing useful to report here.
      }
    }
    await this.client.close().catch(() => undefined);
  }
}

/**
 * Pharos MCP tools return their data as a JSON string in the first text content
 * item. structuredContent is preferred if a future server version sends it.
 * Non-JSON text (SDK validation messages, for example) is returned as-is.
 */
export function parseToolPayload(result: { content?: unknown; structuredContent?: unknown }): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string",
  )?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function elapsed(started: number): string {
  return `${Math.round(performance.now() - started)} ms`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
