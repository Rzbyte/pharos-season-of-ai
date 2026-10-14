// In-process stand-in for the Pharos Chain MCP server, used by the e2e tests.
// Tool names, argument handling and payloads mirror PharosNetwork/pharos-mcp (9a3750c):
// success = text content holding JSON, failure = isError + {"error":{"message","code"}}, get_logs
// rejects ranges over 1,000 blocks inclusive, an unknown tool gets isError + "MCP error -32602: Tool
// <name> not found", and a request with a session ID the server does not hold gets 404
// {"error":"Unknown MCP session"}.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface FakeLogChain {
  head: bigint;
  chainId?: number;
  /** Every log on the fake chain; get_logs filters them by address, topic0 and range. */
  logs: Array<Record<string, unknown>>;
  /** Tools to offer. Defaults to the three this monitor uses plus some it must never call. */
  tools?: string[];
  /** The first N get_logs calls fail with "header not found" (an RPC node catching up). */
  getLogsFailures?: number;
  /** Runs before each get_block_number answer: n is 1 for the first call. Lets a test "mine" blocks. */
  beforeBlockNumber?: (n: number, chain: FakeLogChain) => void;
  /** Replace a get_logs answer: return a value to send it as the payload. */
  onGetLogs?: (args: Record<string, unknown>, n: number) => unknown;
  /** After this many tools/call requests the session is forgotten, as after a server restart. */
  dropSessionAfterToolCalls?: number;
}

export interface FakeServer {
  url: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** HTTP method of every request to /mcp, in arrival order. */
  requests: string[];
  /** Initialize requests (one per MCP session). */
  sessionsOpened(): number;
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

const DEFAULT_TOOLS = ["get_chain_info", "get_block_number", "get_logs", "get_block", "eth_call", "get_transaction_receipt"];

function blockTag(value: unknown, head: bigint): bigint {
  if (value === undefined || value === "latest") return head;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Invalid block tag: ${String(value)}`);
}

function createToolHandler(chain: FakeLogChain) {
  let blockNumberCalls = 0;
  let getLogsCalls = 0;
  return (name: string, args: Record<string, unknown>): ToolResult => {
    switch (name) {
      case "get_chain_info": {
        const chainId = chain.chainId ?? 1672;
        return ok({ name: "Pharos", chainId, chainIdHex: `0x${chainId.toString(16)}`, expectedChainId: 1672, chainIdMatches: chainId === 1672, latestBlock: chain.head.toString(), nativeSymbol: "PROS" });
      }
      case "get_block_number":
        blockNumberCalls += 1;
        chain.beforeBlockNumber?.(blockNumberCalls, chain);
        return ok({ blockNumber: chain.head.toString(), blockNumberHex: `0x${chain.head.toString(16)}` });
      case "get_logs": {
        getLogsCalls += 1;
        if (getLogsCalls <= (chain.getLogsFailures ?? 0)) return fail("header not found", -32000);
        const custom = chain.onGetLogs?.(args, getLogsCalls);
        if (custom !== undefined) return ok(custom);
        try {
          const from = blockTag(args.fromBlock, chain.head);
          const to = blockTag(args.toBlock, chain.head);
          if (to < from) return fail("toBlock must be greater than or equal to fromBlock");
          if (to - from + 1n > 1000n) {
            return fail(`Block range too large: ${to - from + 1n} blocks requested, maximum is 1000. Narrow fromBlock/toBlock and page through the range.`);
          }
          const address = typeof args.address === "string" ? args.address.toLowerCase() : undefined;
          const topic0 = Array.isArray(args.topics) && typeof args.topics[0] === "string" ? args.topics[0].toLowerCase() : undefined;
          return ok(
            chain.logs.filter((log) => {
              const block = BigInt(String(log.blockNumber));
              const topics = log.topics as string[];
              return (!address || String(log.address).toLowerCase() === address) && (!topic0 || topics[0]?.toLowerCase() === topic0) && block >= from && block <= to;
            }),
          );
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      }
      default:
        return unknownTool(name);
    }
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? (JSON.parse(body) as unknown) : undefined;
}

export async function startFakePharosMcp(chain: FakeLogChain): Promise<FakeServer> {
  const calls: FakeServer["calls"] = [];
  const requests: string[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const handle = createToolHandler(chain);
  const tools = chain.tools ?? DEFAULT_TOOLS;
  let opened = 0;
  let toolCallRequests = 0;

  const http = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
        return;
      }
      requests.push(String(req.method));
      const header = req.headers["mcp-session-id"];
      const existing = typeof header === "string" ? sessions.get(header) : undefined;
      if (req.method === "POST") {
        const body = await readJson(req);
        if ((body as { method?: unknown } | undefined)?.method === "tools/call") {
          toolCallRequests += 1;
          if (chain.dropSessionAfterToolCalls !== undefined && toolCallRequests > chain.dropSessionAfterToolCalls && typeof header === "string") {
            sessions.delete(header);
            chain.dropSessionAfterToolCalls = undefined;
          }
        }
        const live = typeof header === "string" ? sessions.get(header) : undefined;
        if (live) return void (await live.handleRequest(req, res, body));
        if (header) return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Unknown MCP session"}');
        opened += 1;
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, transport),
          onsessionclosed: (id) => void sessions.delete(id),
        });
        const server = new Server({ name: "fake-pharos-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((name) => ({ name, inputSchema: { type: "object" as const } })) }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const { name, arguments: args = {} } = request.params;
          calls.push({ tool: name, args: structuredClone(args) });
          return tools.includes(name) ? handle(name, args) : unknownTool(name);
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
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
    requests,
    sessionsOpened: () => opened,
    openSessions: () => sessions.size,
    close: async () => {
      for (const transport of sessions.values()) await transport.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
