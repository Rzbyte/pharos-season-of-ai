import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { HOSTED_ENDPOINT } from "./constants.js";

export type ErrorKind =
  | "USAGE"
  | "MCP_CONNECTION"
  | "MCP_TOOLS_MISSING"
  | "MCP_TOOL_ERROR"
  | "NOT_ERC20"
  | "UNEXPECTED";

const EXIT_CODES: Readonly<Record<ErrorKind, number>> = {
  UNEXPECTED: 1,
  USAGE: 2,
  MCP_CONNECTION: 3,
  MCP_TOOLS_MISSING: 4,
  MCP_TOOL_ERROR: 5,
  NOT_ERC20: 5,
};

/** An error with a category, a process exit code and an optional fix-it hint. */
export class CliError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly hint?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CliError";
  }

  get exitCode(): number {
    return EXIT_CODES[this.kind];
  }
}

/**
 * A tool call that reached the MCP server but came back with isError: true.
 * The Pharos server wraps upstream failures as {"error":{"message","code","data"}};
 * SDK-level failures (for example argument validation) arrive as plain text.
 */
export class ToolCallError extends CliError {
  constructor(
    readonly tool: string,
    readonly detail: string,
    readonly rpcCode?: number,
    readonly rpcData?: unknown,
  ) {
    super("MCP_TOOL_ERROR", `${tool} failed: ${detail}`);
    this.name = "ToolCallError";
  }

  /** EVM execution reverted (JSON-RPC code 3, or the node says so). */
  get isRevert(): boolean {
    return this.rpcCode === 3 || /revert/i.test(this.detail);
  }

  /** The request itself was rejected, so retrying it unchanged is pointless. */
  get isInvalidParams(): boolean {
    return this.rpcCode === -32602 || /-32602|input validation|invalid arguments/i.test(this.detail);
  }

  static fromPayload(tool: string, payload: unknown): ToolCallError {
    if (typeof payload === "string") return new ToolCallError(tool, shorten(payload));
    if (payload && typeof payload === "object" && "error" in payload) {
      const error = (payload as { error: unknown }).error;
      if (typeof error === "string") return new ToolCallError(tool, shorten(error));
      if (error && typeof error === "object") {
        const { message, code, data } = error as { message?: unknown; code?: unknown; data?: unknown };
        return new ToolCallError(
          tool,
          shorten(typeof message === "string" ? message : JSON.stringify(error)),
          typeof code === "number" ? code : undefined,
          data,
        );
      }
    }
    return new ToolCallError(tool, shorten(JSON.stringify(payload) ?? "unknown error"));
  }
}

/**
 * Whether a tools/call error says the server has no tool by this name. The wording comes from the
 * server's MCP SDK: "MCP error -32602: Tool eth_call not found" (TypeScript, as pharos-mcp sends it),
 * "Tool eth_call not found", or "Unknown tool: eth_call" (Python).
 */
export function isUnknownToolMessage(tool: string, message: string): boolean {
  const name = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quote = "[\"'`]?";
  return new RegExp(`\\btool\\s+${quote}${name}${quote}\\s+not found|\\bunknown tool:?\\s+${quote}${name}(?![\\w-])`, "i").test(message);
}

/** The server does not offer a tool this CLI calls by name. */
export function missingToolError(tool: string, endpoint: URL, cause?: unknown): CliError {
  return new CliError(
    "MCP_TOOLS_MISSING",
    `The MCP server at ${endpoint.href} does not expose: ${tool}.`,
    `Point --endpoint at the Pharos Chain MCP server (${HOSTED_ENDPOINT}).`,
    cause,
  );
}

