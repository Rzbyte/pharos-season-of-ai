// Task 26: the period a report covers, from what was asked to the blocks that fall in it.
//
// A period is the last N hours (ending at the newest block's time), two times (`since` to `until`), or two
// blocks. A block is in a time period when its timestamp is after `since` and at or before `until`, so
// back-to-back periods never share a block. Times are placed with get_block: the search interpolates on
// the chain's own pace between two block times, and bisects where that is slow, so a regular chain costs a
// few calls and an irregular one at most a few dozen.
import type { BlockHeader, Chain } from "../core/chain.js";
import { AgentError } from "../core/errors.js";

export type PeriodRequest = { kind: "hours"; hours: number } | { kind: "time"; since: string; until: string | null } | { kind: "blocks"; from: string; to: string };

export interface ResolvedPeriod {
  from: { number: bigint; timestamp: bigint };
  to: { number: bigint; timestamp: bigint };
  /** The asked period was longer than a report reads: its first block and length, before trimming. */
  trimmed: { from: bigint; blocks: bigint } | null;
  /** "in the last hour", "from 17 Oct 2026, 09:00 to 15:00 UTC", "in blocks 1,000 to 2,000". */
  description: string;
}

export const MAX_HOURS = 168;
/** The most get_block calls one search may make. */
const MAX_SEARCH = 48;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const group = (n: bigint | number) => n.toLocaleString("en-US");
const two = (n: number) => String(n).padStart(2, "0");

/** A time as ISO 8601; one with no zone is UTC, so the same input means the same time anywhere. */
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

function parseTime(text: string, what: string): string {
  const trimmed = text.trim();
  if (!ISO.test(trimmed)) throw new AgentError("usage", `${what} must be a date and time, like 2026-10-17T09:00Z (UTC when no zone is given).`);
  // Date.parse rolls 30 February over into March: check the calendar and the clock first.
  const [year, month, day, hour = 0, minute = 0, second = 0] = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/)!.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  if (calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw new AgentError("usage", `${what} is not a real date and time: ${trimmed}.`);
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed) ? trimmed : `${trimmed}${trimmed.includes("T") ? "" : "T00:00"}Z`;
  return new Date(Date.parse(zoned)).toISOString();
}

/** A period from untrusted input (CLI flags, an API query): at most one kind, every field checked. */
export function parsePeriod(input: { hours?: string; since?: string; until?: string; fromBlock?: string; toBlock?: string }): PeriodRequest {
  const time = input.since !== undefined || input.until !== undefined;
  const blocks = input.fromBlock !== undefined || input.toBlock !== undefined;
  if ([input.hours !== undefined, time, blocks].filter(Boolean).length > 1) throw new AgentError("usage", "Give the period one way: hours, a since/until time, or from/to blocks.");
  if (blocks) {
    if (input.fromBlock === undefined || input.toBlock === undefined) throw new AgentError("usage", "A block period needs both its first and its last block.");
    if (!/^\d{1,12}$/.test(input.fromBlock) || !/^\d{1,12}$/.test(input.toBlock)) throw new AgentError("usage", "Blocks must be whole numbers.");
    if (BigInt(input.fromBlock) > BigInt(input.toBlock)) throw new AgentError("usage", "The first block must not be after the last.");
    return { kind: "blocks", from: BigInt(input.fromBlock).toString(), to: BigInt(input.toBlock).toString() };
  }
  if (time) {
    if (input.since === undefined) throw new AgentError("usage", "A time period needs its start (since).");
    const since = parseTime(input.since, "since");
    const until = input.until === undefined || input.until.trim() === "" ? null : parseTime(input.until, "until");
    if (until !== null && Date.parse(until) <= Date.parse(since)) throw new AgentError("usage", "until must be after since.");
    return { kind: "time", since, until };
  }
  const hours = input.hours ?? "1";
  if (!/^\d{1,3}$/.test(hours) || Number(hours) < 1 || Number(hours) > MAX_HOURS) throw new AgentError("usage", `hours must be a whole number from 1 to ${MAX_HOURS}.`);
  return { kind: "hours", hours: Number(hours) };
}

