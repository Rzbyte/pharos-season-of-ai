// Typed access to the Pharos Chain MCP tools, with each payload checked against the shape the official
// server returns (vendor/pharos-mcp/src/server.ts). Blocks are passed as 0x quantities, as in Tasks 01
// and 02, so a pinned read names its block exactly.
import { AgentError, ToolCallError } from "./errors.js";
import type { Network } from "./networks.js";

/** What the typed wrappers need from an MCP client: the live ChainMcp, or a replay of a recorded run. */
export interface ToolCaller {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  readonly where: string;
  readonly server?: { name: string; version: string };
  readonly toolCalls: number;
}

export type Hex = `0x${string}`;
export type Address = `0x${string}`;
export type BlockRef = bigint | "latest" | "pending";

export interface TxRequest {
  from?: Address;
  to: Address;
  data?: Hex;
  value?: bigint;
}

export interface ChainInfo {
  chainId: number;
  latestBlock: bigint;
  nativeSymbol: string;
  clientVersion: string | null;
}

export interface BlockHeader {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  baseFeePerGas: bigint | null;
  gasUsed: bigint;
  gasLimit: bigint;
}

export interface GasPrice {
  gasPrice: bigint;
  priorityFee: bigint;
}

export interface Receipt {
  transactionHash: Hex;
  blockNumber: bigint;
  status: "success" | "reverted";
  gasUsed: bigint;
  effectiveGasPrice: bigint | null;
  from: Address;
  to: Address | null;
  logs: RawLog[];
}

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

/** A revert from eth_call or estimate_gas, with whatever revert data the node returned. */
export class CallReverted extends AgentError {
  constructor(
    readonly tool: string,
    readonly reason: string,
    readonly data: Hex | null,
  ) {
    super("mcp_tool", `${tool} reverted: ${reason}`);
    this.name = "CallReverted";
  }
}

export const blockTag = (block: BlockRef): string => (typeof block === "bigint" ? `0x${block.toString(16)}` : block);

const isHex = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
const isAddress = (value: unknown): value is Address => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const decimal = (value: unknown, what: string): bigint => {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw unexpected(what, value);
};
const quantity = (value: unknown, what: string): bigint => {
  if (isHex(value) && value.length > 2) return BigInt(value);
  throw unexpected(what, value);
};
const optionalQuantity = (value: unknown, what: string): bigint | null => (value === undefined || value === null ? null : quantity(value, what));
function unexpected(what: string, value: unknown): AgentError {
  return new AgentError("mcp_tool", `Unexpected ${what} from Chain MCP: ${JSON.stringify(value)?.slice(0, 120)}`);
}
const object = (value: unknown, what: string): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw unexpected(what, value);
};

function txArgs(tx: TxRequest): Record<string, string> {
  const out: Record<string, string> = { to: tx.to };
  if (tx.from) out.from = tx.from;
  if (tx.data) out.data = tx.data;
  if (tx.value !== undefined && tx.value > 0n) out.value = `0x${tx.value.toString(16)}`;
  return out;
}

/** Revert data and a readable reason from a tool error, when the node said the call reverted. */
function revertOf(error: unknown, tool: string): CallReverted | null {
  if (!(error instanceof ToolCallError) || !error.isRevert) return null;
  const data = isHex(error.rpcData) ? error.rpcData : null;
  return new CallReverted(tool, error.detail.replace(/^execution reverted:?\s*/i, "") || "execution reverted", data);
}

export class Chain {
  constructor(
    readonly mcp: ToolCaller,
    readonly network: Network,
  ) {}

  async chainInfo(): Promise<ChainInfo> {
    const info = object(await this.mcp.call("get_chain_info"), "get_chain_info");
    if (typeof info.chainId !== "number") throw unexpected("chainId", info.chainId);
    return {
      chainId: info.chainId,
      latestBlock: decimal(info.latestBlock, "latestBlock"),
      nativeSymbol: typeof info.nativeSymbol === "string" ? info.nativeSymbol : this.network.nativeSymbol,
      clientVersion: typeof info.clientVersion === "string" ? info.clientVersion : null,
    };
  }

  /** get_chain_info, refusing to go on if the server is on another chain than the agent expects. */
  async expectChain(): Promise<ChainInfo> {
    const info = await this.chainInfo();
    if (info.chainId !== this.network.chainId) {
      throw new AgentError("wrong_chain", `The Chain MCP server is on chain ${info.chainId}, not ${this.network.name} (${this.network.chainId}).`, "Nothing was evaluated. Point the agent at the right network.");
    }
    return info;
  }

