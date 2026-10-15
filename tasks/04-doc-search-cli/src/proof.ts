import { ASK_TOOL, DOCS_HOST, DOCS_ORIGIN, HARD_MAX_PAGES, MCP_ENDPOINT, TOOL_NAME } from "./constants.js";
import { docsPath, pageUrl } from "./docs-index.js";
import { askTool, parseToolList, toolText, type McpTool } from "./providers/developer-docs-mcp.js";
import { interpret } from "./providers/docs-http.js";
import { jsonRpcMessages, responseFor } from "./providers/mcp-http.js";
import type { DocsAnswer } from "./providers/provider.js";
import { GOAL, MCP_GOAL } from "./search.js";
import { judgeAnswer, officialSourceUrl, retainedText } from "./source-gate.js";
import { answerAndSources } from "./text.js";
import type { RequestRecord, SearchResult } from "./types.js";

/** The three README examples, asked of the Developer Docs MCP: a fact, a how-to, and one the docs do not cover. */
export const PROOF_QUERIES = [
  { id: "a", label: "Simple factual query", question: "What is the Atlantic chain ID?", expect: "answered" },
  { id: "b", label: "Procedural how-to query", question: "How do I deploy a contract with Foundry?", expect: "answered" },
  { id: "c", label: "Not covered by the docs", question: "How do I deploy an Anchor program to Solana?", expect: "no_answer" },
] as const;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const RESULT_KEYS = ["schema", "status", "question", "answer", "sources", "reason", "suggestions", "error", "meta"];

// ---------------------------------------------------------------------------
// The canonical proof: runs through the Pharos Developer Docs MCP

/** What `pharos-docs --transcript` saves for a run through the Developer Docs MCP. */
export interface McpTranscript {
  format: string;
  tool: { name: string; version: string };
  provider: string;
  transport: string;
  endpoint: string;
  toolsFromCache: boolean;
  tools: McpTool[] | null;
  /** The tool every question goes to: askQuestion. */
  selectedTool: string;
  startedAt: string;
  finishedAt: string;
  argv: string[];
  requests: RequestRecord[];
  answer: DocsAnswer | null;
  result: SearchResult;
}

/**
 * Check one MCP proof run from its own transcript: every request a JSON-RPC POST to the official Developer
 * Docs MCP, the tools listed live with askQuestion among them, askQuestion called once with the question,
 * every saved response well formed, and the result exactly what the saved askQuestion response gives
 * through the source gate, recomputed here from the saved bytes. Nothing trusts the result's own account.
 */
