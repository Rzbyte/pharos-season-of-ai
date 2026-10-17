// Task 17, Natural-Language Payment Agent: a payment request in plain words, read into payments. The
// reading is a small grammar, not a language model. Every word of the request must be read, or the
// request is refused with the words that were not: nothing is paid that was not asked for, and nothing
// asked for is dropped.
//
//   Pay alice 25 USDC                          Send 25 USDC to alice for the March invoice
//   Pay alice 25 USDC and bob 5 USDC           Send 5 USDC each to alice, bob and 0x…
//   Split 30 USDC between alice and bob        Transfer 0.01 PROS to 0x…; then pay bob 2 USDC
//
// A recipient is an address, or a name in the address book the run is given. An amount comes with its
// asset: PROS (PHRS on Atlantic) or an official token of the Skill Engine's list. "from 0x…" names the
// sender. "for …" is a note kept with the payment; a token transfer carries none on chain.
import { getAddress } from "viem";
import { formatAmount, parseAmount } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Network, Token } from "../core/networks.js";

export interface RequestedPayment {
  to: { address: Address; name: string | null };
  /** The official token, or null for the native token. */
  token: Token | null;
  /** In the asset's units, as paid: a split's share is worked out exactly in base units. */
  amount: string;
  raw: bigint;
  /** "each" for one amount to every recipient, "split" for one amount shared among them. */
  share: "each" | "split" | null;
  memo: string | null;
  /** The words it was read from. */
  words: string;
}

export interface PaymentRequest {
  payments: RequestedPayment[];
  /** The sender the request names ("from 0x…"), if it names one. */
  from: Address | null;
}

/** An address book: names (case-insensitive) to addresses. */
export type Contacts = Readonly<Record<string, Address>>;

export const MAX_REQUEST = 500;
const bad = (message: string) => new AgentError("usage", message);
const VERBS = new Set(["pay", "send", "transfer", "give"]);
/** Words a clause may open with before its verb: "please", "could you", "I want to"… */
const FILLER = new Set("please kindly could can would you i i'd id want like to also then and just thanks thank".split(" "));
const SPLIT_WITH = new Set(["between", "among", "amongst", "with"]);

type Tok = { kind: "word" | "number" | "address" | "sep"; text: string; at: number };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const rule = /(0x[0-9a-fA-F]{40})(?![0-9a-zA-Z])|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w.])|([A-Za-z][A-Za-z0-9_'-]*)|([,;.!?\n&])|(\s+)|(.)/g;
  for (const m of text.matchAll(rule)) {
    if (m[5]) continue;
    if (m[6]) throw bad(`The request has a character it cannot read: "${m[6]}" (at ${m.index! + 1}).`);
    const kind = m[1] ? "address" : m[2] ? "number" : m[3] ? "word" : "sep";
    out.push({ kind, text: m[2] ? m[2].replaceAll(",", "") : m[0], at: m.index! });
  }
  return out;
}

/** Name-to-address pairs from untrusted input: a JSON object, or "name = 0x…" by line or comma. */
export function parseContacts(input: unknown): Contacts {
  let pairs: [string, unknown][];
  if (input === undefined || input === null || input === "") return {};
  if (typeof input === "object" && !Array.isArray(input)) pairs = Object.entries(input as Record<string, unknown>);
  else if (typeof input === "string") {
    pairs = input
      .split(/[\n,;]+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.search(/[=:]/);
        if (at === -1) throw bad(`An address book line reads "name = 0x…", got "${line.slice(0, 60)}".`);
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      });
  } else throw bad("The address book is a list of name = 0x… pairs.");
  if (pairs.length > 20) throw bad("The address book holds at most 20 names.");
  const out: Record<string, Address> = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key) || VERBS.has(key) || FILLER.has(key) || ["each", "for", "from", "split", "equally", "between", "among", "amongst", "with"].includes(key)) throw bad(`"${name}" cannot be a name in the address book: a name is a word of letters, digits, _ or -, and not one the request reads itself.`);
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) throw bad(`${name}'s address must be 0x and 40 hex characters.`);
    out[key] = getAddress(value.trim().toLowerCase());
  }
  return out;
}

