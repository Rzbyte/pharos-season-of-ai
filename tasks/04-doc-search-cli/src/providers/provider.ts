import type { DocPage, ErrorKind, PageResponse, RequestRecord } from "../types.js";

/**
 * Where answers come from. Search, the source gate, the CLI, the web endpoint and the output schema only
 * ever talk to these interfaces, so the transport can change without touching them.
 *
 * The canonical provider is DeveloperDocsMcpProvider: the Pharos Developer Docs MCP
 * (https://docs.pharos.xyz/~gitbook/mcp), whose askQuestion tool answers a question across the docs with
 * its source pages. It implements DocsAnswerProvider.
 *
 * DocsProvider (list pages; ask one page) is the shape of DocsHttpProvider, a development transport over
 * the docs' HTTP query interface. It is not MCP and is used only when asked for explicitly.
 */
export interface DocsProvider {
  /** Short id shown in results: "docs-http". */
  readonly name: string;
  /** What actually carries the requests, stated plainly: "docs-http" (HTTPS GET, not MCP). */
  readonly transport: string;
  /** The docs index: every page the provider can ask about. */
  index(): Promise<DocPage[]>;
  /** Ask one page a question. Throws ProviderError when the page cannot be read. */
  ask(page: DocPage, question: string, goal: string): Promise<PageResponse>;
  /** Every request made so far, in order. */
  requests(): RequestRecord[];
}

/** One answer to one question, as a docs-wide answering tool returned it, before the source gate. */
export interface DocsAnswer {
  /** The tool that answered ("askQuestion"). */
  tool: string;
  /** The whole text the tool returned. */
  text: string;
  /** The answer part: everything before its Sources section, without a restated question heading. */
  body: string;
  /** Links its Sources section lists (or, without one, the links in the answer itself), as given. The gate keeps official pages only. */
  sources: Array<{ title: string | null; url: string }>;
  /** Whether the text has a Sources section. */
  sourceSection: boolean;
}

/** A provider that answers a question across the whole docs with one call: the Developer Docs MCP. */
export interface DocsAnswerProvider {
  /** "developer-docs-mcp". */
  readonly name: string;
  /** "docs-mcp": MCP over Streamable HTTP. */
  readonly transport: string;
  /** Where its requests go. */
  readonly endpoint: string;
  /** Ask one question. Throws ProviderError when no answer could be obtained. */
  answer(question: string, goal: string): Promise<DocsAnswer>;
  /** Every request made so far, in order. */
  requests(): RequestRecord[];
}

export function answersQuestions(provider: DocsProvider | DocsAnswerProvider): provider is DocsAnswerProvider {
  return typeof (provider as DocsAnswerProvider).answer === "function";
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
