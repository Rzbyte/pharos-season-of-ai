import type { DocPage, ErrorKind, PageResponse, RequestRecord } from "../types.js";

/**
 * Where documentation comes from. Search, ranking, the source gate, the CLI, the web endpoint and the
 * output schema only ever talk to this interface, so the transport can change without touching them.
 *
 * Today there is one implementation, DocsHttpProvider: the official dynamic query interface of the
 * Pharos docs (GET https://docs.pharos.xyz/<page>.md?ask=<question>&goal=<goal>), over plain HTTPS.
 * When a public Developer Docs MCP endpoint and tool schema are documented, an McpDocsProvider can
 * implement the same two methods (list pages; ask one page) and be passed in instead.
 */
export interface DocsProvider {
  /** Short id shown in results: "docs-http". */
  readonly name: string;
  /** What actually carries the requests, stated plainly: "docs-http" (HTTPS GET) or, later, "mcp". */
  readonly transport: string;
  /** The docs index: every page the provider can ask about. */
  index(): Promise<DocPage[]>;
  /** Ask one page a question. Throws ProviderError when the page cannot be read. */
  ask(page: DocPage, question: string, goal: string): Promise<PageResponse>;
  /** Every request made so far, in order. */
  requests(): RequestRecord[];
}

/** A failure the search can explain: which kind, and whether it concerns one page or the whole run. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ErrorKind | "page_unavailable",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
