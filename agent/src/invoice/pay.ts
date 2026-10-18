// Task 19, Invoice-to-Payment Agent: an invoice turned into the payment it asks for, prepared on Pharos.
//
//   1. The invoice, read (read.ts): the payee, the amount and asset, every figure checked against the
//      others, its payment link if it has one. Nothing is asked of the chain for an invoice it refuses.
//   2. Who is paid: the payee against your payees (names and the addresses you have checked for them).
//   3. Through Chain MCP at one block: for a token, what the payer sent over the last blocks (get_logs,
//      pages of at most 1,000 blocks, one query a page). The same amount to the payee already (paid
//      twice?), a payee that starts and ends like an address the payer pays but is not one (address
//      poisoning, a swapped invoice), transfers of nothing to the payee (how poisoning plants one).
//   4. The payment, prepared as Task 17 prepares a flow: the payer's nonce, Task 08's dry run, the funds
//      it needs, the transaction to sign, the Skill Engine's cast send, and the same payment as an
//      EIP-681 link. Anything that calls for a check holds it: on Atlantic, with a key, it is sent only
//      when nothing does, and checked against its receipt.
import { getAddress, pad } from "viem";
import { formatAmount } from "../core/amounts.js";
import type { Address, BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import type { DryRunOptions } from "../dryrun/run.js";
import { EXAMPLE } from "../builder/action.js";
import { prepareFlow, type PaymentFlow, type PlannedPayment } from "../payment/flow.js";
import { LOG_PAGE, TRANSFER_TOPIC } from "../policy/check.js";
import { DEFAULT_BLOCKS, MAX_BLOCKS, looksLike } from "../risk/check.js";
import { formatLink } from "./link.js";
import { addressesIn, readInvoice, type Invoice } from "./read.js";

export { DEFAULT_BLOCKS, MAX_BLOCKS };

/** Your payees: names you have checked, each with its address. Keyed by the name in lowercase words. */
export type Payees = Readonly<Record<string, { name: string; address: Address }>>;

export interface InvoiceCheck {
  id: "figures" | "link" | "network" | "payee" | "duplicate" | "lookalike" | "zero-value" | "due" | "dry-run" | "funds";
  /** "warn" holds the payment for a check first; "fail" is a payment that cannot go through. */
  state: "ok" | "info" | "warn" | "fail";
  title: string;
  detail: string;
  source: string;
}

export interface InvoicePayment {
  schema: "pharos-agent/invoice-payment/1";
  invoice: Invoice;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: string; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  payer: { address: Address; from: "input" | "invoice" | "example" };
  payee: { address: Address; name: string | null; book: { status: "matches" | "listed" | "other-name" | "differs" | "new"; name: string | null; address: Address | null } };
  /** The due date, counted at the block's time. */
  due: { date: string | null; days: number | null; words: string };
  /** What the payer sent of the invoice's token over the last blocks; null for the native token, which leaves no log. */
  history: { token: string; from: string; to: string; pages: number; sent: number; toPayee: number; duplicates: { tx: Hex; block: string }[]; zeroValue: number; lookalike: { address: Address; times: number } | null } | null;
  nonce: number;
  payment: PlannedPayment;
  totals: PaymentFlow["totals"];
  fees: PaymentFlow["fees"];
  /** The same payment as an EIP-681 link, the payment request a wallet reads. */
  link: string;
  checks: InvoiceCheck[];
  skillEngine: PaymentFlow["skillEngine"];
  verdict: "ready" | "check-first" | "short" | "would-fail" | "sent" | "not-sent";
  headline: string;
  steps: { source: string; text: string }[];
  toolCalls: number;
}

export interface InvoiceOptions {
  chain: Chain;
  payees?: Payees;
  /** The payer, over the invoice's bill-to address; on Atlantic with a key, the key's address. */
  from?: Address;
  block?: bigint;
  /** Blocks of the payer's history to read (default 2,000, at most 10,000). */
  blocks?: number;
  /** Atlantic only: send the payment, signed by this key, when nothing calls for a check first. */
  signer?: Signer;
  wait?: DryRunOptions["wait"];
  maxInvoice?: number;
  now?: () => Date;
}

const bad = (message: string) => new AgentError("usage", message);
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const group = (n: number | bigint) => n.toLocaleString("en-US");
const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const DAY = 86_400_000;

/** Your payees from untrusted input: a JSON object, or "name = 0x…" a line. A name may have spaces. */
export function parsePayees(input: unknown): Payees {
  if (input === undefined || input === null || input === "") return {};
  let pairs: [string, string][];
  if (typeof input === "object" && !Array.isArray(input)) pairs = Object.entries(input as Record<string, unknown>).map(([name, value]) => [name, typeof value === "string" ? value : ""]);
  else if (typeof input === "string")
    pairs = input
      .split(/[\n;]+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.search(/0x/i);
        if (at <= 0) throw bad(`A payee line reads "name = 0x…", got "${line.slice(0, 60)}".`);
        return [line.slice(0, at).replace(/[\s=:,\-–]+$/, "").trim(), line.slice(at).trim()];
      });
  else throw bad("Your payees are a list of name = 0x… lines.");
  if (pairs.length > 20) throw bad("Your payees hold at most 20 names.");
  const out: Record<string, { name: string; address: Address }> = {};
  for (const [name, value] of pairs) {
    const key = nameKey(name);
    if (!/[a-z]/.test(key) || name.length > 64) throw bad(`"${name.slice(0, 70)}" cannot be a payee's name: it needs a letter, and at most 64 characters.`);
    const found = /^0x[0-9a-fA-F]{40}$/.test(value) ? addressesIn(value) : [];
    if (found.length !== 1) throw bad(`${name}'s address must be 0x and 40 hex characters.`);
    if (out[key]) throw bad(`"${name}" is in your payees twice.`);
    out[key] = { name: name.replace(/\s+/g, " "), address: found[0]! };
  }
  return out;
}

