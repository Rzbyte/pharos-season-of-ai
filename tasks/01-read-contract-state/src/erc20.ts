import { decodeAbiParameters, encodeFunctionData, erc20Abi, hexToString, isHex, size, toHex, type Address, type Hex } from "viem";
import { RETRY_DELAY_MS } from "./constants.js";
import { CliError, errorMessage, shorten, ToolCallError } from "./errors.js";
import type { ToolCaller } from "./mcp-client.js";

// viem is used here only as an ABI codec. No viem client or transport exists in this
// project: every eth_call goes through the MCP server's eth_call tool.

export type ContractField = "name" | "symbol" | "decimals" | "totalSupply";

/** The four required reads. A run succeeds only if all four return a value. */
export const FIELDS: readonly ContractField[] = ["name", "symbol", "decimals", "totalSupply"];

/** Calldata for each read: the 4-byte selectors, since none of these functions take arguments. */
export const CALLDATA: Readonly<Record<ContractField, Hex>> = {
  name: encodeFunctionData({ abi: erc20Abi, functionName: "name" }),
  symbol: encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }),
  decimals: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
  totalSupply: encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" }),
};

/** eth_call succeeded but returned "0x": no code at the address, or the function does not exist. */
export class EmptyReturnError extends Error {
  override name = "EmptyReturnError";
}

/** eth_call returned bytes that do not decode as the expected ABI type. */
export class MalformedReturnError extends Error {
  override name = "MalformedReturnError";
}

export interface TokenState {
  address: Address;
  /** The block every eth_call ran against. */
  blockNumber: bigint;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** Reads whose first attempt failed transiently and were repeated at the same block. */
  retried: ContractField[];
}

