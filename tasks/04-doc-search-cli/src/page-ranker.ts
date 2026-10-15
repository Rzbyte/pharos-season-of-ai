import { DEFAULT_MAX_PAGES, HARD_MAX_PAGES } from "./constants.js";
import { questionTerms, terms } from "./text.js";
import type { DocPage, RankedPage } from "./types.js";

/** Below this, a page is not related enough to ask. */
export const MIN_PAGE_SCORE = 2.5;

/**
 * Score every page in the index for a question. Deterministic, from the page's title, path and section:
 *
 *   question word in the title   3      documented synonym in the title   1.5
 *   question word in the path    2      documented synonym in the path    1
 *   question word in the section 1      documented synonym in the section 0.5
 *
 * The topic words of a how-to verb (deploy -> foundry, hardhat) count like the question's own words.
 *
 * Each word counts once per field. Deeper, more specific pages win ties over overviews
 * (a small bonus per path segment), so "the smallest relevant page" is asked first.
 */
export function rankPages(question: string, pages: DocPage[]): RankedPage[] {
  const { direct, related, intent } = questionTerms(question);
  if (direct.length === 0) return [];
  const ranked = pages.map((page) => {
    const title = new Set(terms(page.title));
    const path = new Set(terms(page.path.replace(/\//g, " ")));
    const section = new Set(terms(page.section ?? ""));
    let score = 0;
    const matched = new Set<string>();
    for (const [words, weight] of [[direct, 1], [intent, 1], [related, 0.5]] as const) {
      for (const word of words) {
        let hit = 0;
        if (title.has(word)) hit += 3 * weight;
        if (path.has(word)) hit += 2 * weight;
        if (section.has(word)) hit += 1 * weight;
        if (hit > 0) matched.add(word);
        score += hit;
      }
    }
    const depth = page.path.split("/").filter(Boolean).length;
    if (score > 0) score += Math.min(depth, 4) * 0.05;
    return { ...page, score: Math.round(score * 100) / 100, matched: [...matched] };
  });
  return ranked.filter((page) => page.score > 0).sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
}

/** A question with more than one part ("set up X and deploy Y", "steps to …"), which may need two pages. */
export function isMultiPart(question: string): boolean {
  return /\b(and then|then|after that|steps?|workflow|end[- ]to[- ]end|from scratch|both)\b/i.test(question) || /\band\b.+\b(on|to|with)\b/i.test(question);
}

/**
 * The pages to ask, best first: one by default. A second (or third, up to `maxPages`) only when the
 * question has several parts, or when another page scores nearly as high, and only if it clears the
 * minimum score. Never the whole corpus.
 */
export function choosePages(question: string, ranked: RankedPage[], maxPages = DEFAULT_MAX_PAGES): RankedPage[] {
  const limit = Math.max(1, Math.min(maxPages, HARD_MAX_PAGES));
  const eligible = ranked.filter((page) => page.score >= MIN_PAGE_SCORE);
  if (eligible.length === 0) return [];
  const [best, ...rest] = eligible;
  const chosen = [best!];
  const multi = isMultiPart(question);
  const { direct } = questionTerms(question);
  const covered = (word: string) => chosen.some((other) => other.matched.includes(word));
  for (const page of rest) {
    if (chosen.length >= limit) break;
    // Another page only when it adds something: for a multi-part question, one of the question's own
    // words no chosen page covers ("set up Foundry and deploy to Atlantic" -> Atlantic, then Foundry);
    // otherwise, a near-tie that matches a word the first page did not.
    const addsQuestionWord = page.matched.some((word) => direct.includes(word) && !covered(word));
    const addsAnything = page.matched.some((word) => !covered(word));
    if ((multi && addsQuestionWord) || (page.score >= best!.score * 0.85 && addsAnything)) chosen.push(page);
  }
  return chosen;
}

/** Nearby documented topics for a no-answer result: the best-scoring pages, whether or not they cleared the bar. */
export function nearbyTopics(ranked: RankedPage[], count = 3): RankedPage[] {
  return ranked.slice(0, count);
}
