// Task 19, Invoice-to-Payment Agent: an invoice, read. The text of an invoice (pasted from an email or a
// PDF), or a payment link, read into the one payment it asks for. The reading is rules, not a language
// model:
//
//   Invoice: INV-1042          From: Example Studio          Bill to: Example Shop
//   Issued: 2026-10-01         Due: 2026-11-01               (or Terms: Net 30)
//   Design work   15.00 USDC   Hosting, October: 5 USDC      (lines: a description, then an amount)
//   Subtotal: 20 USDC   Tax: 0   Total: 20 USDC   Amount due: 20 USDC
//   Pay to: 0x…                Network: Pharos Mainnet       Pay with: ethereum:0x…
//
// Every figure the invoice gives must agree with the others: the lines with the subtotal, the subtotal
// less any discount plus tax with the total, the total less what was paid with the amount due, and the
// payment link with all of them. An invoice that does not add up is refused, saying which figures
// disagree. So is one in a currency rather than an asset on Pharos, one for another network, one whose
// address fails its checksum, and one that names no address to pay. Lines that are none of these (a
// postal address, a thank-you) are kept as not read, and shown.
import { getAddress, zeroAddress } from "viem";
import { formatAmount, parseAmount } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { knownToken, type Network, type Token } from "../core/networks.js";
import { LINK, parseLink, type PaymentLink } from "./link.js";

export interface Money {
  /** In the asset's units, as written without grouping: "1250.5". */
  amount: string;
  raw: string;
}

export interface InvoiceLine {
  text: string;
  amount: string;
  raw: string;
}

export interface Invoice {
  number: string | null;
  /** Who sent the invoice ("From"). */
  issuer: string | null;
  /** Who it is billed to, as written. */
  billTo: string | null;
  /** The bill-to's address, when it gives one: the payer. */
  payer: Address | null;
  payee: { address: Address; name: string | null };
  /** The network as the invoice writes it; null when it names none (then the run's network is used). */
  network: string | null;
  asset: string;
  token: Address | null;
  decimals: number;
  /** What is to be paid. */
  due: Money;
  lines: InvoiceLine[];
  figures: { subtotal: Money | null; discount: Money | null; tax: Money | null; total: Money | null; paid: Money | null; amountDue: Money | null };
  /** Dates as YYYY-MM-DD. */
  issued: string | null;
  dueDate: string | null;
  /** Where the due date came from: the invoice's own date, or its terms counted from the issue date. */
  dueFrom: "invoice" | "terms" | null;
  terms: string | null;
  note: string | null;
  link: { uri: string; chainId: number | null; ignored: string[] } | null;
  /** How the figures agree, in words (the payment link, when there is one, agrees with them too). */
  sums: string[];
  /** The lines that are none of the above, as written. */
  notRead: string[];
}

type Field = "number" | "issued" | "dueDate" | "due" | "terms" | "issuer" | "billTo" | "payee" | "address" | "network" | "asset" | "subtotal" | "discount" | "tax" | "total" | "paid" | "amountDue" | "note" | "link";
type MoneyField = "subtotal" | "discount" | "tax" | "total" | "paid" | "amountDue";

export const MAX_INVOICE = 4000;
const MAX_LINES = 120;
const MAX_LINE = 300;
const bad = (message: string) => new AgentError("usage", message);

