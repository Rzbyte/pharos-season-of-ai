// Task 28, Weekly Digest Agent: a periodic summary of a protocol's or a wallet's activity.
//
//   1. Check the chain (get_chain_info) and read the newest block.
//   2. The periods to digest: UTC hours, days or weeks (calendar.ts). With a store, each period completed
//      since the last digest, once, oldest first (at most MAX_PERIODS a run); without one, the last
//      `periods` complete ones. The period still open can be summed up too, as so far. Each period's first
//      block is placed with get_block (BlockClock), and so are its parts (a week's days, a day's hours),
//      to name the busiest.
//   3. The logs, once over all of them, in pages of at most 1,000 blocks. For a protocol (an official
//      token): its every Transfer, one query a page. For a wallet: its Transfer and Approval logs over
//      every official token, two queries a page (as Task 26). Nothing else is read in the past: no state
//      at an old block, which a node may not serve.
//   4. Each period's figures and sentences, compared with the period before where that is known (in this
//      run, or the store's last digest). And now, at the newest block: a token's supply, a wallet's holdings.
import { getAddress, maxUint256, pad, zeroAddress } from "viem";
import { decodeCall, encodeCall, ERC20 } from "../core/abi.js";
import { formatAmount } from "../core/amounts.js";
import type { Address, Chain, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Token } from "../core/networks.js";
import { BlockClock } from "../audit/period.js";
import { APPROVAL_TOPIC } from "../audit/report.js";
import { LOG_PAGE, TRANSFER_TOPIC } from "../policy/check.js";
import { PARTS, partLabel, periodEnd, periodLabel, periodStart, type Every } from "./calendar.js";
import { KEEP, type DigestStore } from "./store.js";

export type Subject = { kind: "token"; token: Token } | { kind: "wallet"; address: Address };

export interface Flow {
  count: number;
  raw: string;
  shown: string;
}

export interface Mover {
  address: Address;
  transfers: number;
  raw: string;
  shown: string;
}

export interface TokenFigures {
  kind: "token";
  /** Transfers of something between two addresses (mints and burns apart). */
  transfers: number;
  volume: string;
  volumeShown: string;
  senders: number;
  recipients: number;
  minted: Flow;
  burned: Flow;
  zeroValue: number;
  largest: { raw: string; shown: string; from: Address; to: Address; block: string; tx: Hex } | null;
  topSenders: Mover[];
  topRecipients: Mover[];
}

export interface WalletFigures {
  kind: "wallet";
  /** Its transfers of something, in and out, over every official token. */
  transfers: number;
  tokens: { symbol: string; in: Flow; out: Flow }[];
  counterparties: { address: Address; transfers: number }[];
  approvals: { symbol: string; spender: Address; shown: string }[];
  zeroValue: number;
}

export interface PeriodDigest {
  /** The period, as ISO 8601: its start, and the next period's start. */
  start: string;
  end: string;
  label: string;
  complete: boolean;
  /** Its blocks; null when none was mined in it. */
  blocks: { from: string; to: string } | null;
  figures: TokenFigures | WalletFigures;
  /** Its parts (a week's days, a day's hours) and their transfers, to name the busiest. */
  parts: { label: string; transfers: number }[];
  /** Against the period before, in percent; null where that period is not known or had none. */
  change: { transfers: number | null; volume: number | null } | null;
  sentences: string[];
}

