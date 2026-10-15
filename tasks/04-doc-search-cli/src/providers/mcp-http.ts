import { createHash } from "node:crypto";
import { MAX_RESPONSE_BYTES, USER_AGENT } from "../constants.js";
import type { JsonRpcRequest, RequestRecord } from "../types.js";
import { hostOf, isTimeout, messageOf, readCapped, type FetchLike } from "./http.js";
import { ProviderError } from "./provider.js";

// A minimal MCP client for one Streamable HTTP endpoint: the part of the protocol pharos-docs needs,
// and nothing else.
//
//   POST <endpoint>
//     Content-Type: application/json
//     Accept: application/json, text/event-stream
//     {"jsonrpc":"2.0","id":<n>,"method":"tools/list" | "tools/call","params":{...}}
//
// The response is either one JSON-RPC message (application/json) or an event stream whose `message`
// events each carry one JSON-RPC message in their `data:` lines; the one with the request's id is the
// response. No session and no authentication: the Developer Docs MCP answers these stateless POSTs
// (verified against the live endpoint), so none is invented here.

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/**
 * Server-sent events, by the WHATWG rules: one field per line ("event:", "data:", "id:", ":" comments),
 * the data lines of one event joined with "\n", an event ending at a blank line. The body here is a
 * complete response, so a last event without its blank line is kept rather than dropped.
 */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let event = "";
  let data: string[] = [];
  let id: string | null = null;
  let pending = false;
  const dispatch = () => {
    if (pending) events.push({ event: event || "message", data: data.join("\n"), id });
    event = "";
    data = [];
    pending = false;
  };
  for (const line of text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") {
      data.push(value);
      pending = true;
    } else if (field === "id") id = value;
  }
  dispatch();
  return events;
}

/** Every JSON-RPC message in a response body: an event stream's `message` events, or a JSON body (one message or a batch). */
export function jsonRpcMessages(body: string, contentType: string | null): unknown[] {
  if (/text\/event-stream/i.test(contentType ?? "")) {
    const messages = parseSse(body).filter((event) => event.event === "message");
    if (messages.length === 0) throw new ProviderError("malformed_response", "The MCP event stream carried no message event.");
    return messages.map((event) => {
      try {
        return JSON.parse(event.data) as unknown;
      } catch {
        throw new ProviderError("malformed_response", "An MCP message event's data is not JSON.");
      }
    });
  }
  if (/application\/json/i.test(contentType ?? "")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ProviderError("malformed_response", "The MCP endpoint answered with JSON that does not parse.");
    }
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  throw new ProviderError("malformed_response", `The MCP endpoint answered ${contentType ? `as ${contentType.split(";")[0]}` : "without a content type"}, not JSON or an event stream.`);
}

/**
 * The response to request `id`: a JSON-RPC 2.0 message with that id and exactly one of result or
 * error. Other messages in the stream (notifications, progress) are skipped. An error response throws.
 */
export function responseFor(messages: unknown[], id: number): unknown {
  const response = messages.find((message): message is JsonRpcResponse => isRecord(message) && message.id === id && ("result" in message || "error" in message));
  if (!response) throw new ProviderError("malformed_response", `The MCP response has no JSON-RPC answer to request ${id}.`);
  if (response.jsonrpc !== "2.0") throw new ProviderError("malformed_response", `The MCP answer to request ${id} is not JSON-RPC 2.0.`);
  const hasResult = "result" in response;
  const hasError = "error" in response;
  if (hasResult === hasError) throw new ProviderError("malformed_response", `The MCP answer to request ${id} has ${hasResult ? "both a result and an error" : "neither a result nor an error"}.`);
  if (hasError) {
    const error: Record<string, unknown> = isRecord(response.error) ? response.error : {};
    const code = typeof error.code === "number" ? error.code : "unknown";
    const message = typeof error.message === "string" && error.message.trim() ? error.message.trim() : "no message";
    throw new ProviderError("upstream_error", `The Developer Docs MCP answered with error ${code}: ${message}`);
  }
  return response.result;
}

