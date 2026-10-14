import { toHex } from "viem";
import { MAX_BLOCK_RANGE, MAX_RANGES_PER_POLL, RETRY_DELAY_MS, SEEN_CAPACITY } from "./constants.js";
import { CliError, shorten, toCliError, ToolCallError } from "./errors.js";
import type { ToolCaller } from "./mcp-client.js";
import { decodeTransfer, logBlock, logKey, type RawLog, type Token, type TransferEvent } from "./transfer.js";

/** An inclusive block range. */
export interface Range {
  from: bigint;
  to: bigint;
}

/** The exact arguments of one get_logs call: always this address, this topic0 and an explicit hex range. */
export interface GetLogsArgs {
  address: string;
  topics: [string];
  fromBlock: Hex;
  toBlock: Hex;
}
type Hex = `0x${string}`;

export interface RangeResult extends Range {
  ok: boolean;
  /** get_logs calls made for this range: 1, or 2 when the first failed and the same range was repeated. */
  attempts: number;
  logs: number;
  error?: string;
}

/** A log that was already reported, then came back with removed: true (its block left the canonical chain). */
export interface Retraction {
  key: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
}

export interface Malformed {
  key: string | null;
  blockNumber: string | null;
  reason: string;
}

export interface SkipCounts {
  /** Same transactionHash + logIndex as an event already reported. */
  duplicate: number;
  /** removed: true for a log never reported: dropped silently, by policy. */
  removed: number;
  malformed: number;
  /** Outside the block range that was asked for: the server did not honor the range. Picked up when its own range is queried. */
  outsideRange: number;
  /** Not the watched address or not the Transfer topic0: the server did not honor the filter. */
  wrongFilter: number;
}

export interface PollResult {
  cycle: number;
  /** Head block resolved for this poll; undefined when get_block_number failed. */
  head?: bigint;
  cursorBefore?: bigint;
  cursorAfter?: bigint;
  ranges: RangeResult[];
  events: TransferEvent[];
  retractions: Retraction[];
  /** Keys of removed logs that were never reported (counted in skipped.removed). */
  removedKeys: string[];
  malformed: Malformed[];
  skipped: SkipCounts;
  /** True when the cursor reached the poll's target (more ranges remain when MAX_RANGES_PER_POLL cut it short). */
  caughtUp: boolean;
  error?: CliError;
}

export interface MonitorOptions {
  token: Token;
  topic: string;
  /** Watch mode, first poll: start this many blocks before the head (0: only blocks mined after the first poll). */
  lookback?: bigint;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  seenCapacity?: number;
  maxRangesPerPoll?: number;
}

/** Split from..to into contiguous inclusive ranges of at most `size` blocks, oldest first, at most `limit` of them. */
export function planRanges(from: bigint, to: bigint, size: bigint = MAX_BLOCK_RANGE, limit = Number.POSITIVE_INFINITY): Range[] {
  if (size < 1n) throw new RangeError("range size must be at least 1");
  const ranges: Range[] = [];
  for (let start = from; start <= to && ranges.length < limit; start += size) {
    const end = start + size - 1n;
    ranges.push({ from: start, to: end < to ? end : to });
  }
  return ranges;
}

export function getLogsArgs(token: Token, topic: string, range: Range): GetLogsArgs {
  return { address: token.address, topics: [topic], fromBlock: toHex(range.from), toBlock: toHex(range.to) };
}

/**
 * Polls Chain MCP for Transfer logs of one contract and reports each log once.
 *
 * The cursor is the last block whose logs are fully processed. A poll resolves the head with
 * get_block_number, then queries only the blocks after the cursor, in ranges of at most 1,000
 * blocks, each call carrying the exact address, the Transfer topic0 and explicit hex bounds. The
 * cursor moves to a range's last block only after that call succeeded and all its logs were
 * processed; a failed range stops the poll with the cursor unchanged, so the next poll asks for
 * exactly the same range again. Reported events are remembered by transactionHash + logIndex, so a
 * log the server returns twice is never reported twice.
 */
