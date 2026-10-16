// Contract calls by signature, through viem: "paused() returns (bool)",
// "balanceOf(address) returns (uint256)". One return value of type bool, address, or (u)int.
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, parseAbiItem, type AbiFunction } from "viem";
import { AgentError } from "./errors.js";
import type { Address, Hex } from "./chain.js";

export type ReturnKind = "bool" | "address" | "uint" | "int";

export interface CallSignature {
  /** As written: "balanceOf(address) returns (uint256)". */
  text: string;
  abi: AbiFunction;
  returns: ReturnKind;
}

/** Parse "name(types) returns (type)" into a view function with one bool/address/(u)int result. */
export function parseSignature(text: string): CallSignature {
  const trimmed = text.trim().replace(/^function\s+/, "");
  if (!/^[A-Za-z_]\w*\([\w\s,[\]]*\)\s+returns\s*\(\s*\w+(\s+\w+)?\s*\)$/.test(trimmed)) {
    throw new AgentError("usage", `A call signature looks like "balanceOf(address) returns (uint256)", got "${text}".`);
  }
  let abi: AbiFunction;
  try {
    abi = parseAbiItem(`function ${trimmed.replace(/\s+returns/, " view returns")}`) as AbiFunction;
  } catch (error) {
    throw new AgentError("usage", `Unreadable call signature "${text}": ${(error as Error).message.split("\n")[0]}`);
  }
  const output = abi.outputs[0]?.type ?? "";
  const returns: ReturnKind | null = output === "bool" ? "bool" : output === "address" ? "address" : /^uint\d*$/.test(output) ? "uint" : /^int\d*$/.test(output) ? "int" : null;
  if (abi.outputs.length !== 1 || !returns) throw new AgentError("usage", `"${text}" must return exactly one bool, address or integer.`);
  return { text: trimmed, abi, returns };
}

export function encodeCall(sig: CallSignature, args: readonly unknown[]): Hex {
  try {
    return encodeFunctionData({ abi: [sig.abi], functionName: sig.abi.name, args: args as unknown[] });
  } catch (error) {
    throw new AgentError("usage", `Arguments do not fit ${sig.text}: ${(error as Error).message.split("\n")[0]}`);
  }
}

export function decodeCall(sig: CallSignature, data: Hex): bigint | boolean | Address {
  const value = decodeFunctionResult({ abi: [sig.abi], functionName: sig.abi.name, data }) as unknown;
  if (typeof value === "bigint" || typeof value === "boolean") return value;
  // viem decodes integers of 48 bits or fewer (uint8 decimals, say) as numbers.
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value as Address;
  throw new AgentError("mcp_tool", `Could not read ${sig.text} from ${data.slice(0, 66)}`);
}

export const ERC20 = {
  balanceOf: parseSignature("balanceOf(address) returns (uint256)"),
  decimals: parseSignature("decimals() returns (uint8)"),
  paused: parseSignature("paused() returns (bool)"),
  totalSupply: parseSignature("totalSupply() returns (uint256)"),
  allowance: parseSignature("allowance(address,address) returns (uint256)"),
};

const TRANSFER = parseAbiItem("function transfer(address to, uint256 amount) returns (bool)") as AbiFunction;
const APPROVE = parseAbiItem("function approve(address spender, uint256 amount) returns (bool)") as AbiFunction;

export const encodeTransfer = (to: Address, amount: bigint): Hex => encodeFunctionData({ abi: [TRANSFER], functionName: "transfer", args: [to, amount] });
export const encodeApprove = (spender: Address, amount: bigint): Hex => encodeFunctionData({ abi: [APPROVE], functionName: "approve", args: [spender, amount] });

/** True only for exactly one 32-byte word holding 1 (an ERC-20 transfer's `true`). */
export const isTrueWord = (data: Hex): boolean => /^0x0{63}1$/i.test(data);

/** A readable revert reason from revert data: Error(string), Panic(uint256), or the 4-byte selector. */
export function revertReason(data: Hex | null, fallback: string): string {
  if (!data || data === "0x") return fallback;
  try {
    const decoded = decodeErrorResult({ abi: [], data });
    if (decoded.errorName === "Error") return String(decoded.args?.[0] ?? fallback);
    if (decoded.errorName === "Panic") return `panic 0x${BigInt(String(decoded.args?.[0] ?? 0)).toString(16)}`;
    return decoded.errorName;
  } catch {
    return `${fallback} (custom error ${data.slice(0, 10)})`;
  }
}