export function verifyMcpRun(transcript: McpTranscript, output: string, expect: string): Check[] {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => void checks.push({ name, ok, detail });
  const { requests, result } = transcript;

  check("transcript", transcript.format === "pharos-docs-mcp-transcript/1" && transcript.tool?.name === TOOL_NAME, `${transcript.format}, ${transcript.tool?.name} ${transcript.tool?.version}`);
  const ids = requests.map((r) => r.rpc?.id);
  check(
    "official Developer Docs MCP only",
    transcript.endpoint === MCP_ENDPOINT && requests.length > 0 && requests.every((r) => r.method === "POST" && r.url === MCP_ENDPOINT && r.rpc?.jsonrpc === "2.0") && new Set(ids).size === ids.length,
    `${requests.length} JSON-RPC POST requests, all to ${MCP_ENDPOINT}`,
  );
  check(
    "transport stated as MCP",
    transcript.transport === "docs-mcp" && transcript.provider === "developer-docs-mcp" && result.meta.transport === "docs-mcp" && result.meta.provider === "developer-docs-mcp" && result.meta.endpoint === MCP_ENDPOINT,
    `provider "${result.meta.provider}", transport "${result.meta.transport}", endpoint ${result.meta.endpoint}`,
  );

  // Every saved response re-read: a JSON-RPC answer with its request's id, no error.
  const results = new Map<RequestRecord, unknown>();
  const unreadable: string[] = [];
  for (const r of requests) {
    try {
      if (r.status !== 200 || r.body === null || !r.rpc) throw new Error(`HTTP ${r.status}`);
      results.set(r, responseFor(jsonRpcMessages(r.body, r.contentType), r.rpc.id));
    } catch (error) {
      unreadable.push(`#${r.seq} ${r.rpc?.method ?? "?"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  check("JSON-RPC responses well formed", unreadable.length === 0, unreadable.length ? unreadable.join("; ") : `${requests.length} responses, each a JSON-RPC result for its own request id`);

  const list = requests[0];
  let tools: McpTool[] | null = null;
  try {
    tools = list?.rpc?.method === "tools/list" ? parseToolList(results.get(list)) : null;
    if (tools) askTool(tools);
  } catch {
    tools = null;
  }
  check(
    "tools listed live, askQuestion offered",
    !transcript.toolsFromCache && tools !== null && JSON.stringify(tools) === JSON.stringify(transcript.tools),
    tools ? `tools/list -> ${tools.map((tool) => tool.name).join(", ")}` : "no live tools/list with a usable askQuestion",
  );

  const calls = requests.filter((r) => r.rpc?.method === "tools/call");
  const call = calls[0];
  const args = (call?.rpc?.params?.arguments ?? {}) as Record<string, unknown>;
  check(
    "askQuestion called once, with the question",
    transcript.selectedTool === ASK_TOOL && calls.length === 1 && call?.rpc?.params?.name === ASK_TOOL && args.question === result.question && (args.goal === undefined || args.goal === MCP_GOAL),
    call ? `tools/call ${String(call.rpc?.params?.name)} { question: ${JSON.stringify(args.question)}${args.goal !== undefined ? ", goal" : ""} }` : "no tools/call",
  );

  check("result schema", JSON.stringify(Object.keys(result)) === JSON.stringify(RESULT_KEYS) && result.schema === "pharos-docs-result/1", Object.keys(result).join(", "));
  check(`status is ${expect}`, result.status === expect, `status ${result.status}${result.reason ? ` (${result.reason})` : ""}`);

  // The answer as the gate saw it, recomputed from the saved askQuestion response.
  let derived: DocsAnswer | null = null;
  try {
    const text = toolText(call ? results.get(call) : undefined);
    derived = { tool: ASK_TOOL, text, ...answerAndSources(text) };
  } catch {
    derived = null;
  }
  const verdict = derived ? judgeAnswer(derived, result.question) : null;
  const same =
    verdict !== null &&
    JSON.stringify(derived) === JSON.stringify(transcript.answer) &&
    JSON.stringify([verdict.status, verdict.answer, verdict.sources, verdict.reason, verdict.suggestions]) === JSON.stringify([result.status, result.answer, result.sources, result.reason, result.suggestions]);
  check("result recomputed from the saved MCP response", same, same ? "the saved askQuestion text gives exactly this answer, sources and status through the gate" : "the saved response does not give this result");

  if (result.status === "answered") {
    const listed = new Set((derived?.sources ?? []).map((source) => officialSourceUrl(source.url)).filter(Boolean));
    const bad = result.sources.filter((source) => officialSourceUrl(source.url) !== source.url || !listed.has(source.url));
    check(
      "sources are official pages the answer lists",
      result.sources.length > 0 && bad.length === 0 && new Set(result.sources.map((source) => source.url)).size === result.sources.length,
      bad.length ? `not listed by the answer, or not a docs page: ${bad.map((source) => source.url).join(", ")}` : `${result.sources.length} docs.pharos.xyz ${result.sources.length === 1 ? "page" : "pages"}, each listed in the MCP answer`,
    );
  } else {
    check("no answer invented", result.answer === null && result.sources.length === 0 && result.reason !== null, result.reason ? `reason ${result.reason}` : "no reason");
  }

  const printed = result.status === "answered" ? result.sources.every((s) => output.includes(s.url)) && output.startsWith("Answer\n") : output.startsWith("No good answer found in the Pharos Developer Docs.");
  check("saved output matches the result", printed, result.status === "answered" ? "Answer and every source URL printed" : "the no-answer message printed");
  return checks;
}

// ---------------------------------------------------------------------------
// The docs-http development transport (not MCP): its transcripts, as archived under proof/archive/

export interface HttpTranscript {
  format: string;
  tool: { name: string; version: string };
  transport: string;
  fetchOrigin: string;
  indexFromCache: boolean;
  startedAt: string;
  finishedAt: string;
  argv: string[];
  requests: RequestRecord[];
  result: SearchResult;
}

/**
 * Check one docs-http run from its own transcript: where every request went, what it asked, and whether
 * the answer's facts are in what the docs returned. Nothing here trusts the result's description of itself.
 */
export function verifyHttpRun(transcript: HttpTranscript, output: string, expect: string): Check[] {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => void checks.push({ name, ok, detail });
  const { requests, result } = transcript;

  check("transcript", transcript.format === "pharos-docs-transcript/1" && transcript.tool?.name === TOOL_NAME, `${transcript.format}, ${transcript.tool?.name} ${transcript.tool?.version}`);
  check(
    "official docs only",
    transcript.fetchOrigin === DOCS_ORIGIN && requests.length > 0 && requests.every((r) => r.method === "GET" && new URL(r.url).protocol === "https:" && new URL(r.url).hostname === DOCS_HOST),
    `${requests.length} HTTPS GET requests, all to ${DOCS_HOST}`,
  );
  check("transport stated as HTTP, not MCP", transcript.transport === "docs-http" && result.meta.transport === "docs-http", `transport "${transcript.transport}"`);

  const index = requests[0];
  check("index read live", !transcript.indexFromCache && index?.purpose === "index" && new URL(index.url).pathname === "/sitemap.md" && index.status === 200, index ? `${index.url} -> ${index.status}` : "no index request");

  const asks = requests.filter((r) => r.purpose === "ask");
  const question = result.question;
  const badAsks = asks.filter((r) => {
    const url = new URL(r.url);
    const path = url.pathname.replace(/\.md$/, "");
    return !url.pathname.endsWith(".md") || docsPath(url.pathname) !== path || r.url !== `${DOCS_ORIGIN}${path}.md?ask=${encodeURIComponent(question)}&goal=${encodeURIComponent(GOAL)}`;
  });
  check(
    "?ask= requests well formed and bounded",
    asks.length >= 1 && asks.length <= HARD_MAX_PAGES && badAsks.length === 0,
    badAsks.length ? `malformed: ${badAsks.map((r) => r.url).join(", ")}` : `${asks.length} page ${asks.length === 1 ? "query" : "queries"}: ${asks.map((r) => new URL(r.url).pathname).join(", ")}`,
  );

  check("result schema", JSON.stringify(Object.keys(result)) === JSON.stringify(RESULT_KEYS) && result.schema === "pharos-docs-result/1", Object.keys(result).join(", "));
  check(`status is ${expect}`, result.status === expect, `status ${result.status}${result.reason ? ` (${result.reason})` : ""}`);

  // Each page body as the search read it (same parser, same segmentation), recomputed from the saved bytes.
  const bodies = requests.filter((r) => r.purpose !== "index" && r.status === 200 && r.body);
  const readings = bodies.flatMap((r) => {
    const path = docsPath(new URL(r.url).pathname);
    if (!path) return [];
    const url = pageUrl(path);
    const title = result.meta.pagesConsulted.find((p) => officialSourceUrl(p.url) === url)?.title ?? "";
    try {
      const response = interpret({ title, path, url, section: null }, r.url, r.body!, r.contentType, r.purpose === "html-fallback" ? "html" : "md-ask");
      return [{ response, retained: retainedText(response) }];
    } catch {
      return [];
    }
  });

  // Sources: pages asked in this run, each once. A page only linked to (in an answer, or in its generated
  // follow-up questions) was never read, so it is not a source.
  const asked = new Set(readings.map(({ response }) => response.page.url));
  const badSources = result.sources.filter((s) => officialSourceUrl(s.url) !== s.url || !asked.has(s.url));
  check(
    "sources are pages asked in this run",
    (result.status !== "answered" || result.sources.length > 0) && badSources.length === 0 && new Set(result.sources.map((s) => s.url)).size === result.sources.length,
    badSources.length ? `not asked in this run: ${badSources.map((s) => s.url).join(", ")}` : `${result.sources.length} unique docs.pharos.xyz sources, each a page asked`,
  );

  // Grounding: every number, hex value and URL in the answer appears verbatim both in a fetched body and
  // in the part of it an answer may come from (not a restated question or a generated follow-up), and
  // almost every word appears in that part too.
  if (result.status === "answered" && result.answer) {
    const raw = bodies.map((r) => r.body!).join("\n");
    const corpus = readings.map(({ retained }) => retained).join("\n");
    const lower = corpus.toLowerCase();
    const values = result.answer.match(/0x[0-9a-fA-F]+|\b\d[\d,.]*\d\b|\b\d\b|https?:\/\/[^\s)]+/g) ?? [];
    const verbatim = (text: string, value: string) => text.includes(value) || text.includes(value.replace(/,/g, ""));
    const missingValues = values.filter((value) => !verbatim(corpus, value) || !verbatim(raw, value));
    const titles = new Set(result.meta.pagesConsulted.flatMap((p) => p.title.toLowerCase().split(/\W+/)));
    const words = (result.answer.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !titles.has(w) && !["parameter", "value"].includes(w));
    const missingWords = words.filter((w) => !lower.includes(w));
    const share = words.length ? 1 - missingWords.length / words.length : 1;
    check(
      "answer grounded in the fetched docs",
      missingValues.length === 0 && share >= 0.9,
      missingValues.length
        ? `values not in the retained answer text of any fetched body: ${missingValues.join(", ")}`
        : `${values.length} values and ${Math.round(share * 100)}% of words found verbatim in the retained answer text of the fetched bodies`,
    );
  } else {
    check("no answer invented", result.answer === null && result.sources.length === 0, result.reason ? `reason ${result.reason}` : "no answer");
  }

  const printed = result.status === "answered" ? result.sources.every((s) => output.includes(s.url)) && output.startsWith("Answer\n") : output.startsWith("No good answer found in the Pharos Developer Docs.");
  check("saved output matches the result", printed, result.status === "answered" ? "Answer and every source URL printed" : "the no-answer message printed");
  return checks;
}

// ---------------------------------------------------------------------------
// README

export interface Example {
  id: string;
  label: string;
  question: string;
  output: string;
}

export function applyProof(readme: string, examples: Example[], json: string, summary: string[]): string {
  let next = replaceBetween(readme, "<!-- proof-status:start -->", "<!-- proof-status:end -->", summary.join("\n"));
  for (const example of examples) {
    const block = [`**${example.label}**`, "", "```console", `$ pharos-docs "${example.question}"`, example.output.replace(/\s+$/, ""), "```"].join("\n");
    next = replaceBetween(next, `<!-- example-${example.id}:start -->`, `<!-- example-${example.id}:end -->`, block);
  }
  next = replaceBetween(next, "<!-- json-example:start -->", "<!-- json-example:end -->", ["```console", `$ pharos-docs "${examples[0]!.question}" --json`, json.replace(/\s+$/, ""), "```"].join("\n"));
  return next.replace(/^(\s*)- \[ \](.*<!-- req-examples -->)/m, "$1- [x]$2");
}

function replaceBetween(text: string, start: string, end: string, content: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) throw new Error(`README is missing ${start} ... ${end}`);
  return `${text.slice(0, from + start.length)}\n${content}\n${text.slice(to)}`;
}
