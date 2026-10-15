import { createHash } from "node:crypto";
import { DEFAULT_TIMEOUT_MS, DOCS_ORIGIN, MAX_RESPONSE_BYTES, SITEMAP_PATH, USER_AGENT } from "../constants.js";
import { parseSitemap } from "../docs-index.js";
import { answerSegment, htmlToText, linksIn } from "../text.js";
import type { DocPage, PageResponse, RequestRecord } from "../types.js";
import { ProviderError, type DocsProvider } from "./provider.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DocsHttpOptions {
  /**
   * Where requests go. Always https://docs.pharos.xyz except in tests, which point it at a local fake
   * server; sources are still the docs.pharos.xyz URLs of the pages, so a test can never pass one off
   * as official, and the proof verifier refuses any request to another host.
   */
  fetchOrigin?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Pre-loaded index (from the CLI's disk cache, or the web endpoint's memory). */
  index?: DocPage[];
  onRequest?: (record: RequestRecord) => void;
}

/**
 * The official dynamic documentation query interface of the Pharos docs, over HTTPS:
 *
 *   GET https://docs.pharos.xyz/sitemap.md                               the page list
 *   GET https://docs.pharos.xyz/<page>.md?ask=<question>&goal=<goal>     one page, asked one question
 *   GET https://docs.pharos.xyz/<page>                                   the HTML page, only if the .md is missing
 *
 * These are plain HTTP requests to the public docs site. They are not MCP calls.
 */
export class DocsHttpProvider implements DocsProvider {
  readonly name = "docs-http";
  readonly transport = "docs-http";
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly log: RequestRecord[] = [];
  private cachedIndex: DocPage[] | undefined;

  constructor(private readonly options: DocsHttpOptions = {}) {
    this.origin = (options.fetchOrigin ?? DOCS_ORIGIN).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.cachedIndex = options.index;
  }

  requests(): RequestRecord[] {
    return [...this.log];
  }

  /** Whether the last index() call was served without a request. */
  get indexFromCache(): boolean {
    return this.options.index !== undefined && this.log.every((record) => record.purpose !== "index");
  }

  async index(): Promise<DocPage[]> {
    if (this.cachedIndex) return this.cachedIndex;
    let body: Fetched;
    try {
      body = await this.get(`${this.origin}${SITEMAP_PATH}`, "index");
    } catch (error) {
      if (error instanceof ProviderError) throw new ProviderError(error.kind === "page_unavailable" ? "index_unavailable" : error.kind, `Could not read the docs index (${SITEMAP_PATH}): ${error.message}`, error.status);
      throw error;
    }
    const pages = parseSitemap(body.text);
    if (pages.length === 0) throw new ProviderError("malformed_response", `The docs index (${SITEMAP_PATH}) listed no pages.`);
    this.cachedIndex = pages;
    return pages;
  }

  /** The exact request for one page and question: the markdown page with ?ask= and &goal=. */
  askUrl(page: DocPage, question: string, goal: string): string {
    return `${this.origin}${page.path}.md?ask=${encodeURIComponent(question)}&goal=${encodeURIComponent(goal)}`;
  }

  async ask(page: DocPage, question: string, goal: string): Promise<PageResponse> {
    const requestUrl = this.askUrl(page, question, goal);
    let fetched: Fetched | null = null;
    try {
      fetched = await this.get(requestUrl, "ask");
    } catch (error) {
      // Only a missing markdown page falls back to the HTML page; timeouts and server errors do not.
      if (!(error instanceof ProviderError) || error.kind !== "page_unavailable") throw error;
    }
    // A JSON body is always parsed (and rejected if malformed); a text body needs some content.
    if (fetched && (meaningful(fetched.text) || /json/i.test(fetched.contentType ?? ""))) return this.read(page, requestUrl, fetched, "md-ask");

    const htmlUrl = `${this.origin}${page.path}`;
    const html = await this.get(htmlUrl, "html-fallback");
    if (!meaningful(html.text)) throw new ProviderError("page_unavailable", `${page.url} has no readable content.`);
    return this.read(page, htmlUrl, html, "html");
  }

  private read(page: DocPage, requestUrl: string, fetched: Fetched, via: PageResponse["via"]): PageResponse {
    return interpret(page, requestUrl, fetched.text, fetched.contentType, via);
  }

