// In-process stand-in for the Pharos Developer Docs MCP (https://docs.pharos.xyz/~gitbook/mcp), used by
// the tests. Its wire format is the one verified against the live endpoint:
//
//   GET                       405 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}
//   POST tools/list           text/event-stream: "event: message" / "data: <JSON-RPC response>"
//   POST tools/call           askQuestion { question, goal? } -> one text content item: the answer, then
//                             "# Sources" and "- [Title](https://docs.pharos.xyz/...)" lines
//
// Every answer, value and page below is MADE UP for testing (for example the chain ID 424242): none of it
// is Pharos data, and none of it is ever used as an answer outside the tests.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The tools the live server lists (names, descriptions and inputs as verified; JSON Schema form). */
export const TOOLS = [
  {
    name: "searchDocumentation",
    description: "Search across docs.pharos.xyz and return relevant information, code examples, API references, guides, contextual content, titles and direct links.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "getPage",
    description: "Fetch the full markdown content of a documentation page from docs.pharos.xyz.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "askQuestion",
    description: "Ask a natural-language question about docs.pharos.xyz and receive a synthesized answer with links to source pages.",
    inputSchema: { type: "object", properties: { question: { type: "string" }, goal: { type: "string" } }, required: ["question"] },
  },
  // Listed by the live server; pharos-docs never calls it. Its input is not modelled here.
  { name: "sendFeedback", description: "Send feedback about the documentation (fixture).", inputSchema: { type: "object", properties: {} } },
];

/** Fixture answers in the verified askQuestion shape. */
export const ANSWERS = {
  chainId: `The Atlantic testnet chain ID is 424242 (test fixture).

# Sources

- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
`,
  foundry: `To deploy a contract with Foundry (test fixture):

1. Install Foundry with foundryup.
2. Deploy it with forge create, passing the network RPC URL and your private key:

\`\`\`bash
forge create src/Counter.sol:Counter --rpc-url $RPC_URL --private-key $PRIVATE_KEY
\`\`\`

# Sources

- [Foundry](https://docs.pharos.xyz/developer-guide/foundry)
- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
`,
  hardhat: `Hardhat is another way to compile and deploy contracts (test fixture).

# Sources

- [Hardhat](https://docs.pharos.xyz/developer-guide/hardhat)
`,
  /** A truthful negative about the docs, with nearby pages: the verified shape for an unsupported question. */
  notCovered: `No. The Pharos Developer Docs don’t cover this topic (test fixture).

# Sources

- [Overview](https://docs.pharos.xyz/getting-started/overview)
- [Foundry](https://docs.pharos.xyz/developer-guide/foundry)
`,
  /** A negative answer about the product, not the docs: still an answer. */
  factualNo: `No. Pharos does not support fixture blobs; transactions carry calldata only (test fixture).

# Sources

- [Gas Model](https://docs.pharos.xyz/getting-started/gas-model)
`,
};

/** Which fixture a question gets: by its words, the way a test asks them. */
function fixtureFor(question: string): string {
  if (/chain\s*id/i.test(question)) return ANSWERS.chainId;
  if (/foundry|deploy a contract/i.test(question)) return ANSWERS.foundry;
  if (/hardhat/i.test(question)) return ANSWERS.hardhat;
  if (/fixture blobs/i.test(question)) return ANSWERS.factualNo;
  return ANSWERS.notCovered;
}

export type Mode =
  | "normal"
  | "hang" // never answers
  | "http-500"
  | "redirect"
  | "plain-text" // 200 text/plain
  | "json-response" // 200 application/json instead of an event stream
  | "notification-first" // a notification event before the response in the stream
  | "no-message" // a stream with only a comment and no message event
  | "bad-data" // a message event whose data is not JSON
  | "wrong-id" // the response carries another id
  | "rpc-error" // a JSON-RPC error response
  | "not-jsonrpc" // "jsonrpc": "1.0"
  | "no-content" // a tools/call result without content
  | "is-error" // a tool error (isError: true)
  | "huge" // a body over the size limit
  | "no-ask-tool" // tools/list without askQuestion
  | "ask-requires-more"; // askQuestion requires an input pharos-docs does not send