export interface DigestRun {
  schema: "pharos-agent/digest-run/1";
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  head: { number: string; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  subject: { kind: "token" | "wallet"; label: string; address: Address };
  every: Every;
  /** The complete periods digested this run, oldest first. */
  digests: PeriodDigest[];
  /** The period still open, so far; null unless asked for. */
  current: PeriodDigest | null;
  /** At the newest block: a token's total supply, or a wallet's holdings. */
  now: { supply: string | null; supplyShown: string | null; holdings: { symbol: string; raw: string; shown: string }[] };
  /** The blocks whose logs were read, and the get_logs calls; null when none were. */
  scanned: { from: string; to: string; pages: number } | null;
  /** With a store: periods ended but left for the next run (this one reached MAX_PERIODS or its block cap). */
  behind: number;
  /** Without one: periods asked for but left out, the oldest, as they did not fit in the blocks one run reads. */
  cut: number;
  store: DigestStore;
  headline: string;
  toolCalls: number;
}

export interface DigestOptions {
  chain: Chain;
  /** Complete periods to digest without a store (default 1). */
  periods?: number;
  /** Sum up the open period too. */
  soFar?: boolean;
  /** The most blocks one run reads logs over (default 1,000,000). */
  maxBlocks?: number;
  block?: bigint;
  now?: () => Date;
}

export const MAX_PERIODS = 10;
export const MAX_RUN_BLOCKS = 1_000_000;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const group = (n: bigint | number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${group(n)} ${n === 1 ? one : many}`;
const places = (decimals: number) => (decimals > 6 ? 4 : decimals);
const amount = (value: bigint, decimals: number) => formatAmount(value, decimals, places(decimals));
const addressOf = (topic: string) => getAddress(`0x${topic.slice(-40)}`);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();
const listOf = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
/** Change in whole percent; null when there was nothing before. */
const percent = (now: bigint, before: bigint): number | null => (before === 0n ? null : Math.round(Number(((now - before) * 1000n) / before) / 10));

interface Logged {
  topic: "transfer" | "approval";
  token: Token;
  from: Address;
  to: Address;
  value: bigint;
  block: bigint;
  tx: Hex;
  logIndex: number;
}

interface Slot {
  start: bigint;
  end: bigint;
  complete: boolean;
  from: bigint;
  to: bigint;
  parts: { start: bigint; from: bigint }[];
}

export async function runDigest(subject: Subject, every: Every, store: DigestStore, options: DigestOptions): Promise<DigestRun> {
  const { chain } = options;
  const net = chain.network;
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  const maxBlocks = BigInt(options.maxBlocks ?? MAX_RUN_BLOCKS);
  await chain.expectChain();
  const head = await chain.block(options.block ?? (await chain.blockNumber()));
  const clock = new BlockClock(chain, head);
  const open = periodStart(head.timestamp, every);

  // The periods: those completed since the store's last digest, or the last N; then the open one.
  let starts: bigint[];
  if (store.digested !== null) {
    starts = [];
    for (let s = BigInt(Date.parse(store.digested) / 1000); s < open; s = periodEnd(s, every)) starts.push(s);
  } else {
    const n = options.periods ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > MAX_PERIODS) throw new AgentError("usage", `periods must be a whole number from 1 to ${MAX_PERIODS}.`);
    starts = [];
    for (let s = open, i = 0; i < n; i += 1) starts.unshift((s = periodStart(s - 1n, every)));
  }
  let behind = Math.max(0, starts.length - MAX_PERIODS);
  starts = starts.slice(0, MAX_PERIODS);

  // Each period's blocks, and its parts'.
  const place = async (start: bigint, complete: boolean): Promise<Slot> => {
    const end = periodEnd(start, every);
    const from = await clock.firstAtOrAfter(start);
    const to = complete ? (await clock.firstAtOrAfter(end)) - 1n : head.number;
    const parts: Slot["parts"] = [];
    const part = PARTS[every];
    if (part && from <= to) for (let p = start; p < end && p <= head.timestamp; p = periodEnd(p, part)) parts.push({ start: p, from: p === start ? from : await clock.firstAtOrAfter(p) });
    return { start, end, complete, from, to, parts };
  };
  const placed: Slot[] = [];
  for (const start of starts) placed.push(await place(start, true));
  // The open period follows the last one digested only when the run has caught up.
  let current = options.soFar && behind === 0 ? await place(open, false) : null;
  // What fits in the blocks one run reads: with a store, the oldest periods (the rest wait for the next
  // run); without one, the newest (the oldest asked for are cut, and the run says so).
  const fits = (list: Slot[]) => list.length === 0 || list.at(-1)!.to - list[0]!.from + 1n <= maxBlocks;
  let slots = placed;
  let cut = 0;
  if (store.digested !== null) {
    while (!fits([...slots, ...(current ? [current] : [])]) && (current || slots.length > 1)) {
      if (current) current = null;
      else {
        slots = slots.slice(0, -1);
        behind += 1;
      }
    }
  } else {
    while (!fits([...slots, ...(current ? [current] : [])]) && slots.length > 0) {
      slots = slots.slice(1);
      cut += 1;
    }
  }
  const all = [...slots, ...(current ? [current] : [])];
  // Not even one period fits: say how long one is.
  const single = !fits(all) ? all.at(-1)! : all.length === 0 && placed.length ? placed.at(-1)! : null;
  if (single) throw new AgentError("usage", `One ${every} is ${group(single.to - single.from + 1n)} blocks, more than the ${group(maxBlocks)} one run reads; digest by a shorter period.`);

  // The logs over every period at once, in pages.
  const reading = all.filter((s) => s.from <= s.to);
  const logs: Logged[] = [];
  let scanned: DigestRun["scanned"] = null;
  if (reading.length) {
    const [from, to] = [reading[0]!.from, reading.at(-1)!.to];
    const tokens = subject.kind === "token" ? [subject.token] : net.tokens;
    const queries: (Hex | Hex[] | null)[][] = subject.kind === "token" ? [[TRANSFER_TOPIC as Hex]] : (() => {
      const who = pad(subject.address.toLowerCase() as Hex, { size: 32 });
      return [[[TRANSFER_TOPIC as Hex, APPROVAL_TOPIC], who], [TRANSFER_TOPIC as Hex, null, who]];
    })();
    const seen = new Set<string>();
    let pages = 0;
    for (const slot of reading) {
      for (let page = slot.from; page <= slot.to; page += LOG_PAGE) {
        const end = page + LOG_PAGE - 1n < slot.to ? page + LOG_PAGE - 1n : slot.to;
        for (const topics of queries) {
          pages += 1;
          for (const log of await chain.logs({ address: subject.kind === "token" ? getAddress(subject.token.address) : tokens.map((t) => getAddress(t.address)), topics, fromBlock: page, toBlock: end })) {
            const token = tokens.find((t) => same(t.address, String(log.address)));
            const key = `${log.transactionHash}:${Number(log.logIndex)}`;
            if (!token || seen.has(key) || log.removed || log.topics.length !== 3 || typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
            const topic = log.topics[0]!.toLowerCase() === TRANSFER_TOPIC ? "transfer" : log.topics[0]!.toLowerCase() === APPROVAL_TOPIC ? "approval" : null;
            if (!topic) continue;
            seen.add(key);
            logs.push({ topic, token, from: addressOf(log.topics[1]!), to: addressOf(log.topics[2]!), value: BigInt(log.data), block: BigInt(log.blockNumber), tx: log.transactionHash as Hex, logIndex: Number(log.logIndex) });
          }
        }
      }
    }
    logs.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
    scanned = { from: from.toString(), to: to.toString(), pages };
  }

  // Now, at the newest block.
  const now: DigestRun["now"] = { supply: null, supplyShown: null, holdings: [] };
  if (subject.kind === "token") {
    const data = await chain.call({ to: subject.token.address, data: encodeCall(ERC20.totalSupply, []) }, head.number);
    if (data === "0x") throw new AgentError("unexpected", `The ${subject.token.symbol} contract answered nothing at block ${group(head.number)}: it has no code there.`);
    const supply = decodeCall(ERC20.totalSupply, data) as bigint;
    [now.supply, now.supplyShown] = [supply.toString(), amount(supply, subject.token.decimals)];
  }
  else {
    const native = await chain.balance(subject.address, head.number);
    if (native > 0n) now.holdings.push({ symbol: net.nativeSymbol, raw: native.toString(), shown: amount(native, 18) });
    for (const token of net.tokens) {
      const data = await chain.call({ to: token.address, data: encodeCall(ERC20.balanceOf, [subject.address]) }, head.number);
      const held = data === "0x" ? 0n : (decodeCall(ERC20.balanceOf, data) as bigint);
      if (held > 0n) now.holdings.push({ symbol: token.symbol, raw: held.toString(), shown: amount(held, token.decimals) });
    }
  }

  // Each period's digest, compared with the one before it.
  const label = subject.kind === "token" ? subject.token.symbol : short(subject.address);
  let previous: PeriodDigest | null = store.digests.at(-1) ?? null;
  const digest = (slot: Slot): PeriodDigest => {
    const mine = slot.from <= slot.to ? logs.filter((l) => l.block >= slot.from && l.block <= slot.to) : [];
    const figures = subject.kind === "token" ? tokenFigures(subject.token, mine) : walletFigures(subject.address, mine);
    const counted = (l: Logged) => l.topic === "transfer" && l.value > 0n && (subject.kind === "wallet" || (l.from !== zeroAddress && l.to !== zeroAddress));
    const parts = slot.parts.map((p, i) => {
      const upTo = slot.parts[i + 1]?.from ?? slot.to + 1n;
      return { label: partLabel(p.start, PARTS[every]!), transfers: mine.filter((l) => l.block >= p.from && l.block < upTo && counted(l)).length };
    });
    // A period still open is not compared: part of an hour against a whole one says nothing.
    const before = slot.complete && previous && previous.end === iso(slot.start) && previous.complete ? previous : null;
    const volume = (f: TokenFigures | WalletFigures) => (f.kind === "token" ? BigInt(f.volume) : null);
    const change = before
      ? { transfers: percent(BigInt(figures.transfers), BigInt(before.figures.transfers)), volume: figures.kind === "token" && before.figures.kind === "token" ? percent(volume(figures)!, volume(before.figures)!) : null }
      : null;
    const result: PeriodDigest = {
      start: iso(slot.start),
      end: iso(slot.end),
      label: periodLabel(slot.start, every),
      complete: slot.complete,
      blocks: slot.from <= slot.to ? { from: slot.from.toString(), to: slot.to.toString() } : null,
      figures,
      parts,
      change,
      sentences: [],
    };
    result.sentences = sentences(result, label, every, subject);
    if (slot.complete) previous = result;
    return result;
  };
  const digests = slots.map(digest);
  const so = current ? digest(current) : null;
  const kept = [...store.digests, ...digests].slice(-KEEP);
  const nextStore: DigestStore = { ...store, digested: digests.length ? digests.at(-1)!.end : store.digested, digests: kept };
  const headline = digests.length ? digests.at(-1)!.sentences[0]! : so ? so.sentences[0]! : `${label}: no ${every} has ended since the last digest; the next ends at ${iso(periodEnd(open, every))}.`;
  return {
    schema: "pharos-agent/digest-run/1",
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    head: { number: head.number.toString(), timestamp: iso(head.timestamp), source: options.block === undefined ? "latest" : "requested" },
    evaluatedAt,
    subject: { kind: subject.kind, label, address: subject.kind === "token" ? getAddress(subject.token.address) : subject.address },
    every,
    digests,
    current: so,
    now,
    scanned,
    behind,
    cut,
    store: nextStore,
    headline,
    toolCalls: chain.mcp.toolCalls,
  };
}

function flow(items: Logged[], decimals: number): Flow {
  const raw = items.reduce((sum, l) => sum + l.value, 0n);
  return { count: items.length, raw: raw.toString(), shown: amount(raw, decimals) };
}

function movers(items: Logged[], side: "from" | "to", decimals: number): Mover[] {
  const by = new Map<string, { address: Address; transfers: number; raw: bigint }>();
  for (const l of items) {
    const who = l[side];
    const entry = by.get(who.toLowerCase()) ?? { address: who, transfers: 0, raw: 0n };
    entry.transfers += 1;
    entry.raw += l.value;
    by.set(who.toLowerCase(), entry);
  }
  return [...by.values()]
    .sort((a, b) => (a.raw === b.raw ? b.transfers - a.transfers : a.raw > b.raw ? -1 : 1))
    .slice(0, 3)
    .map((m) => ({ address: m.address, transfers: m.transfers, raw: m.raw.toString(), shown: amount(m.raw, decimals) }));
}

function tokenFigures(token: Token, logs: Logged[]): TokenFigures {
  const transfers = logs.filter((l) => l.topic === "transfer");
  const moved = transfers.filter((l) => l.value > 0n && l.from !== zeroAddress && l.to !== zeroAddress);
  const largest = moved.reduce<Logged | null>((max, l) => (max === null || l.value > max.value ? l : max), null);
  const volume = moved.reduce((sum, l) => sum + l.value, 0n);
  return {
    kind: "token",
    transfers: moved.length,
    volume: volume.toString(),
    volumeShown: amount(volume, token.decimals),
    senders: new Set(moved.map((l) => l.from.toLowerCase())).size,
    recipients: new Set(moved.map((l) => l.to.toLowerCase())).size,
    minted: flow(transfers.filter((l) => l.value > 0n && l.from === zeroAddress), token.decimals),
    burned: flow(transfers.filter((l) => l.value > 0n && l.to === zeroAddress), token.decimals),
    zeroValue: transfers.filter((l) => l.value === 0n).length,
    largest: largest ? { raw: largest.value.toString(), shown: amount(largest.value, token.decimals), from: largest.from, to: largest.to, block: largest.block.toString(), tx: largest.tx } : null,
    topSenders: movers(moved, "from", token.decimals),
    topRecipients: movers(moved, "to", token.decimals),
  };
}

function walletFigures(address: Address, logs: Logged[]): WalletFigures {
  const transfers = logs.filter((l) => l.topic === "transfer" && l.value > 0n && !(same(l.from, address) && same(l.to, address)));
  const symbols = [...new Set(transfers.map((l) => l.token))];
  const people = new Map<string, { address: Address; transfers: number }>();
  for (const l of transfers) {
    const other = same(l.from, address) ? l.to : l.from;
    const entry = people.get(other.toLowerCase()) ?? { address: other, transfers: 0 };
    entry.transfers += 1;
    people.set(other.toLowerCase(), entry);
  }
  const latest = new Map<string, Logged>();
  for (const l of logs) if (l.topic === "approval" && same(l.from, address)) latest.set(`${l.token.symbol}:${l.to.toLowerCase()}`, l);
  return {
    kind: "wallet",
    transfers: transfers.length,
    tokens: symbols
      .map((token) => ({ symbol: token.symbol, in: flow(transfers.filter((l) => l.token === token && same(l.to, address)), token.decimals), out: flow(transfers.filter((l) => l.token === token && same(l.from, address)), token.decimals) }))
      .sort((a, b) => b.in.count + b.out.count - (a.in.count + a.out.count)),
    counterparties: [...people.values()].sort((a, b) => b.transfers - a.transfers).slice(0, 3),
    approvals: [...latest.values()].map((l) => ({ symbol: l.token.symbol, spender: l.to, shown: l.value === maxUint256 ? "unlimited" : l.value === 0n ? "nothing (revoked)" : amount(l.value, l.token.decimals) })),
    zeroValue: logs.filter((l) => l.topic === "transfer" && l.value === 0n).length,
  };
}

/** "12% more transfers", "3% less volume", "as many transfers". */
function changeWords(value: number, what: string, more: string, less: string, same: string): string {
  if (value === 0) return same;
  return `${Math.abs(value).toLocaleString("en-US")}% ${value > 0 ? more : less} ${what}`;
}

function sentences(d: PeriodDigest, label: string, every: Every, subject: Subject): string[] {
  const out: string[] = [];
  const when = `${d.label}${d.complete ? "" : ", so far"}`;
  const f = d.figures;
  if (!d.blocks) return [`${label}, ${when}: no block was mined.`];
  if (f.kind === "token") {
    const sym = label;
    out.push(f.transfers ? `${sym}, ${when}: ${plural(f.transfers, "transfer")} moved ${f.volumeShown} ${sym} between ${plural(f.senders, "sender")} and ${plural(f.recipients, "recipient")}.` : `${sym}, ${when}: no ${sym} moved between holders.`);
    if (d.change && d.change.transfers !== null) out.push(`Against the ${every} before: ${changeWords(d.change.transfers, "transfers", "more", "fewer", "as many transfers")}${d.change.volume !== null ? ` and ${changeWords(d.change.volume, "volume", "more", "less", "the same volume")}` : ""}.`);
  } else {
    out.push(f.transfers || f.approvals.length ? `${label}, ${when}: ${[f.transfers ? plural(f.transfers, "token transfer") : "", f.approvals.length ? plural(f.approvals.length, "approval") : ""].filter(Boolean).join(" and ")}.` : `${label}, ${when}: no token moved and no approval was given.`);
    if (d.change && d.change.transfers !== null) out.push(`Against the ${every} before: ${changeWords(d.change.transfers, "transfers", "more", "fewer", "as many transfers")}.`);
  }
  const busiest = d.parts.reduce<{ label: string; transfers: number } | null>((max, p) => (p.transfers > (max?.transfers ?? 0) ? p : max), null);
  if (busiest && d.parts.filter((p) => p.transfers > 0).length > 1) out.push(`The busiest ${PARTS[every]} was ${busiest.label}, with ${plural(busiest.transfers, "transfer")}.`);
  if (f.kind === "token") {
    const sym = label;
    if (f.largest) out.push(`The largest was ${f.largest.shown} ${sym}, from ${short(f.largest.from)} to ${short(f.largest.to)}.`);
    const [sender] = f.topSenders;
    const [recipient] = f.topRecipients;
    if (sender && f.transfers > 1) out.push(`${short(sender.address)} sent the most: ${sender.shown} ${sym} in ${plural(sender.transfers, "transfer")}.`);
    if (recipient && f.transfers > 1) out.push(`${short(recipient.address)} received the most: ${recipient.shown} ${sym} in ${plural(recipient.transfers, "transfer")}.`);
    const verb = (shown: string) => (shown === "1" ? "was" : "were");
    const minted = f.minted.count ? `${f.minted.shown} ${sym} ${verb(f.minted.shown)} minted` : "";
    const burned = f.burned.count ? (minted ? `${f.burned.shown} burned` : `${f.burned.shown} ${sym} ${verb(f.burned.shown)} burned`) : "";
    if (minted || burned) out.push(`${[minted, burned].filter(Boolean).join(" and ")}.`);
  } else {
    for (const t of f.tokens) {
      const parts = [t.in.count ? `received ${t.in.shown} ${t.symbol} in ${plural(t.in.count, "transfer")}` : "", t.out.count ? `sent ${t.out.shown} ${t.symbol} in ${plural(t.out.count, "transfer")}` : ""].filter(Boolean);
      out.push(`It ${listOf(parts)}.`);
    }
    const [top] = f.counterparties;
    if (top && f.transfers > 1) out.push(`It dealt most with ${short(top.address)} (${plural(top.transfers, "transfer")}).`);
    for (const a of f.approvals) out.push(a.shown === "nothing (revoked)" ? `It revoked ${short(a.spender)}'s ${a.symbol} approval.` : `It approved ${short(a.spender)} to spend ${a.shown} ${a.symbol}.`);
  }
  if (f.zeroValue) out.push(`${plural(f.zeroValue, "transfer")} of nothing: the trace address poisoning leaves${subject.kind === "wallet" ? "; never copy an address from them" : ""}.`);
  return out;
}
