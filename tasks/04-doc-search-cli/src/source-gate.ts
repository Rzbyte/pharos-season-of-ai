import { DOCS_HOST, MAX_ANSWER_CHARS } from "./constants.js";
import { docsPath, pageUrl } from "./docs-index.js";
import { clip, hasValue, markdownBlocks, plainInline, questionTerms, stripControls, terms, valueKind, type Block } from "./text.js";
import type { NoAnswerReason, PageResponse, Source } from "./types.js";

// The source-first gate. An answer is shown only when it can be traced to text the official docs
// returned for this question; otherwise the result is "no answer" with the reason. Nothing is filled in
// from memory: there is no model here, and no value (chain ID, address, endpoint, gas figure) exists in
// this code to fill in with.

/** Phrases with which a docs answer says the docs do not cover the question. */
const NOT_IN_DOCS = new RegExp(
  [
    "\\bi (?:could ?n[o']t|can ?n[o']t|cannot|was unable to|am unable to|did not|didn't) find\\b",
    "\\bno (?:relevant |specific |such )?(?:information|mention|details|documentation|results?)\\b",
    "\\b(?:is|are) not (?:mentioned|covered|documented|specified|provided|available|included)\\b",
    "\\b(?:does|do)(?: not|n't) (?:contain|mention|cover|provide|specify|include|describe)\\b",
    "\\bunable to (?:find|answer|locate)\\b",
    "\\boutside (?:the|of the) scope\\b",
    "\\bi don't know\\b|\\bi do not know\\b",
    "\\bnot enough information\\b",
  ].join("|"),
  "i",
);

export function saysNotInDocs(text: string): boolean {
  return NOT_IN_DOCS.test(text.slice(0, 600));
}

/** Only an https page on docs.pharos.xyz can be a source. Returns its canonical page URL, or null. */
export function officialSourceUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== DOCS_HOST || parsed.port !== "" || parsed.username || parsed.password) return null;
  const path = docsPath(parsed.href);
  return path ? pageUrl(path) : null;
}

/** Official sources only, each page once (by canonical URL), in first-seen order. */
export function dedupeSources(sources: Array<{ title: string | null; url: string }>, titles: Map<string, string> = new Map()): Source[] {
  const seen = new Map<string, Source>();
  for (const source of sources) {
    const url = officialSourceUrl(source.url);
    if (!url || seen.has(url)) continue;
    const title = titles.get(url) ?? (source.title ? plainInline(source.title) : null) ?? titleFromUrl(url);
    seen.set(url, { title: title || titleFromUrl(url), url });
  }
  return [...seen.values()];
}

