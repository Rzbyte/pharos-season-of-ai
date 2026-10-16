// Errors the agent reports: each has a kind (for the API status and the CLI exit code), a message a
// person can act on, and, where useful, a hint.
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

export type ErrorKind = "usage" | "mcp_connection" | "mcp_tool" | "wrong_chain" | "budget" | "execution" | "unexpected";

const EXIT: Readonly<Record<ErrorKind, number>> = { unexpected: 1, usage: 2, mcp_connection: 3, mcp_tool: 4, wrong_chain: 5, budget: 6, execution: 7 };

export class AgentError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly hint?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentError";
  }

  get exitCode(): number {
    return EXIT[this.kind];
  }
}

/**
 * A tool call that reached the Chain MCP server and came back with isError. The official server sends
 * {"error":{"message","code","data"}} for an upstream RPC failure (an eth_call revert is code 3 with the
 * revert data); SDK-level failures such as argument validation arrive as plain text.
 */
export class ToolCallError extends AgentError {
  constructor(
    readonly tool: string,
    readonly detail: string,
    readonly rpcCode?: number,
    readonly rpcData?: unknown,
  ) {
    super("mcp_tool", `${tool} failed: ${detail}`);
    this.name = "ToolCallError";
  }

  /** The EVM reverted (JSON-RPC code 3, or the node's message says so). */
  get isRevert(): boolean {
    return this.rpcCode === 3 || /revert/i.test(this.detail);
  }

  static fromPayload(tool: string, payload: unknown): ToolCallError {
    if (typeof payload === "string") return new ToolCallError(tool, shorten(payload));
    if (payload && typeof payload === "object" && "error" in payload) {
      const error = (payload as { error: unknown }).error;
      if (typeof error === "string") return new ToolCallError(tool, shorten(error));
      if (error && typeof error === "object") {
        const { message, code, data } = error as { message?: unknown; code?: unknown; data?: unknown };
        return new ToolCallError(tool, shorten(typeof message === "string" ? message : JSON.stringify(error)), typeof code === "number" ? code : undefined, data);
      }
    }
    return new ToolCallError(tool, shorten(JSON.stringify(payload) ?? "unknown error"));
  }
}

/** Anything the MCP SDK or fetch throws, as an AgentError a person can act on. */
export function transportError(error: unknown, where: string, timeoutMs: number): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof StreamableHTTPError) {
    const status = error.code ?? 0;
    if (status === 429) return new AgentError("mcp_connection", "Rate limited by the Chain MCP server (HTTP 429).", "It allows 120 requests a minute per IP. Wait a minute, then retry.", error);
    if (status === 401 || status === 403) return new AgentError("mcp_connection", `${where} refused the request (HTTP ${status}).`, undefined, error);
    if (status === 404 && /session/i.test(error.message)) return new AgentError("mcp_connection", "The Chain MCP server no longer knows this session (HTTP 404).", "Rerun: every run opens a fresh session.", error);
    if (status >= 500) return new AgentError("mcp_connection", `The Chain MCP server returned HTTP ${status}.`, "Retry shortly.", error);
    return new AgentError("mcp_connection", `MCP request to ${where} failed (HTTP ${status}): ${shorten(error.message)}`, undefined, error);
  }
  if (error instanceof McpError && /timed? ?out/i.test(error.message)) {
    return new AgentError("mcp_connection", `${where} did not answer within ${Math.round(timeoutMs / 1000)} s.`, "Retry; the endpoint may be busy.", error);
  }
  const message = errorMessage(error);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket/i.test(message)) {
    return new AgentError("mcp_connection", `Could not reach ${where} (${shorten(message, 120)}).`, "Check the network connection.", error);
  }
  return new AgentError("mcp_connection", `MCP failure at ${where}: ${shorten(message)}`, undefined, error);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
}

export function shorten(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
