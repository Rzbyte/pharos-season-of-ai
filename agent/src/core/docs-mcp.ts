// The Pharos Developer Docs MCP (https://docs.pharos.xyz/~gitbook/mcp), the docs site's own MCP server.
// It is called the way Task 04 verified the live endpoint answers (tasks/04-doc-search-cli/proof): stateless
// JSON-RPC 2.0 POSTs, with no initialize and no session, each answered with one JSON message or an event
// stream of `message` events. Its tools, from the live tools/list: searchDocumentation {query}, getPage
// {url}, askQuestion {question, goal}. Every message is recorded, so a proof can replay the run.
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { AGENT, Recorder, type RecordedMessage } from "./chain-mcp.js";
import { AgentError, errorMessage } from "./errors.js";

export const DOCS_MCP = "https://docs.pharos.xyz/~gitbook/mcp";
export const DOCS_ORIGIN = "https://docs.pharos.xyz";
/** The largest response read; anything longer is refused rather than cut silently. */
const MAX_BYTES = 2_000_000;

export type DocsToolName = "askQuestion" | "getPage" | "searchDocumentation";

/** What a run needs of the Developer Docs MCP: a tool's text answer. */
export interface DocsTools {
  readonly where: string;
  readonly calls: number;
  call(name: DocsToolName, args: Record<string, string>): Promise<string>;
}

/** Server-sent events by the WHATWG rules: the data lines of each `message` event, joined. */
function sseMessages(text: string): string[] {
  const out: string[] = [];
  let event = "";
  let data: string[] = [];
  const dispatch = () => {
    if (data.length && (event === "" || event === "message")) out.push(data.join("\n"));
    [event, data] = ["", []];
  };
  for (const line of text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") dispatch();
    else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const [field, value] = colon === -1 ? [line, ""] : [line.slice(0, colon), line.slice(colon + 1).replace(/^ /, "")];
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  }
  dispatch();
  return out;
}

/** The JSON-RPC messages of a response body: an event stream's message events, or one JSON body. */
function messagesOf(body: string, contentType: string | null): unknown[] {
  const texts = /text\/event-stream/i.test(contentType ?? "") ? sseMessages(body) : [body];
  return texts.flatMap((text) => {
    try {
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new AgentError("mcp_tool", "The Developer Docs MCP sent a message that is not JSON.");
    }
  });
}

/**
 * A docs tool's own refusal: an isError result, or a JSON-RPC error. Its answer is recorded, so a replay of
 * the run meets the same refusal, and a run may go on past one (a page it could not read).
 */
export class DocsToolError extends AgentError {
  constructor(message: string) {
    super("mcp_tool", message);
    this.name = "DocsToolError";
  }
}

/** A tools/call result's text: its text content, in order. An isError result is the tool's refusal. */
export function docsText(name: string, result: unknown): string {
  const r = result as { content?: unknown; isError?: unknown } | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.content)) throw new AgentError("mcp_tool", `The ${name} result has no content.`);
  const text = r.content
    .filter((item): item is { type: "text"; text: string } => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("\n\n")
    .trim();
  if (r.isError === true) throw new DocsToolError(`The Developer Docs MCP could not answer ${name}: ${text.slice(0, 300) || "no detail"}.`);
  return text;
}

export class DocsMcp implements DocsTools {
  readonly recorder = new Recorder();
  private id = 0;
  private made = 0;

  constructor(
    readonly where: string = DOCS_MCP,
    private readonly options: { timeoutMs?: number; budget?: number; fetch?: typeof fetch; trace?: (line: string) => void } = {},
  ) {}

  get calls(): number {
    return this.made;
  }

  async call(name: DocsToolName, args: Record<string, string>): Promise<string> {
    const budget = this.options.budget ?? 4;
    if (this.made >= budget) throw new AgentError("budget", `This run reached its limit of ${budget} Developer Docs MCP calls.`);
    this.made += 1;
    const request = { jsonrpc: "2.0" as const, id: (this.id += 1), method: "tools/call", params: { name, arguments: args } };
    this.recorder.record("client->server", request as JSONRPCMessage);
    this.options.trace?.(`docs ${name} ${JSON.stringify(args).slice(0, 160)}`);
    let response: Response;
    let body: string;
    try {
      response = await (this.options.fetch ?? fetch)(this.where, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": `${AGENT.name}/${AGENT.version} (+https://github.com/Rzbyte/pharos-season-of-ai)` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
      body = await response.text();
    } catch (error) {
      throw new AgentError("mcp_connection", `Could not reach the Developer Docs MCP at ${this.where}: ${errorMessage(error)}.`, "Retry; if it persists, the docs site is down or unreachable from here.", error);
    }
    if (!response.ok) throw new AgentError("mcp_connection", `The Developer Docs MCP answered HTTP ${response.status}.`, "Retry; if it persists, the docs site is down.");
    if (body.length > MAX_BYTES) throw new AgentError("mcp_tool", `The Developer Docs MCP answer to ${name} is over ${MAX_BYTES.toLocaleString("en-US")} bytes.`);
    const reply = messagesOf(body, response.headers.get("content-type")).find((m) => typeof m === "object" && m !== null && (m as { id?: unknown }).id === request.id) as { result?: unknown; error?: { message?: string } } | undefined;
    if (!reply) throw new AgentError("mcp_tool", `The Developer Docs MCP sent no answer to ${name}.`);
    this.recorder.record("server->client", reply as JSONRPCMessage);
    if (reply.error) throw new DocsToolError(`${name} failed: ${reply.error.message ?? "no detail"}.`);
    return docsText(name, reply.result);
  }
}

/**
 * The Developer Docs MCP from a recorded run: each call must be exactly the next recorded one (the same
 * tool, the same arguments), and gets the recorded answer, read the same way.
 */
export class ReplayDocs implements DocsTools {
  private readonly pairs: { name: string; args: unknown; result?: unknown; error?: { message?: string } }[] = [];
  private next = 0;

  constructor(
    transcript: readonly RecordedMessage[],
    readonly where: string,
  ) {
    const replies = new Map<unknown, { result?: unknown; error?: { message?: string } }>();
    for (const { direction, message } of transcript) if (direction === "server->client" && "id" in message) replies.set(message.id, message as { result?: unknown; error?: { message?: string } });
    for (const { direction, message } of transcript) {
      if (direction !== "client->server" || !("method" in message) || message.method !== "tools/call" || !("id" in message)) continue;
      const params = (message as { params?: { name?: unknown; arguments?: unknown } }).params ?? {};
      const reply = replies.get(message.id);
      if (!reply) throw new Error(`Docs tools/call ${String(params.name)} (id ${String(message.id)}) has no response in the transcript.`);
      this.pairs.push({ name: String(params.name), args: params.arguments ?? {}, ...reply });
    }
  }

  get calls(): number {
    return this.next;
  }

  get remaining(): number {
    return this.pairs.length - this.next;
  }

  async call(name: DocsToolName, args: Record<string, string>): Promise<string> {
    const recorded = this.pairs[this.next];
    if (!recorded || recorded.name !== name || JSON.stringify(recorded.args) !== JSON.stringify(args)) throw new Error(`Docs call ${this.next + 1}: the code asked for ${name} ${JSON.stringify(args)}; the recorded run ${recorded ? `asked for ${recorded.name} ${JSON.stringify(recorded.args)}` : "made no more calls"}.`);
    this.next += 1;
    if (recorded.error) throw new DocsToolError(`${name} failed: ${recorded.error.message ?? "no detail"}.`);
    return docsText(name, recorded.result);
  }
}
