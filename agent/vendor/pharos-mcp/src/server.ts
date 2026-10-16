import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatEther, formatGwei } from "viem";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { RpcClient, RpcError } from "./rpc.js";
import { assertAddress, assertHash, assertHex, normalizeBlockTag } from "./validation.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const transactionSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  data: z.string().optional(),
  value: z.string().optional(),
  gas: z.string().optional(),
  gasPrice: z.string().optional(),
  maxFeePerGas: z.string().optional(),
  maxPriorityFeePerGas: z.string().optional(),
  nonce: z.string().optional(),
});

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof RpcError ? { message, code: error.code, data: error.data } : { message };
  return { content: [{ type: "text", text: JSON.stringify({ error: details }, null, 2) }], isError: true };
}

function parseHexQuantity(value: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`Invalid RPC quantity: ${value}`);
  return BigInt(value);
}

// Cap the eth_getLogs window to match what the upstream RPC actually accepts:
// it allows at most 1000 blocks inclusive (a 1001-block span is rejected with
// "The block range is too large"). Enforcing the same bound here turns a
// confusing upstream error into a clear, actionable message — and still guards
// against an anonymous caller requesting every log since genesis, which would
// force a full scan upstream and a large synchronous JSON.stringify here.
const MAX_LOG_BLOCK_RANGE = 1_000n;

// Resolve a normalized block tag to a number when possible. Named tags other
// than "earliest" can't be resolved locally, so callers must handle undefined.
function resolveBlockNumber(tag: string, latest: bigint): bigint | undefined {
  if (tag === "earliest") return 0n;
  if (tag === "latest" || tag === "safe" || tag === "finalized" || tag === "pending") return latest;
  if (/^0x[0-9a-fA-F]+$/.test(tag)) return BigInt(tag);
  return undefined;
}

function validateTransaction(input: z.infer<typeof transactionSchema>): Record<string, string> {
  const result: Record<string, string> = {};
  if (input.from) result.from = assertAddress(input.from, "from");
  if (input.to) result.to = assertAddress(input.to, "to");
  if (input.data) result.data = assertHex(input.data, "data");
  for (const field of ["value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce"] as const) {
    if (input[field]) result[field] = assertHex(input[field]!, field);
  }
  return result;
}