/** "17 Oct 2026" and "09:00" (seconds only when there are some), in UTC. */
export function utcParts(seconds: bigint): { date: string; time: string } {
  const d = new Date(Number(seconds) * 1000);
  const s = d.getUTCSeconds();
  return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, time: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${s ? `:${two(s)}` : ""}` };
}

/** "17 Oct 2026, 09:00 to 15:00 UTC", or with both dates when they differ. */
export function utcSpan(start: bigint, end: bigint): string {
  const [a, b] = [utcParts(start), utcParts(end)];
  return a.date === b.date ? `${a.date}, ${a.time} to ${b.time} UTC` : `${a.date} ${a.time} to ${b.date} ${b.time} UTC`;
}

/**
 * Reads block times through get_block, each block once. The first block after `target`: the newest
 * block's number plus one when none is.
 */
export class BlockClock {
  private readonly seen = new Map<bigint, bigint>();
  private searches = 0;

  constructor(
    private readonly chain: Chain,
    readonly head: BlockHeader,
  ) {
    this.seen.set(head.number, head.timestamp);
  }

  async time(n: bigint): Promise<bigint> {
    const known = this.seen.get(n);
    if (known !== undefined) return known;
    if ((this.searches += 1) > MAX_SEARCH) throw new AgentError("unexpected", `Placing the period took more than ${MAX_SEARCH} block reads; the chain's block times are too irregular to search.`);
    const t = (await this.chain.block(n)).timestamp;
    this.seen.set(n, t);
    return t;
  }

  async firstAfter(target: bigint): Promise<bigint> {
    let hi = this.head.number;
    let tHi = this.head.timestamp;
    if (tHi <= target) return hi + 1n;
    // Step back until a block at or before the target: 1,000 blocks first, then as far as the pace seen says.
    let lo: bigint;
    let tLo: bigint;
    let span = 1000n;
    for (;;) {
      const probe = hi - span > 0n ? hi - span : 0n;
      const t = await this.time(probe);
      if (t <= target) {
        [lo, tLo] = [probe, t];
        break;
      }
      if (probe === 0n) return 0n;
      // Blocks back from the probe to the target, at the pace between the probe and the last block read.
      const guess = tHi > t ? ((t - target) * (hi - probe)) / (tHi - t) : 0n;
      [hi, tHi] = [probe, t];
      span = guess + guess / 5n + 10n > span * 2n ? guess + guess / 5n + 10n : span * 2n;
    }
    // Now lo is at or before the target and hi after it. Guess the first block after the target at the
    // pace between them, and read it and the one before: on a regular chain that settles it. A guess that
    // did not halve the gap is followed by a bisection, so an irregular chain still converges.
    let interpolate = true;
    while (hi - lo > 1n) {
      const width = hi - lo;
      if (interpolate && tHi > tLo) {
        let guess = lo + ((target - tLo) * width) / (tHi - tLo) + 1n;
        if (guess <= lo) guess = lo + 1n;
        if (guess > hi) guess = hi;
        for (const n of [guess - 1n, guess]) {
          if (n <= lo || n >= hi) continue;
          const t = await this.time(n);
          if (t <= target) [lo, tLo] = [n, t];
          else {
            [hi, tHi] = [n, t];
            break;
          }
        }
      } else {
        const mid = lo + width / 2n;
        const t = await this.time(mid);
        if (t <= target) [lo, tLo] = [mid, t];
        else [hi, tHi] = [mid, t];
      }
      interpolate = (hi - lo) * 2n <= width;
    }
    return hi;
  }
}

/** The blocks a period covers, at most `maxBlocks` (the newest of a longer period). */
export async function resolvePeriod(period: PeriodRequest, clock: BlockClock, maxBlocks: number): Promise<ResolvedPeriod> {
  const head = clock.head;
  let from: bigint;
  let to: bigint;
  let description: string;
  if (period.kind === "blocks") {
    [from, to] = [BigInt(period.from), BigInt(period.to)];
    if (to > head.number) throw new AgentError("usage", `Block ${group(to)} is not mined yet: the newest is ${group(head.number)}.`);
    description = `in blocks ${group(from)} to ${group(to)}`;
  } else if (period.kind === "hours") {
    to = head.number;
    from = await clock.firstAfter(head.timestamp - BigInt(period.hours) * 3600n);
    description = period.hours === 1 ? "in the last hour" : `in the last ${period.hours} hours`;
  } else {
    const since = BigInt(Date.parse(period.since) / 1000);
    const until = period.until === null ? null : BigInt(Date.parse(period.until) / 1000);
    from = await clock.firstAfter(since);
    if (from > head.number) {
      const start = utcParts(since);
      throw new AgentError("usage", `No block has been mined since ${start.date}, ${start.time} UTC: the newest is from ${utcParts(head.timestamp).time}.`);
    }
    to = until === null || until >= head.timestamp ? head.number : (await clock.firstAfter(until)) - 1n;
    description = `from ${utcSpan(since, until ?? head.timestamp)}`;
  }
  if (from > to) throw new AgentError("usage", `No block was mined ${description}.`);
  let trimmed: ResolvedPeriod["trimmed"] = null;
  if (to - from + 1n > BigInt(maxBlocks)) {
    trimmed = { from, blocks: to - from + 1n };
    from = to - BigInt(maxBlocks) + 1n;
  }
  return { from: { number: from, timestamp: await clock.time(from) }, to: { number: to, timestamp: await clock.time(to) }, trimmed, description };
}