  private async get(url: string, purpose: RequestRecord["purpose"]): Promise<Fetched> {
    const started = performance.now();
    const record: RequestRecord = { seq: this.log.length + 1, method: "GET", url, purpose, status: null, contentType: null, bytes: 0, ms: 0, sha256: null, excerpt: null, body: null, error: null };
    this.log.push(record);
    const finish = () => {
      record.ms = Math.round(performance.now() - started);
      this.options.onRequest?.(record);
    };
    let response: Response;
    try {
      // Redirects are followed by hand, at most 3, and never off the docs site: an off-site Location is
      // refused without being requested.
      const signal = AbortSignal.timeout(this.timeoutMs);
      let target = url;
      for (let hop = 0; ; hop += 1) {
        response = await this.fetchImpl(target, {
          method: "GET",
          headers: { accept: "text/markdown, text/plain;q=0.9, application/json;q=0.8, text/html;q=0.5", "user-agent": USER_AGENT },
          redirect: "manual",
          signal,
        });
        const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (!location) break;
        const next = new URL(location, target).href;
        await response.body?.cancel().catch(() => undefined);
        // Same origin only: another host, or the same host over plain http, is refused.
        if (new URL(next).origin !== new URL(url).origin || hop >= 3) {
          record.status = response.status;
          record.error = hop >= 3 ? "too many redirects" : `redirected off the docs site to ${new URL(next).origin}`;
          finish();
          throw new ProviderError("malformed_response", hop >= 3 ? `${url} redirected too many times.` : `${url} redirected to ${next}, outside the docs site.`);
        }
        target = next;
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      record.error = timedOut ? `timed out after ${this.timeoutMs} ms` : `network error: ${messageOf(error)}`;
      finish();
      throw new ProviderError(timedOut ? "timeout" : "upstream_unreachable", timedOut ? `No answer from ${hostOf(url)} within ${this.timeoutMs} ms.` : `Could not reach ${hostOf(url)} (${messageOf(error)}).`);
    }
    record.status = response.status;
    record.contentType = response.headers.get("content-type");
    if (response.status === 404 || response.status === 410) {
      record.error = `HTTP ${response.status}`;
      finish();
      throw new ProviderError("page_unavailable", `HTTP ${response.status} for ${url}.`, response.status);
    }
    if (!response.ok) {
      record.error = `HTTP ${response.status}`;
      finish();
      throw new ProviderError(response.status >= 500 || response.status === 429 ? "upstream_error" : "page_unavailable", `${hostOf(url)} answered HTTP ${response.status}.`, response.status);
    }
    let text: string;
    try {
      text = await readCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      record.error = timedOut ? `timed out reading the body` : messageOf(error);
      finish();
      throw new ProviderError(timedOut ? "timeout" : "malformed_response", timedOut ? `${hostOf(url)} stopped sending within ${this.timeoutMs} ms.` : messageOf(error));
    }
    record.bytes = Buffer.byteLength(text);
    record.sha256 = createHash("sha256").update(text).digest("hex");
    record.excerpt = text.slice(0, 1_200);
    if (purpose !== "index") record.body = text;
    finish();
    return { text, contentType: record.contentType };
  }
}

interface Fetched {
  text: string;
  contentType: string | null;
}

/**
 * How a fetched body is read: a JSON answer, a composed Markdown answer, or the page itself. Pure, so the
 * proof verifier reads a saved body exactly the way the search did.
 */
export function interpret(page: DocPage, requestUrl: string, body: string, contentType: string | null, via: PageResponse["via"]): PageResponse {
  const type = contentType ?? "";
  if (/json/i.test(type)) {
    const parsed = parseJsonBody(body);
    return { page, requestUrl, kind: "json", via, text: parsed.text, links: linksIn(answerSegment(parsed.text), page.url), declaredSources: parsed.sources };
  }
  const html = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body);
  const text = html ? htmlToText(body) : body.trim();
  // An HTML page is the page itself, never an answer composed for the question.
  const kind = via === "html" || html ? "page" : classify(text, page);
  // A composed answer cites only what its own answer segment links to; generated follow-up questions
  // and navigation after it are not where the answer came from.
  return { page, requestUrl, kind, via, text, links: linksIn(kind === "page" ? text : answerSegment(text), page.url), declaredSources: [] };
}

/** At least a few words of real content: an empty or whitespace body counts as no page. */
function meaningful(text: string): boolean {
  return text.replace(/\s+/g, "").length >= 20;
}

/**
 * A body is "page" content when it reads like the page itself (front matter, the page's own title as
 * its first heading, or long); otherwise it is a short "answer" composed for the question.
 */
export function classify(text: string, page: DocPage): "answer" | "page" {
  if (/^---\n/.test(text)) return "page";
  const firstHeading = /^\s*#\s+(.+)$/m.exec(text)?.[1];
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (firstHeading && norm(firstHeading) === norm(page.title)) return "page";
  // Long means a page, but generated follow-up questions after a short answer do not make it one.
  if (answerSegment(text).length > 3_000) return "page";
  return "answer";
}

/** A JSON body: its answer text, and any sources it lists. Anything else is malformed. */
export function parseJsonBody(body: string): { text: string; sources: Array<{ title: string | null; url: string }> } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ProviderError("malformed_response", "The docs answered with JSON that does not parse.");
  }
  const record = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const text = record ? [record.answer, record.text, record.content, record.markdown].find((value): value is string => typeof value === "string" && value.trim() !== "") : undefined;
  if (!text) throw new ProviderError("malformed_response", "The docs answered with JSON that has no answer text.");
  const listed = record ? [record.sources, record.references, record.links].find(Array.isArray) ?? [] : [];
  const sources = (listed as unknown[])
    .map((entry) => {
      if (typeof entry === "string") return { title: null, url: entry };
      if (entry && typeof entry === "object") {
        const { url, href, title } = entry as Record<string, unknown>;
        const link = typeof url === "string" ? url : typeof href === "string" ? href : null;
        return link ? { title: typeof title === "string" ? title : null, url: link } : null;
      }
      return null;
    })
    .filter((entry): entry is { title: string | null; url: string } => entry !== null);
  return { text: text.trim(), sources };
}

async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error(`The response is ${declared} bytes; the limit is ${max}.`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`The response is larger than ${max} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function messageOf(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return error instanceof Error ? `${error.message}${cause}` : String(error);
}