function titleFromUrl(url: string): string {
  const last = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "Pharos Docs";
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export interface Verdict {
  ok: boolean;
  /** The grounded answer text (verbatim from the response, lightly cleaned), when ok. */
  answer: string | null;
  reason: NoAnswerReason | null;
  /** Extra official sources the response itself pointed to. */
  sources: Source[];
  /** How strongly the response supports the question (for ordering multi-page answers). */
  score: number;
}

/** Judge one page response against the question. */
export function judge(response: PageResponse, question: string): Verdict {
  const { direct, related } = questionTerms(question);
  const kind = valueKind(question);
  // Extra sources only from a composed answer (its links and declared sources). A full page's links
  // (navigation, "next page", see-also) are not where the answer comes from, so they are not sources.
  const extra =
    response.kind === "page" ? [] : dedupeSources([...response.declaredSources, ...response.links.map((url) => ({ title: null, url }))]).filter((source) => source.url !== response.page.url);
  const fail = (reason: NoAnswerReason): Verdict => ({ ok: false, answer: null, reason, sources: [], score: 0 });

  if (response.kind === "answer" || response.kind === "json") {
    // An answer the docs composed for this question: shown as given, if it is on topic and says something.
    if (saysNotInDocs(response.text)) return fail("not_in_docs");
    const text = cleanAnswer(response.text);
    const words = new Set(terms(text));
    const titleWords = new Set(terms(response.page.title));
    const overlap = direct.filter((word) => words.has(word)).length + related.filter((word) => words.has(word)).length * 0.5;
    // The same bar as a page passage: the answer (with the page title) covers half the question's words.
    const covered = direct.filter((word) => words.has(word) || titleWords.has(word)).length;
    if (text.length < 15 || !coversEnough(covered, direct.length)) return fail("weak_match");
    if (kind && !hasValue(text, kind)) return fail("value_not_found");
    let answer = clip(text, MAX_ANSWER_CHARS);
    // A long answer that states the value past the clip point: show the lines that hold it instead.
    if (kind && !hasValue(answer, kind)) answer = clip(text.split("\n").filter((line) => hasValue(line, kind)).join("\n"), MAX_ANSWER_CHARS);
    return { ok: true, answer, reason: null, sources: extra, score: 10 + overlap };
  }

  // The page itself: answer with its best-matching passages, verbatim.
  const picked = bestPassages(markdownBlocks(response.text), direct, related, kind, terms(response.page.title));
  if (!picked) return fail("weak_match");
  if (kind && !hasValue(picked.text, kind)) return fail("value_not_found");
  return { ok: true, answer: picked.text, reason: null, sources: extra, score: picked.score };
}

/** Markdown answer -> compact plain text: headings dropped to plain lines, list markers kept as "- ". */
export function cleanAnswer(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .map((line) => {
      const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (item) return `- ${plainInline(item[1]!)}`;
      if (/^\s*(```|~~~)/.test(line) || /^\s*\{%.*%\}\s*$/.test(line)) return "";
      return plainInline(line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*>\s?/, ""));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Score every block of the page; return the best one plus up to two close runners-up, in page order,
 * within the answer length. Null when nothing covers enough of the question.
 *
 * A block scores 2 per question word it contains and 1 per documented synonym; words of the heading it
 * sits under count half. For a value question (chain ID, address, endpoint, number), a block that holds
 * a value of that kind gets +3, and the best such block is preferred. The best block must cover at
 * least half of the question's words (counting its heading and the page title), or at least two of
 * them for long questions.
 */
export function bestPassages(blocks: Block[], direct: string[], related: string[], kind: ReturnType<typeof valueKind>, pageTitle: string[] = []): { text: string; score: number } | null {
  if (direct.length === 0) return null;
  // Words the page title already establishes ("Atlantic Testnet") count as covered, not as score.
  const titleWords = new Set(pageTitle);
  const scored = blocks
    .map((block, index) => {
      if (block.kind === "heading") return null;
      const words = new Set(terms(block.text));
      const headingWords = new Set(terms(block.heading ?? ""));
      const covered = direct.filter((word) => words.has(word) || headingWords.has(word) || titleWords.has(word));
      const score =
        direct.filter((word) => words.has(word)).length * 2 +
        related.filter((word) => words.has(word)).length +
        direct.filter((word) => !words.has(word) && headingWords.has(word)).length +
        (kind && hasValue(block.text, kind) ? 3 : 0);
      return { block, index, score, covered: covered.length };
    })
    .filter((entry): entry is { block: Block; index: number; score: number; covered: number } => entry !== null && entry.score > 0);
  if (scored.length === 0) return null;
  const ordered = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
  // A value question is answered by the best passage that holds such a value, when one does.
  const best = (kind ? ordered.find((entry) => hasValue(entry.block.text, kind)) : undefined) ?? ordered[0]!;
  if (!coversEnough(best.covered, direct.length)) return null;

  const chosen = [best];
  for (const entry of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (chosen.length >= 3) break;
    if (entry === best || entry.score < best.score * 0.6) continue;
    // For a value question, extra passages must hold a value of that kind too, or they are only context.
    if (kind && !hasValue(entry.block.text, kind)) continue;
    chosen.push(entry);
  }
  // Fill the length budget best first (the best passage always goes in), then show in page order.
  const kept: typeof chosen = [];
  let length = 0;
  for (const entry of chosen) {
    const size = render(entry.block).length + 1;
    if (kept.length > 0 && length + size > MAX_ANSWER_CHARS) continue;
    kept.push(entry);
    length += size;
  }
  kept.sort((a, b) => a.index - b.index);
  // A single row or item stands on its own, without a list dash.
  const lines = kept.map(({ block }) => (kept.length === 1 && (block.kind === "row" || block.kind === "item") ? block.text : render(block)));
  return { text: clip(lines.join("\n"), MAX_ANSWER_CHARS), score: best.score };
}

/** Half of the question's words, or two of them for a long question. */
function coversEnough(covered: number, total: number): boolean {
  return covered >= Math.ceil(total / 2) || (total >= 4 && covered >= 2);
}

function render(block: Block): string {
  if (block.kind === "code") return stripControls(block.text).split("\n").slice(0, 6).join("\n");
  if (block.kind === "item" || block.kind === "row") return `- ${block.text}`;
  return block.text;
}