export interface FakeMcp {
  /** The endpoint: http://127.0.0.1:<port>/~gitbook/mcp */
  url: string;
  requests: Array<{ httpMethod: string; accept: string | null; contentType: string | null; rpc: { jsonrpc?: unknown; id: unknown; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null }>;
  /** Behaviour of every following request (or only tools/call, with `only`). */
  set(mode: Mode, only?: "tools/call" | "tools/list"): void;
  /** The answer text askQuestion returns for the next calls, instead of the fixture. */
  answer(text: string | null): void;
  reset(): void;
  close(): Promise<void>;
}

const sse = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;

export async function startFakeMcp(): Promise<FakeMcp> {
  let mode: Mode = "normal";
  let only: "tools/call" | "tools/list" | undefined;
  let override: string | null = null;
  const requests: FakeMcp["requests"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname !== "/~gitbook/mcp") return void res.writeHead(404).end("Not found");
    if (req.method !== "POST") {
      requests.push({ httpMethod: req.method ?? "", accept: null, contentType: null, rpc: null });
      return void res.writeHead(405, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}');
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      let rpc: FakeMcp["requests"][number]["rpc"] = null;
      try {
        rpc = JSON.parse(raw);
      } catch {
        // recorded as null; answered below as a parse error
      }
      requests.push({ httpMethod: "POST", accept: req.headers.accept ?? null, contentType: req.headers["content-type"] ?? null, rpc });
      if (!rpc) return void res.writeHead(400, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}');
      const active: Mode = !only || only === rpc.method ? mode : "normal";
      const id = rpc.id;
      const stream = (body: string) => res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).end(body);

      if (active === "hang") return;
      if (active === "http-500") return void res.writeHead(500, { "content-type": "text/plain" }).end("Internal error");
      if (active === "redirect") return void res.writeHead(307, { location: "https://elsewhere.invalid/mcp" }).end();
      if (active === "plain-text") return void res.writeHead(200, { "content-type": "text/plain" }).end("hello");
      if (active === "huge") return void res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${"x".repeat(2_100_000)}\n\n`);
      if (active === "no-message") return stream(": keep-alive\n\n");
      if (active === "bad-data") return stream("event: message\ndata: {not json\n\n");
      if (active === "rpc-error") return stream(sse({ jsonrpc: "2.0", id, error: { code: -32603, message: "Fixture failure" } }));
      if (active === "wrong-id") return stream(sse({ jsonrpc: "2.0", id: 999, result: {} }));
      if (active === "not-jsonrpc") return stream(sse({ jsonrpc: "1.0", id, result: {} }));

      let result: unknown;
      if (rpc.method === "tools/list") {
        const tools =
          active === "no-ask-tool"
            ? TOOLS.filter((tool) => tool.name !== "askQuestion")
            : active === "ask-requires-more"
              ? TOOLS.map((tool) => (tool.name === "askQuestion" ? { ...tool, inputSchema: { type: "object", properties: { question: { type: "string" }, space: { type: "string" } }, required: ["question", "space"] } } : tool))
              : TOOLS;
        result = { tools };
      } else if (rpc.method === "tools/call") {
        const name = rpc.params?.name;
        const question = String(rpc.params?.arguments?.question ?? "");
        if (name !== "askQuestion") result = { content: [{ type: "text", text: `Unknown tool ${String(name)}` }], isError: true };
        else if (active === "no-content") result = {};
        else if (active === "is-error") result = { content: [{ type: "text", text: "The fixture could not answer." }], isError: true };
        else result = { content: [{ type: "text", text: override ?? fixtureFor(question) }] };
      } else {
        return stream(sse({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
      }
      const response = { jsonrpc: "2.0", id, result };
      if (active === "json-response") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
      if (active === "notification-first") return stream(`${sse({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}${sse(response)}`);
      return stream(sse(response));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/~gitbook/mcp`,
    requests,
    set: (next, scope) => {
      mode = next;
      only = scope;
    },
    answer: (text) => void (override = text),
    reset: () => {
      mode = "normal";
      only = undefined;
      override = null;
      requests.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