export interface McpHttpOptions {
  timeoutMs: number;
  fetch?: FetchLike;
  onRequest?: (record: RequestRecord) => void;
}

/** One endpoint, its JSON-RPC ids, and a record of every exchange (the request sent, the raw body received). */
export class McpHttpClient {
  private readonly log: RequestRecord[] = [];
  private readonly fetchImpl: FetchLike;
  private nextId = 1;

  constructor(
    readonly endpoint: string,
    private readonly options: McpHttpOptions,
  ) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  requests(): RequestRecord[] {
    return [...this.log];
  }

  /** Send one request and return its result. Throws ProviderError for every way it can fail. */
  async call(method: "tools/list" | "tools/call", params?: Record<string, unknown>): Promise<unknown> {
    const rpc: JsonRpcRequest = { jsonrpc: "2.0", id: this.nextId++, method, ...(params ? { params } : {}) };
    const started = performance.now();
    const record: RequestRecord = { seq: this.log.length + 1, method: "POST", url: this.endpoint, purpose: method, rpc, status: null, contentType: null, bytes: 0, ms: 0, sha256: null, excerpt: null, body: null, error: null };
    this.log.push(record);
    const fail = (kind: ConstructorParameters<typeof ProviderError>[0], message: string, note = message, status: number | null = null): never => {
      record.error = note;
      record.ms = Math.round(performance.now() - started);
      this.options.onRequest?.(record);
      throw new ProviderError(kind, message, status);
    };
    const host = hostOf(this.endpoint);
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": USER_AGENT },
        body: JSON.stringify(rpc),
        // An MCP endpoint answers where it is asked; a redirect is refused, not followed.
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (isTimeout(error)) return fail("timeout", `No answer from the Developer Docs MCP (${host}) within ${this.options.timeoutMs} ms.`, `timed out after ${this.options.timeoutMs} ms`);
      return fail("upstream_unreachable", `Could not reach the Developer Docs MCP (${host}): ${messageOf(error)}.`, `network error: ${messageOf(error)}`);
    }
    record.status = response.status;
    record.contentType = response.headers.get("content-type");
    let body: string;
    try {
      body = await readCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (isTimeout(error)) return fail("timeout", `The Developer Docs MCP (${host}) stopped sending within ${this.options.timeoutMs} ms.`, "timed out reading the body");
      return fail("malformed_response", `The Developer Docs MCP response could not be read: ${messageOf(error)}`, messageOf(error));
    }
    record.bytes = Buffer.byteLength(body);
    record.sha256 = createHash("sha256").update(body).digest("hex");
    record.excerpt = body.slice(0, 1_200);
    record.body = body;
    if (response.status >= 300 && response.status < 400) {
      return fail("upstream_error", `The Developer Docs MCP redirected (HTTP ${response.status}) instead of answering.`, `HTTP ${response.status}`, response.status);
    }
    if (!response.ok) {
      // A JSON-RPC error in an error response says more than its status.
      let detail = "";
      try {
        const [message] = jsonRpcMessages(body, record.contentType);
        if (isRecord(message) && isRecord(message.error) && typeof message.error.message === "string") detail = `: ${message.error.message}`;
      } catch {
        // no JSON-RPC body; the status says enough
      }
      return fail("upstream_error", `The Developer Docs MCP (${host}) answered HTTP ${response.status}${detail}.`, `HTTP ${response.status}`, response.status);
    }
    let result: unknown;
    try {
      result = responseFor(jsonRpcMessages(body, record.contentType), rpc.id);
    } catch (error) {
      if (error instanceof ProviderError) return fail(error.kind, error.message);
      throw error;
    }
    record.ms = Math.round(performance.now() - started);
    this.options.onRequest?.(record);
    return result;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
