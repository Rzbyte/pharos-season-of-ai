// In-process stand-in for the Pharos Chain MCP server, for the inspector tests. It speaks real MCP
// over Streamable HTTP and mirrors the payload shapes of PharosNetwork/pharos-mcp's server.ts:
// success = text content holding JSON, failure = isError + {"error":{"message","code"}}, an unknown
// tool = isError "MCP error -32602: Tool <name> not found", and get_transaction /
// get_transaction_receipt answer null for a hash the chain does not know. A listed contract has code
// (get_code answers non-empty bytecode); any other address has none ("0x"), and get_balance and
// get_transaction_count answer in the real server's shapes ({ balanceWei, balance, symbol,
// balanceHex } and { nonce, nonceHex }).
// Test fixtures only: every value here is made up and never used as proof.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { formatEther } from "viem";

export const ALL_TOOLS = ["get_chain_info", "get_block_number", "get_code", "get_balance", "get_transaction_count", "eth_call", "get_transaction", "get_transaction_receipt"];

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message, code) => ({ content: [{ type: "text", text: JSON.stringify({ error: code === undefined ? { message } : { message, code } }, null, 2) }], isError: true });
const unknownTool = (name) => ({ content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }], isError: true });
const never = () => new Promise(() => undefined);

/**
 * Behaviors, used for eth_call results (per contract and 4-byte selector) and for transaction
 * lookups: a value to return, { revert }, { rpcError }, { hang: true }, or
 * { failTimes, then } to fail with a transient RPC error that many times first.
 *
 * chain = {
 *   blockNumber: bigint, chainId?: number, nativeSymbol?: string, tools?: string[],
 *   chainInfo?: "fail" | "hang", blockNumber?: ..., blockNumberFails?: boolean,
 *   contracts: { [lowercaseAddress]: { [selector]: behavior } },
 *   code?: { [lowercaseAddress]: behavior }          (get_code; default: listed contracts have code)
 *   accounts?: { [lowercaseAddress]: { balance?: bigint | behavior, nonce?: bigint | behavior } },
 *   transactions: { [lowercaseHash]: { tx?: behavior, receipt?: behavior } },
 * }
 */
export async function startFakeInspectorMcp(chain) {
  const calls = [];
  const sessions = new Map();
  const failures = new Map();
  let httpRequests = 0;
  const tools = chain.tools ?? ALL_TOOLS;

  const behave = (key, behavior, wrap) => {
    if (behavior === undefined || behavior === null) return ok(wrap(behavior ?? null));
    if (typeof behavior === "object" && "failTimes" in behavior) {
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      return count <= behavior.failTimes ? fail("header not found", -32000) : behave(key, behavior.then, wrap);
    }
    if (typeof behavior === "object" && behavior.hang) return never();
    if (typeof behavior === "object" && "revert" in behavior) return fail(behavior.revert, 3);
    if (typeof behavior === "object" && "rpcError" in behavior) return fail(behavior.rpcError, -32000);
    return ok(wrap(behavior));
  };

  const handle = (name, args) => {
    switch (name) {
      case "get_chain_info":
        if (chain.chainInfo === "fail") return fail("upstream unavailable", -32000);
        if (chain.chainInfo === "hang") return never();
        return ok({ name: "Pharos", chainId: chain.chainId ?? 1672, expectedChainId: 1672, chainIdMatches: (chain.chainId ?? 1672) === 1672, nativeSymbol: chain.nativeSymbol ?? "PROS" });
      case "get_block_number":
        if (chain.blockNumberFails) return fail("upstream unavailable", -32000);
        return ok({ blockNumber: chain.blockNumber.toString(), blockNumberHex: `0x${chain.blockNumber.toString(16)}` });
      case "get_code": {
        const address = String(args.address).toLowerCase();
        const behavior = chain.code?.[address] ?? (chain.contracts?.[address] ? "0x6080604052348015600f57600080fd5b50" : "0x");
        return behave(`code:${address}`, behavior, (code) => ({ code }));
      }
      case "get_balance": {
        const address = String(args.address).toLowerCase();
        const value = chain.accounts?.[address]?.balance ?? 0n;
        if (typeof value !== "bigint") return behave(`balance:${address}`, value, (wei) => ({ address: args.address, balanceWei: String(wei), balanceHex: `0x${BigInt(wei).toString(16)}`, symbol: chain.nativeSymbol ?? "PROS" }));
        return ok({ address: args.address, balanceWei: value.toString(), balance: formatEther(value), symbol: chain.nativeSymbol ?? "PROS", balanceHex: `0x${value.toString(16)}` });
      }
      case "get_transaction_count": {
        const address = String(args.address).toLowerCase();
        const value = chain.accounts?.[address]?.nonce ?? 0n;
        if (typeof value !== "bigint") return behave(`nonce:${address}`, value, (nonce) => ({ nonce: String(nonce), nonceHex: `0x${BigInt(nonce).toString(16)}` }));
        return ok({ nonce: value.toString(), nonceHex: `0x${value.toString(16)}` });
      }
      case "eth_call": {
        const tx = args.transaction ?? {};
        const contract = chain.contracts?.[String(tx.to).toLowerCase()];
        if (!contract) return ok({ result: "0x" });
        const selector = String(tx.data).slice(0, 10).toLowerCase();
        const behavior = contract[selector];
        if (behavior === undefined) return fail("execution reverted", 3);
        return behave(`${tx.to}:${selector}`, behavior, (result) => ({ result }));
      }
      case "get_transaction":
      case "get_transaction_receipt": {
        const entry = chain.transactions?.[String(args.hash).toLowerCase()];
        const behavior = entry?.[name === "get_transaction" ? "tx" : "receipt"];
        return behave(`${name}:${args.hash}`, behavior ?? null, (value) => value);
      }
      default:
        return unknownTool(name);
    }
  };

  const createMcpServer = () => {
    const server = new Server({ name: "fake-pharos-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      calls.push({ tool: name, args });
      return tools.includes(name) ? handle(name, args) : unknownTool(name);
    });
    return server;
  };

  const http = createServer(async (req, res) => {
    httpRequests += 1;
    try {
      const header = req.headers["mcp-session-id"];
      const existing = typeof header === "string" ? sessions.get(header) : undefined;
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = body ? JSON.parse(body) : undefined;
        if (existing) return void (await existing.handleRequest(req, res, parsed));
        if (header) return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Unknown MCP session"}');
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, transport),
          onsessionclosed: (id) => void sessions.delete(id),
        });
        await createMcpServer().connect(transport);
        await transport.handleRequest(req, res, parsed);
        return;
      }
      if (existing && (req.method === "GET" || req.method === "DELETE")) return void (await existing.handleRequest(req, res));
      res.writeHead(existing ? 405 : 404).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${http.address().port}/mcp`,
    calls,
    httpRequests: () => httpRequests,
    openSessions: () => sessions.size,
    close: async () => {
      for (const transport of sessions.values()) await transport.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise((resolve) => http.close(() => resolve()));
    },
  };
}