/** Labels, lowercased with punctuation, parentheses and percentages taken out ("VAT (20%)" is "vat"). */
const LABELS: Readonly<Record<string, Field>> = Object.freeze({
  invoice: "number", "invoice #": "number", "invoice no": "number", "invoice nr": "number", "invoice number": "number", "invoice id": "number", "invoice ref": "number", "invoice reference": "number", reference: "number", ref: "number", "reference no": "number",
  date: "issued", "invoice date": "issued", issued: "issued", "issued on": "issued", "issue date": "issued", "date issued": "issued", "date of issue": "issued",
  due: "due", "payment due": "due", "due date": "dueDate", "due on": "dueDate", "due by": "dueDate", "pay by": "dueDate", "payable by": "dueDate", "payment due date": "dueDate",
  terms: "terms", "payment terms": "terms",
  from: "issuer", issuer: "issuer", seller: "issuer", vendor: "issuer", supplier: "issuer", "billed by": "issuer", "invoice from": "issuer",
  to: "billTo", "bill to": "billTo", "billed to": "billTo", customer: "billTo", client: "billTo", "invoice to": "billTo", buyer: "billTo",
  "pay to": "payee", payee: "payee", wallet: "payee", "wallet address": "payee", "payment address": "payee", "pay to address": "payee", "pay to wallet": "payee", "send to": "payee", "send payment to": "payee", recipient: "payee", beneficiary: "payee", "deposit address": "payee", "receiving address": "payee",
  address: "address",
  network: "network", chain: "network", blockchain: "network", "payment network": "network",
  currency: "asset", asset: "asset", token: "asset", "pay in": "asset", "payment currency": "asset", "payment token": "asset",
  subtotal: "subtotal", "sub total": "subtotal",
  discount: "discount",
  tax: "tax", vat: "tax", gst: "tax", "sales tax": "tax",
  total: "total", "invoice total": "total", "total amount": "total", "grand total": "total",
  paid: "paid", "amount paid": "paid", "already paid": "paid", "less paid": "paid", "payments received": "paid",
  "amount due": "amountDue", "balance due": "amountDue", "total due": "amountDue", "amount to pay": "amountDue", "please pay": "amountDue", "due now": "amountDue", "amount payable": "amountDue", "total payable": "amountDue", balance: "amountDue", amount: "amountDue",
  note: "note", notes: "note", memo: "note", message: "note",
  "pay with": "link", "payment link": "link", link: "link", "pay online": "link", "pay here": "link",
});
/** Fields also read without a colon ("Total 20 USDC"), when the rest of the line reads as their value. */
const LOOSE = new Set<Field>(["number", "issued", "dueDate", "payee", "network", "asset", "subtotal", "discount", "tax", "total", "paid", "amountDue"]);
const MONEY_WORDS: Readonly<Record<MoneyField, string>> = Object.freeze({ subtotal: "the subtotal", discount: "the discount", tax: "the tax", total: "the total", paid: "what was paid", amountDue: "the amount due" });
/** Currencies, not assets on Pharos: an amount in one is never taken for a token. */
const FIAT = new Set("usd us$ $ eur € gbp £ jpy ¥ cny rmb inr ₹ idr rp sgd s$ cad c$ aud a$ chf hkd krw ₩ myr rm php ₱ thb ฿ vnd ₫ aed brl r$ mxn nzd sek nok dkk pln try ₺ zar ngn kes".split(" "));
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const SYMBOL = String.raw`[A-Za-z$€£¥₹₩₱฿₫₺][A-Za-z.$]*`;
const MONEY = new RegExp(String.raw`^([-−–]\s*)?(?:(${SYMBOL})\s?)?([-−–]\s*)?(${NUMBER})(?:\s?(${SYMBOL}))?$`);
const ADDRESS = /0x[0-9a-fA-F]+/g;
/** Other chains an invoice may name: a "Network" line naming one is refused, never passed over. */
const CHAINS = /^(?:ethereum|eth|base|polygon|matic|arbitrum|optimism|bnb|bsc|binance|solana|sol|tron|trc20|erc20|avalanche|avax|bitcoin|btc|ton|sui|aptos|near|zksync|linea|scroll|mantle|blast|celo|fantom|gnosis|sepolia|holesky)\b/i;

const labelKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\d+(?:\.\d+)?\s*%/g, " ")
    .replace(/[^a-z#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const clean = (text: string) =>
  text
    .replace(/\(\s*\)|\[\s*\]|<\s*>/g, " ")
    .replace(/[\s,;:|\-–—]+$/g, "")
    .replace(/^[\s,;:|\-–—]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
/** A name as written, without the e-mail address or <…> a mail header adds. */
const nameIn = (text: string) => clean(text.replace(/<[^>]*>/g, " ").replace(/\S+@\S+/g, " ").replace(ADDRESS, " "));
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Every 0x address in `text`, each 40 hex characters and, when written in mixed case, with a good checksum. */
export function addressesIn(text: string): Address[] {
  const out: Address[] = [];
  for (const m of text.matchAll(ADDRESS)) {
    const written = m[0];
    if (written.length !== 42) throw bad(`"${written.length > 50 ? `${written.slice(0, 48)}…` : written}" is not an address: 0x and 40 hex characters.`);
    const checked = getAddress(written.toLowerCase());
    const hex = written.slice(2);
    if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && written !== checked) throw bad(`The address ${written} fails its checksum: a character may be wrong. Check it with the issuer.`);
    if (!out.includes(checked)) out.push(checked);
  }
  return out;
}

/** The asset a symbol or name stands for on `net`: null for the native token. Refuses a currency and anything not official. */
function assetNamed(net: Network, written: string): Token | null {
  const word = written.trim().replace(/\.$/, "");
  const lower = word.toLowerCase();
  if (lower === net.nativeSymbol.toLowerCase()) return null;
  const token = net.tokens.find((t) => t.symbol.toLowerCase() === lower || t.name.toLowerCase() === lower);
  if (token) return { ...token, address: getAddress(token.address) };
  if (FIAT.has(lower)) throw bad(`The invoice is in ${word.toUpperCase() === word || /^[a-z]{3}$/i.test(word) ? word.toUpperCase() : word}, a currency, not an asset on Pharos. Ask the issuer for an amount in ${net.tokens.some((t) => t.symbol === "USDC") ? "USDC" : net.nativeSymbol} or another official token.`);
  throw bad(`"${word}" is not ${net.nativeSymbol} or an official ${net.name} token (${net.tokens.map((t) => t.symbol).join(", ")}).`);
}

/** Whether a symbol written with an amount is an asset on `net`, a currency, or neither. */
function symbolKind(net: Network, written: string): "asset" | "fiat" | "unknown" {
  const lower = written.trim().replace(/\.$/, "").toLowerCase();
  if (lower === net.nativeSymbol.toLowerCase() || net.tokens.some((t) => t.symbol.toLowerCase() === lower)) return "asset";
  return FIAT.has(lower) ? "fiat" : "unknown";
}

/** "20 USDC", "USDC 20", "1,250.00", "$20": the number and the symbol written with it, or null for none. */
function moneyIn(value: string): { number: string; symbol: string | null; negative: boolean } | null {
  const v = value.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const m = MONEY.exec(v);
  if (!m || (m[2] && m[5])) return null;
  return { number: m[4]!.replaceAll(",", ""), symbol: m[2] ?? m[5] ?? null, negative: Boolean(m[1] || m[3]) };
}

function isoDate(y: number, m: number, d: number, written: string): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw bad(`"${written}" is not a real date.`);
  return date.toISOString().slice(0, 10);
}

const monthOf = (word: string) => (word.length >= 3 ? MONTHS.findIndex((name) => name.startsWith(word.toLowerCase().replace(/\.$/, ""))) + 1 : 0);

/** A date as YYYY-MM-DD, or null when `text` is not one. Refuses a numeric date that reads both ways. */
function dateIn(text: string): string | null {
  const t = text
    .trim()
    .replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, "")
    .replace(/\s*\([^)]*\)$/, "");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(t);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]), text);
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9}\.?),?\s+(\d{4})$/.exec(t);
  if (m && monthOf(m[2]!)) return isoDate(Number(m[3]), monthOf(m[2]!), Number(m[1]), text);
  m = /^([A-Za-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(t);
  if (m && monthOf(m[1]!)) return isoDate(Number(m[3]), monthOf(m[1]!), Number(m[2]), text);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a > 12) return isoDate(Number(m[3]), b, a, text);
    if (b > 12 || a === b) return isoDate(Number(m[3]), a, b, text);
    throw bad(`"${text}" reads as two dates (day first, or month first). Write it as ${m[3]}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")} or ${m[3]}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}.`);
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]), text);
  return null;
}

/** Days from the issue date the terms give ("Net 30", "30 days", "on receipt"), or null. */
function termDays(terms: string): number | null {
  const net = /\bnet\s*(\d{1,3})\b/i.exec(terms) ?? /^(\d{1,3})\s*days?\b/i.exec(terms.trim());
  if (net) return Number(net[1]);
  return /\b(?:on|upon)\s+receipt\b|\bimmediate(?:ly)?\b|\bdue now\b/i.test(terms) ? 0 : null;
}

/** The network an invoice writes, as one the agent knows. Refuses another chain, or one it cannot tell. */
function networkIn(written: string): "pharos-mainnet" | "atlantic-testnet" {
  const v = written.toLowerCase();
  if (/\b688689\b|\batlantic\b/.test(v)) return "atlantic-testnet";
  if (/\bpharos\b/.test(v) && /\btest\s?net\b|\bdevnet\b/.test(v)) throw bad(`"${written}": the Pharos testnet the agent knows is Atlantic (chain 688689). Write Atlantic, or Pharos Mainnet.`);
  if (/\b1672\b|\bpharos\b/.test(v)) return "pharos-mainnet";
  if (/^\s*(?:main\s?net|test\s?net)\s*$/.test(v)) throw bad(`"${written}" of which chain? Write Pharos Mainnet (chain 1672) or Atlantic (chain 688689).`);
  throw bad(`The invoice asks for payment on ${written.trim()}, not on Pharos.`);
}