export class TransferMonitor {
  cursor: bigint | undefined;
  private cycles = 0;
  /** key -> block of reported events, in insertion order so the oldest can be evicted. */
  private readonly seen = new Map<string, bigint>();
  readonly totals: SkipCounts & { polls: number; getLogsCalls: number; logs: number; reported: number; retracted: number } = {
    polls: 0,
    getLogsCalls: 0,
    logs: 0,
    reported: 0,
    retracted: 0,
    duplicate: 0,
    removed: 0,
    malformed: 0,
    outsideRange: 0,
    wrongFilter: 0,
  };

  constructor(
    private caller: ToolCaller,
    private readonly options: MonitorOptions,
  ) {}

  /** Replace the MCP session (watch mode reconnects after a connection failure). State is kept. */
  setCaller(caller: ToolCaller): void {
    this.caller = caller;
  }

  get seenCount(): number {
    return this.seen.size;
  }

  async readHead(): Promise<bigint> {
    return parseBlockNumber(await this.caller.call<unknown>("get_block_number", {}));
  }

  /**
   * One poll. `head` skips get_block_number when the caller already resolved it (finite mode);
   * `upTo` caps the target block (finite mode's --to-block). Never throws: a failure is returned in
   * `error`, together with whatever the ranges before it committed.
   */
  async poll(options: { head?: bigint; upTo?: bigint } = {}): Promise<PollResult> {
    this.cycles += 1;
    this.totals.polls += 1;
    const result: PollResult = {
      cycle: this.cycles,
      cursorBefore: this.cursor,
      ranges: [],
      events: [],
      retractions: [],
      removedKeys: [],
      malformed: [],
      skipped: { duplicate: 0, removed: 0, malformed: 0, outsideRange: 0, wrongFilter: 0 },
      caughtUp: false,
    };

    let head: bigint;
    try {
      head = options.head ?? (await this.readHead());
    } catch (error) {
      result.error = toCliError(error);
      return result;
    }
    result.head = head;
    if (this.cursor === undefined) {
      const start = head - (this.options.lookback ?? 0n);
      this.cursor = start < -1n ? -1n : start;
      result.cursorBefore = this.cursor;
    }

    const target = options.upTo !== undefined && options.upTo < head ? options.upTo : head;
    const limit = this.options.maxRangesPerPoll ?? MAX_RANGES_PER_POLL;
    for (const range of planRanges(this.cursor + 1n, target, MAX_BLOCK_RANGE, limit)) {
      const entry: RangeResult = { ...range, ok: false, attempts: 0, logs: 0 };
      result.ranges.push(entry);
      let logs: RawLog[];
      try {
        logs = await this.fetchRange(range, entry);
      } catch (error) {
        result.error = toCliError(error);
        entry.error = result.error.message;
        break;
      }
      entry.ok = true;
      entry.logs = logs.length;
      this.totals.logs += logs.length;
      this.processLogs(range, logs, result);
      // Only now, with the call succeeded and every log processed, does the cursor move.
      this.cursor = range.to;
    }
    result.cursorAfter = this.cursor;
    result.caughtUp = result.error === undefined && this.cursor >= target;
    return result;
  }

  /** get_logs for one range; a transient failure repeats the very same arguments once. */
  private async fetchRange(range: Range, entry: RangeResult): Promise<RawLog[]> {
    const args = Object.freeze(getLogsArgs(this.options.token, this.options.topic, range));
    for (let attempt = 1; ; attempt += 1) {
      entry.attempts = attempt;
      this.totals.getLogsCalls += 1;
      try {
        const payload = await this.caller.call<unknown>("get_logs", { ...args, topics: [...args.topics] });
        if (!Array.isArray(payload)) {
          throw new ToolCallError("get_logs", `expected an array of logs, got ${shorten(JSON.stringify(payload) ?? "undefined", 120)}`);
        }
        return payload as RawLog[];
      } catch (error) {
        if (attempt >= 2 || !isRetryable(error)) throw error;
        await (this.options.sleep ?? delay)(this.options.retryDelayMs ?? RETRY_DELAY_MS);
      }
    }
  }