/** Your payees as a proof or a request records them: each name to its address. */
export function plainPayees(payees: Payees): Record<string, Address> {
  return Object.fromEntries(Object.values(payees).map((p) => [p.name, p.address]));
}

/** The payee against your payees: the name the invoice claims, and the address it gives. */
function againstPayees(payees: Payees, payee: Address, claimed: string | null): InvoicePayment["payee"]["book"] {
  const byName = claimed ? (payees[nameKey(claimed)] ?? null) : null;
  const byAddress = Object.values(payees).find((p) => p.address === payee) ?? null;
  if (byName) return { status: byName.address === payee ? "matches" : "differs", name: byName.name, address: byName.address };
  if (byAddress) return { status: claimed ? "other-name" : "listed", name: byAddress.name, address: byAddress.address };
  return { status: "new", name: null, address: null };
}

/** The due date in words, counted in whole days from the block's UTC date. */
function dueAt(date: string | null, at: Date): InvoicePayment["due"] {
  if (!date) return { date: null, days: null, words: "no due date" };
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())) / DAY);
  const words = days > 1 ? `due in ${days} days` : days === 1 ? "due tomorrow" : days === 0 ? "due today" : days === -1 ? "overdue by a day" : `overdue by ${-days} days`;
  return { date, days, words };
}

