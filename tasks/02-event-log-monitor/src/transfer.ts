import { getAddress, type Address, type Hex } from "viem";
import { TRANSFER_TOPIC } from "./constants.js";
import { formatTokenAmount } from "./format.js";

/** One entry of a get_logs result, as eth_getLogs returns it. Every field is checked before use. */
export interface RawLog {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
  blockHash?: unknown;
  blockTimestamp?: unknown;
  transactionHash?: unknown;
  transactionIndex?: unknown;
  logIndex?: unknown;
  removed?: unknown;
}

export type TransferKind = "Transfer" | "Mint" | "Burn";

export interface Token {
  address: string;
  symbol: string;
  decimals: number;
}

export interface TransferEvent {
  /** Dedup key: transactionHash + ":" + logIndex (both lowercase hex, as the log carries them). */
  key: string;
  kind: TransferKind;
  from: Address;
  to: Address;
  amountRaw: bigint;
  /** Exact decimal amount (raw / 10^decimals), integer part grouped: "1,250.5". */
  amount: string;
  symbol: string;
  transactionHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  summary: string;
}

export type DecodeResult = { ok: true; event: TransferEvent } | { ok: false; reason: string };

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const HEX_QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
/** An indexed address topic: 32 bytes, the address left-padded with 12 zero bytes. */
const ADDRESS_TOPIC = /^0x0{24}([0-9a-f]{40})$/i;
/** A single uint256: exactly 32 bytes of data. */
const UINT256_DATA = /^0x[0-9a-f]{64}$/i;

/**
 * Dedup key of a log, from the two fields that identify it on chain. undefined when either is
 * missing or malformed (such a log is reported as malformed, never deduplicated by accident).
 */
export function logKey(log: RawLog): string | undefined {
  const { transactionHash, logIndex } = log;
  if (typeof transactionHash !== "string" || !HASH.test(transactionHash)) return undefined;
  if (typeof logIndex !== "string" || !HEX_QUANTITY.test(logIndex)) return undefined;
  return `${transactionHash.toLowerCase()}:${BigInt(logIndex).toString()}`;
}

/** Block number of a log, or undefined when it is missing or not a hex quantity (a pending log has null). */
export function logBlock(log: RawLog): bigint | undefined {
  return typeof log.blockNumber === "string" && HEX_QUANTITY.test(log.blockNumber) ? BigInt(log.blockNumber) : undefined;
}

/**
 * Strictly decode one ERC-20 Transfer log of `token`. Anything that is not exactly the expected
 * shape is rejected with a reason instead of being guessed at: three topics (signature, from, to),
 * from and to as zero-padded 20-byte addresses, and data holding one 32-byte uint256 amount.
 * An ERC-721 Transfer (tokenId as a fourth topic, empty data) fails here, as it should.
 */
export function decodeTransfer(log: RawLog, token: Token): DecodeResult {
  if (log === null || typeof log !== "object" || Array.isArray(log)) return fail("not an object");
  const { address, topics, data, transactionHash } = log;

  if (typeof address !== "string" || !ADDRESS.test(address)) return fail("address is missing or not a 20-byte hex address");
  if (address.toLowerCase() !== token.address.toLowerCase()) return fail(`emitted by ${address}, not the watched contract`);
  if (!Array.isArray(topics)) return fail("topics is not an array");
  if (topics.length !== 3) return fail(`expected 3 topics (signature, from, to), got ${topics.length}`);
  const [signature, fromTopic, toTopic] = topics as unknown[];
  if (typeof signature !== "string" || signature.toLowerCase() !== TRANSFER_TOPIC) return fail("topic0 is not the Transfer signature");
  const from = topicAddress(fromTopic);
  if (!from) return fail("topic1 (from) is not a zero-padded 20-byte address");
  const to = topicAddress(toTopic);
  if (!to) return fail("topic2 (to) is not a zero-padded 20-byte address");
  if (typeof data !== "string" || !UINT256_DATA.test(data)) return fail("data is not exactly one 32-byte uint256");
  if (typeof transactionHash !== "string" || !HASH.test(transactionHash)) return fail("transactionHash is missing or not 32 bytes");
  const blockNumber = logBlock(log);
  if (blockNumber === undefined) return fail("blockNumber is missing or not a hex quantity");
  const key = logKey(log);
  if (key === undefined) return fail("logIndex is missing or not a hex quantity");
  const logIndex = Number(BigInt(log.logIndex as string));
  if (!Number.isSafeInteger(logIndex)) return fail("logIndex is out of range");

  const amountRaw = BigInt(data);
  const kind = classify(from, to);
  const amount = formatTokenAmount(amountRaw, token.decimals);
  return {
    ok: true,
    event: {
      key,
      kind,
      from,
      to,
      amountRaw,
      amount,
      symbol: token.symbol,
      transactionHash: transactionHash.toLowerCase() as Hex,
      blockNumber,
      logIndex,
      summary: summarize(kind, `${amount} ${token.symbol}`, from, to),
    },
  };
}

/**
 * Deterministic, from the two addresses only: from the zero address is a Mint, to the zero address
 * is a Burn, anything else is a Transfer. Mint wins when both are zero.
 */
export function classify(from: Address, to: Address): TransferKind {
  if (from === ZERO_ADDRESS) return "Mint";
  if (to === ZERO_ADDRESS) return "Burn";
  return "Transfer";
}

export function summarize(kind: TransferKind, amount: string, from: Address, to: Address): string {
  if (kind === "Mint") return `${amount} minted to ${shortAddress(to)}`;
  if (kind === "Burn") return `${amount} burned from ${shortAddress(from)}`;
  return `${amount} transferred from ${shortAddress(from)} to ${shortAddress(to)}`;
}

/** "0x1234…abcd": the first 4 and last 4 hex digits of the checksummed address. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function topicAddress(topic: unknown): Address | undefined {
  if (typeof topic !== "string") return undefined;
  const match = ADDRESS_TOPIC.exec(topic);
  return match ? getAddress(`0x${match[1]!.toLowerCase()}`) : undefined;
}

function fail(reason: string): DecodeResult {
  return { ok: false, reason };
}