  async blockNumber(): Promise<bigint> {
    return decimal(object(await this.mcp.call("get_block_number"), "get_block_number").blockNumber, "blockNumber");
  }

  async block(block: BlockRef): Promise<BlockHeader> {
    const raw = await this.mcp.call("get_block", { block: blockTag(block), includeTransactions: false });
    const b = object(raw, "get_block");
    return {
      number: quantity(b.number, "block number"),
      hash: isHex(b.hash) ? b.hash : (() => { throw unexpected("block hash", b.hash); })(),
      timestamp: quantity(b.timestamp, "block timestamp"),
      baseFeePerGas: optionalQuantity(b.baseFeePerGas, "baseFeePerGas"),
      gasUsed: quantity(b.gasUsed, "gasUsed"),
      gasLimit: quantity(b.gasLimit, "gasLimit"),
    };
  }

  async balance(address: Address, block: BlockRef): Promise<bigint> {
    return decimal(object(await this.mcp.call("get_balance", { address, block: blockTag(block) }), "get_balance").balanceWei, "balanceWei");
  }

  async nonce(address: Address, block: BlockRef): Promise<bigint> {
    return decimal(object(await this.mcp.call("get_transaction_count", { address, block: blockTag(block) }), "get_transaction_count").nonce, "nonce");
  }

  async gasPrice(): Promise<GasPrice> {
    const g = object(await this.mcp.call("get_gas_price"), "get_gas_price");
    return { gasPrice: decimal(g.gasPriceWei, "gasPriceWei"), priorityFee: decimal(g.maxPriorityFeePerGasWei, "maxPriorityFeePerGasWei") };
  }

  async code(address: Address, block: BlockRef): Promise<Hex> {
    const code = object(await this.mcp.call("get_code", { address, block: blockTag(block) }), "get_code").code;
    if (!isHex(code)) throw unexpected("code", code);
    return code;
  }

  /** eth_call; a revert throws CallReverted with the revert data. */
  async call(tx: TxRequest, block: BlockRef): Promise<Hex> {
    try {
      const result = object(await this.mcp.call("eth_call", { transaction: txArgs(tx), block: blockTag(block) }), "eth_call").result;
      if (!isHex(result)) throw unexpected("eth_call result", result);
      return result;
    } catch (error) {
      throw revertOf(error, "eth_call") ?? error;
    }
  }

  /** estimate_gas (the official tool has no block argument: it estimates against the latest state). */
  async estimateGas(tx: TxRequest): Promise<bigint> {
    try {
      return decimal(object(await this.mcp.call("estimate_gas", { transaction: txArgs(tx) }), "estimate_gas").gas, "gas");
    } catch (error) {
      throw revertOf(error, "estimate_gas") ?? error;
    }
  }

  async logs(filter: { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]> {
    const raw = await this.mcp.call("get_logs", { ...(filter.address ? { address: filter.address } : {}), ...(filter.topics ? { topics: filter.topics } : {}), fromBlock: blockTag(filter.fromBlock), toBlock: blockTag(filter.toBlock) });
    if (!Array.isArray(raw)) throw unexpected("get_logs result", raw);
    return raw as RawLog[];
  }

  async receipt(hash: Hex): Promise<Receipt | null> {
    const raw = await this.mcp.call("get_transaction_receipt", { hash });
    if (raw === null) return null;
    const r = object(raw, "get_transaction_receipt");
    return {
      transactionHash: isHex(r.transactionHash) ? r.transactionHash : hash,
      blockNumber: quantity(r.blockNumber, "receipt blockNumber"),
      status: r.status === "0x1" ? "success" : "reverted",
      gasUsed: quantity(r.gasUsed, "gasUsed"),
      effectiveGasPrice: optionalQuantity(r.effectiveGasPrice, "effectiveGasPrice"),
      from: isAddress(r.from) ? r.from : (() => { throw unexpected("receipt from", r.from); })(),
      to: isAddress(r.to) ? r.to : null,
      logs: Array.isArray(r.logs) ? (r.logs as RawLog[]) : [],
    };
  }

  /** send_raw_transaction: broadcast a transaction signed locally (the server never sees a key). */
  async sendRaw(raw: Hex): Promise<Hex> {
    const hash = object(await this.mcp.call("send_raw_transaction", { rawTransaction: raw }), "send_raw_transaction").txHash;
    if (!isHex(hash) || hash.length !== 66) throw unexpected("txHash", hash);
    return hash;
  }
}