/** For a line written without a colon: the fields its first words may name, longest first, each with the rest. */
function looseFields(line: string): { field: Field; value: string }[] {
  const words = [...line.matchAll(/\S+/g)];
  const out: { field: Field; value: string }[] = [];
  for (let n = Math.min(4, words.length - 1); n >= 1; n -= 1) {
    const end = words[n - 1]!.index! + words[n - 1]![0].length;
    const label = line.slice(0, end);
    if (/\d/.test(label)) continue;
    const field = LABELS[labelKey(label)];
    if (field && LOOSE.has(field)) out.push({ field, value: line.slice(end).trim() });
  }
  return out;
}

/** A line ending with an amount: "Design work   15.00 USDC", "Logo 1,250.00". The amount is one or two words. */
function trailingAmount(line: string): { text: string; number: string; symbol: string | null; negative: boolean } | null {
  const words = line.replace(/\.{3,}|…+/g, " ").split(/\s+/).filter(Boolean);
  for (const n of [2, 1]) {
    if (words.length <= n) continue;
    const m = moneyIn(words.slice(-n).join(" "));
    if (!m) continue;
    let rest = words.slice(0, -n);
    const negative = m.negative || /^[-−–]$/.test(rest.at(-1) ?? "");
    if (/^[-−–]$/.test(rest.at(-1) ?? "")) rest = rest.slice(0, -1);
    const text = clean(rest.join(" "));
    if (!/[A-Za-z]/.test(text)) continue;
    return { text, number: m.number, symbol: m.symbol, negative };
  }
  return null;
}

