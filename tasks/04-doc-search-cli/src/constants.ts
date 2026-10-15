export const TOOL_NAME = "pharos-docs";
export const VERSION = "1.0.0";

/** The official Pharos Developer Docs. Every source this tool shows is a page on this origin. */
export const DOCS_ORIGIN = "https://docs.pharos.xyz";
export const DOCS_HOST = "docs.pharos.xyz";

/** The docs' own page list, in markdown. The ranking reads it; it is never answered from. */
export const SITEMAP_PATH = "/sitemap.md";

/**
 * Pages queried per question: one by default, a few when the question has several parts.
 * The whole corpus (llms-full.txt) is never pulled for a question.
 */
export const DEFAULT_MAX_PAGES = 2;
export const HARD_MAX_PAGES = 3;

/** Per request. The ask endpoint may compose an answer, so it gets more time than a plain page. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Largest response body read; anything longer is rejected as malformed, not truncated silently. */
export const MAX_RESPONSE_BYTES = 2_000_000;
/** The docs index is reused for this long (disk cache for the CLI, memory for the web endpoint). */
export const INDEX_TTL_MS = 6 * 60 * 60 * 1000;

/** Longest question accepted. */
export const MAX_QUESTION_CHARS = 300;
/** Longest answer shown: a few sentences or rows, never a page dump. */
export const MAX_ANSWER_CHARS = 700;

/** Sent with every request so the docs operator can tell this tool apart. */
export const USER_AGENT = `${TOOL_NAME}/${VERSION} (+https://github.com/Rzbyte/pharos-season-of-ai)`;
