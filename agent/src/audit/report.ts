// Task 26, Audit-Log Agent: what one address did over a period, in plain language.
//
//   1. Check the chain (get_chain_info) and read the newest block (or a requested one).
//   2. The period's blocks (period.ts): the last N hours, two times, or two blocks; a longer period than
//      one report reads is trimmed to its newest `maxBlocks` blocks, and says so.
//   3. The address at the period's last block (code, PROS, nonce, each official token's balance) and at
//      the block before its first (PROS, nonce, tokens). A node that cannot serve the earlier state leaves
//      the opening unknown, and the report says why.
//   4. Its token activity from get_logs, in pages of at most 1,000 blocks, two queries a page over every
//      official token at once: Transfer and Approval logs from it, with WETH-style Deposit and Withdrawal
//      logs (wrapping), then Transfer logs to it.
//   5. The report: transactions sent (the nonce's change), PROS before and after, each token's flows,
//      main counterparties and balance (reconciled with the logs), approvals given, transfers of nothing,
//      a timeline, and all of it in plain sentences built from those values. No language model.
import { getAddress, keccak256, maxUint256, pad, toBytes } from "viem";
import { decodeCall, encodeCall, ERC20 } from "../core/abi.js";
import { formatAmount } from "../core/amounts.js";
import type { Address, Chain, Hex } from "../core/chain.js";
import { AgentError, ToolCallError } from "../core/errors.js";
import type { Token } from "../core/networks.js";
import { LOG_PAGE, TRANSFER_TOPIC } from "../policy/check.js";
import { BlockClock, resolvePeriod, utcSpan, type PeriodRequest } from "./period.js";

export interface Flow {
  count: number;
  raw: string;
  shown: string;
}

export interface TokenActivity {
  token: Address;
  symbol: string;
  opening: string | null;
  closing: string;
  openingShown: string | null;
  closingShown: string;
  /** Transfers of something in and out (transfers of nothing are counted apart, in `zeroValue`, and to itself in neither). */
  in: Flow;
  out: Flow;
  /** WETH-style Deposit and Withdrawal logs: the token minted to it and burned from it by wrapping. */
  wrapped: Flow;
  unwrapped: Flow;
  zeroValue: number;
  /** The closing balance less the opening one and every flow logged; null without an opening. */
  unexplained: string | null;
  unexplainedShown: string | null;
  /** Whom it moved this token with most, by transfers (at most three). */
  counterparties: { address: Address; in: number; out: number }[];
}

export interface Approval {
  token: Address;
  symbol: string;
  spender: Address;
  amount: string;
  shown: string;
  block: string;
  tx: Hex;
}

export interface AuditEvent {
  kind: "in" | "out" | "self" | "approval" | "wrap" | "unwrap";
  token: Address;
  symbol: string;
  amount: string;
  shown: string;
  counterparty: Address | null;
  block: string;
  /** Estimated from the block number, between the period's two ends, whose times are read. */
  approxTime: string;
  tx: Hex;
  logIndex: number;
  text: string;
}

