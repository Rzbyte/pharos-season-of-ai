import { DEFAULT_MAX_PAGES, DOCS_ORIGIN, MAX_ANSWER_CHARS, MAX_QUESTION_CHARS, TOOL_NAME, VERSION } from "./constants.js";
import { choosePages, nearbyTopics, rankPages } from "./page-ranker.js";
import { answersQuestions, ProviderError, type DocsAnswer, type DocsAnswerProvider, type DocsProvider } from "./providers/provider.js";
import { combineAnswers, dedupeSources, judge, judgeAnswer, type Verdict } from "./source-gate.js";
import { clip } from "./text.js";
import type { ErrorKind, NoAnswerReason, PageResponse, RankedPage, SearchResult, Source } from "./types.js";

/** askQuestion's goal, with every question: the goal the live Developer Docs MCP was verified with. */
export const MCP_GOAL = "Answer a developer question using the Pharos Developer Docs";
/** docs-http development transport only: passed as &goal= with every question. */
export const GOAL = "A concise, factual answer for a developer, using only the Pharos documentation, with the page it comes from.";

export interface SearchOptions {
  /** The Developer Docs MCP (canonical), or the docs-http development transport when asked for explicitly. */
  provider: DocsAnswerProvider | DocsProvider;
  /** docs-http only: pages asked per question. */
  maxPages?: number;
  /** Called with the MCP answer as received, before the gate (the CLI's transcript records it). */
  onAnswer?: (answer: DocsAnswer) => void;
}

/** Why a question was refused before any request. */
export function checkQuestion(input: string): string | null {
  const question = input.trim();
  if (!question) return "Ask a question, for example: pharos-docs \"how do I deploy a contract?\"";
  if (question.length > MAX_QUESTION_CHARS) return `Keep the question under ${MAX_QUESTION_CHARS} characters.`;
  if (!/\p{L}/u.test(question)) return "The question needs at least one word.";
  return null;
}

/**
 * The canonical path (the Developer Docs MCP): question -> askQuestion -> the source gate -> one result
 * with the official pages the answer cites. An MCP failure is an error result; nothing falls back to
 * another transport.
 *
 * The docs-http development path: question -> docs index -> the smallest relevant page(s) -> each asked
 * with ?ask= -> the source gate -> one result with its sources. At most `maxPages` pages are asked.
 *
 * Never throws: failures come back as status "error" or "no_answer".
 */