export async function payInvoice(text: string, options: InvoiceOptions): Promise<InvoicePayment> {
  const { chain } = options;
  const net = chain.network;
  const blocks = options.blocks ?? DEFAULT_BLOCKS;
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_BLOCKS) throw bad(`blocks must be a whole number from 1 to ${group(MAX_BLOCKS)}.`);
  // The invoice is read whole before anything is asked of the chain.
  const invoice = readInvoice(text, net, options.maxInvoice);
  const payerFrom = options.from ? "input" : invoice.payer ? "invoice" : net.id === "pharos-mainnet" ? "example" : null;
  const payer = options.from ?? invoice.payer ?? (net.id === "pharos-mainnet" ? EXAMPLE.account : null);
  if (!payer || !payerFrom) throw bad("Name the payer: --from 0x…, or a bill-to address on the invoice (on Atlantic there is no example to fall back on).");
  const payee = invoice.payee.address;
  if (payer === payee) throw bad(`The payer, ${short(payer)}, is the address the invoice asks to be paid at.`);
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  await chain.expectChain();
  const head: BlockHeader = await chain.block(options.block ?? (await chain.blockNumber()));
  const source = options.block === undefined ? ("latest" as const) : ("requested" as const);
  const at = new Date(Number(head.timestamp) * 1000);
  const raw = BigInt(invoice.due.raw);
  const amount = `${formatAmount(raw, invoice.decimals, invoice.decimals)} ${invoice.asset}`;
  const steps: InvoicePayment["steps"] = [];
  const checks: InvoiceCheck[] = [];
  const check = (c: InvoiceCheck) => checks.push(c);
  const what = invoice.number ? `invoice ${invoice.number}` : "the invoice";
  const fromWho = invoice.issuer ? ` from ${invoice.issuer}` : "";
  const due = dueAt(invoice.dueDate, at);

  const figures = invoice.sums.length ? invoice.sums.join(" ") : "It gives only the amount due, with nothing else to check it against.";
  const unread = invoice.notRead.length ? ` ${invoice.notRead.length === 1 ? "One line is" : `${invoice.notRead.length} lines are`} not part of it, and shown as not read.` : "";
  steps.push({ source: "the invoice", text: `Read ${what}${fromWho}: ${amount} to ${short(payee)}${invoice.dueDate ? `, due ${invoice.dueDate}${invoice.dueFrom === "terms" ? ` (${invoice.terms} from ${invoice.issued})` : ""}` : ""}. ${figures}${unread}` });
  check(invoice.sums.length ? { id: "figures", state: "ok", title: "The figures add up", detail: invoice.sums.join(" "), source: "the invoice" } : { id: "figures", state: "info", title: "Only the amount due is given", detail: "The invoice gives nothing else to check it against.", source: "the invoice" });
  if (invoice.link) {
    const ignored = invoice.link.ignored.length ? ` Its ${invoice.link.ignored.join(" and ")} ${invoice.link.ignored.length === 1 ? "is" : "are"} not used: the dry run sets the gas.` : "";
    const detail = `The EIP-681 link asks for ${amount} to ${short(payee)}${invoice.link.chainId !== null ? `, on chain ${invoice.link.chainId}` : ""}${invoice.sums.length || invoice.figures.amountDue || invoice.figures.total ? ", the same as the invoice" : ""}.${ignored}`;
    steps.push({ source: "the payment link", text: detail });
    check({ id: "link", state: "ok", title: invoice.sums.length || invoice.figures.amountDue || invoice.figures.total ? "Its payment link agrees" : "Read from its payment link", detail, source: "the payment link" });
  }
  check(
    invoice.network
      ? { id: "network", state: "ok", title: `On ${net.name}, as the invoice says`, detail: `The invoice writes "${invoice.network}"${invoice.link?.chainId ? `, and its link names chain ${invoice.link.chainId}` : ""}.`, source: "the invoice" }
      : invoice.link?.chainId
        ? { id: "network", state: "ok", title: `On ${net.name}, as its link says`, detail: `The payment link names chain ${invoice.link.chainId}.`, source: "the payment link" }
        : { id: "network", state: "info", title: "The invoice names no network", detail: `Read as ${net.name} (chain ${net.chainId}), the network this runs on.`, source: "the invoice" },
  );

  // Who is paid, against your payees.
  const claimed = invoice.issuer ?? invoice.payee.name;
  const book = againstPayees(options.payees ?? {}, payee, claimed);
  const count = Object.keys(options.payees ?? {}).length;
  steps.push({
    source: "your payees",
    text:
      book.status === "matches"
        ? `${book.name} is ${short(payee)} in your payees: the same address.`
        : book.status === "listed"
          ? `${short(payee)} is ${book.name} in your payees.`
          : book.status === "other-name"
            ? `${short(payee)} is ${book.name} in your payees, not ${claimed}.`
            : book.status === "differs"
              ? `Your payees give ${book.name} ${book.address}, not ${payee}.`
              : `${short(payee)} is not in your payees (${count === 0 ? "none given" : `${count} ${count === 1 ? "name" : "names"}`}).`,
  });

  // What the payer sent of the token over the last blocks: one query a page, sent by the payer.
  let history: InvoicePayment["history"] = null;
  if (invoice.token) {
    const start = head.number - BigInt(blocks) + 1n > 0n ? head.number - BigInt(blocks) + 1n : 0n;
    const seen = new Map<string, { to: Address; amount: bigint; block: bigint; tx: Hex }>();
    let pages = 0;
    for (let page = start; page <= head.number; page += LOG_PAGE) {
      const end = page + LOG_PAGE - 1n < head.number ? page + LOG_PAGE - 1n : head.number;
      pages += 1;
      for (const log of await chain.logs({ address: invoice.token, topics: [TRANSFER_TOPIC as Hex, pad(payer.toLowerCase() as Hex, { size: 32 })], fromBlock: page, toBlock: end })) {
        if (log.removed || log.topics.length !== 3 || typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
        seen.set(`${log.transactionHash}:${Number(log.logIndex)}`, { to: getAddress(`0x${log.topics[2]!.slice(-40)}`), amount: BigInt(log.data), block: BigInt(log.blockNumber), tx: log.transactionHash });
      }
    }
    const transfers = [...seen.values()];
    const toPayee = transfers.filter((t) => t.to === payee && t.amount > 0n);
    const duplicates = toPayee.filter((t) => t.amount === raw).sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
    const zeroValue = transfers.filter((t) => t.to === payee && t.amount === 0n).length;
    const paid = new Map<Address, number>();
    for (const t of transfers) if (t.amount > 0n && t.to !== payee) paid.set(t.to, (paid.get(t.to) ?? 0) + 1);
    const look = [...paid.entries()].filter(([address]) => looksLike(address, payee)).sort((a, b) => b[1] - a[1])[0];
    history = { token: invoice.asset, from: start.toString(), to: head.number.toString(), pages, sent: transfers.length, toPayee: toPayee.length, duplicates: duplicates.slice(0, 3).map((t) => ({ tx: t.tx, block: t.block.toString() })), zeroValue, lookalike: look ? { address: look[0], times: look[1] } : null };
    const span = `blocks ${group(start)} to ${group(head.number)}`;
    const found = transfers.length === 0 ? "none" : `${transfers.length} ${transfers.length === 1 ? "transfer" : "transfers"}, ${toPayee.length === 0 ? "none" : toPayee.length} to the payee${duplicates.length ? `, ${duplicates.length === 1 ? "one" : duplicates.length} of exactly ${amount}` : ""}`;
    steps.push({ source: "Chain MCP · get_logs", text: `${invoice.asset} sent by ${short(payer)} in ${span} (${pages} ${pages === 1 ? "query" : "queries"}): ${found}.` });
    check(
      duplicates.length
        ? { id: "duplicate", state: "warn", title: "May already be paid", detail: `${amount} went from ${short(payer)} to ${short(payee)} in block ${group(duplicates[0]!.block)} (${duplicates[0]!.tx})${duplicates.length > 1 ? `, and ${duplicates.length - 1} more ${duplicates.length === 2 ? "time" : "times"}` : ""}. Make sure this invoice was not paid already.`, source: "Chain MCP · get_logs" }
        : { id: "duplicate", state: "ok", title: `Not paid in the last ${group(blocks)} blocks`, detail: `No transfer of ${amount} from ${short(payer)} to ${short(payee)} in ${span}, the last ${group(blocks)}.`, source: "Chain MCP · get_logs" },
    );
    if (look) check({ id: "lookalike", state: "warn", title: "Looks like an address the payer pays", detail: `${payee} starts and ends like ${look[0]}, which ${short(payer)} paid ${look[1]} ${look[1] === 1 ? "time" : "times"} in ${span}, but it is a different address. Address poisoning and swapped invoices count on that.`, source: "Chain MCP · get_logs" });
    if (zeroValue) check({ id: "zero-value", state: "warn", title: "Transfers of nothing to the payee", detail: `${zeroValue} ${zeroValue === 1 ? "transfer" : "transfers"} of 0 ${invoice.asset} from ${short(payer)} to ${short(payee)} in ${span}: that is how address poisoning plants an address in a wallet's history.`, source: "Chain MCP · get_logs" });
  } else check({ id: "duplicate", state: "info", title: "Not checked for an earlier payment", detail: `A ${net.nativeSymbol} payment leaves no log, so one already made cannot be read here.`, source: "the invoice" });

  const paidBefore = (history?.toPayee ?? 0) > 0;
  const bookCheck: Record<typeof book.status, InvoiceCheck> = {
    matches: { id: "payee", state: "ok", title: `${book.name}, as in your payees`, detail: `Your payees give ${book.name} the same address, ${short(payee)}.`, source: "your payees" },
    listed: { id: "payee", state: "ok", title: `In your payees as ${book.name}`, detail: `The invoice names no one; your payees give ${book.name} this address.`, source: "your payees" },
    "other-name": { id: "payee", state: "warn", title: "In your payees under another name", detail: `The invoice is from ${claimed}, but your payees give ${short(payee)} to ${book.name}.`, source: "your payees" },
    differs: { id: "payee", state: "warn", title: "Not the address your payees give", detail: `Your payees give ${book.name} ${book.address}; this invoice asks to be paid at ${payee}. A changed address is how invoice fraud starts: confirm it with ${book.name} another way.`, source: "your payees" },
    new: paidBefore
      ? { id: "payee", state: "ok", title: "Paid before", detail: `Not in your payees, but ${short(payer)} paid ${short(payee)} ${history!.toPayee} ${history!.toPayee === 1 ? "time" : "times"} in the last ${group(blocks)} blocks.`, source: "Chain MCP · get_logs" }
      : { id: "payee", state: "warn", title: "A new payee", detail: `${short(payee)} is not in your payees${history ? `, and ${short(payer)} has not paid it in the last ${group(blocks)} blocks` : ""}. Confirm the address with the issuer another way before paying it for the first time.`, source: "your payees" },
  };
  check(bookCheck[book.status]);
  check({ id: "due", state: "info", title: due.date ? `${due.words[0]!.toUpperCase()}${due.words.slice(1)}` : "No due date", detail: due.date ? `Due ${due.date}${invoice.dueFrom === "terms" ? ` (${invoice.terms} from ${invoice.issued})` : ""}, counted at block ${group(head.number)}'s time, ${at.toISOString().slice(0, 10)}.` : "The invoice gives no due date or terms to count one from.", source: "the block's time" });

  // The payment, prepared as Task 17 prepares a flow; held, not sent, while anything calls for a check.
  // It is named only by a name your payees give its address: never by the name the invoice claims.
  const known = book.status === "matches" || book.status === "listed" || book.status === "other-name" ? book.name : null;
  const held = checks.some((c) => c.state === "warn");
  const flow = await prepareFlow(
    { payments: [{ to: { address: payee, name: known }, token: invoice.token ? { symbol: invoice.asset, name: invoice.asset, decimals: invoice.decimals, address: invoice.token } : null, amount: invoice.due.amount, raw, share: null, memo: what, words: `${what}${fromWho}` }], from: payer },
    text.trim(),
    { chain, from: payer, at: { header: head, source }, signer: held ? undefined : options.signer, wait: options.wait, now: options.now, requestStep: false },
  );
  const payment = flow.payments[0]!;
  const run = payment.dryRun;
  steps.push(...flow.steps.filter((s) => s.source !== "the verdict"));
  steps.push({ source: "the block's time", text: due.date ? `${due.date}: ${due.words}, at block ${group(head.number)}'s time.` : "No due date." });
  check(run.verdict === "would-succeed" ? { id: "dry-run", state: "ok", title: "The payment would succeed", detail: run.headline, source: "Chain MCP · eth_call · estimate_gas" } : { id: "dry-run", state: "fail", title: "The payment would not go through", detail: run.reason ?? run.headline, source: "Chain MCP · eth_call · estimate_gas" });
  const shortOf = flow.totals.filter((t) => !t.covered);
  check(
    shortOf.length
      ? { id: "funds", state: "fail", title: "Not enough to pay", detail: `${short(payer)} holds ${shortOf.map((t) => t.holdsShown).join(" and ")}; the payment needs ${shortOf.map((t) => t.needsShown).join(" and ")}.`, source: "the flow" }
      : { id: "funds", state: "ok", title: "Enough to pay", detail: `${short(payer)} holds ${flow.totals.map((t) => t.holdsShown).join(" and ")}; the payment needs ${flow.totals.map((t) => (t.token !== null ? t.needsShown : t.raw === "0" ? `up to ${t.needsShown} of gas` : `${t.needsShown} with its gas at most`)).join(", and ")}.`, source: "the flow" },
  );

  const warns = checks.filter((c) => c.state === "warn");
  const verdict: InvoicePayment["verdict"] = warns.length ? "check-first" : flow.verdict === "partly-sent" ? "not-sent" : flow.verdict;
  const to = `${short(payee)}${known && known !== invoice.issuer ? ` (${known})` : ""}`;
  const notSent = net.id === "pharos-mainnet" ? "Nothing was sent: the hosted Chain MCP is read-only." : "Nothing was sent.";
  const What = `${what[0]!.toUpperCase()}${what.slice(1)}`;
  const failing = run.verdict !== "would-succeed" ? ` The payment would also not go through: ${run.reason ?? run.headline}` : "";
  const submission = payment.submission;
  const headline =
    verdict === "check-first"
      ? `Check first: ${warns[0]!.title.toLowerCase()}${warns.length > 1 ? ` (and ${warns.length - 1} more)` : ""}. ${What}${fromWho} asks for ${amount} to ${payee}. ${notSent}${failing}`
      : verdict === "sent"
        ? `${What} paid: ${amount} to ${to}, sent and checked against its receipt${submission!.matched ? "" : ", which does not match the prediction"}.`
        : verdict === "not-sent"
          ? `${What}: the payment was sent, ${submission!.txHash}, but ${submission!.status === "pending" ? "is not yet in a block" : `${submission!.status} in block ${group(Number(submission!.blockNumber))}`}.`
          : verdict === "would-fail"
            ? `${What}${fromWho}: ${amount} to ${to} would not go through: ${run.reason ?? "it fails."} ${notSent}`
            : verdict === "short"
              ? `${What}${fromWho}: ${amount} to ${to} needs ${shortOf.map((t) => t.needsShown).join(" and ")}, but ${short(payer)} holds ${shortOf.map((t) => t.holdsShown).join(" and ")}. ${notSent}`
              : `${What}${fromWho}: ${amount} to ${to}${due.date ? `, ${due.words}` : ""}, ready to sign. It dry-runs at block ${group(head.number)} for about ${flow.fees!.expectedShown} of gas. ${notSent}`;
  steps.push({ source: "the verdict", text: headline });
  return {
    schema: "pharos-agent/invoice-payment/1",
    invoice,
    network: flow.network,
    chainMcp: flow.chainMcp,
    block: flow.block,
    evaluatedAt,
    payer: { address: payer, from: payerFrom },
    payee: { address: payee, name: invoice.payee.name, book },
    due,
    history,
    nonce: flow.nonce,
    payment,
    totals: flow.totals,
    fees: flow.fees,
    link: formatLink(net, { to: payee, token: invoice.token, raw }),
    checks,
    skillEngine: flow.skillEngine,
    verdict,
    headline,
    steps,
    toolCalls: chain.mcp.toolCalls,
  };
}
