// Task 08, Dry-Run Executor: what can be dry-run. An intent is one transaction described by what it
// means (send PROS, send a token, approve a spender, call a function), checked here before anything
// touches the chain, then turned into calldata once the token's decimals are known.
import { encodeFunctionData, getAddress, isAddress, maxUint256, parseAbiItem, type AbiFunction } from "viem";
import { parseAmount } from "../core/amounts.js";
import type { Address, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { NETWORKS, type NetworkId } from "../core/networks.js";

export type Intent =
  | { kind: "native-transfer"; from: Address; to: Address; amount: string }
  | { kind: "erc20-transfer"; token: Address; from: Address; to: Address; amount: string }
  | { kind: "erc20-approve"; token: Address; from: Address; spender: Address; amount: string }
  | { kind: "call"; from: Address; to: Address; signature: string; args: (string | number | boolean)[]; value: string };

export interface DryRunRequest {
  network: NetworkId;
  intent: Intent;
}

export const KINDS = ["native-transfer", "erc20-transfer", "erc20-approve", "call"] as const;

const bad = (message: string) => new AgentError("usage", message);
const address = (value: unknown, what: string): Address => {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw bad(`${what} must be a 0x address (40 hex characters).`);
  return getAddress(value);
};
const amount = (value: unknown, what: string, decimals: number): string => {
  const text = String(value ?? "").trim();
  parseAmount(text, decimals, what);
  return text;
};

/** A state-changing function by signature: "deposit(uint256)" or "deposit(uint256) returns (bool)". */
export function parseCallSignature(text: string): AbiFunction {
  const trimmed = text.trim().replace(/^function\s+/, "");
  if (!/^[A-Za-z_]\w*\([\w\s,[\]]*\)(\s+payable)?(\s+returns\s*\([\w\s,[\]]*\))?$/.test(trimmed)) throw bad(`A function looks like "deposit(uint256)" or "deposit(uint256) returns (bool)", got "${text}".`);
  try {
    return parseAbiItem(`function ${trimmed}`) as AbiFunction;
  } catch (error) {
    throw bad(`Unreadable function "${text}": ${(error as Error).message.split("\n")[0]}`);
  }
}

/** A dry-run request from untrusted input (CLI flags, an API query): every field checked. */
export function parseDryRun(input: { network?: unknown; intent?: unknown }): DryRunRequest {
  const network = input.network ?? "pharos-mainnet";
  if (typeof network !== "string" || !(network in NETWORKS)) throw bad("network must be pharos-mainnet or atlantic-testnet.");
  const i = (input.intent ?? {}) as Record<string, unknown>;
  const kind = i.kind;
  switch (kind) {
    case "native-transfer":
      return { network: network as NetworkId, intent: { kind, from: address(i.from, "from"), to: address(i.to, "to"), amount: amount(i.amount, "amount", 18) } };
    case "erc20-transfer":
      // The token's own decimals are applied once read; here only the shape is checked.
      return { network: network as NetworkId, intent: { kind, token: address(i.token, "token"), from: address(i.from, "from"), to: address(i.to, "to"), amount: amount(i.amount, "amount", 36) } };
    case "erc20-approve": {
      const value = String(i.amount ?? "").trim();
      return { network: network as NetworkId, intent: { kind, token: address(i.token, "token"), from: address(i.from, "from"), spender: address(i.spender, "spender"), amount: value === "max" ? "max" : amount(value, "amount", 36) } };
    }
    case "call": {
      const signature = String(i.signature ?? "");
      const abi = parseCallSignature(signature);
      const args = i.args === undefined ? [] : i.args;
      if (!Array.isArray(args) || args.length > 6 || !args.every((arg) => ["string", "number", "boolean"].includes(typeof arg))) throw bad("args must be a list of at most 6 plain values.");
      if (args.length !== abi.inputs.length) throw bad(`args has ${args.length} values; ${abi.name} takes ${abi.inputs.length}.`);
      const value = amount(i.value ?? "0", "value", 18);
      if (value !== "0" && abi.stateMutability !== "payable") throw bad(`${abi.name} is not payable, so it cannot be sent a value.`);
      return { network: network as NetworkId, intent: { kind, from: address(i.from, "from"), to: address(i.to, "to"), signature: signature.trim(), args: args as (string | number | boolean)[], value } };
    }
    default:
      throw bad(`kind must be one of ${KINDS.join(", ")}.`);
  }
}

/** The transaction an intent becomes, given the token's decimals where it has a token. */
export function encodeIntent(intent: Intent, decimals: number | null): { from: Address; to: Address; data: Hex; value: bigint; amountRaw: bigint } {
  switch (intent.kind) {
    case "native-transfer": {
      const raw = parseAmount(intent.amount, 18);
      return { from: intent.from, to: intent.to, data: "0x", value: raw, amountRaw: raw };
    }
    case "erc20-transfer": {
      const raw = parseAmount(intent.amount, decimals ?? 0, "amount");
      return { from: intent.from, to: intent.token, data: encodeFunctionData({ abi: [TRANSFER], functionName: "transfer", args: [intent.to, raw] }), value: 0n, amountRaw: raw };
    }
    case "erc20-approve": {
      const raw = intent.amount === "max" ? maxUint256 : parseAmount(intent.amount, decimals ?? 0, "amount");
      return { from: intent.from, to: intent.token, data: encodeFunctionData({ abi: [APPROVE], functionName: "approve", args: [intent.spender, raw] }), value: 0n, amountRaw: raw };
    }
    case "call": {
      const abi = parseCallSignature(intent.signature);
      let data: Hex;
      try {
        data = encodeFunctionData({ abi: [abi], functionName: abi.name, args: intent.args as unknown[] });
      } catch (error) {
        throw bad(`The args do not fit ${intent.signature}: ${(error as Error).message.split("\n")[0]}`);
      }
      const value = parseAmount(intent.value, 18);
      return { from: intent.from, to: intent.to, data, value, amountRaw: value };
    }
  }
}

const TRANSFER = parseAbiItem("function transfer(address to, uint256 amount) returns (bool)") as AbiFunction;
const APPROVE = parseAbiItem("function approve(address spender, uint256 amount) returns (bool)") as AbiFunction;