export interface ReadOptions {
  retryDelayMs?: number;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

const DECODERS: Readonly<Record<ContractField, (data: Hex) => unknown>> = {
  name: decodeStringReturn,
  symbol: decodeStringReturn,
  decimals: decodeDecimalsReturn,
  totalSupply: decodeUint256Return,
};

/**
 * Read name, symbol, decimals and totalSupply through MCP eth_call, all pinned to one block
 * so the four values form a single consistent snapshot. All four are required.
 */
export async function readTokenState(mcp: ToolCaller, address: Address, blockNumber: bigint, options: ReadOptions = {}): Promise<TokenState> {
  const block = toHex(blockNumber);
  const outcomes = await readFields(mcp, address, block, FIELDS);

  // A transient failure (for example a load-balanced RPC node that is a block behind the one
  // get_block_number reported) gets one more try at the SAME block. Never at "latest": the
  // output must name the exact block the data was read at.
  const retried = FIELDS.filter((field) => isTransient(outcomes[field]));
  if (retried.length > 0) {
    await delay(options.retryDelayMs ?? RETRY_DELAY_MS);
    Object.assign(outcomes, await readFields(mcp, address, block, retried));
  }

  const failed: Array<readonly [ContractField, unknown]> = [];
  for (const field of FIELDS) {
    const outcome = outcomes[field];
    if (!outcome || !outcome.ok) failed.push([field, outcome ? outcome.error : new Error("not read")]);
  }
  if (failed.length > 0) throw explainFailures(address, blockNumber, failed);

  const value = (field: ContractField) => (outcomes[field] as { ok: true; value: unknown }).value;
  return {
    address,
    blockNumber,
    name: value("name") as string,
    symbol: value("symbol") as string,
    decimals: value("decimals") as number,
    totalSupply: value("totalSupply") as bigint,
    retried,
  };
}

async function readFields(mcp: ToolCaller, address: Address, block: Hex, fields: readonly ContractField[]) {
  const settled = await Promise.allSettled(
    fields.map((field) => ethCall(mcp, address, CALLDATA[field], block).then((data) => DECODERS[field](data))),
  );

  // If the MCP connection itself broke, stop here instead of reporting half a token.
  for (const outcome of settled) {
    if (outcome.status === "rejected" && outcome.reason instanceof CliError && outcome.reason.kind === "MCP_CONNECTION") {
      throw outcome.reason;
    }
  }

  const result: Partial<Record<ContractField, Outcome>> = {};
  fields.forEach((field, index) => {
    const outcome = settled[index];
    if (!outcome) return;
    result[field] = outcome.status === "fulfilled" ? { ok: true, value: outcome.value } : { ok: false, error: outcome.reason };
  });
  return result;
}

/** One MCP eth_call. The Pharos server answers with {"result": "0x..."}. */
async function ethCall(mcp: ToolCaller, to: Address, data: Hex, block: Hex): Promise<Hex> {
  const payload = await mcp.call<{ result?: unknown } | null>("eth_call", { transaction: { to, data }, block });
  const result = payload !== null && typeof payload === "object" ? payload.result : undefined;
  if (typeof result !== "string" || !isHex(result)) {
    throw new CliError("MCP_TOOL_ERROR", `eth_call returned an unexpected payload: ${shorten(JSON.stringify(payload) ?? "undefined", 160)}`);
  }
  return result;
}

export function decodeStringReturn(data: Hex): string {
  const length = size(data);
  if (length === 0) throw new EmptyReturnError("the call returned no data");
  try {
    return decodeAbiParameters([{ type: "string" }], data)[0];
  } catch {
    // Some early tokens (MKR, SAI) return bytes32 instead of string.
    if (length === 32) return hexToString(data, { size: 32 });
    throw new MalformedReturnError(`returned ${length} bytes that are not an ABI-encoded string`);
  }
}

export function decodeUint256Return(data: Hex): bigint {
  const length = size(data);
  if (length === 0) throw new EmptyReturnError("the call returned no data");
  if (length < 32) throw new MalformedReturnError(`returned ${length} bytes, expected a 32-byte uint256`);
  return decodeAbiParameters([{ type: "uint256" }], data)[0];
}

export function decodeDecimalsReturn(data: Hex): number {
  const value = decodeUint256Return(data);
  if (value > 255n) throw new MalformedReturnError(`returned ${value}, which does not fit in uint8`);
  return Number(value);
}

/** One error that says which required reads failed and why. */
function explainFailures(address: Address, blockNumber: bigint, failures: ReadonlyArray<readonly [ContractField, unknown]>): CliError {
  // An MCP-level problem (for example an unexpected payload) says more than "not an ERC-20".
  const mcpProblem = failures.find(([, error]) => error instanceof CliError && !(error instanceof ToolCallError));
  if (mcpProblem) return mcpProblem[1] as CliError;

  const rpcFailures = failures.filter(([, error]) => error instanceof ToolCallError && !error.isRevert);
  const firstRpc = rpcFailures[0];
  if (firstRpc) {
    const error = firstRpc[1] as ToolCallError;
    return new CliError(
      "MCP_TOOL_ERROR",
      `Could not read ${rpcFailures.map(([field]) => `${field}()`).join(", ")} at block ${blockNumber}: ${error.detail}`,
      error.isInvalidParams
        ? "The MCP server rejected the request arguments. Rerun with --verbose to see the exact call."
        : "The RPC node behind the MCP server could not serve this block, even after one retry. Rerun the command.",
    );
  }

  if (failures.length === FIELDS.length && failures.every(([, error]) => error instanceof EmptyReturnError)) {
    return new CliError(
      "NOT_ERC20",
      `${address} returned no data for any required read at block ${blockNumber}.`,
      "Either no contract is deployed at this address on the network your MCP endpoint serves, or it is not an ERC-20 token. The default contract is on Pharos Mainnet (chain ID 1672).",
    );
  }

  return new CliError(
    "NOT_ERC20",
    `${address} did not answer every required ERC-20 read at block ${blockNumber}: ${failures
      .map(([field, error]) => `${field}() ${describeFailure(error)}`)
      .join("; ")}.`,
    "This tool needs name(), symbol(), decimals() and totalSupply() to all succeed. Double-check the address on a Pharos block explorer.",
  );
}

/** Worth one retry at the same block: the server answered with an error that is not a revert or bad input. */
function isTransient(outcome: Outcome | undefined): boolean {
  return outcome !== undefined && !outcome.ok && outcome.error instanceof ToolCallError && !outcome.error.isRevert && !outcome.error.isInvalidParams;
}

function describeFailure(error: unknown): string {
  if (error instanceof ToolCallError) return error.isRevert ? `reverted (${error.detail})` : `failed (${error.detail})`;
  if (error instanceof EmptyReturnError) return "returned no data";
  if (error instanceof MalformedReturnError) return `returned invalid data (${error.message})`;
  return `failed (${errorMessage(error)})`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