export interface AuditReport {
  schema: "pharos-agent/audit-log/1";
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  head: { number: string; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  address: Address;
  account: { code: "none" | "contract" | "delegated"; delegate: Address | null };
  period: {
    asked: PeriodRequest;
    /** "in the last hour", "from 17 Oct 2026, 09:00 to 15:00 UTC", "in blocks 1,000 to 2,000". */
    description: string;
    from: { number: string; timestamp: string };
    to: { number: string; timestamp: string };
    blocks: number;
    /** The asked period's first block and length, when it was longer than a report reads. */
    trimmed: { from: string; blocks: string } | null;
  };
  /** At the block before the period's first; null when the node did not serve it. */
  opening: { block: string; native: string; nonce: string } | null;
  openingError: string | null;
  closing: { block: string; native: string; nonce: string };
  /** Transactions it sent in the period: its nonce's change (for a contract, the contracts it created). */
  sent: number | null;
  native: { opening: string | null; closing: string; change: string | null; openingShown: string | null; closingShown: string; changeShown: string | null };
  tokens: TokenActivity[];
  /** Approvals it gave, the latest per token and spender. */
  approvals: Approval[];
  zeroValue: { count: number; with: Address[] };
  /** Newest first, at most MAX_EVENTS. */
  events: AuditEvent[];
  truncated: number;
  scanned: { from: string; to: string; pages: number };
  /** The report, sentence by sentence. */
  summary: string[];
  headline: string;
  quiet: boolean;
  toolCalls: number;
}

export interface AuditOptions {
  chain: Chain;
  /** The most blocks one report reads (two get_logs calls per 1,000); default 100,000. */
  maxBlocks?: number;
  /** "Now": the newest block by default. */
  block?: bigint;
  now?: () => Date;
}

export const MAX_BLOCKS = 100_000;
export const MAX_EVENTS = 50;
export const APPROVAL_TOPIC = keccak256(toBytes("Approval(address,address,uint256)"));
export const DEPOSIT_TOPIC = keccak256(toBytes("Deposit(address,uint256)"));
export const WITHDRAWAL_TOPIC = keccak256(toBytes("Withdrawal(address,uint256)"));

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const group = (n: bigint | number) => n.toLocaleString("en-US");
const addressOf = (topic: string) => getAddress(`0x${topic.slice(-40)}`);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const places = (decimals: number) => (decimals > 6 ? 4 : decimals);
const amount = (value: bigint, decimals: number) => formatAmount(value, decimals, places(decimals));
const signed = (value: bigint, decimals: number) => `${value > 0n ? "+" : value < 0n ? "−" : "±"}${amount(value < 0n ? -value : value, decimals)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${group(n)} ${n === 1 ? one : many}`;
const listOf = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

interface Logged {
  kind: AuditEvent["kind"];
  token: Token;
  value: bigint;
  counterparty: Address | null;
  block: bigint;
  tx: Hex;
  logIndex: number;
}

export async function auditAddress(address: Address, period: PeriodRequest, options: AuditOptions): Promise<AuditReport> {
  const { chain } = options;
  const net = chain.network;
  const maxBlocks = options.maxBlocks ?? MAX_BLOCKS;
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  await chain.expectChain();
  const head = await chain.block(options.block ?? (await chain.blockNumber()));
  const clock = new BlockClock(chain, head);
  const resolved = await resolvePeriod(period, clock, maxBlocks);
  const [from, to] = [resolved.from.number, resolved.to.number];
  const tokens = net.tokens;

  // The address at the period's end, then just before it.
  const code = await chain.code(address, to);
  const kind = /^0x0*$/.test(code) ? "none" : /^0xef0100[0-9a-fA-F]{40}$/.test(code) ? "delegated" : "contract";
  // A token not yet deployed at that block answers nothing: it held none of it.
  const balanceOf = async (token: Token, at: bigint) => {
    const data = await chain.call({ to: token.address, data: encodeCall(ERC20.balanceOf, [address]) }, at);
    return data === "0x" ? 0n : (decodeCall(ERC20.balanceOf, data) as bigint);
  };
  const closing = { native: await chain.balance(address, to), nonce: await chain.nonce(address, to), tokens: [] as bigint[] };
  for (const token of tokens) closing.tokens.push(await balanceOf(token, to));
  let opening: typeof closing | null = null;
  let openingError: string | null = null;
  if (from === 0n) openingError = "the period starts at the first block";
  else {
    try {
      const before = { native: await chain.balance(address, from - 1n), nonce: await chain.nonce(address, from - 1n), tokens: [] as bigint[] };
      for (const token of tokens) before.tokens.push(await balanceOf(token, from - 1n));
      opening = before;
    } catch (error) {
      if (!(error instanceof ToolCallError)) throw error;
      openingError = `the node did not serve the state at block ${group(from - 1n)}: ${error.detail}`;
    }
  }

  // Its logs in the period: from it (Transfer, Approval, Deposit, Withdrawal), then Transfers to it.
  const who = pad(address.toLowerCase() as Hex, { size: 32 });
  const found = new Map<string, Logged>();
  let pages = 0;
  for (let page = from; page <= to; page += LOG_PAGE) {
    const end = page + LOG_PAGE - 1n < to ? page + LOG_PAGE - 1n : to;
    for (const topics of [[[TRANSFER_TOPIC as Hex, APPROVAL_TOPIC, DEPOSIT_TOPIC, WITHDRAWAL_TOPIC], who], [TRANSFER_TOPIC as Hex, null, who]] as (Hex | Hex[] | null)[][]) {
      pages += 1;
      for (const log of await chain.logs({ address: tokens.map((t) => getAddress(t.address)), topics, fromBlock: page, toBlock: end })) {
        const token = tokens.find((t) => same(t.address, String(log.address)));
        if (!token || log.removed || typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
        const [topic, first, second] = log.topics.map((t) => t.toLowerCase());
        const value = BigInt(log.data);
        const base = { token, value, block: BigInt(log.blockNumber), tx: log.transactionHash as Hex, logIndex: Number(log.logIndex) };
        let entry: Logged | null = null;
        if (topic === TRANSFER_TOPIC && log.topics.length === 3) {
          const [sender, recipient] = [addressOf(first!), addressOf(second!)];
          if (same(sender, address) && same(recipient, address)) entry = { ...base, kind: "self", counterparty: address };
          else if (same(sender, address)) entry = { ...base, kind: "out", counterparty: recipient };
          else if (same(recipient, address)) entry = { ...base, kind: "in", counterparty: sender };
        } else if (topic === APPROVAL_TOPIC && log.topics.length === 3 && same(addressOf(first!), address)) entry = { ...base, kind: "approval", counterparty: addressOf(second!) };
        else if ((topic === DEPOSIT_TOPIC || topic === WITHDRAWAL_TOPIC) && log.topics.length === 2 && same(addressOf(first!), address)) entry = { ...base, kind: topic === DEPOSIT_TOPIC ? "wrap" : "unwrap", counterparty: null };
        if (entry) found.set(`${log.transactionHash}:${base.logIndex}`, entry);
      }
    }
  }
  const logged = [...found.values()].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));

