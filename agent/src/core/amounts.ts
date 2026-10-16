// Amounts in human units, exactly: "1,250.5" USDC, "5 gwei", "0.01" PROS. Nothing here goes through a
// float, so a threshold compares bit for bit with the chain's integer.
import { formatUnits, parseUnits } from "viem";
import { AgentError } from "./errors.js";

/** "1,250.50" with `decimals` → base units. Rejects signs, exponents and more fraction digits than the token has. */
export function parseAmount(text: string | number, decimals: number, what = "amount"): bigint {
  const raw = String(text).trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new AgentError("usage", `${what} must be a plain non-negative number, got "${text}".`);
  const fraction = raw.split(".")[1] ?? "";
  if (fraction.length > decimals) throw new AgentError("usage", `${what} has more than ${decimals} decimal places: "${text}".`);
  return parseUnits(raw, decimals);
}

/** A gas price: "5 gwei", "1500000000 wei", or a bare number of gwei. */
export function parseGasPrice(text: string | number): bigint {
  const match = /^\s*([\d.,]+)\s*(gwei|wei)?\s*$/i.exec(String(text));
  if (!match) throw new AgentError("usage", `A gas price looks like "5 gwei", got "${text}".`);
  return (match[2] ?? "gwei").toLowerCase() === "wei" ? parseAmount(match[1]!, 0, "gas price") : parseAmount(match[1]!, 9, "gas price");
}

/** Base units → "1,250.5" (trailing zeros dropped, at most `maxFraction` digits, thousands grouped). */
export function formatAmount(value: bigint, decimals: number, maxFraction = 6): string {
  const negative = value < 0n;
  const [whole, fraction = ""] = formatUnits(negative ? -value : value, decimals).split(".");
  const cut = fraction.slice(0, maxFraction).replace(/0+$/, "");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const shown = cut ? `${grouped}.${cut}` : grouped;
  // A tiny non-zero value must not read as zero.
  if (shown === "0" && value !== 0n) return `${negative ? "-" : ""}<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return `${negative ? "-" : ""}${shown}`;
}

/** Wei → "1.25 gwei". */
export function formatGwei(wei: bigint): string {
  return `${formatAmount(wei, 9, 4)} gwei`;
}
