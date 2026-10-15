import { DOCS_HOST, MAX_ANSWER_CHARS, MAX_SOURCES, MAX_SUGGESTIONS } from "./constants.js";
import { docsPath, pageUrl } from "./docs-index.js";
import type { DocsAnswer } from "./providers/provider.js";
import { answerSegment, clip, hasValue, markdownBlocks, pageBody, plainInline, questionTerms, stripControls, terms, valueKind, type Block } from "./text.js";
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
  /** How strongly the response supports the question (for ordering multi-page answers). */
  score: number;
}

/** Judge one page response against the question. */
export function judge(response: PageResponse, question: string): Verdict {
  const { direct, related } = questionTerms(question);
  const kind = valueKind(question);
  // The text an answer may come from: a composed answer's own segment (no restated question heading,
  // no generated follow-up questions or navigation), or the page without any follow-up list.
  const retained = retainedText(response);
  // Sources are chosen by search(): the pages that were asked and whose answer is used. A page the
  // answer only links to was never read, so it is not a source (and neither is a generated follow-up).
  const fail = (reason: NoAnswerReason): Verdict => ({ ok: false, answer: null, reason, score: 0 });

  if (response.kind === "answer" || response.kind === "json") {
    // An answer the docs composed for this question: shown as given, if it is on topic and says something.
    if (saysNotInDocs(retained)) return fail("not_in_docs");
    const text = cleanAnswer(retained);
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
    return { ok: true, answer, reason: null, score: 10 + overlap };
  }

  // The page itself: answer with its best-matching passages, verbatim.
  const picked = bestPassages(markdownBlocks(retained), direct, related, kind, terms(response.page.title));
  if (!picked) return fail("weak_match");
  if (kind && !hasValue(picked.text, kind)) return fail("value_not_found");
  return { ok: true, answer: picked.text, reason: null, score: picked.score };
}

/** The part of a response an answer may be taken from. The proof verifier checks answers against it too. */
export function retainedText(response: Pick<PageResponse, "kind" | "text">): string {
  return response.kind === "page" ? pageBody(response.text) : answerSegment(response.text);
}

/**
 * Markdown answer -> compact plain text: headings dropped to plain lines, bullets kept as "- ", numbered
 * steps keep their numbers, and code lines kept as written (only the fences go), so a command keeps its
 * placeholders and indentation.
 */
export function cleanAnswer(text: string): string {
  let fence: string | null = null;
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence !== null) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return fence === null ? "" : stripControls(line).trimEnd();
      }
      if (marker) {
        fence = marker;
        return "";
      }
      const step = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (step) return `${step[1]}. ${plainInline(step[2]!)}`;
      const item = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (item) return `- ${plainInline(item[1]!)}`;
      if (/^\s*\{%.*%\}\s*$/.test(line)) return "";
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

// ---------------------------------------------------------------------------
// Combining the answers of several pages

/** Share of a statement's words found in one earlier statement for it to count as already said. */
export const SAME_STATEMENT = 0.8;

const VALUE_PATTERN = /0x[0-9a-f]+|https?:\/\/[^\s)]+|\d[\d,.]*\d|\d/gi;

interface Statement {
  line: number;
  text: string;
  words: Set<string>;
  values: string[];
}

