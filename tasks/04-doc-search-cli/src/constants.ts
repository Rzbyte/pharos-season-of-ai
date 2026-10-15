export const TOOL_NAME = "pharos-docs";
export const VERSION = "1.0.0";

/** The official Pharos Developer Docs. Every source this tool shows is a page on this origin. */
export const DOCS_ORIGIN = "https://docs.pharos.xyz";
export const DOCS_HOST = "docs.pharos.xyz";

/**
 * The Pharos Developer Docs MCP: the MCP server the docs site itself publishes. Streamable HTTP: JSON-RPC
 * 2.0 requests are POSTed here and answered as a text/event-stream of `event: message` frames. This is
 * the canonical transport of pharos-docs ("docs-mcp").
 */
export const MCP_ENDPOINT = `${DOCS_ORIGIN}/~gitbook/mcp`;
/** The MCP tool every question goes to: a natural-language question in, an answer with its source pages out. */
export const ASK_TOOL = "askQuestion";
/** Per MCP request. askQuestion composes its answer on the server, so it gets more time than a page read. */
export const MCP_TIMEOUT_MS = 30_000;
/** How long a verified tool list (tools/list) is reused: disk cache for the CLI, memory for the web endpoint. */
export const TOOLS_TTL_MS = 6 * 60 * 60 * 1000;

/** The docs' own page list, in markdown (docs-http development transport only). */
export const SITEMAP_PATH = "/sitemap.md";

/**
 * Pages queried per question: one by default, a few when the question has several parts.
 * The whole corpus (llms-full.txt) is never pulled for a question.
 */
export const DEFAULT_MAX_PAGES = 2;
export const HARD_MAX_PAGES = 3;

/** Per request, docs-http development transport. The ask endpoint may compose an answer, so it gets more time than a plain page. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Largest response body read; anything longer is rejected as malformed, not truncated silently. */
export const MAX_RESPONSE_BYTES = 2_000_000;
/** The docs index is reused for this long (disk cache for the CLI, memory for the web endpoint). */
export const INDEX_TTL_MS = 6 * 60 * 60 * 1000;

/** Longest question accepted. */
export const MAX_QUESTION_CHARS = 300;
/** Longest answer shown: a few sentences or rows, never a page dump. */
export const MAX_ANSWER_CHARS = 700;
/**
 * Most sources shown with a Developer Docs MCP answer, and most pages offered as nearby topics with a
 * no-answer. askQuestion can list many pages; the first ones (pages the answer links to, then its
 * Sources list, in order) are shown, and none is ever added.
 */
export const MAX_SOURCES = 5;
export const MAX_SUGGESTIONS = 3;

/** Sent with every request so the docs operator can tell this tool apart. */
export const USER_AGENT = `${TOOL_NAME}/${VERSION} (+https://github.com/Rzbyte/pharos-season-of-ai)`;