/** Turn anything thrown by the MCP SDK or fetch into a CliError a human can act on. */
export function toTransportError(
  error: unknown,
  endpoint: URL,
  timeoutMs: number,
  phase: "connect" | "call",
): CliError {
  if (error instanceof CliError) return error;
  const where = endpoint.href;

  if (error instanceof StreamableHTTPError) {
    const status = error.code ?? 0;
    const detail = shorten(error.message.replace(/^Streamable HTTP error:\s*/, "").replace(/^Error POSTing to endpoint:\s*/, ""));
    if (status === 401) {
      return new CliError("MCP_CONNECTION", `${where} requires authentication (HTTP 401).`, "Set PHAROS_MCP_TOKEN to a bearer token this server accepts.", error);
    }
    if (status === 403) {
      return new CliError("MCP_CONNECTION", `Access to ${where} was denied (HTTP 403).`, "A firewall, proxy or the server itself refused the request.", error);
    }
    if (status === 404) {
      // pharos-mcp answers 404 {"error":"Unknown MCP session"} when a request carries a session ID
      // the serving process does not hold: the server restarted, or a load balancer routed the
      // request to another instance. That is not a wrong URL, so say so.
      if (/unknown mcp session/i.test(error.message)) {
        return new CliError(
          "MCP_CONNECTION",
          "The MCP server no longer recognizes this session (HTTP 404: Unknown MCP session).",
          "The server probably restarted, or a load balancer sent the request to an instance that does not hold the session. Rerun the command; every run opens a fresh session.",
          error,
        );
      }
      return new CliError("MCP_CONNECTION", `No MCP endpoint at ${where} (HTTP 404).`, `Use the full endpoint path, for example ${HOSTED_ENDPOINT}`, error);
    }
    if (status === 405) {
      return new CliError("MCP_CONNECTION", `${where} does not accept MCP requests (HTTP 405).`, `Check the URL. The hosted server lives at ${HOSTED_ENDPOINT}`, error);
    }
    if (status === 429) {
      return new CliError("MCP_CONNECTION", "Rate limited by the MCP server (HTTP 429).", "The server caps requests per minute per IP. Wait about a minute, then retry.", error);
    }
    if (status === 503) {
      return new CliError("MCP_CONNECTION", "The MCP server is at capacity or temporarily unavailable (HTTP 503).", "Retry in a minute.", error);
    }
    if (status >= 500) {
      return new CliError("MCP_CONNECTION", `The MCP server returned HTTP ${status}: ${detail}`, "Server-side problem. Retry shortly.", error);
    }
    if (status === -1) {
      return new CliError("MCP_CONNECTION", `${where} did not answer like an MCP server (${detail}).`, "Check that the URL points at an MCP endpoint.", error);
    }
    return new CliError("MCP_CONNECTION", `MCP request to ${where} failed (HTTP ${status}): ${detail}`, undefined, error);
  }

  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) {
      return new CliError("MCP_CONNECTION", `No response from the MCP server within ${timeoutMs} ms.`, "The network or server is slow. Retry, or raise --timeout.", error);
    }
    if (error.code === ErrorCode.ConnectionClosed) {
      return new CliError("MCP_CONNECTION", "The MCP connection closed unexpectedly.", "Retry. If it keeps happening, the server may be restarting.", error);
    }
    if (phase === "connect") {
      return new CliError(
        "MCP_CONNECTION",
        `${where} rejected the MCP handshake: ${shorten(error.message)}`,
        "Make sure the URL is an MCP endpoint, not a JSON-RPC endpoint.",
        error,
      );
    }
    return new CliError("MCP_TOOL_ERROR", shorten(error.message), undefined, error);
  }

  const host = endpoint.host;
  const proxyStatus = /Proxy response \((\d{3})\)/.exec(causeMessages(error).join(" "))?.[1];
  if (proxyStatus) {
    return new CliError(
      "MCP_CONNECTION",
      `A proxy between you and ${host} refused the connection (HTTP ${proxyStatus}).`,
      `Your network's proxy or firewall blocks ${host}. Try another network, or ask whoever runs the proxy to allow it.`,
      error,
    );
  }

  const code = networkErrorCode(error);
  if (code) {
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return new CliError("MCP_CONNECTION", `Could not resolve ${host} (${code}).`, "Check your internet connection and DNS.", error);
    }
    if (code === "ECONNREFUSED") {
      return new CliError("MCP_CONNECTION", `Connection refused by ${host}.`, "Nothing is listening at that address. Check the endpoint URL.", error);
    }
    if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
      return new CliError("MCP_CONNECTION", `TLS error talking to ${host} (${code}).`, "If a proxy intercepts TLS on your network, point NODE_EXTRA_CA_CERTS at its CA certificate.", error);
    }
    const root = causeMessages(error).at(-1);
    return new CliError("MCP_CONNECTION", `Network error talking to ${host} (${code}${root ? `: ${shorten(root, 120)}` : ""}).`, "Check your connection and retry.", error);
  }

  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return new CliError("MCP_CONNECTION", `Could not reach ${where}.`, "Check your internet connection and the endpoint URL.", error);
  }

  return new CliError("UNEXPECTED", errorMessage(error), undefined, error);
}

/** Wrap any unknown throwable as a CliError. */
export function toCliError(error: unknown): CliError {
  return error instanceof CliError ? error : new CliError("UNEXPECTED", errorMessage(error), undefined, error);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : (JSON.stringify(error) ?? String(error));
}

export function shorten(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Messages along an error's cause chain, outermost first. fetch hides the real reason a few levels down. */
function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (current.message) messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

/** Walk an error's cause chain (fetch wraps socket errors) looking for a Node error code. */
function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === "object") {
      const { code, errors, cause } = current as { code?: unknown; errors?: unknown; cause?: unknown };
      if (typeof code === "string" && code.length > 0) return code;
      if (Array.isArray(errors) && errors.length > 0) {
        const nested = networkErrorCode(errors[0]);
        if (nested) return nested;
      }
      current = cause;
    } else {
      return undefined;
    }
  }
  return undefined;
}