  // Each token: flows, counterparties, balances and what the logs do not explain.
  const flow = (items: Logged[], decimals: number): Flow => {
    const raw = items.reduce((sum, item) => sum + item.value, 0n);
    return { count: items.length, raw: raw.toString(), shown: amount(raw, decimals) };
  };
  const total = (items: Logged[]) => items.reduce((sum, item) => sum + item.value, 0n);
  const perToken = tokens.map((token, i) => {
    const mine = logged.filter((l) => l.token === token);
    const moved = mine.filter((l) => l.value > 0n);
    // A transfer to itself moves nothing: it is counted apart, in neither flow.
    const ins = moved.filter((l) => l.kind === "in");
    const outs = moved.filter((l) => l.kind === "out");
    const [wraps, unwraps] = [moved.filter((l) => l.kind === "wrap"), moved.filter((l) => l.kind === "unwrap")];
    const inLogs = total(ins) - total(outs) + total(wraps) - total(unwraps);
    const before = opening ? opening.tokens[i]! : null;
    const after = closing.tokens[i]!;
    const unexplained = before === null ? null : after - before - inLogs;
    const people = new Map<string, { address: Address; in: number; out: number }>();
    for (const l of moved) {
      if (!l.counterparty || (l.kind !== "in" && l.kind !== "out")) continue;
      const p = people.get(l.counterparty.toLowerCase()) ?? { address: l.counterparty, in: 0, out: 0 };
      p[l.kind] += 1;
      people.set(l.counterparty.toLowerCase(), p);
    }
    const everyone = [...people.values()];
    const activity: TokenActivity = {
      token: getAddress(token.address),
      symbol: token.symbol,
      opening: before?.toString() ?? null,
      closing: after.toString(),
      openingShown: before === null ? null : amount(before, token.decimals),
      closingShown: amount(after, token.decimals),
      in: flow(ins, token.decimals),
      out: flow(outs, token.decimals),
      wrapped: flow(wraps, token.decimals),
      unwrapped: flow(unwraps, token.decimals),
      zeroValue: mine.filter((l) => l.value === 0n && (l.kind === "in" || l.kind === "out" || l.kind === "self")).length,
      unexplained: unexplained?.toString() ?? null,
      unexplainedShown: unexplained === null ? null : signed(unexplained, token.decimals),
      counterparties: [...everyone].sort((a, b) => b.in + b.out - (a.in + a.out)).slice(0, 3),
    };
    return { token, activity, everyone, inLogs, self: moved.filter((l) => l.kind === "self").length };
  });
  const activity = perToken.map((t) => t.activity);
  // The sentences take the busiest token first.
  const ranked = [...perToken].sort((a, b) => b.activity.in.count + b.activity.out.count - (a.activity.in.count + a.activity.out.count));

