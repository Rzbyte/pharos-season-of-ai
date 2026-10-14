// Test fixtures only: every value below is made up and never used as proof. The field set and
// encodings follow the live get_logs payload from the hosted Pharos Chain MCP (probe at head
// 20248479): address, blockHash, blockNumber, blockTimestamp, data, logIndex, removed, topics,
// transactionHash, transactionIndex, with quantities as 0x hex strings and addresses lowercase.
import { CliError, ToolCallError } from "../src/errors.js";
import type { ToolCaller } from "../src/mcp-client.js";

export const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
export const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427e1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const ZERO = "0x0000000000000000000000000000000000000000";
// Digit-only addresses are trivially valid EIP-55.
export const ALICE = "0x1234000000000000000000000000000000000abc";
export const BOB = "0xabcd000000000000000000000000000000001234";

export interface LogSpec {
  block: bigint;
  index?: number;
  from?: string;
  to?: string;
  amount?: bigint;
  tx?: string;
  address?: string;
  removed?: boolean;
}

export const hex = (value: bigint | number) => `0x${value.toString(16)}`;
export const topicFor = (address: string) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
export const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
/** A distinct, deterministic 32-byte transaction hash for block + index. */
export const txHash = (block: bigint, index = 0) => `0x${block.toString(16).padStart(32, "0")}${index.toString(16).padStart(32, "0")}`;

/** One USDC Transfer log in the live payload shape. */
export function makeLog(spec: LogSpec): Record<string, unknown> {
  const index = spec.index ?? 0;
  return {
    address: (spec.address ?? USDC).toLowerCase(),
    blockHash: `0x${"ef".repeat(24)}${spec.block.toString(16).padStart(16, "0")}`,
    blockNumber: hex(spec.block),
    blockTimestamp: hex(1_760_000_000n + spec.block),
    data: word(spec.amount ?? 125_500_000n),
    logIndex: hex(index),
    removed: spec.removed ?? false,
    topics: [TOPIC, topicFor(spec.from ?? ALICE), topicFor(spec.to ?? BOB)],
    transactionHash: spec.tx ?? txHash(spec.block, index),
    transactionIndex: hex(index),
  };
}

export type GetLogsBehavior = (args: Record<string, unknown>, call: number) => unknown;

/**
 * In-memory stand-in for the MCP session: get_block_number answers `head`, get_logs filters
 * `logs` the way the server does (address, topic0, inclusive block range). `onGetLogs` can
 * replace an answer (return a value) or fail a call (throw).
 */
export class FakeCaller implements ToolCaller {
  head: bigint;
  logs: Array<Record<string, unknown>>;
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  onGetLogs?: GetLogsBehavior;
  onBlockNumber?: () => unknown;
  private getLogsCalls = 0;

  constructor(head: bigint, logs: Array<Record<string, unknown>> = []) {
    this.head = head;
    this.logs = logs;
  }

  get getLogs(): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.name === "get_logs").map((call) => call.args);
  }

  async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ name, args: structuredClone(args) });
    if (name === "get_block_number") {
      if (this.onBlockNumber) return this.onBlockNumber() as T;
      return { blockNumber: this.head.toString(), blockNumberHex: hex(this.head) } as T;
    }
    if (name === "get_logs") {
      this.getLogsCalls += 1;
      const custom = this.onGetLogs?.(args, this.getLogsCalls);
      if (custom !== undefined) return custom as T;
      return serverFilter(this.logs, args) as T;
    }
    throw new CliError("MCP_TOOLS_MISSING", `fake has no tool ${name}`);
  }
}

/** What pharos-mcp + eth_getLogs do with a filter: address, topic0 and an inclusive range of at most 1,000 blocks. */
export function serverFilter(logs: Array<Record<string, unknown>>, args: Record<string, unknown>): Array<Record<string, unknown>> {
  const from = BigInt(String(args.fromBlock));
  const to = BigInt(String(args.toBlock));
  if (to - from + 1n > 1000n) throw new ToolCallError("get_logs", `Block range too large: ${to - from + 1n} blocks requested, maximum is 1000.`);
  const address = String(args.address).toLowerCase();
  const topic0 = Array.isArray(args.topics) ? String(args.topics[0]).toLowerCase() : undefined;
  return logs.filter((log) => {
    const block = BigInt(String(log.blockNumber));
    return String(log.address).toLowerCase() === address && (topic0 === undefined || String((log.topics as unknown[])[0]).toLowerCase() === topic0) && block >= from && block <= to;
  });
}

export const transient = () => new ToolCallError("get_logs", "header not found", -32000);
