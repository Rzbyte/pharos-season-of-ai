// Task 23, Whale-Watching Agent: one run.
//
//   1. Check the chain (get_chain_info) and pin the newest block.
//   2. Each tracked address at that block: its native balance (get_balance), nonce
//      (get_transaction_count) and token balances (eth_call balanceOf); whether it has code (get_code)
//      only the first time it is seen.
//   3. The tracked tokens' Transfer logs since the last run (the cursor), with get_logs in pages of at
//      most 1,000 blocks: one query for transfers sent by any tracked address, one for transfers they
//      received, so a page costs two calls whatever the number of addresses. A first run looks back
//      `lookback` blocks; a run more than `maxScan` blocks behind scans the newest `maxScan`.
//   4. What is significant: a transfer of at least the token's minimum, sent or received by a tracked
//      address, once; and a change of an address's native balance since the last run of at least the
//      native minimum, since native transfers leave no logs. Everything else is counted per address:
//      transfers in and out, holdings and their change, transactions sent.
import { getAddress, pad } from "viem";
import { decodeCall, encodeCall, ERC20 } from "../core/abi.js";
import { formatAmount, parseAmount } from "../core/amounts.js";
import type { Address, BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { LOG_PAGE, TRANSFER_TOPIC } from "../policy/check.js";
import { short, type Tracked, type TrackedToken, type Watchlist } from "./config.js";
import type { Snapshot, WhaleStore } from "./store.js";

export interface Flow {
  count: number;
  raw: string;
  shown: string;
}

export interface Holding {
  token: Address;
  symbol: string;
  raw: string;
  shown: string;
  /** Since the address's last snapshot, signed; null the first time it is seen. */
  change: string | null;
  changeShown: string | null;
  /** This run's transfers, from the logs scanned. */
  in: Flow;
  out: Flow;
}

export interface AddressReport {
  address: Address;
  label: string;
  /** It had code when first seen: a contract (or a delegated account), not a plain wallet. */
  contract: boolean;
  native: { raw: string; shown: string; change: string | null; changeShown: string | null };
  nonce: string;
  /** Transactions it sent since its last snapshot (its nonce went up by this much); null the first time. */
  sent: number | null;
  /** The block of its last snapshot, or null the first time. */
  since: string | null;
  tokens: Holding[];
  /** This run's significant moves about it. */
  significant: number;
}

export interface WhaleEvent {
  /** Stable across runs: the transfer's log, or the address and block of a balance change. */
  id: string;
  kind: "transfer" | "native";
  /** The tracked address the move is about: a transfer between two tracked addresses is the sender's. */
  address: Address;
  label: string;
  direction: "in" | "out";
  counterparty: Address | null;
  /** The counterparty's label, when it is tracked too. */
  counterpartyLabel: string | null;
  symbol: string;
  amount: string;
  shown: string;
  block: string;
  tx: Hex | null;
  logIndex: number | null;
  message: string;
}

export interface WhaleRun {
  schema: "pharos-agent/whale-run/1";
  watchlist: string;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: Hex; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  /** The blocks scanned for transfers this run (`pages` is the number of get_logs calls), or null. */
  scanned: { from: string; to: string; pages: number } | null;
  skipped: { from: string; to: string } | null;
  addresses: AddressReport[];
  /** Significant moves, oldest first: transfers (at most MAX_MOVES), then balance changes. */
  events: WhaleEvent[];
  /** Significant transfers beyond the most one run reports. */
  truncated: number;
  /** Every transfer of a tracked token sent or received by a tracked address in the blocks scanned. */
  transfers: number;
  store: WhaleStore;
  headline: string;
  toolCalls: number;
}

export interface WhaleOptions {
  chain: Chain;
  block?: bigint;
  now?: () => Date;
}

/** The most significant transfers one run reports; balance changes (one per address at most) always are. */
export const MAX_MOVES = 100;

const addressOf = (topic: string) => getAddress(`0x${topic.slice(-40)}`);
const signed = (value: bigint, decimals: number, places: number, unit: string) => `${value > 0n ? "+" : value < 0n ? "−" : "±"}${formatAmount(value < 0n ? -value : value, decimals, places)} ${unit}`;
const placesOf = (decimals: number) => (decimals > 6 ? 4 : decimals);

export async function runWhales(list: Watchlist, store: WhaleStore, options: WhaleOptions): Promise<WhaleRun> {
  const { chain } = options;
  const net = chain.network;
  if (net.id !== list.network) throw new AgentError("usage", `The watchlist is for ${list.network}; this chain is ${net.id}.`);
  const now = (options.now ?? (() => new Date()))();
  await chain.expectChain();
  const pinned: BlockHeader = await chain.block(options.block ?? (await chain.blockNumber()));
  const at = pinned.number;

  // Each address at the pinned block.
  const reads = [];
  for (const tracked of list.addresses) {
    const before: Snapshot | null = store.snapshots[tracked.address.toLowerCase()] ?? null;
    const contract = before ? before.contract : !/^0x0*$/.test(await chain.code(tracked.address, at));
    const native = await chain.balance(tracked.address, at);
    const nonce = await chain.nonce(tracked.address, at);
    const tokens = new Map<string, bigint>();
    for (const t of list.tokens) tokens.set(t.token.toLowerCase(), decodeCall(ERC20.balanceOf, await chain.call({ to: t.token, data: encodeCall(ERC20.balanceOf, [tracked.address]) }, at)) as bigint);
    // A snapshot from a later block (a node behind the last one) is kept, and nothing is compared with it.
    const comparable = before !== null && BigInt(before.block) <= at;
    reads.push({ tracked, before, comparable, contract, native, nonce, tokens });
  }

  // The tracked tokens' transfers by tracked addresses, after the cursor, at most maxScan blocks.
  let from = store.cursor === null ? (at - BigInt(list.lookback) + 1n > 0n ? at - BigInt(list.lookback) + 1n : 0n) : BigInt(store.cursor) + 1n;
  let skipped: WhaleRun["skipped"] = null;
  if (from <= at && at - from + 1n > BigInt(list.maxScan)) {
    skipped = { from: from.toString(), to: (at - BigInt(list.maxScan)).toString() };
    from = at - BigInt(list.maxScan) + 1n;
  }
  const scanning = from <= at && list.tokens.length > 0;
  const tracked = new Map<string, Tracked>(list.addresses.map((a) => [a.address.toLowerCase(), a]));
  const anyOf = list.addresses.map((a) => pad(a.address.toLowerCase() as Hex, { size: 32 }));
  const found = new Map<string, { token: TrackedToken; block: bigint; logIndex: number; tx: Hex; sender: Address; recipient: Address; amount: bigint }>();
  let pages = 0;
  if (scanning) {
    for (const token of list.tokens) {
      for (let start = from; start <= at; start += LOG_PAGE) {
        const end = start + LOG_PAGE - 1n < at ? start + LOG_PAGE - 1n : at;
        for (const topics of [[TRANSFER_TOPIC as Hex, anyOf], [TRANSFER_TOPIC as Hex, null, anyOf]]) {
          pages += 1;
          for (const log of await chain.logs({ address: token.token, topics, fromBlock: start, toBlock: end })) {
            if (log.removed || String(log.address).toLowerCase() !== token.token.toLowerCase() || log.topics.length !== 3 || typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
            const logIndex = Number(log.logIndex);
            found.set(`${log.transactionHash}:${logIndex}`, { token, block: BigInt(log.blockNumber), logIndex, tx: log.transactionHash, sender: addressOf(log.topics[1]!), recipient: addressOf(log.topics[2]!), amount: BigInt(log.data) });
          }
        }
      }
    }
  }

  // Flows per address and token, and the significant transfers, in chain order.
  const flows = new Map<string, { in: [number, bigint]; out: [number, bigint] }>();
  const flow = (address: string, token: string) => {
    const key = `${address.toLowerCase()}:${token.toLowerCase()}`;
    if (!flows.has(key)) flows.set(key, { in: [0, 0n], out: [0, 0n] });
    return flows.get(key)!;
  };
  let transfers = 0;
  const moves: WhaleEvent[] = [];
  for (const t of [...found.values()].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1))) {
    const sender = tracked.get(t.sender.toLowerCase());
    const recipient = tracked.get(t.recipient.toLowerCase());
    if (!sender && !recipient) continue;
    transfers += 1;
    if (t.sender === t.recipient) continue; // to itself: nothing moved
    if (sender) {
      const f = flow(sender.address, t.token.token).out;
      f[0] += 1;
      f[1] += t.amount;
    }
    if (recipient) {
      const f = flow(recipient.address, t.token.token).in;
      f[0] += 1;
      f[1] += t.amount;
    }
    // A transfer of nothing moves nothing, whatever the minimum (and is how address-poisoning spam looks).
    if (t.amount === 0n || t.amount < parseAmount(t.token.min, t.token.decimals)) continue;
    const about = sender ?? recipient!;
    const direction = sender ? "out" : "in";
    const counterparty = sender ? t.recipient : t.sender;
    const counterpartyLabel = sender && recipient ? recipient.label : null;
    const shown = `${formatAmount(t.amount, t.token.decimals, placesOf(t.token.decimals))} ${t.token.symbol}`;
    const other = counterpartyLabel ?? short(counterparty);
    moves.push({
      id: `${t.tx}:${t.logIndex}`,
      kind: "transfer",
      address: about.address,
      label: about.label,
      direction,
      counterparty,
      counterpartyLabel,
      symbol: t.token.symbol,
      amount: t.amount.toString(),
      shown,
      block: t.block.toString(),
      tx: t.tx,
      logIndex: t.logIndex,
      message: `${about.label} ${direction === "out" ? `sent ${shown} to ${other}` : `received ${shown} from ${other}`} at block ${t.block.toLocaleString("en-US")}`,
    });
  }

  // Native balance changes since each address's last snapshot.
  const changes: WhaleEvent[] = [];
  const nativeMin = list.native ? parseAmount(list.native.min, 18) : null;
  for (const r of reads) {
    if (!r.comparable || nativeMin === null) continue;
    const change = r.native - BigInt(r.before!.native);
    const size = change < 0n ? -change : change;
    if (change === 0n || size < nativeMin) continue;
    const shown = `${formatAmount(size, 18, 4)} ${net.nativeSymbol}`;
    changes.push({
      id: `native:${r.tracked.address}:${at}`,
      kind: "native",
      address: r.tracked.address,
      label: r.tracked.label,
      direction: change > 0n ? "in" : "out",
      counterparty: null,
      counterpartyLabel: null,
      symbol: net.nativeSymbol,
      amount: size.toString(),
      shown,
      block: at.toString(),
      tx: null,
      logIndex: null,
      message: `${r.tracked.label}'s ${net.nativeSymbol} balance ${change > 0n ? "rose" : "fell"} by ${shown} since block ${BigInt(r.before!.block).toLocaleString("en-US")}, to ${formatAmount(r.native, 18, 4)} ${net.nativeSymbol}`,
    });
  }
  const events = [...moves.slice(0, MAX_MOVES), ...changes];

  const shownFlow = ([count, raw]: [number, bigint], token: TrackedToken): Flow => ({ count, raw: raw.toString(), shown: `${formatAmount(raw, token.decimals, placesOf(token.decimals))} ${token.symbol}` });
  const addresses: AddressReport[] = reads.map((r) => {
    const prev = r.comparable ? r.before! : null;
    const nativeChange = prev ? r.native - BigInt(prev.native) : null;
    return {
      address: r.tracked.address,
      label: r.tracked.label,
      contract: r.contract,
      native: { raw: r.native.toString(), shown: `${formatAmount(r.native, 18, 4)} ${net.nativeSymbol}`, change: nativeChange?.toString() ?? null, changeShown: nativeChange === null ? null : signed(nativeChange, 18, 4, net.nativeSymbol) },
      nonce: r.nonce.toString(),
      sent: prev ? Number(r.nonce - BigInt(prev.nonce)) : null,
      since: prev?.block ?? null,
      tokens: list.tokens.map((t) => {
        const raw = r.tokens.get(t.token.toLowerCase())!;
        const before = prev?.tokens[t.token.toLowerCase()];
        const change = before === undefined ? null : raw - BigInt(before);
        const f = flows.get(`${r.tracked.address.toLowerCase()}:${t.token.toLowerCase()}`) ?? { in: [0, 0n] as [number, bigint], out: [0, 0n] as [number, bigint] };
        return { token: t.token, symbol: t.symbol, raw: raw.toString(), shown: `${formatAmount(raw, t.decimals, placesOf(t.decimals))} ${t.symbol}`, change: change?.toString() ?? null, changeShown: change === null ? null : signed(change, t.decimals, placesOf(t.decimals), t.symbol), in: shownFlow(f.in, t), out: shownFlow(f.out, t) };
      }),
      significant: events.filter((e) => e.address === r.tracked.address).length,
    };
  });

  const snapshots = { ...store.snapshots };
  for (const r of reads) {
    if (r.before && !r.comparable) continue;
    snapshots[r.tracked.address.toLowerCase()] = { block: at.toString(), native: r.native.toString(), nonce: r.nonce.toString(), contract: r.contract, tokens: Object.fromEntries([...r.tokens].map(([token, raw]) => [token, raw.toString()])) };
  }
  const after: WhaleStore = { ...store, cursor: at > BigInt(store.cursor ?? -1) ? at.toString() : store.cursor, snapshots };
  const shownAt = at.toLocaleString("en-US");
  const headline = events.length
    ? `${events.length} significant ${events.length === 1 ? "move" : "moves"} at block ${shownAt}: ${events[0]!.message}${events.length > 1 ? " …" : "."}`
    : `No significant moves at block ${shownAt}; ${scanning ? `${transfers} ${transfers === 1 ? "transfer" : "transfers"} by tracked addresses in blocks ${from.toLocaleString("en-US")}–${shownAt}` : "no new blocks"}.`;
  return {
    schema: "pharos-agent/whale-run/1",
    watchlist: list.name,
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: at.toString(), hash: pinned.hash, timestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), source: options.block === undefined ? "latest" : "requested" },
    evaluatedAt: now.toISOString(),
    scanned: scanning ? { from: from.toString(), to: at.toString(), pages } : null,
    skipped: scanning ? skipped : null,
    addresses,
    events,
    truncated: Math.max(0, moves.length - MAX_MOVES),
    transfers,
    store: after,
    headline,
    toolCalls: chain.mcp.toolCalls,
  };
}