  // Approvals: the latest per token and spender.
  const latest = new Map<string, Logged>();
  for (const l of logged) if (l.kind === "approval") latest.set(`${l.token.address}:${l.counterparty!.toLowerCase()}`, l);
  const approvalShown = (l: Logged) => (l.value === maxUint256 ? "unlimited" : amount(l.value, l.token.decimals));
  const approvals: Approval[] = [...latest.values()].map((l) => ({ token: getAddress(l.token.address), symbol: l.token.symbol, spender: l.counterparty!, amount: l.value.toString(), shown: approvalShown(l), block: l.block.toString(), tx: l.tx }));
  const zeroWith = new Map<string, Address>();
  for (const l of logged) if (l.value === 0n && (l.kind === "in" || l.kind === "out") && l.counterparty) zeroWith.set(l.counterparty.toLowerCase(), l.counterparty);
  const zeroCount = activity.reduce((s, t) => s + t.zeroValue, 0);

  // The timeline, newest first; times between the period's ends estimated from the block number.
  const [t0, t1] = [resolved.from.timestamp, resolved.to.timestamp];
  const timeOf = (block: bigint) => (to === from ? t1 : t0 + ((block - from) * (t1 - t0)) / (to - from));
  const describe = (l: Logged): string => {
    const sym = l.token.symbol;
    const what = `${amount(l.value, l.token.decimals)} ${sym}`;
    const nothing = l.value === 0n ? " (a transfer of nothing)" : "";
    switch (l.kind) {
      case "in":
        return `Received ${what} from ${short(l.counterparty!)}${nothing}`;
      case "out":
        return `Sent ${what} to ${short(l.counterparty!)}${nothing}`;
      case "self":
        return `Sent ${what} to itself`;
      case "approval":
        return l.value === 0n ? `Revoked ${short(l.counterparty!)}'s ${sym} approval` : `Approved ${short(l.counterparty!)} to spend ${approvalShown(l)} ${sym}`;
      case "wrap":
        return `Wrapped ${what} (a deposit)`;
      case "unwrap":
        return `Unwrapped ${what} (a withdrawal)`;
    }
  };
  const newest = [...logged].reverse();
  const events: AuditEvent[] = newest.slice(0, MAX_EVENTS).map((l) => ({
    kind: l.kind,
    token: getAddress(l.token.address),
    symbol: l.token.symbol,
    amount: l.value.toString(),
    shown: l.kind === "approval" ? approvalShown(l) : amount(l.value, l.token.decimals),
    counterparty: l.counterparty,
    block: l.block.toString(),
    approxTime: new Date(Number(timeOf(l.block)) * 1000).toISOString(),
    tx: l.tx,
    logIndex: l.logIndex,
    text: describe(l),
  }));