/** The asset a word names: null for the native token, an official token, undefined for neither. */
function assetOf(net: Network, word: string): Token | null | undefined {
  const upper = word.toUpperCase();
  if (upper === net.nativeSymbol) return null;
  const token = net.tokens.find((t) => t.symbol.toUpperCase() === upper);
  return token && { ...token, address: getAddress(token.address) };
}

/**
 * The payments a request asks for. Refuses, saying why, a request it cannot read whole: an unknown
 * name or asset, an amount for several recipients without "each" or "split", words left over.
 */
export function parseRequest(text: unknown, contacts: Contacts, net: Network, max = 10): PaymentRequest {
  const request = typeof text === "string" ? text.trim() : "";
  if (!request) throw bad('Write a payment request, like: "Pay alice 25 USDC" or "Send 0.01 PROS to 0x…".');
  if (request.length > MAX_REQUEST) throw bad(`A request is at most ${MAX_REQUEST} characters.`);
  const toks = tokenize(request);
  let i = 0;
  const peek = (k = 0) => toks[i + k];
  const word = (k = 0) => (peek(k)?.kind === "word" ? peek(k)!.text.toLowerCase() : null);
  const known = () => Object.keys(contacts).join(", ") || "none given";
  const wordsFrom = (start: number) => request.slice(toks[start]!.at, i < toks.length ? toks[i]!.at : request.length).replace(/[\s,;.!?&]+$/, "").trim();
  const isRecipient = (k = 0) => peek(k)?.kind === "address" || (peek(k)?.kind === "word" && Object.hasOwn(contacts, word(k)!));
  const tokens = net.tokens.map((t) => t.symbol).join(", ");

  const recipient = (): RequestedPayment["to"] => {
    const t = peek();
    if (t?.kind === "address") {
      i += 1;
      return { address: getAddress(t.text.toLowerCase()), name: null };
    }
    if (t?.kind === "word" && Object.hasOwn(contacts, t.text.toLowerCase())) {
      i += 1;
      return { address: contacts[t.text.toLowerCase()]!, name: t.text.toLowerCase() };
    }
    if (t?.kind === "word") throw bad(`Who is "${t.text}"? Name an address (0x…), or a name in the address book (${known()}).`);
    throw bad(`A recipient is missing${t ? ` before "${request.slice(t.at, t.at + 30)}"` : " at the end"}.`);
  };
  /** One recipient, or several joined by commas and "and". */
  const recipients = (): RequestedPayment["to"][] => {
    const list = [recipient()];
    while ((peek()?.text === "," || word() === "and" || peek()?.text === "&") && isRecipient(1)) {
      i += 1;
      list.push(recipient());
    }
    return list;
  };
  const amount = (): { value: string; token: Token | null } => {
    const n = peek();
    if (n?.kind !== "number") throw bad(`An amount is missing${n ? ` before "${request.slice(n.at, n.at + 30)}"` : " at the end"}.`);
    const unit = peek(1);
    if (unit?.kind !== "word") throw bad(`${n.text} of what? Name the asset after the amount: ${net.nativeSymbol} or ${tokens}.`);
    const token = assetOf(net, unit.text);
    if (token === undefined) throw bad(`${unit.text} is not ${net.nativeSymbol} or an official ${net.name} token (${tokens}).`);
    i += 2;
    return { value: n.text, token };
  };
  /** "for …" up to the end of the clause: a separator, or "and"/"then" before another payment. */
  const memo = (): string | null => {
    if (word() !== "for") return null;
    const start = (i += 1);
    while (i < toks.length) {
      const t = peek()!;
      if (t.kind === "sep" && t.text !== "&") break;
      if ((word() === "and" || word() === "then" || t.text === "&") && (VERBS.has(word(1) ?? "") || peek(1)?.kind === "number" || (isRecipient(1) && peek(2)?.kind === "number"))) break;
      if (word() === "from" && isRecipient(1)) break;
      i += 1;
    }
    if (i === start) throw bad('"for" needs a note after it, like "for the March invoice".');
    const text = request.slice(toks[start]!.at, i < toks.length ? toks[i]!.at : request.length).replace(/[\s,;.!?&]+$/, "").trim();
    return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
  };

  const payments: RequestedPayment[] = [];
  let from: Address | null = null;
  let verb: string | null = null;
  const add = (to: RequestedPayment["to"], token: Token | null, raw: bigint, share: RequestedPayment["share"], note: string | null, words: string) => {
    if (payments.length >= max) throw bad(`A request is at most ${max} payments.`);
    const decimals = token?.decimals ?? 18;
    payments.push({ to, token, amount: formatAmount(raw, decimals, decimals).replaceAll(",", ""), raw, share, memo: note, words });
  };
  const sender = () => {
    if (word() !== "from") return;
    i += 1;
    const who = recipient().address;
    if (from && from !== who) throw bad("The request names two senders; a flow pays from one.");
    from = who;
  };

  while (i < toks.length) {
    // Separators, and the filler before a verb ("please", "could you", "and then").
    while (i < toks.length && (peek()!.kind === "sep" || (FILLER.has(word() ?? "") && !isRecipient()))) i += 1;
    if (i >= toks.length) break;
    const start = i;
    const w = word();
    if (w === "split") {
      i += 1;
      const { value, token } = amount();
      if (word() === "equally") i += 1;
      if (!SPLIT_WITH.has(word() ?? "")) throw bad(`Split ${value} ${token?.symbol ?? net.nativeSymbol} between whom? Write "between alice and bob".`);
      i += 1;
      const list = recipients();
      if (list.length < 2) throw bad("A split is between two recipients or more.");
      sender();
      const note = memo();
      sender();
      const decimals = token?.decimals ?? 18;
      const total = parseAmount(value, decimals, "amount");
      const share = total / BigInt(list.length);
      if (share === 0n) throw bad(`${value} cannot be split ${list.length} ways at ${decimals} decimals.`);
      const words = wordsFrom(start);
      // The share is exact in base units; what is left over goes to the first recipient, so the parts add up.
      list.forEach((to, k) => add(to, token, share + (k === 0 ? total - share * BigInt(list.length) : 0n), "split", note, words));
      verb = "pay";
      continue;
    }
    if (w !== null && VERBS.has(w)) {
      verb = w;
      i += 1;
    } else if (!verb || !(peek()?.kind === "number" || isRecipient())) {
      throw bad(`This is not read as a payment: "${request.slice(peek()!.at, peek()!.at + 40)}". Start with pay, send, transfer, give or split.`);
    }
    let list: RequestedPayment["to"][];
    let asked: { value: string; token: Token | null };
    let each = false;
    if (peek()?.kind === "number") {
      // "send 25 USDC (each) to alice"
      asked = amount();
      if (word() === "each") {
        each = true;
        i += 1;
      }
      if (word() !== "to") throw bad(`To whom? Write "${asked.value} ${asked.token?.symbol ?? net.nativeSymbol} to alice" or to an address.`);
      i += 1;
      list = recipients();
    } else {
      // "pay alice 25 USDC (each)"
      list = recipients();
      asked = amount();
      if (word() === "each") {
        each = true;
        i += 1;
      }
    }
    if (list.length > 1 && !each) throw bad(`${asked.value} ${asked.token?.symbol ?? net.nativeSymbol} to ${list.length} recipients: write "each" to send it to every one, or "split" to share it.`);
    sender();
    const note = memo();
    sender();
    const raw = parseAmount(asked.value, asked.token?.decimals ?? 18, "amount");
    if (raw === 0n) throw bad("An amount must be more than zero.");
    const words = wordsFrom(start);
    for (const to of list) add(to, asked.token, raw, list.length > 1 ? "each" : null, note, words);
    // Whatever follows must start another clause: a separator, a filler word ("and", "then", "please"), or a verb.
    const next = peek();
    if (next && next.kind !== "sep" && !FILLER.has(word() ?? "") && !VERBS.has(word() ?? "") && word() !== "split") throw bad(`This is not read as part of a payment: "${request.slice(next.at, next.at + 40)}".`);
  }
  if (!payments.length) throw bad('The request names no payment. Write, like: "Pay alice 25 USDC".');
  return { payments, from };
}
