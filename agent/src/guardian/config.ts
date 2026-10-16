// Task 05, Threshold Guardian: what a guardian checks and what it fires. A guardian is data, checked here
// before anything touches the chain: a set of on-chain conditions, a rule for how many must hold, and one
// action that fires only when the rule is met.
import { getAddress, isAddress } from "viem";
import { parseSignature } from "../core/abi.js";
import { parseAmount, parseGasPrice } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { NETWORKS, type NetworkId } from "../core/networks.js";

export type Comparator = "<" | "<=" | ">" | ">=" | "==" | "!=";

/** One on-chain value, read at the guardian's pinned block (gas price and block age are read live). */
export type Read =
  | { kind: "erc20-balance"; token: Address; holder: Address }
  | { kind: "native-balance"; address: Address }
  | { kind: "call"; to: Address; signature: string; args: (string | number | boolean)[]; decimals: number | null }
  | { kind: "has-code"; address: Address }
  | { kind: "gas-price" }
  | { kind: "block-age" }
  | { kind: "nonce"; address: Address };

export interface Condition {
  id: string;
  /** What must be true, as a sentence: "The payer holds at least the payout". */
  label: string;
  read: Read;
  op: Comparator;
  /** The threshold in human units: "250" (token units), "5 gwei", 60 (seconds), false. */
  value: string | number | boolean;
}

export type Action =
  | { type: "erc20-transfer"; token: Address; from: Address; to: Address; amount: string }
  | { type: "native-transfer"; from: Address; to: Address; amount: string };

export type FireWhen = "all" | "any" | { atLeast: number };

export interface GuardianConfig {
  name: string;
  network: NetworkId;
  fireWhen: FireWhen;
  conditions: Condition[];
  action: Action;
}

export const LIMITS = Object.freeze({ conditions: 8, label: 90, name: 60, args: 4 });

const COMPARATORS: readonly Comparator[] = ["<", "<=", ">", ">=", "==", "!="];

const bad = (message: string) => new AgentError("usage", message);
const record = (value: unknown, what: string): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw bad(`${what} must be an object.`);
};
const text = (value: unknown, what: string, max: number): string => {
  if (typeof value !== "string" || !value.trim()) throw bad(`${what} is required.`);
  if (value.length > max) throw bad(`${what} is longer than ${max} characters.`);
  return value.trim();
};
const address = (value: unknown, what: string): Address => {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw bad(`${what} must be a 0x address (40 hex characters).`);
  return getAddress(value);
};
const only = (obj: Record<string, unknown>, keys: string[], what: string) => {
  for (const key of Object.keys(obj)) if (!keys.includes(key)) throw bad(`${what} has an unknown field "${key}".`);
};

/** Whether a read produces a yes/no or an address (compared with == and != only) rather than a number. */
export function readValueType(read: Read): "bool" | "address" | "number" {
  if (read.kind === "has-code") return "bool";
  if (read.kind === "call") {
    const returns = parseSignature(read.signature).returns;
    return returns === "bool" ? "bool" : returns === "address" ? "address" : "number";
  }
  return "number";
}

function parseRead(raw: unknown, where: string): Read {
  const r = record(raw, `${where}.read`);
  switch (r.kind) {
    case "erc20-balance":
      only(r, ["kind", "token", "holder"], `${where}.read`);
      return { kind: "erc20-balance", token: address(r.token, `${where}.read.token`), holder: address(r.holder, `${where}.read.holder`) };
    case "native-balance":
      only(r, ["kind", "address"], `${where}.read`);
      return { kind: "native-balance", address: address(r.address, `${where}.read.address`) };
    case "has-code":
      only(r, ["kind", "address"], `${where}.read`);
      return { kind: "has-code", address: address(r.address, `${where}.read.address`) };
    case "nonce":
      only(r, ["kind", "address"], `${where}.read`);
      return { kind: "nonce", address: address(r.address, `${where}.read.address`) };
    case "gas-price":
    case "block-age":
      only(r, ["kind"], `${where}.read`);
      return { kind: r.kind };
    case "call": {
      only(r, ["kind", "to", "signature", "args", "decimals"], `${where}.read`);
      const signature = text(r.signature, `${where}.read.signature`, 120);
      const sig = parseSignature(signature);
      const args = r.args === undefined ? [] : r.args;
      if (!Array.isArray(args) || args.length > LIMITS.args || !args.every((arg) => ["string", "number", "boolean"].includes(typeof arg))) throw bad(`${where}.read.args must be a list of at most ${LIMITS.args} plain values.`);
      if (args.length !== sig.abi.inputs.length) throw bad(`${where}.read.args has ${args.length} values; ${sig.text} takes ${sig.abi.inputs.length}.`);
      const decimals = r.decimals === undefined || r.decimals === null ? null : r.decimals;
      if (decimals !== null && (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 36)) throw bad(`${where}.read.decimals must be an integer from 0 to 36.`);
      return { kind: "call", to: address(r.to, `${where}.read.to`), signature, args: args as (string | number | boolean)[], decimals: decimals as number | null };
    }
    default:
      throw bad(`${where}.read.kind must be one of erc20-balance, native-balance, call, has-code, gas-price, block-age, nonce.`);
  }
}