  // The report in sentences.
  const sym = net.nativeSymbol;
  const sent = opening ? Number(closing.nonce - opening.nonce) : null;
  const nativeChange = opening ? closing.native - opening.native : null;
  const quiet = logged.length === 0 && !sent;
  const description = resolved.description;
  const summary: string[] = [];
  const span = `blocks ${group(from)} to ${group(to)} (${utcSpan(t0, t1)})`;
  summary.push(period.kind === "blocks" ? `Activity of ${short(address)} in ${span}.` : `Activity of ${short(address)} ${description}: ${span}.`);
  if (resolved.trimmed) summary.push(`Only the newest ${group(to - from + 1n)} of the period's ${group(resolved.trimmed.blocks)} blocks were read; a longer period needs the CLI, or several reports.`);
  if (quiet) summary.push(sent === null ? "No token moved and no approval was given." : "Nothing happened: no transaction sent, no token moved, no approval given.");
  else if (kind === "contract") summary.push(sent ? `It is a contract: it sends no transactions of its own, and its nonce, which counts the contracts it created, went from ${group(opening!.nonce)} to ${group(closing.nonce)}.` : "It is a contract: it sends no transactions of its own.");
  else if (sent !== null) summary.push(sent ? `It sent ${plural(sent, "transaction")} (its nonce went from ${group(opening!.nonce)} to ${group(closing.nonce)}).` : "It sent no transaction.");
  for (const { activity: t, everyone, self } of ranked) {
    const lead = (direction: "in" | "out", count: number) => {
      const [first] = everyone.filter((c) => c[direction] > 0).sort((a, b) => b[direction] - a[direction]);
      const word = direction === "in" ? "from" : "to";
      if (!first) return "";
      if (count === 1) return ` ${word} ${short(first.address)}`;
      if (first[direction] === count) return ` (all ${word} ${short(first.address)})`;
      return first[direction] > 1 ? ` (${first[direction]} ${word} ${short(first.address)})` : "";
    };
    const [ins, outs] = [t.in.count, t.out.count];
    const parts: string[] = [];
    if (ins) parts.push(`received ${t.in.shown} ${t.symbol} in ${plural(ins, "transfer")}${lead("in", ins)}`);
    if (outs) parts.push(`sent ${t.out.shown} ${t.symbol} in ${plural(outs, "transfer")}${lead("out", outs)}`);
    if (self) parts.push(`moved ${t.symbol} to itself ${self === 1 ? "once" : `${self} times`}`);
    if (parts.length) summary.push(`It ${listOf(parts)}.`);
    const wraps = [t.wrapped.count ? `grew by ${t.wrapped.shown} in ${plural(t.wrapped.count, "deposit")}` : "", t.unwrapped.count ? `shrank by ${t.unwrapped.shown} in ${plural(t.unwrapped.count, "withdrawal")}` : ""].filter(Boolean);
    if (wraps.length) summary.push(`Its ${t.symbol} ${listOf(wraps)} (wrapping).`);
  }
  for (const a of approvals.slice(0, 5)) summary.push(a.amount === "0" ? `It revoked ${short(a.spender)}'s ${a.symbol} approval.` : `It approved ${short(a.spender)} to spend ${a.shown} ${a.symbol}.`);
  if (approvals.length > 5) summary.push(`It gave ${plural(approvals.length - 5, "more approval")}.`);
  if (zeroCount) summary.push(`It had ${plural(zeroCount, "transfer")} of nothing, with ${listOf([...zeroWith.values()].slice(0, 3).map(short))}${zeroWith.size > 3 ? ` and ${zeroWith.size - 3} more` : ""}: that is how address poisoning plants lookalike addresses in a wallet's history, so never copy an address from them.`);
  if (nativeChange !== null) summary.push(nativeChange === 0n ? `Its ${sym} stayed at ${amount(closing.native, 18)}.` : `Its ${sym} went from ${amount(opening!.native, 18)} to ${amount(closing.native, 18)} (${signed(nativeChange, 18)}): gas, and any ${sym} it sent or received, which leave no logs.`);
  else summary.push(`It holds ${amount(closing.native, 18)} ${sym} at the end.`);
  const steady: string[] = [];
  const ends: string[] = [];
  for (const { token, activity: t, inLogs } of ranked) {
    const moved = t.in.count + t.out.count + t.wrapped.count + t.unwrapped.count > 0;
    if (t.opening === null) {
      if (t.closing !== "0") ends.push(`${t.closingShown} ${t.symbol}`);
    } else if (moved || t.unexplained !== "0") {
      const gap = t.unexplained === "0" ? ", all of it in the logs above" : `: the logs account for ${signed(inLogs, token.decimals)}, and ${t.unexplainedShown} changed without one`;
      summary.push(`Its ${t.symbol} went from ${t.openingShown} to ${t.closingShown}${gap}.`);
    } else if (t.closing !== "0") steady.push(`${t.closingShown} ${t.symbol}`);
  }
  if (steady.length) summary.push(`It held ${listOf(steady)} throughout.`);
  if (ends.length) summary.push(`At the end it holds ${listOf(ends)}.`);
  if (openingError) summary.push(`Its balances and nonce before the period are unknown: ${openingError}.`);
  const transfers = logged.filter((l) => (l.kind === "in" || l.kind === "out" || l.kind === "self") && l.value > 0n).length;
  const counts = [kind !== "contract" && sent ? `${plural(sent, "transaction")} sent` : "", transfers ? plural(transfers, "token transfer") : "", approvals.length ? plural(approvals.length, "approval") : "", zeroCount ? `${plural(zeroCount, "transfer")} of nothing` : ""].filter(Boolean);
  const headline = `${short(address)} ${description}: ${counts.length ? listOf(counts) : "nothing happened"}.`;

