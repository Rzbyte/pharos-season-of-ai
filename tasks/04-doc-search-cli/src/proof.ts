import { DOCS_HOST, DOCS_ORIGIN, HARD_MAX_PAGES, TOOL_NAME } from "./constants.js";
import { docsPath } from "./docs-index.js";
import { GOAL } from "./search.js";
import { officialSourceUrl } from "./source-gate.js";
import type { RequestRecord, SearchResult } from "./types.js";

/** The three README examples: a simple fact, a multi-step workflow, and one the docs should not answer. */
export const PROOF_QUERIES = [
  { id: "a", label: "Simple factual query", question: "What is the chain ID of the Atlantic testnet?", expect: "answered" },
  { id: "b", label: "Multi-step developer workflow", question: "How do I set up Foundry and deploy a contract to the Atlantic testnet?", expect: "answered" },
  { id: "c", label: "Not covered by the docs", question: "How do I deploy an Anchor program to Solana?", expect: "no_answer" },
] as const;

export interface Transcript {
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

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const RESULT_KEYS = ["schema", "status", "question", "answer", "sources", "reason", "suggestions", "error", "meta"];

/**
 * Check one proof run from its own transcript: where every request went, what it asked, and whether the
 * answer's facts are in what the docs returned. Nothing here trusts the result's description of itself.
 */
export function verifyRun(transcript: Transcript, output: string, expect: string): Check[] {
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

  // Sources: official pages that were actually read in this run (or linked from what was read).
  const bodies = requests.filter((r) => r.purpose !== "index" && r.status === 200 && r.body);
  const readPages = new Set(bodies.map((r) => officialSourceUrl(`${DOCS_ORIGIN}${new URL(r.url).pathname}`)).filter(Boolean));
  const linked = new Set(bodies.flatMap((r) => [...(r.body ?? "").matchAll(/https:\/\/docs\.pharos\.xyz\/[^\s)<>"']+/g)].map((m) => officialSourceUrl(m[0]))).filter(Boolean));
  const badSources = result.sources.filter((s) => officialSourceUrl(s.url) !== s.url || !(readPages.has(s.url) || linked.has(s.url)));
  check(
    "sources are official pages read in this run",
    (result.status !== "answered" || result.sources.length > 0) && badSources.length === 0 && new Set(result.sources.map((s) => s.url)).size === result.sources.length,
    badSources.length ? `not read: ${badSources.map((s) => s.url).join(", ")}` : `${result.sources.length} unique docs.pharos.xyz sources`,
  );

  // Grounding: every number, hex value and URL in the answer appears verbatim in a fetched body,
  // and almost every word does too.
  if (result.status === "answered" && result.answer) {
    const corpus = bodies.map((r) => r.body!).join("\n");
    const lower = corpus.toLowerCase();
    const values = result.answer.match(/0x[0-9a-fA-F]+|\b\d[\d,.]*\d\b|\b\d\b|https?:\/\/[^\s)]+/g) ?? [];
    const missingValues = values.filter((value) => !corpus.includes(value) && !corpus.includes(value.replace(/,/g, "")));
    const titles = new Set(result.meta.pagesConsulted.flatMap((p) => p.title.toLowerCase().split(/\W+/)));
    const words = (result.answer.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !titles.has(w) && !["parameter", "value"].includes(w));
    const missingWords = words.filter((w) => !lower.includes(w));
    const share = words.length ? 1 - missingWords.length / words.length : 1;
    check(
      "answer grounded in the fetched docs",
      missingValues.length === 0 && share >= 0.9,
      missingValues.length ? `values not in any fetched body: ${missingValues.join(", ")}` : `${values.length} values and ${Math.round(share * 100)}% of words found verbatim in the fetched pages`,
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