/** The threshold, checked against the kind of value the read produces. Token amounts are checked once decimals are known. */
function checkThreshold(read: Read, op: Comparator, value: unknown, where: string): string | number | boolean {
  const type = readValueType(read);
  if (type !== "number" && op !== "==" && op !== "!=") throw bad(`${where}: a ${type === "bool" ? "yes/no" : "address"} value can only be compared with == or !=.`);
  if (type === "bool") {
    if (typeof value !== "boolean") throw bad(`${where}.value must be true or false.`);
    return value;
  }
  if (type === "address") return address(value, `${where}.value`);
  if (typeof value !== "string" && typeof value !== "number") throw bad(`${where}.value must be a number.`);
  switch (read.kind) {
    case "gas-price":
      parseGasPrice(value);
      return value;
    case "block-age":
    case "nonce":
      if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) throw bad(`${where}.value must be a whole number.`);
      return Number(value);
    case "native-balance":
      parseAmount(value, 18, `${where}.value`);
      return value;
    case "call":
      parseAmount(value, read.decimals ?? 0, `${where}.value`);
      return value;
    default:
      // erc20-balance: decimals come from the token on-chain; the shape is checked now.
      parseAmount(value, 36, `${where}.value`);
      return value;
  }
}

function parseAction(raw: unknown): Action {
  const a = record(raw, "action");
  if (a.type === "erc20-transfer") {
    only(a, ["type", "token", "from", "to", "amount"], "action");
    parseAmount(String(a.amount ?? ""), 36, "action.amount");
    return { type: "erc20-transfer", token: address(a.token, "action.token"), from: address(a.from, "action.from"), to: address(a.to, "action.to"), amount: String(a.amount) };
  }
  if (a.type === "native-transfer") {
    only(a, ["type", "from", "to", "amount"], "action");
    parseAmount(String(a.amount ?? ""), 18, "action.amount");
    return { type: "native-transfer", from: address(a.from, "action.from"), to: address(a.to, "action.to"), amount: String(a.amount) };
  }
  throw bad("action.type must be erc20-transfer or native-transfer.");
}

/** A guardian from untrusted JSON (a file, a preset, an API body): every field checked, nothing extra kept. */
export function parseGuardianConfig(input: unknown): GuardianConfig {
  const c = record(input, "The guardian");
  only(c, ["name", "network", "fireWhen", "conditions", "action"], "The guardian");
  const name = text(c.name, "name", LIMITS.name);
  if (typeof c.network !== "string" || !(c.network in NETWORKS)) throw bad("network must be pharos-mainnet or atlantic-testnet.");
  if (!Array.isArray(c.conditions) || c.conditions.length === 0 || c.conditions.length > LIMITS.conditions) throw bad(`conditions must list 1 to ${LIMITS.conditions} conditions.`);
  const ids = new Set<string>();
  const conditions = c.conditions.map((raw, index): Condition => {
    const where = `conditions[${index}]`;
    const cond = record(raw, where);
    only(cond, ["id", "label", "read", "op", "value"], where);
    const id = text(cond.id, `${where}.id`, 40);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw bad(`${where}.id must be lowercase letters, digits and dashes.`);
    if (ids.has(id)) throw bad(`Two conditions share the id "${id}".`);
    ids.add(id);
    const read = parseRead(cond.read, where);
    if (typeof cond.op !== "string" || !COMPARATORS.includes(cond.op as Comparator)) throw bad(`${where}.op must be one of ${COMPARATORS.join(" ")}.`);
    const op = cond.op as Comparator;
    return { id, label: text(cond.label, `${where}.label`, LIMITS.label), read, op, value: checkThreshold(read, op, cond.value, where) };
  });
  let fireWhen: FireWhen;
  if (c.fireWhen === "all" || c.fireWhen === "any") fireWhen = c.fireWhen;
  else {
    const rule = record(c.fireWhen, "fireWhen");
    const atLeast = rule.atLeast;
    if (!Number.isInteger(atLeast) || (atLeast as number) < 1 || (atLeast as number) > conditions.length) throw bad(`fireWhen must be "all", "any" or { "atLeast": 1 to ${conditions.length} }.`);
    fireWhen = { atLeast: atLeast as number };
  }
  return { name, network: c.network as NetworkId, fireWhen, conditions, action: parseAction(c.action) };
}

/** "all 6", "any of 6", "at least 4 of 6". */
export function describeRule(rule: FireWhen, total: number): string {
  if (rule === "all") return `all ${total}`;
  if (rule === "any") return `any of ${total}`;
  return `at least ${rule.atLeast} of ${total}`;
}