  private processLogs(range: Range, logs: RawLog[], result: PollResult): void {
    const { token, topic } = this.options;
    for (const log of [...logs].sort(byPosition)) {
      if (log === null || typeof log !== "object" || Array.isArray(log)) {
        this.skipMalformed(result, { key: null, blockNumber: null, reason: "not an object" });
        continue;
      }
      const topic0 = Array.isArray(log.topics) ? log.topics[0] : undefined;
      if (String(log.address).toLowerCase() !== token.address.toLowerCase() || String(topic0).toLowerCase() !== topic) {
        this.count(result, "wrongFilter");
        continue;
      }
      const block = logBlock(log);
      const key = logKey(log) ?? null;
      if (block === undefined) {
        this.skipMalformed(result, { key, blockNumber: null, reason: "blockNumber is missing or not a hex quantity" });
        continue;
      }
      if (block < range.from || block > range.to) {
        this.count(result, "outsideRange");
        continue;
      }
      // Removed-log policy: a removed log is never reported as an event. If it had been reported,
      // a retraction is reported and its key forgotten; otherwise it is only counted.
      if (log.removed === true) {
        if (key !== null && this.seen.has(key)) {
          this.seen.delete(key);
          this.totals.retracted += 1;
          result.retractions.push({ key, transactionHash: String(log.transactionHash).toLowerCase(), logIndex: Number(BigInt(String(log.logIndex))), blockNumber: block });
        } else {
          this.count(result, "removed");
          if (key !== null) result.removedKeys.push(key);
        }
        continue;
      }
      if (log.removed !== undefined && log.removed !== false) {
        this.skipMalformed(result, { key, blockNumber: block.toString(), reason: "removed is not a boolean" });
        continue;
      }
      const decoded = decodeTransfer(log, token);
      if (!decoded.ok) {
        this.skipMalformed(result, { key, blockNumber: block.toString(), reason: decoded.reason });
        continue;
      }
      if (this.seen.has(decoded.event.key)) {
        this.count(result, "duplicate");
        continue;
      }
      this.remember(decoded.event);
      this.totals.reported += 1;
      result.events.push(decoded.event);
    }
  }

  private remember(event: TransferEvent): void {
    this.seen.set(event.key, event.blockNumber);
    const capacity = this.options.seenCapacity ?? SEEN_CAPACITY;
    while (this.seen.size > capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  private count(result: PollResult, kind: keyof SkipCounts): void {
    result.skipped[kind] += 1;
    this.totals[kind] += 1;
  }

  private skipMalformed(result: PollResult, entry: Malformed): void {
    result.malformed.push(entry);
    this.count(result, "malformed");
  }
}

/**
 * Worth repeating the same range once: a tool error from the server's upstream RPC (a lagging node,
 * a timeout) or a payload that was not a log array. Not: rejected arguments, a missing tool, or a
 * lost connection (watch mode reconnects on the next poll instead).
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ToolCallError) return !error.isInvalidParams && !/block range too large/i.test(error.detail);
  return false;
}

export function parseBlockNumber(payload: unknown): bigint {
  const record = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const { blockNumber, blockNumberHex } = record;
  if (typeof blockNumber === "string" && /^\d+$/.test(blockNumber)) return BigInt(blockNumber);
  if (typeof blockNumber === "number" && Number.isSafeInteger(blockNumber) && blockNumber >= 0) return BigInt(blockNumber);
  if (typeof blockNumberHex === "string" && /^0x[0-9a-fA-F]+$/.test(blockNumberHex)) return BigInt(blockNumberHex);
  throw new CliError("MCP_TOOL_ERROR", `get_block_number returned an unexpected payload: ${shorten(JSON.stringify(payload) ?? "undefined", 160)}`);
}

/** Block, then logIndex; logs without a readable position keep their relative order at the front. */
function byPosition(a: RawLog, b: RawLog): number {
  const position = (log: RawLog): [bigint, bigint] => {
    if (log === null || typeof log !== "object") return [-1n, -1n];
    const index = typeof log.logIndex === "string" && /^0x[0-9a-f]+$/i.test(log.logIndex) ? BigInt(log.logIndex) : -1n;
    return [logBlock(log) ?? -1n, index];
  };
  const [blockA, indexA] = position(a);
  const [blockB, indexB] = position(b);
  if (blockA !== blockB) return blockA < blockB ? -1 : 1;
  return indexA === indexB ? 0 : indexA < indexB ? -1 : 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

