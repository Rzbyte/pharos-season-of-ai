// Task 18, Recurring Payment Agent: one run of a schedule of repeating payments (subscriptions, payroll,
// rent), made to be run again and again, by hand or from cron.
//
//   1. The schedule, read (schedule.ts): who is paid, how much of what, and when. Nothing is asked of the
//      chain for a schedule it cannot read whole.
//   2. The day, from the chain: the pinned block's UTC day. Every day each payment fell due since the
//      start (the store's, or one given), not recorded as paid, is owed: a run that was missed, or a
//      payment that did not go through, is caught up on the next run. Each run takes the oldest, at most
//      a few of one payment and a few in all; the rest wait for the next.
//   3. Prepared as Task 17 prepares a flow, at the same block: the payer's nonce, Task 08's dry run of
//      each payment, the totals against what the payer holds, the transactions to sign, the Skill
//      Engine's cast send. On Atlantic, with a key and a store, they are sent in order, each checked
//      against its receipt; the store records each one paid, so it is never paid twice.
import type { Address, BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import { EXAMPLE } from "../builder/action.js";
import type { DryRunOptions } from "../dryrun/run.js";
import { prepareFlow, type PaymentFlow, type PlannedPayment } from "../payment/flow.js";
import { dayOf, isoOf, MAX_ITEMS, nextDue, occurrences, readSchedule, type ScheduleItem } from "./schedule.js";
import { emptyRecurringStore, type PaidPayment, type RecurringStore } from "./store.js";

export interface OwedPayment {
  /** "<payment>@<due day>". */
  id: string;
  item: string;
  name: string;
  date: string;
  amount: string;
  asset: string;
  /** Days since it fell due. */
  late: number;
}

export interface RecurringRun {
  schema: "pharos-agent/recurring-run/1";
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: string; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  /** The block's UTC day: what is due is due by it. */
  today: string;
  since: string;
  sinceFrom: "store" | "input" | "month" | "today";
  payer: { address: Address; from: "input" | "store" | "example" };
  items: { id: string; name: string; to: Address; asset: string; amount: string; every: string; from: string | null; until: string | null; owed: number; next: string | null }[];
  /** Every payment owed by today, oldest first. */
  owed: OwedPayment[];
  /** The owed payments this run takes, in its order. */
  due: string[];
  /** Owed past this run's limits: the next run takes them. */
  later: number;
  nonce: number | null;
  payments: PlannedPayment[];
  totals: PaymentFlow["totals"];
  fees: PaymentFlow["fees"];
  skillEngine: PaymentFlow["skillEngine"] | null;
  /** Sent this run and in a block: recorded as paid. */
  paid: PaidPayment[];
  /** The store after this run; null when the run keeps none. */
  store: RecurringStore | null;
  verdict: "nothing-due" | "ready" | "short" | "would-fail" | "sent" | "partly-sent";
  headline: string;
  steps: { source: string; text: string }[];
  toolCalls: number;
}

export interface RecurringOptions {
  chain: Chain;
  /** The store from the last run; with `keep` and none, a new one is started. */
  store?: RecurringStore | null;
  /** Return the store after this run (the CLI's --store). */
  keep?: boolean;
  /** The payer, over the store's; on Atlantic with a key, the key's address. */
  from?: Address;
  /** Without a store: the first day counted, YYYY-MM-DD; else `sinceDefault`. */
  since?: string;
  /** Without a store or `since`: the block's day, or the first of its month. */
  sinceDefault?: "today" | "month";
  block?: bigint;
  /** Atlantic only, with a store: send the payments taken, signed by this key. */
  signer?: Signer;
  wait?: DryRunOptions["wait"];
  /** The most of one payment a run takes (default 3), and of all (default 10). */
  maxPerItem?: number;
  maxPayments?: number;
  maxItems?: number;
  now?: () => Date;
}

const bad = (message: string) => new AgentError("usage", message);
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const group = (n: number | bigint) => n.toLocaleString("en-US");
/** Ten years: a store started further back is not caught up. */
const MAX_DAYS = 3660;

const money = (amount: string, asset: string) => `${amount.replace(/^\d+/, (whole) => group(BigInt(whole)))} ${asset}`;

export async function runRecurring(text: string, options: RecurringOptions): Promise<RecurringRun> {
  const { chain } = options;
  const net = chain.network;
  const maxPerItem = options.maxPerItem ?? 3;
  const maxPayments = options.maxPayments ?? 10;
  if (!Number.isInteger(maxPerItem) || maxPerItem < 1 || !Number.isInteger(maxPayments) || maxPayments < 1 || maxPayments > 20) throw bad("A run takes 1 to 20 payments, and at least 1 of each.");
  // The schedule is read whole before anything is asked of the chain.
  const items = readSchedule(text, net, options.maxItems ?? MAX_ITEMS);
  const store = options.store ?? null;
  if (options.signer && !options.keep) throw bad("Sending needs a store, so that each payment is recorded as paid and never paid twice: give --store FILE.");
  if (store && options.since && options.since !== store.since) throw bad(`The store counts from ${store.since}; a store's start is not moved. Start a new store to count from ${options.since}.`);
  if (options.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.since)) throw bad("since must be a day as YYYY-MM-DD.");
  const payerFrom: RecurringRun["payer"]["from"] | null = options.from ? "input" : store ? "store" : net.id === "pharos-mainnet" ? "example" : null;
  const payer = options.from ?? store?.payer ?? (net.id === "pharos-mainnet" ? EXAMPLE.account : null);
  if (!payer || !payerFrom) throw bad("Name the payer: --from 0x… (on Atlantic there is no example to fall back on).");
  if (store && store.payer.toLowerCase() !== payer.toLowerCase()) throw bad(`The store belongs to the payer ${store.payer}, not ${payer}: one store a payer.`);
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  await chain.expectChain();
  const head: BlockHeader = await chain.block(options.block ?? (await chain.blockNumber()));
  const source = options.block === undefined ? ("latest" as const) : ("requested" as const);
  const today = isoOf(Math.floor(Number(head.timestamp) / 86_400));
  const sinceFrom: RecurringRun["sinceFrom"] = store ? "store" : options.since ? "input" : (options.sinceDefault ?? "today");
  const since = store?.since ?? options.since ?? (sinceFrom === "month" ? `${today.slice(0, 8)}01` : today);
  if (since > today) throw bad(`The start, ${since}, is after the block's day, ${today}.`);
  if (dayOf(today) - dayOf(since) > MAX_DAYS) throw bad(`The start, ${since}, is more than ten years before ${today}: start from a later day.`);
  if (!store && dayOf(today) - dayOf(since) > 366) throw bad(`Without a store, a run counts from a day in the last year: ${since} is more than a year before ${today}.`);
  const steps: RecurringRun["steps"] = [];
  // A payment sent but not in a block when the last run ended: its receipt says whether it was paid.
  const settled: PaidPayment[] = [];
  const settling: string[] = [];
  for (const p of store?.paid ?? []) {
    if (p.status === "success") {
      settled.push(p);
      continue;
    }
    const receipt = await chain.receipt(p.tx);
    if (receipt?.status === "success") settled.push({ ...p, block: receipt.blockNumber.toString(), status: "success" });
    else if (!receipt) settled.push(p);
    settling.push(`${p.id} ${receipt ? (receipt.status === "success" ? `paid in block ${group(receipt.blockNumber)}` : "reverted: owed again") : "still not in a block: not paid again while it may land"}`);
  }
  steps.push({ source: "the schedule", text: `Read ${items.length === 1 ? "one payment" : `${items.length} payments`}: ${items.map((item) => `${item.name}, ${money(item.amount, item.asset)} ${item.every}`).join("; ")}.` });

  if (settling.length) steps.push({ source: "Chain MCP · get_transaction_receipt", text: `Sent but pending at the last run: ${settling.join("; ")}.` });
  // What is owed by today: every due day since the start, not recorded as paid (or pending).
  const paidIds = new Set(settled.map((p) => p.id));
  const owed: OwedPayment[] = [];
  for (const item of items) for (const date of occurrences(item, since, today)) if (!paidIds.has(`${item.id}@${date}`)) owed.push({ id: `${item.id}@${date}`, item: item.id, name: item.name, date, amount: item.amount, asset: item.asset, late: dayOf(today) - dayOf(date) });
  owed.sort((a, b) => (a.date === b.date ? items.findIndex((i) => i.id === a.item) - items.findIndex((i) => i.id === b.item) : a.date < b.date ? -1 : 1));
  const taken = new Map<string, number>();
  const due: OwedPayment[] = [];
  for (const o of owed) {
    if (due.length >= maxPayments || (taken.get(o.item) ?? 0) >= maxPerItem) continue;
    taken.set(o.item, (taken.get(o.item) ?? 0) + 1);
    due.push(o);
  }
  const later = owed.length - due.length;
  const start = store ? `the store's start, with ${settled.length === 0 ? "nothing" : settled.length === 1 ? "one payment" : `${settled.length} payments`} recorded as paid` : sinceFrom === "input" ? "the start given" : sinceFrom === "month" ? "the first of this month; nothing is kept between runs here" : "today, the first day counted";
  steps.push({
    source: "the calendar",
    text: `At block ${group(head.number)}'s day, ${today}, counting from ${since} (${start}): ${owed.length === 0 ? "nothing is owed." : `${owed.length} owed, ${owed.slice(0, 6).map((o) => `${o.name} of ${o.date}`).join(", ")}${owed.length > 6 ? ` and ${owed.length - 6} more` : ""}.`}${later ? ` This run takes ${due.length} (at most ${maxPerItem} of one payment, ${maxPayments} in all); ${later} ${later === 1 ? "waits" : "wait"} for the next.` : ""}`,
  });
  const itemsView = items.map((item) => ({ id: item.id, name: item.name, to: item.to, asset: item.asset, amount: item.amount, every: item.every, from: item.from, until: item.until, owed: owed.filter((o) => o.item === item.id).length, next: nextDue(item, today) }));
  const upcoming = itemsView.filter((i) => i.next).sort((a, b) => (a.next! < b.next! ? -1 : a.next! > b.next! ? 1 : 0));
  const nextWords = upcoming.length ? `Next: ${upcoming.slice(0, 4).map((i) => `${i.name} on ${i.next}`).join(", ")}${upcoming.length > 4 ? ", and more" : ""}.` : "No payment falls due again: each has ended.";

  const base = {
    schema: "pharos-agent/recurring-run/1" as const,
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: head.number.toString(), hash: head.hash, timestamp: new Date(Number(head.timestamp) * 1000).toISOString(), source },
    evaluatedAt,
    today,
    since,
    sinceFrom,
    payer: { address: payer, from: payerFrom },
    items: itemsView,
    owed,
    due: due.map((o) => o.id),
    later,
  };
  const keep = (paid: PaidPayment[]): RecurringStore | null => (options.keep ? { ...(store ?? emptyRecurringStore(net.id, payer, since)), lastRun: { block: head.number.toString(), day: today }, paid: [...settled, ...paid] } : null);

  if (!due.length) {
    const headline = `Nothing is due at ${today}: ${owed.length === 0 ? `every payment since ${since} is paid or not yet due` : "nothing owed"}. ${nextWords}`;
    steps.push({ source: "the verdict", text: headline });
    return { ...base, nonce: null, payments: [], totals: [], fees: null, skillEngine: null, paid: [], store: keep([]), verdict: "nothing-due", headline, steps, toolCalls: chain.mcp.toolCalls };
  }

  // The payments taken, prepared and (on Atlantic, with a key) sent as Task 17's flow, at the same block.
  const byId = new Map<string, ScheduleItem>(items.map((item) => [item.id, item]));
  const flow = await prepareFlow(
    { payments: due.map((o) => { const item = byId.get(o.item)!; return { to: { address: item.to, name: item.name }, token: item.token, amount: item.amount, raw: item.raw, share: null, memo: `${item.name}, due ${o.date}`, words: item.line }; }), from: payer },
    text.trim(),
    { chain, from: payer, at: { header: head, source }, signer: options.signer, wait: options.wait, now: options.now, requestStep: false },
  );
  steps.push(...flow.steps.filter((s) => s.source !== "the verdict"));
  // Paid when in a block and a success; kept as pending, never sent again, while it may still land.
  const paid = flow.payments.flatMap((p, k): PaidPayment[] => (p.submission?.status === "success" ? [{ id: due[k]!.id, tx: p.submission.txHash as Hex, block: p.submission.blockNumber!, status: "success" }] : p.submission?.status === "pending" ? [{ id: due[k]!.id, tx: p.submission.txHash as Hex, block: null, status: "pending" }] : []));
  const sentOk = paid.filter((p) => p.status === "success").length;
  const after = keep(paid);
  if (after) steps.push({ source: "the store", text: paid.length ? `Recorded ${paid.length === 1 ? "one payment" : `${paid.length} payments`}: ${paid.map((p) => `${p.id}${p.status === "pending" ? " (pending: its receipt is read next run)" : ""}`).join(", ")}. The next run will not pay them again.` : `Nothing recorded as paid: ${options.signer ? "none went through" : "nothing was sent"}, so ${due.length === 1 ? "it stays" : "they stay"} owed for the next run.` });
  steps.push({ source: "the calendar", text: nextWords });

  const verdict: RecurringRun["verdict"] = flow.verdict;
  const all = due.length === 1 ? "The payment due" : `The ${due.length} payments due`;
  const totalWords = flow.totals.filter((t) => t.raw !== "0").map((t) => t.shown).join(" and ");
  const notSent = net.id === "pharos-mainnet" ? "Nothing was sent: the hosted Chain MCP is read-only." : "Nothing was sent.";
  const failing = flow.payments.find((p) => p.dryRun.verdict !== "would-succeed");
  const shortOf = flow.totals.filter((t) => !t.covered);
  const waits = later ? ` ${later} more ${later === 1 ? "waits" : "wait"} for the next run.` : "";
  const headline =
    verdict === "sent"
      ? `${all}, ${totalWords} in all, sent and checked against ${due.length === 1 ? "its receipt" : "their receipts"}, and recorded as paid.${waits}`
      : verdict === "partly-sent"
        ? `${sentOk} of ${due.length} payments sent and recorded as paid; ${due[sentOk]!.id} ${paid.length > sentOk ? "is not yet in a block (recorded as pending, never sent again while it may land)" : "did not go through, so it stays owed"}, and the rest wait for the next run.`
        : verdict === "would-fail"
          ? `${failing!.memo}: ${money(failing!.amount, failing!.asset)} to ${short(failing!.to.address)} would not go through: ${failing!.dryRun.reason ?? "it fails."} ${notSent}`
          : verdict === "short"
            ? `${all} ${due.length === 1 ? "needs" : "need"} ${shortOf.map((t) => t.needsShown).join(" and ")}, but ${short(payer)} holds ${shortOf.map((t) => t.holdsShown).join(" and ")}. ${notSent}`
            : `${all} by ${today}, ${totalWords} in all, ready to sign: each dry-runs at block ${group(head.number)}, for about ${flow.fees!.expectedShown} in gas together. ${notSent}${waits}`;
  steps.push({ source: "the verdict", text: headline });
  return { ...base, nonce: flow.nonce, payments: flow.payments, totals: flow.totals, fees: flow.fees, skillEngine: flow.skillEngine, paid, store: after, verdict, headline, steps, toolCalls: chain.mcp.toolCalls };
}