  return {
    schema: "pharos-agent/audit-log/1",
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    head: { number: head.number.toString(), timestamp: new Date(Number(head.timestamp) * 1000).toISOString(), source: options.block === undefined ? "latest" : "requested" },
    evaluatedAt,
    address,
    account: { code: kind, delegate: kind === "delegated" ? getAddress(`0x${code.slice(8)}`) : null },
    period: {
      asked: period,
      description,
      from: { number: from.toString(), timestamp: new Date(Number(t0) * 1000).toISOString() },
      to: { number: to.toString(), timestamp: new Date(Number(t1) * 1000).toISOString() },
      blocks: Number(to - from + 1n),
      trimmed: resolved.trimmed ? { from: resolved.trimmed.from.toString(), blocks: resolved.trimmed.blocks.toString() } : null,
    },
    opening: opening ? { block: (from - 1n).toString(), native: opening.native.toString(), nonce: opening.nonce.toString() } : null,
    openingError,
    closing: { block: to.toString(), native: closing.native.toString(), nonce: closing.nonce.toString() },
    sent,
    native: { opening: opening?.native.toString() ?? null, closing: closing.native.toString(), change: nativeChange?.toString() ?? null, openingShown: opening ? amount(opening.native, 18) : null, closingShown: amount(closing.native, 18), changeShown: nativeChange === null ? null : signed(nativeChange, 18) },
    tokens: activity,
    approvals,
    zeroValue: { count: zeroCount, with: [...zeroWith.values()] },
    events,
    truncated: Math.max(0, logged.length - MAX_EVENTS),
    scanned: { from: from.toString(), to: to.toString(), pages },
    summary,
    headline,
    quiet,
    toolCalls: chain.mcp.toolCalls,
  };
}

/** An address from untrusted input. */
export function parseAuditAddress(text: unknown): Address {
  if (typeof text !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(text.trim())) throw new AgentError("usage", "The address must be a 0x address of 40 hex characters.");
  return getAddress(text.trim().toLowerCase());
}
