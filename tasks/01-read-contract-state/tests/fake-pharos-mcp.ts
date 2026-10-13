// In-process stand-in for the Pharos Chain MCP server, used by the e2e tests.
// Tool names, argument shapes and payloads mirror PharosNetwork/pharos-mcp v0.5.1:
// success = text content holding JSON, failure = isError + {"error":{"message","code"}},
// an unknown tool name gets isError + "MCP error -32602: Tool <name> not found" (McpServer in SDK 1.29),
// and a request with a session ID the server does not hold gets 404 {"error":"Unknown MCP session"}.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

export type CallBehavior = `0x${string}` | { revert: string } | { rpcError: string };

export interface FakeChain {
  blockNumber: bigint;
  chainId?: number;
  /** lowercase address -> 4-byte selector -> behavior. Listed addresses have contract code. */
  contracts: Record<string, Record<string, CallBehavior>>;
  /** Tools to advertise. Defaults to a subset of the real server's tools, including some the CLI must not call. */
  tools?: string[];
  /** The first N eth_calls fail with "header not found" (an RPC node catching up). */
  transientEthCallFailures?: number;
  /** Every eth_call at an explicit block number fails (a node that cannot serve that block). */
  pinnedBlockUnavailable?: boolean;
  /** After this many tools/call requests the session is forgotten, as after a server restart. */
  dropSessionAfterToolCalls?: number;
  /** get_chain_info answers with an error, as when its upstream RPC calls fail. */
  chainInfoFails?: boolean;
  /** "hang": tools/list is accepted but never answered, as seen live. "unsupported": no tools/list handler (-32601). */
  toolsList?: "hang" | "unsupported";
  /** Reject an unknown tool name with a JSON-RPC error (older MCP SDK servers) instead of isError. */
  unknownToolAsRpcError?: boolean;
  /** Once a standalone GET event stream is open for a session, its later POSTs are never answered (as the hosted endpoint behaved live). */
  getStreamStallsSession?: boolean;
}

export interface FakeServer {
  url: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** JSON-RPC method of every POSTed message, notifications included, in arrival order. */
  methods: string[];
  /** HTTP method of every request to /mcp, in arrival order; a GET carrying Last-Event-ID is "GET (resume)". */
  requests: string[];
  /** Authorization header of every POST ("" when absent). */
  authorizations: string[];
  openSessions(): number;
  close(): Promise<void>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message: string, code?: number): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: code === undefined ? { message } : { message, code } }, null, 2) }],
  isError: true,
});
const unknownTool = (name: string): ToolResult => ({ content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }], isError: true });

function createToolHandler(chain: FakeChain) {
  let ethCalls = 0;
  return (name: string, args: Record<string, unknown>): ToolResult => {
    const chainId = chain.chainId ?? 1672;
    switch (name) {
      case "get_block_number":
        return ok({ blockNumber: chain.blockNumber.toString(), blockNumberHex: `0x${chain.blockNumber.toString(16)}` });
      case "get_chain_info":
        if (chain.chainInfoFails) return fail("upstream unavailable", -32000);
        return ok({ name: "Pharos", chainId, expectedChainId: 1672, chainIdMatches: chainId === 1672, latestBlock: chain.blockNumber.toString() });
      case "get_code": {
        const address = String(args.address).toLowerCase();
        return ok({ code: chain.contracts[address] ? "0x6080604052" : "0x" });
      }
      case "eth_call": {
        ethCalls += 1;
        if (ethCalls <= (chain.transientEthCallFailures ?? 0)) return fail("header not found", -32000);
        if (chain.pinnedBlockUnavailable && args.block !== "latest") return fail("header not found", -32000);
        const tx = (args.transaction ?? {}) as { to?: unknown; data?: unknown };
        const contract = chain.contracts[String(tx.to).toLowerCase()];
        if (!contract) return ok({ result: "0x" });
        const behavior = contract[String(tx.data).slice(0, 10).toLowerCase()];
        if (behavior === undefined) return fail("execution reverted", 3);
        if (typeof behavior === "string") return ok({ result: behavior });
        return "revert" in behavior ? fail(behavior.revert, 3) : fail(behavior.rpcError, -32000);
      }
      default:
        return unknownTool(name);
    }
  };
}

function createMcpServer(chain: FakeChain, calls: FakeServer["calls"], handle: ReturnType<typeof createToolHandler>): Server {
  const tools = chain.tools ?? ["get_chain_info", "get_block_number", "get_code", "eth_call"];
  const server = new Server({ name: "fake-pharos-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
  if (chain.toolsList === "hang") {
    server.setRequestHandler(ListToolsRequestSchema, () => new Promise<never>(() => undefined));
  } else if (chain.toolsList !== "unsupported") {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((name) => ({ name, inputSchema: { type: "object" as const } })),
    }));
  }
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    calls.push({ tool: name, args });
    if (!tools.includes(name) && chain.unknownToolAsRpcError) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
    return tools.includes(name) ? handle(name, args) : unknownTool(name);
  });
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? (JSON.parse(body) as unknown) : undefined;
}

export async function startFakePharosMcp(chain: FakeChain): Promise<FakeServer> {
  const calls: FakeServer["calls"] = [];
  const methods: string[] = [];
  const requests: string[] = [];
  const authorizations: string[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const streamingSessions = new Set<string>();
  const handle = createToolHandler(chain);
  let toolCallRequests = 0;

  const http = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
        return;
      }
      const header = req.headers["mcp-session-id"];
      const existing = typeof header === "string" ? sessions.get(header) : undefined;
      const resuming = req.method === "GET" && req.headers["last-event-id"] !== undefined;
      requests.push(`${req.method}${resuming ? " (resume)" : ""}`);

      if (req.method === "POST") {
        authorizations.push(String(req.headers.authorization ?? ""));
        const body = await readJson(req);
        for (const message of Array.isArray(body) ? body : [body]) {
          const method = (message as { method?: unknown } | undefined)?.method;
          if (typeof method === "string") methods.push(method);
        }
        if ((body as { method?: unknown } | undefined)?.method === "tools/call") {
          toolCallRequests += 1;
          if (chain.dropSessionAfterToolCalls !== undefined && toolCallRequests > chain.dropSessionAfterToolCalls && typeof header === "string") {
            sessions.delete(header);
          }
        }
        // Hold the request without ever answering, like the hosted endpoint once its GET stream was open.
        if (chain.getStreamStallsSession && typeof header === "string" && streamingSessions.has(header)) return;
        const live = typeof header === "string" ? sessions.get(header) : undefined;
        if (live) return void (await live.handleRequest(req, res, body));
        if (header) return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Unknown MCP session"}');
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, transport),
          onsessionclosed: (id) => void sessions.delete(id),
        });
        await createMcpServer(chain, calls, handle).connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (existing && req.method === "GET" && !resuming && typeof header === "string") {
        streamingSessions.add(header);
        res.on("close", () => streamingSessions.delete(header));
      }
      if (existing && (req.method === "GET" || req.method === "DELETE")) return void (await existing.handleRequest(req, res));
      res.writeHead(existing ? 405 : 404, { "content-type": "application/json" }).end(existing ? "" : '{"error":"Unknown MCP session"}');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    }
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    methods,
    requests,
    authorizations,
    openSessions: () => sessions.size,
    close: async () => {
      for (const transport of sessions.values()) await transport.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
