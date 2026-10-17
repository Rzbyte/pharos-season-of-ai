// A stand-in for the Pharos Developer Docs MCP, for tests: a local HTTP server that answers JSON-RPC
// tools/call POSTs the way the live endpoint does (Task 04's proof, tasks/04-doc-search-cli/proof): an
// event stream of one `message` event, or plain JSON when asked. The answers and pages are made up for
// each test, in the shape the docs answer; nothing here is or claims to be the Pharos docs.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeDocs {
  url: string;
  requests: { name: string; arguments: Record<string, unknown> }[];
  /** The answer askQuestion gives a question. */
  answer: (question: string) => string;
  /** getPage's pages, by URL; any other URL is the tool's error. */
  pages: Record<string, string>;
  /** Answer with plain JSON instead of an event stream. */
  json: boolean;
  /** Answer every request with this HTTP status. */
  status?: number;
  close(): Promise<void>;
}

export async function startFakeDocs(answer: (question: string) => string, pages: Record<string, string> = {}): Promise<FakeDocs> {
  const docs: FakeDocs = { url: "", requests: [], answer, pages, json: false, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (docs.status) return res.writeHead(docs.status).end("unavailable");
      const { id, params } = JSON.parse(body) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
      docs.requests.push(params);
      const text = params.name === "askQuestion" ? docs.answer(String(params.arguments.question)) : params.name === "getPage" ? docs.pages[String(params.arguments.url)] : undefined;
      const result = text === undefined ? { content: [{ type: "text", text: `No page at ${String(params.arguments.url)}` }], isError: true } : { content: [{ type: "text", text }] };
      const message = JSON.stringify({ result, jsonrpc: "2.0", id });
      if (docs.json) res.writeHead(200, { "content-type": "application/json" }).end(message);
      else res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${message}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  docs.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/~gitbook/mcp`;
  return docs;
}