export async function search(input: string, options: SearchOptions): Promise<SearchResult> {
  const started = performance.now();
  const question = input.trim().replace(/\s+/g, " ");
  const { provider } = options;
  const consulted: SearchResult["meta"]["pagesConsulted"] = [];
  // Built field by field, so every result has the same keys in the same order.
  const result = (fields: Partial<SearchResult> & Pick<SearchResult, "status">): SearchResult => ({
    schema: "pharos-docs-result/1",
    status: fields.status,
    question,
    answer: fields.answer ?? null,
    sources: fields.sources ?? [],
    reason: fields.reason ?? null,
    suggestions: fields.suggestions ?? [],
    error: fields.error ?? null,
    meta: {
      tool: TOOL_NAME,
      version: VERSION,
      provider: provider.name,
      transport: provider.transport,
      endpoint: answersQuestions(provider) ? provider.endpoint : DOCS_ORIGIN,
      pagesConsulted: consulted,
      requests: provider.requests().length,
      elapsedMs: Math.round(performance.now() - started),
    },
  });

  const problem = checkQuestion(input);
  if (problem) return result({ status: "error", error: { kind: "usage", message: problem } });

  if (answersQuestions(provider)) {
    let answer: DocsAnswer;
    try {
      answer = await provider.answer(question, MCP_GOAL);
    } catch (error) {
      return result({ status: "error", error: toError(error) });
    }
    options.onAnswer?.(answer);
    const verdict = judgeAnswer(answer, question);
    return result({ status: verdict.status, answer: verdict.answer, sources: verdict.sources, reason: verdict.reason, suggestions: verdict.suggestions });
  }

  let ranked: RankedPage[];
  try {
    ranked = rankPages(question, await provider.index());
  } catch (error) {
    return result({ status: "error", error: toError(error) });
  }
  const pages = choosePages(question, ranked, options.maxPages ?? DEFAULT_MAX_PAGES);
  const suggestions = nearbyTopics(ranked).map(({ title, url }) => ({ title, url }));
  if (pages.length === 0) {
    return result({ status: "no_answer", reason: "no_matching_page", suggestions });
  }

  const titles = new Map(ranked.map((page) => [page.url, page.title]));
  const answered: Array<{ page: RankedPage; verdict: Verdict }> = [];
  const reasons: NoAnswerReason[] = [];
  let lastError: ReturnType<typeof toError> | null = null;
  for (const page of pages) {
    let response: PageResponse;
    try {
      response = await provider.ask(page, question, GOAL);
    } catch (error) {
      const failure = toError(error);
      consulted.push({ title: page.title, url: page.url, requestUrl: "", kind: null, outcome: failure.kind });
      if (error instanceof ProviderError && error.kind === "page_unavailable") reasons.push("page_unavailable");
      else lastError = failure;
      continue;
    }
    const verdict = judge(response, question);
    consulted.push({ title: page.title, url: page.url, requestUrl: response.requestUrl, kind: response.kind, outcome: verdict.ok ? "used" : (verdict.reason ?? "not used") });
    if (verdict.ok) answered.push({ page, verdict });
    else if (verdict.reason) reasons.push(verdict.reason);
  }

  if (answered.length === 0) {
    // Every page failed for a transport reason: that is an error, not a statement about the docs.
    if (lastError && reasons.length === 0) return result({ status: "error", error: lastError, suggestions });
    return result({ status: "no_answer", reason: pickReason(reasons), suggestions });
  }

  // Best first (ties keep the ranked page order), each statement once across pages.
  answered.sort((a, b) => b.verdict.score - a.verdict.score || pages.indexOf(a.page) - pages.indexOf(b.page));
  const answer =
    answered.length === 1
      ? answered[0]!.verdict.answer!
      : clip(combineAnswers(answered.map(({ page, verdict }) => ({ title: page.title, answer: verdict.answer! }))), MAX_ANSWER_CHARS * answered.length);
  // Sources: the pages asked whose answer supports what is shown, in the same order. A page whose answer
  // repeated another's still stated it, so it stays a source; pages only linked to were never read.
  const sources: Source[] = dedupeSources(
    answered.map(({ page }) => ({ title: page.title, url: page.url })),
    titles,
  );
  return result({ status: "answered", answer, sources });
}

/** The most telling reason when several pages each fell short. */
function pickReason(reasons: NoAnswerReason[]): NoAnswerReason {
  for (const reason of ["value_not_found", "not_in_docs", "weak_match", "page_unavailable", "no_matching_page"] as const) {
    if (reasons.includes(reason)) return reason;
  }
  return "weak_match";
}

function toError(error: unknown): { kind: ErrorKind; message: string } {
  if (error instanceof ProviderError) {
    const kind = error.kind === "page_unavailable" ? "upstream_error" : error.kind;
    return { kind, message: error.message };
  }
  return { kind: "unexpected", message: error instanceof Error ? error.message : String(error) };
}

/** Plain-language reason for a no-answer result. */
export const REASON_TEXT: Record<NoAnswerReason, string> = {
  no_matching_page: "No page in the Pharos Developer Docs matches this question.",
  page_unavailable: "The matching docs page could not be read.",
  not_in_docs: "The Pharos Developer Docs say they do not cover this.",
  weak_match: "The docs do not answer this question directly.",
  value_not_found: "The docs do not state this value, and values are never filled in from memory.",
  unsourced: "The docs answered without citing a docs.pharos.xyz page, so the answer is not shown.",
};