/** An answer as statements: each line, with prose lines split into sentences. */
function statements(answer: string): Statement[] {
  return answer.split("\n").flatMap((line, index) =>
    line
      .trim()
      .split(/(?<=[.!?])\s+(?=[A-Z0-9`"'(\[])/)
      .filter((text) => text.trim() !== "")
      .map((text) => ({
        line: index,
        text,
        words: new Set(terms(text)),
        values: [...text.matchAll(VALUE_PATTERN)].map((m) => m[0].toLowerCase().replace(/,/g, "").replace(/[.,;:]+$/, "")),
      })),
  );
}

/**
 * Already said: every value in it was already shown, and at least SAME_STATEMENT of its words appear in
 * one earlier statement, or in two consecutive ones (the same text split into sentences differently).
 */
function alreadySaid(statement: Statement, kept: Statement[], keptValues: Set<string>): boolean {
  if (statement.values.some((value) => !keptValues.has(value))) return false;
  if (statement.words.size === 0) return statement.values.length > 0 || kept.some((k) => k.text.toLowerCase() === statement.text.toLowerCase());
  const share = (pool: Set<string>) => [...statement.words].filter((word) => pool.has(word)).length / statement.words.size;
  return kept.some((k, i) => share(k.words) >= SAME_STATEMENT || (i + 1 < kept.length && share(new Set([...k.words, ...kept[i + 1]!.words])) >= SAME_STATEMENT));
}

/**
 * Several pages' answers as one, each statement shown once. The first answer is shown whole; every later
 * one adds only its statements not already said (same values, and most of the same words, in an earlier
 * statement), kept verbatim and in order. A later answer with nothing new adds nothing. When only one
 * answer has anything to show it stands alone; otherwise each part is labelled with its page title.
 * Deterministic: text comparison only, in the order given.
 */
export function combineAnswers(parts: Array<{ title: string; answer: string }>): string {
  const kept: Statement[] = [];
  const keptValues = new Set<string>();
  const blocks: Array<{ title: string; text: string }> = [];
  for (const [index, part] of parts.entries()) {
    const fresh = statements(part.answer).filter((statement) => index === 0 || !alreadySaid(statement, kept, keptValues));
    for (const statement of fresh) {
      kept.push(statement);
      for (const value of statement.values) keptValues.add(value);
    }
    if (fresh.length === 0) continue;
    // Back to lines: statements from the same line rejoin with a space.
    const lines: string[] = [];
    let last = -1;
    for (const statement of fresh) {
      if (statement.line === last) lines[lines.length - 1] += ` ${statement.text}`;
      else lines.push(statement.text);
      last = statement.line;
    }
    blocks.push({ title: part.title, text: index === 0 ? part.answer : lines.join("\n") });
  }
  return blocks.length === 1 ? blocks[0]!.text : blocks.map(({ title, text }) => `${title}:\n${text}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// The Developer Docs MCP: one answer across the docs, with the sources it lists

/** The documentation as the subject of a sentence: "the (official) (Pharos) (Developer) docs / documentation". */
const DOCS = String.raw`(?:the\s+)?(?:official\s+)?(?:pharos\s+)?(?:developer\s+)?(?:(?:docs|documentation|knowledge\s+base)(?:\s+(?:site|pages?|portal))?|doc\s+pages?)`;
/** What an info-type "no ... about X" names: information, a guide, instructions, a page. */
const INFO = String.raw`(?:information|documentation|mention|guide|guidance|details|instructions|tutorial|page|section|reference)s?`;

/**
 * Statements that the documentation does not cover a question. Each one is about the docs (or the search
 * of them), never about the product, so a factual negative ("No. Pharos does not support X.") stays an
 * answer. Generic: no topic, product or question is named here.
 */
/** What the docs would do with a topic: cover it, mention it, document it. */
const COVER = String.raw`(?:cover|contain|mention|include|describe|document|explain|address|discuss|have|specify|reference|detail|provide)`;
/** "is not", "isn't", "are not", "aren't", "it's not", "they're not". */
const IS_NOT = String.raw`(?:\b(?:is|are|was|were)|'s|'re)(?:\s+not|n't)`;

const NON_COVERAGE = new RegExp(
  [
    // "The Pharos Developer Docs don't cover X", "the documentation does not mention X"
    String.raw`\b${DOCS}\s+(?:(?:currently|also)\s+)?(?:do|does|did)(?:\s+not|n't)\s+(?:(?:currently|appear\s+to|seem\s+to)\s+)?${COVER}\b`,
    // "The Pharos docs focus on EVM tooling and don't include X": the docs stay the subject
    String.raw`\b${DOCS}\s+(?:\w+\s+){1,8}?and\s+(?:do|does)(?:\s+not|n't)\s+${COVER}\b`,
    // "X is not covered in the docs", "it's not mentioned in the Pharos documentation"
    String.raw`${IS_NOT}\s+(?:(?:currently|explicitly)\s+)?(?:covered|mentioned|described|addressed|discussed|included|explained|specified|documented)\s+(?:anywhere\s+)?(?:in|by|within)\s+${DOCS}`,
    // "X is not documented"
    String.raw`${IS_NOT}\s+(?:(?:currently|explicitly)\s+)?documented\b`,
    // "The docs have no guide for X"
    String.raw`\b${DOCS}\s+(?:has|have|contains?|includes?)\s+no\s+(?:\w+\s+){0,2}?${INFO}\b`,
    // "There is no documentation about X", "there's no information on X", "there isn't any guide for X"
    String.raw`\bthere(?:\s+is|\s+are|'s)\s+no\s+(?:\w+\s+){0,2}?${INFO}\s+(?:about|on|for|regarding|covering|that|in)\b`,
    String.raw`\bthere\s+(?:is|are)(?:\s+not|n't)\s+any\s+(?:\w+\s+){0,2}?${INFO}\s+(?:about|on|for|regarding|covering|that|in)\b`,
    // "Nothing in the Pharos docs covers X"
    String.raw`\b(?:nothing|none)\s+(?:of\s+|in\s+)${DOCS}\s+(?:covers?|mentions?|describes?|explains?|addresses?|discusses?|documents?)\b`,
    // "I couldn't find anything about X", "I don't see any mention of X"
    String.raw`\bi\s+(?:could\s*not|couldn't|cannot|can't|did\s*not|didn't|was\s+unable\s+to|am\s+unable\s+to|wasn't\s+able\s+to)\s+(?:find|locate)\b`,
    String.raw`\bi\s+(?:do\s*not|don't)\s+see\s+(?:any|anything)\b`,
    // "outside the scope of the Pharos docs"
    String.raw`\boutside\s+(?:of\s+)?(?:the\s+)?scope\s+of\s+${DOCS}`,
  ].join("|"),
  "i",
);

/**
 * An answer's opening: its first sentence, and the second too when the first is only a short opener
 * with no value in it ("No.", "Unfortunately not.", "Short answer: no."). Typographic quotes become
 * plain ones, so "don’t" reads as "don't". A note about a gap in the docs after a real first sentence
 * ("It is X. The docs don't mention Y.") is not part of it.
 */
export function opening(text: string): string {
  const plain = text.replace(/[\u2018\u2019\u02bc\u2032]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
  const [first = "", second = ""] = plain.split(/(?<=[.!?])\s+/);
  const opener = second !== "" && first.split(" ").length <= 4 && !/\d/.test(first);
  return (opener ? `${first} ${second}` : first).slice(0, 400);
}

/** Whether an answer opens by saying the documentation does not cover what was asked. */
export function explicitNonCoverage(text: string): boolean {
  return NON_COVERAGE.test(opening(text));
}

export interface AnswerVerdict {
  status: "answered" | "no_answer";
  answer: string | null;
  sources: Source[];
  reason: NoAnswerReason | null;
  /** Pages the answer listed, offered as nearby topics when there is no answer. */
  suggestions: Source[];
}

/**
 * Judge one Developer Docs MCP answer against the question. Shown only when it is on topic, states the
 * kind of value asked for, and cites at least one docs.pharos.xyz page; its sources are the official
 * pages it gives (links in the answer, then its Sources list; the first MAX_SOURCES), nothing else. An
 * answer that opens by saying the docs do not cover the question is a no-answer, with the first pages it
 * listed as nearby topics.
 */
export function judgeAnswer(answer: DocsAnswer, question: string): AnswerVerdict {
  const official = dedupeSources(answer.sources);
  const text = cleanAnswer(answer.body);
  const none = (reason: NoAnswerReason, suggestions = official.slice(0, MAX_SUGGESTIONS)): AnswerVerdict => ({ status: "no_answer", answer: null, sources: [], reason, suggestions });
  if (explicitNonCoverage(text)) return none("not_in_docs");
  const { direct } = questionTerms(question);
  const words = new Set(terms(text));
  const titleWords = new Set(official.flatMap((source) => terms(source.title)));
  // The same bar as everywhere else: the answer (with the titles of the pages it cites) covers half the question's words.
  const covered = direct.filter((word) => words.has(word) || titleWords.has(word)).length;
  if (text.length < 15 || !coversEnough(covered, direct.length)) return none("weak_match");
  const kind = valueKind(question);
  if (kind && !hasValue(text, kind)) return none("value_not_found");
  if (official.length === 0) return none("unsourced", []);
  let shown = clip(text, MAX_ANSWER_CHARS);
  // A long answer that states the value past the clip point: show the lines that hold it instead.
  if (kind && !hasValue(shown, kind)) shown = clip(text.split("\n").filter((line) => hasValue(line, kind)).join("\n"), MAX_ANSWER_CHARS);
  return { status: "answered", answer: shown, sources: official.slice(0, MAX_SOURCES), reason: null, suggestions: [] };
}
