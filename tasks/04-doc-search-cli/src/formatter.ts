import { REASON_TEXT } from "./search.js";
import { stripControls } from "./text.js";
import type { RequestRecord, SearchResult, Source } from "./types.js";

// Plain text only: no colors, no cursor tricks, so the output reads the same in a terminal, a pipe, a
// log file or the browser terminal.

export function formatText(result: SearchResult): string {
  const lines: string[] = [];
  if (result.status === "answered") {
    lines.push("Answer", indent(stripControls(result.answer ?? "")), "", "Sources", ...sourceLines(result.sources));
  } else if (result.status === "no_answer") {
    lines.push("No good answer found in the Pharos Developer Docs.");
    if (result.reason) lines.push(indent(REASON_TEXT[result.reason]));
    if (result.suggestions.length > 0) {
      lines.push("", "Nearby documented topics", ...sourceLines(result.suggestions));
    }
    lines.push("", indent("Try rephrasing the question, or open one of the pages above."));
  } else {
    lines.push(`Error: ${result.error?.message ?? "unknown error"}`);
  }
  lines.push("", meta(result));
  return `${lines.join("\n")}\n`;
}

export function formatJson(result: SearchResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function sourceLines(sources: Source[]): string[] {
  return sources.flatMap((source, index) => [`${String(index + 1).padStart(2, "0")}  ${oneLine(source.title)}`, `    ${source.url}`]);
}

/** The last line: what answered, over what, how many requests, how long. */
function meta(result: SearchResult): string {
  const seconds = (result.meta.elapsedMs / 1000).toFixed(1);
  const requests = `${result.meta.requests} ${result.meta.requests === 1 ? "request" : "requests"}`;
  if (result.meta.transport === "docs-mcp") return `Developer Docs MCP (askQuestion) · ${requests} to ${endpointLabel(result.meta.endpoint)} · ${seconds} s`;
  const pages = result.meta.pagesConsulted.length;
  return `${pages} docs ${pages === 1 ? "page" : "pages"} asked · ${result.meta.requests} HTTPS ${result.meta.requests === 1 ? "request" : "requests"} to docs.pharos.xyz · ${seconds} s`;
}

/** "https://docs.pharos.xyz/~gitbook/mcp" -> "docs.pharos.xyz/~gitbook/mcp". */
function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.host}${url.pathname}`;
  } catch {
    return endpoint;
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `  ${line}` : ""))
    .join("\n");
}

/** Titles come from the network: one line, no control characters. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
}

/** One line per request, for --verbose. An MCP request names its JSON-RPC method and tool. */
export function formatRequest(record: RequestRecord): string {
  const size = record.bytes ? ` ${(record.bytes / 1024).toFixed(1)} kB` : "";
  const outcome = record.error ? ` ${record.error}` : ` ${record.status}${record.contentType ? ` ${record.contentType.split(";")[0]}` : ""}${size}`;
  const tool = record.rpc?.method === "tools/call" && typeof record.rpc.params?.name === "string" ? ` ${record.rpc.params.name}` : "";
  return `[${record.purpose}${tool}] ${record.method} ${record.url} ->${outcome} (${record.ms} ms)`;
}