export function createPharosServer(config: AppConfig): McpServer {
  const rpc = new RpcClient(config.rpcUrl);
  const server = new McpServer(
    { name: "pharos-mcp-server", version: "0.1.0" },
    {
      instructions:
        "Pharos EVM JSON-RPC tools. Read operations are safe. send_raw_transaction only accepts a transaction already signed outside this server.",
    },
  );

  server.registerTool(
    "get_chain_info",
    {
      description: "Get Pharos chain ID, client version, latest block and configured RPC endpoint",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const chainIdHex = await rpc.call<string>("eth_chainId");
        const blockNumberHex = await rpc.call<string>("eth_blockNumber");
        const clientVersion = await rpc.call<string>("web3_clientVersion");
        const chainId = Number(parseHexQuantity(chainIdHex));
        return ok({
          name: "Pharos",
          chainId,
          chainIdHex,
          expectedChainId: config.chainId,
          chainIdMatches: chainId === config.chainId,
          latestBlock: parseHexQuantity(blockNumberHex).toString(),
          latestBlockHex: blockNumberHex,
          nativeSymbol: config.nativeSymbol,
          clientVersion,
          rpcUrl: config.rpcUrl,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_block_number",
    {
      description: "Get the latest Pharos block number",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const hex = await rpc.call<string>("eth_blockNumber");
        return ok({ blockNumber: parseHexQuantity(hex).toString(), blockNumberHex: hex });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_balance",
    {
      description: "Get the native PROS balance of an EVM address",
      inputSchema: {
        address: z.string().describe("EVM address"),
        block: z.union([z.string(), z.number()]).optional().describe("Block tag or number; defaults to latest"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, block }) => {
      try {
        const normalizedAddress = assertAddress(address);
        const balanceHex = await rpc.call<string>("eth_getBalance", [normalizedAddress, normalizeBlockTag(block)]);
        const wei = parseHexQuantity(balanceHex);
        return ok({ address: normalizedAddress, balanceWei: wei.toString(), balance: formatEther(wei), symbol: config.nativeSymbol, balanceHex });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_transaction_count",
    {
      description: "Get an address transaction count (nonce)",
      inputSchema: {
        address: z.string(),
        block: z.union([z.string(), z.number()]).optional().describe("Usually latest or pending"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ address, block }) => {
      try {
        const value = await rpc.call<string>("eth_getTransactionCount", [assertAddress(address), normalizeBlockTag(block)]);
        return ok({ nonce: parseHexQuantity(value).toString(), nonceHex: value });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_gas_price",
    {
      description: "Get current Pharos gas price and priority fee",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const gasPriceHex = await rpc.call<string>("eth_gasPrice");
        const priorityFeeHex = await rpc.call<string>("eth_maxPriorityFeePerGas");
        const gasPriceWei = parseHexQuantity(gasPriceHex);
        const priorityFeeWei = parseHexQuantity(priorityFeeHex);
        return ok({
          gasPriceWei: gasPriceWei.toString(),
          gasPriceGwei: formatGwei(gasPriceWei),
          gasPriceHex,
          maxPriorityFeePerGasWei: priorityFeeWei.toString(),
          maxPriorityFeePerGasGwei: formatGwei(priorityFeeWei),
          maxPriorityFeePerGasHex: priorityFeeHex,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_block",
    {
      description: "Get a Pharos block by tag or number",
      inputSchema: {
        block: z.union([z.string(), z.number()]).optional(),
        includeTransactions: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ block, includeTransactions }) => {
      try {
        return ok(await rpc.call("eth_getBlockByNumber", [normalizeBlockTag(block), includeTransactions]));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_transaction",
    {
      description: "Get a transaction by hash",
      inputSchema: { hash: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ hash }) => {
      try {
        return ok(await rpc.call("eth_getTransactionByHash", [assertHash(hash)]));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_transaction_receipt",
    {
      description: "Get a transaction receipt by hash",
      inputSchema: { hash: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ hash }) => {
      try {
        return ok(await rpc.call("eth_getTransactionReceipt", [assertHash(hash)]));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_code",
    {
      description: "Get contract bytecode at an address",
      inputSchema: { address: z.string(), block: z.union([z.string(), z.number()]).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, block }) => {
      try {
        return ok({ code: await rpc.call("eth_getCode", [assertAddress(address), normalizeBlockTag(block)]) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_storage_at",
    {
      description: "Read a contract storage slot",
      inputSchema: { address: z.string(), position: z.string(), block: z.union([z.string(), z.number()]).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, position, block }) => {
      try {
        return ok({ value: await rpc.call("eth_getStorageAt", [assertAddress(address), assertHex(position, "position"), normalizeBlockTag(block)]) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "eth_call",
    {
      description: "Execute a read-only EVM contract call",
      inputSchema: { transaction: transactionSchema, block: z.union([z.string(), z.number()]).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ transaction, block }) => {
      try {
        return ok({ result: await rpc.call("eth_call", [validateTransaction(transaction), normalizeBlockTag(block)]) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "estimate_gas",
    {
      description: "Estimate gas for a transaction without sending it",
      inputSchema: { transaction: transactionSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ transaction }) => {
      try {
        const gasHex = await rpc.call<string>("eth_estimateGas", [validateTransaction(transaction)]);
        return ok({ gas: parseHexQuantity(gasHex).toString(), gasHex });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_logs",
    {
      description: `Get EVM logs. The fromBlock/toBlock window is limited to ${MAX_LOG_BLOCK_RANGE} blocks inclusive (the upstream RPC limit); page through larger ranges.`,
      inputSchema: {
        address: z.union([z.string(), z.array(z.string())]).optional(),
        topics: z.array(z.union([z.string(), z.array(z.string()), z.null()])).optional(),
        fromBlock: z.union([z.string(), z.number()]).optional(),
        toBlock: z.union([z.string(), z.number()]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address, topics, fromBlock, toBlock }) => {
      try {
        const normalizedAddress = Array.isArray(address)
          ? address.map((item) => assertAddress(item))
          : address
            ? assertAddress(address)
            : undefined;
        const normalizedTopics = topics?.map((topic) =>
          Array.isArray(topic) ? topic.map((item) => assertHex(item, "topic")) : topic === null ? null : assertHex(topic, "topic"),
        );
        const filter = {
          ...(normalizedAddress ? { address: normalizedAddress } : {}),
          ...(normalizedTopics ? { topics: normalizedTopics } : {}),
          fromBlock: normalizeBlockTag(fromBlock ?? "latest"),
          toBlock: normalizeBlockTag(toBlock ?? "latest"),
        };

        // Enforce the bounded range this tool's description promises.
        const latest = parseHexQuantity(await rpc.call<string>("eth_blockNumber"));
        const from = resolveBlockNumber(filter.fromBlock, latest);
        const to = resolveBlockNumber(filter.toBlock, latest);
        if (from !== undefined && to !== undefined) {
          if (to < from) throw new Error("toBlock must be greater than or equal to fromBlock");
          const span = to - from + 1n;
          if (span > MAX_LOG_BLOCK_RANGE) {
            throw new Error(
              `Block range too large: ${span} blocks requested, maximum is ${MAX_LOG_BLOCK_RANGE}. Narrow fromBlock/toBlock and page through the range.`,
            );
          }
        }

        return ok(await rpc.call("eth_getLogs", [filter]));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "send_raw_transaction",
    {
      description: "Broadcast an already-signed raw EVM transaction. This server never receives a private key.",
      inputSchema: { rawTransaction: z.string().describe("0x-prefixed signed transaction bytes") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ rawTransaction }) => {
      try {
        if (!config.enableSendRawTransaction) {
          throw new Error("Transaction broadcasting is disabled. Set ENABLE_SEND_RAW_TRANSACTION=true to enable it.");
        }
        const value = assertHex(rawTransaction, "rawTransaction");
        if (value.length < 20) throw new Error("rawTransaction is too short to be a signed EVM transaction");
        const txHash = await rpc.call<string>("eth_sendRawTransaction", [value]);
        return ok({ txHash });
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
