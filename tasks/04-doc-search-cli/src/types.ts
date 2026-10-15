/** One page of the official docs, as the index lists it. */
export interface DocPage {
  title: string;
  /** Path on the docs site without extension, e.g. "/getting-started/network/atlantic-testnet". */
  path: string;
  /** The page's human URL on docs.pharos.xyz: what a reader opens. */
  url: string;
  /** Nearest heading above the entry in the index, when there is one ("Getting Started"). */
  section: string | null;
}

export interface RankedPage extends DocPage {
  score: number;
  /** Question terms (or their documented synonyms) found in the title, path or section. */
  matched: string[];
}

/**
 * What one page query returned, normalized. `kind` says how the body was read:
 * - "answer": a short answer composed by the docs host for this question;
 * - "page": the page's own content (markdown, or HTML reduced to text);
 * - "json": a structured body; its text field becomes `text`.
 */
export interface PageResponse {
  page: DocPage;
  requestUrl: string;
  kind: "answer" | "page" | "json";
  /** How it was fetched: the markdown page with ?ask=, or the HTML page as a fallback. */
  via: "md-ask" | "html";
  text: string;
  /** Links found in the body, absolute. Only docs.pharos.xyz ones can become sources. */
  links: string[];
  /** Links in a "json" body's own sources/references field. */
  declaredSources: Array<{ title: string | null; url: string }>;
}

export interface Source {
  title: string;
  url: string;
}

export type SearchStatus = "answered" | "no_answer" | "error";

export type NoAnswerReason =
  | "no_matching_page"
  | "page_unavailable"
  | "not_in_docs"
  | "weak_match"
  | "value_not_found";

export type ErrorKind = "usage" | "index_unavailable" | "timeout" | "upstream_unreachable" | "upstream_error" | "malformed_response" | "unexpected";

/** The one result shape the CLI (text and --json), the web endpoint and the proof all use. */
export interface SearchResult {
  schema: "pharos-docs-result/1";
  status: SearchStatus;
  question: string;
  answer: string | null;
  sources: Source[];
  /** Why there is no answer (status "no_answer"). */
  reason: NoAnswerReason | null;
  /** Nearby documented topics worth trying (status "no_answer"). */
  suggestions: Source[];
  error: { kind: ErrorKind; message: string } | null;
  meta: {
    tool: string;
    version: string;
    /** "docs-http" today: the official dynamic docs query interface over HTTPS, not MCP. */
    transport: string;
    pagesConsulted: Array<{ title: string; url: string; requestUrl: string; kind: PageResponse["kind"] | null; outcome: string }>;
    requests: number;
    elapsedMs: number;
  };
}

/** One HTTP request a provider made, for --verbose and the proof transcript. */
export interface RequestRecord {
  seq: number;
  method: "GET";
  url: string;
  purpose: "index" | "ask" | "html-fallback";
  status: number | null;
  contentType: string | null;
  bytes: number;
  ms: number;
  /** sha256 of the body, so a saved excerpt can be tied to the exact response. */
  sha256: string | null;
  /** First part of the body (the index), for the proof transcript. */
  excerpt: string | null;
  /** The whole body of a page request (ask or HTML fallback), so the proof can check every answer against it. */
  body: string | null;
  error: string | null;
}
