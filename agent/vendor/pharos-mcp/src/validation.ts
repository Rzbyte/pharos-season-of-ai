import { isAddress, isHex } from "viem";

export function assertAddress(value: string, label = "address"): `0x${string}` {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${label} must be a valid EVM address`);
  }
  return value as `0x${string}`;
}

export function assertHash(value: string, label = "hash"): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a 32-byte hex hash`);
  }
  return value as `0x${string}`;
}

export function assertHex(value: string, label = "hex value"): `0x${string}` {
  if (!isHex(value)) {
    throw new Error(`${label} must be 0x-prefixed hexadecimal data`);
  }
  return value as `0x${string}`;
}

export function normalizeBlockTag(value: string | number | undefined): string {
  if (value === undefined) return "latest";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("block must be non-negative");
    return `0x${value.toString(16)}`;
  }
  const normalized = value.trim().toLowerCase();
  if (["latest", "earliest", "pending", "safe", "finalized"].includes(normalized)) {
    return normalized;
  }
  if (/^0x[0-9a-f]+$/.test(normalized)) return normalized;
  if (/^[0-9]+$/.test(normalized)) return `0x${BigInt(normalized).toString(16)}`;
  throw new Error("block must be a named tag, decimal number, or hex quantity");
}
