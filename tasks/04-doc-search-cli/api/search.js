// Vercel function behind the docs search page: GET /api/search?q=<question>.
//
// It runs the same search core and the same canonical provider as the CLI (dist/src, compiled from src/
// during `npm ci`): the Pharos Developer Docs MCP at https://docs.pharos.xyz/~gitbook/mcp, one JSON-RPC
// tools/call askQuestion per question (POST, Streamable HTTP), after a tools/list check that askQuestion
// is offered. The MCP answers stateless POSTs, so nothing has to live between invocations; a verified
// tool list is only remembered on a warm instance to save a request. There is no other transport here and
// no fallback: an MCP failure is a 502 with the reason.
// The endpoint is fixed here and nothing is read from the environment, so a deployment setting cannot
// point it anywhere else.
import { MAX_QUESTION_CHARS, MCP_ENDPOINT, TOOLS_TTL_MS } from "../dist/src/constants.js";
import { DeveloperDocsMcpProvider } from "../dist/src/providers/developer-docs-mcp.js";
import { checkQuestion, search } from "../dist/src/search.js";

/** Per MCP request. Two requests at most per question (tools/list on a cold instance, askQuestion) stay within the function's 60 s. */
const TIMEOUT_MS = 25_000;

/** The verified tool list, kept between requests on a warm instance. */
const memo = new Map();

/** One question. Tests pass a local fake MCP endpoint. Returns { status, body }. */
export async function answer(question, { mcpUrl = MCP_ENDPOINT, timeoutMs = TIMEOUT_MS } = {}) {
  const problem = typeof question === "string" ? checkQuestion(question) : "Ask a question with ?q=.";
  if (problem) return { status: 400, body: { schema: "pharos-docs-result/1", status: "error", question: String(question ?? ""), error: { kind: "usage", message: problem } } };
  // One provider per question: it reuses a remembered tool list, or lists the tools itself (and that
  // request is counted in the result like any other).
  const hit = memo.get(mcpUrl);
  const fresh = hit && Date.now() - hit.at < TOOLS_TTL_MS ? hit.tools : undefined;
  const provider = new DeveloperDocsMcpProvider({ endpoint: mcpUrl, timeoutMs, tools: fresh });
  const result = await search(question, { provider });
  if (result.status === "error") memo.delete(mcpUrl);
  else if (!fresh && provider.verifiedTools()) memo.set(mcpUrl, { at: Date.now(), tools: provider.verifiedTools() });
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

/** The deployed handler: always the official Developer Docs MCP. */
export default createHandler();
