// Task 05: deciding. Pure functions from observed values to the decision, shared by the live run and the
// offline proof verifier, so a proof is checked by the same rules that made it.
import { parseSignature } from "../core/abi.js";
import { formatAmount, formatGwei, parseAmount, parseGasPrice } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import type { Comparator, Condition, FireWhen } from "./config.js";

/** A value as read: integers in base units (with the decimals and unit to show them), a yes/no, or an address. */
export type Value = { type: "number"; raw: bigint; decimals: number; unit: string } | { type: "bool"; value: boolean } | { type: "address"; value: Address };

export interface ConditionOutcome {
  id: string;
  label: string;
  /** The Chain MCP tool that read the value. */
  tool: string;
  op: Comparator;
  observed: string | null;
  threshold: string;
  /** null when the value could not be read: never counted as passing. */
  passed: boolean | null;
  error: string | null;
}

export interface Decision {
  fire: boolean;
  passed: number;
  total: number;
  failed: string[];
  unreadable: string[];
  summary: string;
}

/** The Chain MCP tool behind each kind of read. */
export function toolFor(condition: Condition): string {
  switch (condition.read.kind) {
    case "erc20-balance":
    case "call":
      return "eth_call";
    case "native-balance":
      return "get_balance";
    case "has-code":
      return "get_code";
    case "gas-price":
      return "get_gas_price";
    case "block-age":
      return "get_block";
    case "nonce":
      return "get_transaction_count";
  }
}

/** The threshold as a Value of the same kind as the reading; `decimals` is the token's, for token balances. */
export function thresholdValue(condition: Condition, decimals: number, unit: string): Value {
  const { read, value } = condition;
  if (typeof value === "boolean") return { type: "bool", value };
  if (read.kind === "call" && parseSignature(read.signature).returns === "address") return { type: "address", value: String(value) as Address };
  switch (read.kind) {
    case "gas-price":
      return { type: "number", raw: parseGasPrice(value), decimals: 9, unit: "gwei" };
    case "block-age":
      return { type: "number", raw: BigInt(value), decimals: 0, unit: "s" };
    case "nonce":
      return { type: "number", raw: BigInt(value), decimals: 0, unit: "" };
    case "native-balance":
      return { type: "number", raw: parseAmount(value, 18), decimals: 18, unit };
    case "call":
      return { type: "number", raw: parseAmount(value, read.decimals ?? 0), decimals: read.decimals ?? 0, unit };
    default:
      return { type: "number", raw: parseAmount(value, decimals), decimals, unit };
  }
}

export function display(value: Value): string {
  if (value.type === "bool") return String(value.value);
  if (value.type === "address") return value.value;
  if (value.unit === "gwei") return formatGwei(value.raw);
  const amount = formatAmount(value.raw, value.decimals, value.decimals === 0 ? 0 : 6);
  if (value.unit === "s") return `${amount} s`;
  return value.unit ? `${amount} ${value.unit}` : amount;
}

export function compare(observed: Value, op: Comparator, threshold: Value): boolean {
  if (observed.type === "number" && threshold.type === "number") {
    const [a, b] = [observed.raw, threshold.raw];
    return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "==" ? a === b : a !== b;
  }
  if (observed.type === "bool" && threshold.type === "bool") return op === "==" ? observed.value === threshold.value : observed.value !== threshold.value;
  if (observed.type === "address" && threshold.type === "address") {
    const same = observed.value.toLowerCase() === threshold.value.toLowerCase();
    return op === "==" ? same : !same;
  }
  throw new Error(`Cannot compare a ${observed.type} with a ${threshold.type}.`);
}

/**
 * A value as the condition means it: whether an address has contract code, or what a yes/no call
 * returned ("paused() = false"), rather than a bare true or false.
 */
export function describe(condition: Condition, value: Value): string {
  if (value.type === "bool" && condition.read.kind === "has-code") return value.value ? "contract code" : "no contract code";
  if (value.type === "bool" && condition.read.kind === "call") return `${parseSignature(condition.read.signature).abi.name}() = ${value.value}`;
  return display(value);
}

export function outcome(condition: Condition, observed: Value | null, threshold: Value, error: string | null = null): ConditionOutcome {
  return {
    id: condition.id,
    label: condition.label,
    tool: toolFor(condition),
    op: condition.op,
    observed: observed ? describe(condition, observed) : null,
    threshold: describe(condition, threshold),
    passed: observed && !error ? compare(observed, condition.op, threshold) : null,
    error,
  };
}

/** Fire only when the rule holds; a value that could not be read never counts as passing. */
export function decide(rule: FireWhen, outcomes: readonly ConditionOutcome[]): Decision {
  const total = outcomes.length;
  const passed = outcomes.filter((o) => o.passed === true).length;
  const failed = outcomes.filter((o) => o.passed === false).map((o) => o.id);
  const unreadable = outcomes.filter((o) => o.passed === null).map((o) => o.id);
  const needed = rule === "all" ? total : rule === "any" ? 1 : rule.atLeast;
  const fire = passed >= needed;
  const missing = needed - passed;
  const summary = fire
    ? `${passed} of ${total} conditions hold; the rule needs ${needed}.`
    : `${passed} of ${total} conditions hold; the rule needs ${needed}${unreadable.length ? `, and ${unreadable.length} could not be read` : ""}. ${missing} short.`;
  return { fire, passed, total, failed, unreadable, summary };
}