/** The invoice in `text`: the payment it asks for, with every figure checked against the others. */
export function readInvoice(text: unknown, net: Network, max = MAX_INVOICE): Invoice {
  const whole = typeof text === "string" ? text.replace(/\r\n?/g, "\n").trim() : "";
  if (!whole) throw bad('Paste an invoice (its lines, like "Pay to: 0x…" and "Amount due: 20 USDC"), or a payment link (ethereum:…).');
  if (whole.length > max) throw bad(`An invoice is at most ${max.toLocaleString("en-US")} characters.`);
  const rows = whole.split("\n").map((line) => line.trim()).filter(Boolean);
  if (rows.length > MAX_LINES) throw bad(`An invoice is at most ${MAX_LINES} lines.`);

  const values: Partial<Record<"number" | "issued" | "dueDate" | "terms" | "issuer" | "billTo" | "network" | "asset" | "note", string>> = {};
  const money: Partial<Record<MoneyField, { number: string; symbol: string | null; line: string }[]>> = {};
  const items: { text: string; number: string; symbol: string | null }[] = [];
  const notRead: string[] = [];
  const payees: Address[] = [];
  let payeeName: string | null = null;
  let payer: Address | null = null;
  let link: PaymentLink | null = null;
  let pending: Field | null = null;

  /** A value the invoice may give once: the same again is fine, a different one refuses it. Names keep the first. */
  const once = (field: keyof typeof values, value: string, line: string, what: string) => {
    if (values[field] === undefined) values[field] = value;
    else if (values[field] !== value && !["terms", "issuer", "billTo", "note"].includes(field)) throw bad(`The invoice gives ${what} twice, differently: "${values[field]}" and "${value}" (in "${line}").`);
  };
  const setMoney = (field: MoneyField, value: string, line: string): boolean => {
    const m = moneyIn(field === "tax" || field === "discount" ? value.replace(/^\d+(?:\.\d+)?\s*%\s*/, "") : value);
    if (!m) return false;
    if (m.negative && field !== "discount") throw bad(`${MONEY_WORDS[field][0]!.toUpperCase()}${MONEY_WORDS[field].slice(1)} is negative: "${line}".`);
    (money[field] ??= []).push({ number: m.number, symbol: m.symbol, line });
    return true;
  };
  const item = (text: string, m: { number: string; symbol: string | null; negative: boolean }, line: string): boolean => {
    if (m.symbol ? symbolKind(net, m.symbol) === "unknown" : !/\.\d{2}$/.test(m.number)) return false;
    if (m.symbol && symbolKind(net, m.symbol) === "fiat") assetNamed(net, m.symbol);
    if (m.negative) throw bad(`A line with a negative amount is not read: "${line}". Write it as a discount.`);
    items.push({ text, number: m.number, symbol: m.symbol });
    return true;
  };

  /** Reads `value` as `field`. False when it does not read as one: a line without a colon then falls through. */
  const take = (field: Field, value: string, line: string, strict: boolean): boolean => {
    const v = value.trim();
    switch (field) {
      case "number": {
        const id = v.replace(/\([^)]*\)/g, " ").trim().replace(/^#\s*/, "");
        if (!/^[A-Za-z0-9][A-Za-z0-9\-/._]{0,63}$/.test(id) || (!strict && !/\d/.test(id))) return false;
        once("number", id, line, "its number");
        return true;
      }
      case "issued":
      case "dueDate": {
        const date = dateIn(v);
        if (date === null) {
          if (!strict) return false;
          throw bad(`"${line}": the date is not one the agent reads. Write it as 2026-11-01.`);
        }
        once(field, date, line, field === "issued" ? "its issue date" : "its due date");
        return true;
      }
      case "due": {
        if (moneyIn(v)) return setMoney("amountDue", v, line);
        const date = dateIn(v);
        if (date !== null) {
          once("dueDate", date, line, "its due date");
          return true;
        }
        if (termDays(v) === null) throw bad(`"${line}": "Due" is read as a date or an amount, and this is neither.`);
        once("terms", v.slice(0, 80), line, "its terms");
        return true;
      }
      case "terms":
        once("terms", v.slice(0, 80), line, "its terms");
        return true;
      case "issuer":
      case "billTo": {
        const found = addressesIn(v);
        if (field === "billTo") {
          if (found.length > 1) throw bad(`"${line}": the bill-to gives two addresses.`);
          if (found[0]) payer = found[0];
        }
        const name = nameIn(v);
        if (name) once(field, name.slice(0, 80), line, field === "issuer" ? "who it is from" : "who it is billed to");
        return Boolean(name || found.length);
      }
      case "payee":
      case "address": {
        const found = addressesIn(v);
        if (field === "address" && !found.length) return false;
        if (found.length > 1) throw bad(`"${line}": the payee is given two addresses.`);
        const name = nameIn(v);
        if (!found.length && (!strict || !name) && payeeName) return false;
        if (found[0]) payees.push(found[0]);
        if (name && field === "payee") payeeName ??= name.slice(0, 80);
        if (!found.length) pending = "payee";
        return true;
      }
      case "network":
        if (!strict && !/pharos|atlantic|\b1672\b|\b688689\b/i.test(v) && !CHAINS.test(v)) return false;
        networkIn(v);
        once("network", v.slice(0, 60), line, "its network");
        return true;
      case "asset":
        if (!strict && !/^\S+$/.test(v)) return false;
        assetNamed(net, v);
        once("asset", v, line, "its asset");
        return true;
      case "note":
        once("note", v.slice(0, 200), line, "a note");
        return true;
      case "link":
        return false;
      default:
        if (setMoney(field, v, line)) return true;
        if (!strict) return false;
        throw bad(`"${line}": ${MONEY_WORDS[field]} is not read as an amount.`);
    }
  };

  for (const line of rows) {
    if (line.length > MAX_LINE) throw bad(`A line of the invoice is at most ${MAX_LINE} characters.`);
    const links = [...line.matchAll(LINK)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
    if (links.length) {
      if (links.length > 1 || link) throw bad("The invoice has two payment links: it asks for one payment.");
      link = parseLink(links[0]!);
      pending = null;
      continue;
    }
    const wasPending = pending;
    pending = null;
    const colon = /^([^:]{1,40}?)\s*:\s*(.*)$/.exec(line);
    const key = colon && /[A-Za-z]/.test(colon[1]!) ? labelKey(colon[1]!) : null;
    const field = key ? LABELS[key] : undefined;
    // A label alone on its line ("Pay to:") takes the next line as its value.
    if (wasPending && !field && take(wasPending, line, line, false)) continue;
    if (field) {
      if (!colon![2]!.trim()) {
        if (field !== "link") pending = field;
        continue;
      }
      if (!take(field, colon![2]!, line, true)) notRead.push(line);
      continue;
    }
    if (colon && key) {
      // An unknown label: a line item when its value is an amount ("Hosting, October: 5 USDC").
      const m = moneyIn(colon[2]!);
      if (m && item(clean(colon[1]!), m, line)) continue;
    }
    if (!colon && looseFields(line).some((loose) => loose.value && take(loose.field, loose.value, line, false))) continue;
    const trailing = trailingAmount(line);
    if (trailing && item(trailing.text, trailing, line)) continue;
    notRead.push(line);
  }

  // The asset: the currency line, every symbol written with an amount, and the link's token must agree.
  const named = new Map<string, Token | null>();
  const mark = (written: string) => {
    const asset = assetNamed(net, written);
    named.set(asset?.address ?? "native", asset);
  };
  if (values.asset) mark(values.asset);
  for (const m of [...Object.values(money).flat(), ...items]) if (m?.symbol) mark(m.symbol);
  const linked = link as PaymentLink | null;
  if (linked?.token) {
    const token = knownToken(net, linked.token);
    if (!token) throw bad(`The payment link asks for a token at ${linked.token}, not an official ${net.name} token (${net.tokens.map((t) => t.symbol).join(", ")}).`);
    named.set(getAddress(token.address), { ...token, address: getAddress(token.address) });
  } else if (linked) named.set("native", null);
  if (named.size > 1) throw bad(`The invoice gives amounts in ${[...named.values()].map((t) => t?.symbol ?? net.nativeSymbol).join(" and ")}: it asks for one payment, in one asset.`);
  if (!named.size) throw bad(`The invoice names no asset: write it with its amounts ("20 USDC") or as "Currency: USDC". The asset is ${net.nativeSymbol} or an official ${net.name} token.`);
  const token = [...named.values()][0]!;
  const asset = token?.symbol ?? net.nativeSymbol;
  const decimals = token?.decimals ?? 18;
  const units = (number: string, what: string) => parseAmount(number, decimals, what);
  const shown = (raw: bigint) => `${formatAmount(raw, decimals, decimals)} ${asset}`;
  const asMoney = (raw: bigint): Money => ({ amount: formatAmount(raw, decimals, decimals).replaceAll(",", ""), raw: raw.toString() });

  // The network: the invoice's, the link's chain and the run's must agree.
  const written = values.network ?? null;
  const wanted = written ? networkIn(written) : null;
  if (wanted && wanted !== net.id) throw bad(`The invoice is for ${wanted === "atlantic-testnet" ? "Atlantic" : "Pharos Mainnet"} ("${written}"): run it on ${wanted}.`);
  if (linked && linked.chainId !== null && linked.chainId !== net.chainId) {
    const other = linked.chainId === 1672 ? "Pharos Mainnet: run it on pharos-mainnet" : linked.chainId === 688689 ? "Atlantic: run it on atlantic-testnet" : "another chain, not Pharos";
    throw bad(`The payment link is for chain ${linked.chainId}, ${other}.`);
  }

  // The figures in base units: each given once (or the same each time), each checked against the others.
  const figure = (field: MoneyField): bigint | null => {
    const seen = money[field];
    if (!seen) return null;
    const [first, ...more] = seen.map((m) => units(m.number, MONEY_WORDS[field]));
    const other = more.find((raw) => raw !== first);
    if (other !== undefined) throw bad(`The invoice gives ${MONEY_WORDS[field]} twice, differently: ${shown(first!)} and ${shown(other)}.`);
    return first!;
  };
  const subtotal = figure("subtotal");
  const discount = figure("discount");
  const tax = figure("tax");
  const total = figure("total");
  const paid = figure("paid");
  const amountDue = figure("amountDue");
  const lines = items.map((line) => ({ text: line.text, raw: units(line.number, `the line "${line.text}"`) }));
  const sum = lines.reduce((all, line) => all + line.raw, 0n);
  const theLines = lines.length === 1 ? "The line" : `The ${lines.length} lines`;
  const sums: string[] = [];
  if (lines.length && subtotal !== null) {
    if (sum !== subtotal) throw bad(`The lines add up to ${shown(sum)}, but the subtotal says ${shown(subtotal)}.`);
    sums.push(`${theLines} ${lines.length === 1 ? "is" : "add up to"} the subtotal, ${shown(sum)}.`);
  }
  const base = subtotal ?? (lines.length ? sum : null);
  const adjusted = [...(discount ? [`less ${shown(discount)} discount`] : []), ...(tax ? [`plus ${shown(tax)} tax`] : [])].join(" and ");
  const computed = base === null ? null : base - (discount ?? 0n) + (tax ?? 0n);
  if (total !== null && computed !== null) {
    const one = subtotal !== null || lines.length === 1;
    const what = subtotal !== null ? "The subtotal" : theLines;
    if (computed !== total)
      throw bad(adjusted ? `${what}, ${shown(base!)}${lines.length && subtotal === null ? " in all" : ""}, ${adjusted}, come${one ? "s" : ""} to ${shown(computed)}, but the total says ${shown(total)}.` : `${what} ${subtotal !== null ? "is" : one ? "is" : "add up to"} ${shown(base!)}, but the total says ${shown(total)}.`);
    sums.push(adjusted ? `${what}, ${adjusted}, come${one ? "s" : ""} to the total, ${shown(total)}.` : `${what} ${one ? "is" : "add up to"} the total, ${shown(total)}.`);
  }
  const owed = total ?? computed;
  if (total === null && amountDue === null && !linked) throw bad("The invoice gives no total or amount due: nothing says what to pay.");
  if (owed !== null && amountDue !== null) {
    const left = owed - (paid ?? 0n);
    if (left !== amountDue) throw bad(`The total, ${shown(owed)}${paid ? `, less ${shown(paid)} paid,` : ""} leaves ${shown(left)}, but the amount due says ${shown(amountDue)}.`);
    sums.push(paid ? `The total, less ${shown(paid)} paid, leaves the amount due, ${shown(amountDue)}.` : `The amount due is the total, ${shown(amountDue)}.`);
  }
  const fromFigures = amountDue ?? (owed !== null ? owed - (paid ?? 0n) : null);
  if (fromFigures !== null && fromFigures <= 0n) throw bad(`Nothing is due: ${paid && owed !== null ? `${shown(paid)} of ${shown(owed)} is paid already` : "the invoice asks for 0"}.`);

  // The payee: one address, from the invoice's lines and its link alike.
  if (linked) payees.push(linked.to);
  const distinct = [...new Set(payees)];
  if (distinct.length > 1) throw bad(`The invoice gives two addresses to pay: ${distinct.map(short).join(" and ")}${linked ? " (one in its payment link)" : ""}.`);
  const payee = distinct[0];
  if (!payee) throw bad('The invoice gives no address to pay: a "Pay to: 0x…" line, or a payment link.');
  if (payee === zeroAddress) throw bad("The invoice asks to be paid at the zero address: whatever is sent there is lost.");
  const asToken = knownToken(net, payee);
  if (asToken) throw bad(`The invoice asks to be paid at the ${asToken.symbol} token contract itself: tokens sent there are lost.`);
  if (payer && payer === payee) throw bad("The invoice is billed to the address it asks to be paid at.");

  let due: bigint;
  if (linked) {
    if (fromFigures !== null && linked.raw !== fromFigures) throw bad(`The invoice asks for ${shown(fromFigures)}, but its payment link asks for ${shown(linked.raw)}.`);
    due = linked.raw;
  } else due = fromFigures!;

  // The due date: the invoice's own, or its terms counted from the issue date.
  const issued = values.issued ?? null;
  let dueDate = values.dueDate ?? null;
  let dueFrom: Invoice["dueFrom"] = dueDate ? "invoice" : null;
  const days = values.terms ? termDays(values.terms) : null;
  if (!dueDate && issued && days !== null) {
    dueDate = new Date(Date.parse(`${issued}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    dueFrom = "terms";
  }

  const maybe = (raw: bigint | null) => (raw === null ? null : asMoney(raw));
  return {
    number: values.number ?? null,
    issuer: values.issuer ?? null,
    billTo: values.billTo ?? null,
    payer,
    payee: { address: payee, name: payeeName },
    network: written,
    asset,
    token: token?.address ?? null,
    decimals,
    due: asMoney(due),
    lines: lines.map((line) => ({ text: line.text, ...asMoney(line.raw) })),
    figures: { subtotal: maybe(subtotal), discount: maybe(discount), tax: maybe(tax), total: maybe(total), paid: maybe(paid), amountDue: maybe(amountDue) },
    issued,
    dueDate,
    dueFrom,
    terms: values.terms ?? null,
    note: values.note ?? null,
    link: linked ? { uri: linked.uri, chainId: linked.chainId, ignored: linked.ignored } : null,
    sums,
    notRead,
  };
}
