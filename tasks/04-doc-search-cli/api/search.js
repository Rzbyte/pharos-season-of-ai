// Vercel function behind the browser terminal: GET /api/search?q=<question>.
//
// It runs the same search core and the same provider as the CLI (dist/src, compiled from src/ during
// `npm ci`), so the browser terminal and `pharos-docs "<question>"` return the same result schema from
// the same requests: HTTPS GET to https://docs.pharos.xyz (sitemap.md, then <page>.md?ask=...). Not MCP.
// The docs origin is fixed here and nothing is read from the environment, so a deployment setting
// cannot point it anywhere else.
import { DOCS_ORIGIN, INDEX_TTL_MS, MAX_QUESTION_CHARS } from "../dist/src/constants.js";
import { DocsHttpProvider } from "../dist/src/providers/docs-http.js";
import { checkQuestion, search } from "../dist/src/search.js";

/** The docs index, kept between requests on a warm instance. */
const memo = new Map();

/** One question. Tests pass a local fake docs origin. Returns { status, body }. */
export async function answer(question, { fetchOrigin = DOCS_ORIGIN, timeoutMs = 20_000 } = {}) {
  const problem = typeof question === "string" ? checkQuestion(question) : "Ask a question with ?q=.";
  if (problem) return { status: 400, body: { schema: "pharos-docs-result/1", status: "error", question: String(question ?? ""), error: { kind: "usage", message: problem } } };
  // One provider per question: it reuses a remembered index, or reads it itself (and that request is
  // counted in the result like any other), so a failing index is tried once, not twice.
  const hit = memo.get(fetchOrigin);
  const fresh = hit && Date.now() - hit.at < INDEX_TTL_MS ? hit.pages : undefined;
  const provider = new DocsHttpProvider({ fetchOrigin, timeoutMs, index: fresh });
  const result = await search(question, { provider });
  if (!fresh && result.status !== "error") {
    const pages = await provider.index().catch(() => null);
    if (pages) memo.set(fetchOrigin, { at: Date.now(), pages });
  }
  const status = result.status === "error" ? (result.error?.kind === "usage" ? 400 : 502) : 200;
  return { status, body: result };
}

export function createHandler(options = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" }).end('{"status":"error","error":{"kind":"usage","message":"Use GET /api/search?q=<question>."}}\n');
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const question = (url.searchParams.get("q") ?? "").slice(0, MAX_QUESTION_CHARS + 1);
    let status;
    let body;
    try {
      ({ status, body } = await answer(question, options));
    } catch (error) {
      [status, body] = [500, { status: "error", error: { kind: "unexpected", message: error instanceof Error ? error.message : String(error) } }];
    }
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      // Docs change rarely: a good answer is shared at the edge for a few minutes. Errors never are.
      "cache-control": status === 200 ? "public, s-maxage=300, stale-while-revalidate=600" : "no-store",
    });
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  };
}

/** The deployed handler: always the official docs site. */
export default createHandler();
