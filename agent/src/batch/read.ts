// Task 10, Batch Executor: a batch read from its lines, one action a line, before anything touches the
// chain. Only actions whose effects are known before they run are read, so the batch can be shown to be
// independent rather than assumed to be:
//
//   send 25 USDC to 0x…            send 0.01 PROS to 0x…        (also "transfer", "pay")
//   approve 100 USDC for 0x…       approve max USDC for 0x…     revoke USDC for 0x…
//   wrap 0.5 PROS                  (into WPROS: its deposit(), as Task 29 prepares it)
//
// A "#" starts a note, kept with the action. Blank lines are skipped. PROS is PHRS on Atlantic, and a
// token is an official one of the Skill Engine's list: a contract call of any other kind can change
// anything, so its independence could not be known before it runs.
import { getAddress, isAddress, maxUint256 } from "viem";
import { parseAmount } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Network, Token } from "../core/networks.js";
import { wrappedNative } from "../builder/action.js";

export type BatchKind = "send" | "approve" | "wrap";

export interface BatchAction {
  /** Its line in the batch, from 1 (blank and comment lines count). */
  line: number;
  /** The line as written, without its note. */
  words: string;
  note: string | null;
  kind: BatchKind;
  /** The token sent or approved, or the wrapped token a wrap makes; null for the native token sent. */
  token: Token | null;
  /** What is sent, approved or wrapped: the token's symbol, or the native symbol. */
  asset: string;
  /** The recipient of a send, the spender of an approval; null for a wrap. */
  to: Address | null;
  /** In the asset's units, as written (commas dropped); "max" for an unlimited approval. */
  amount: string;
  /** In base units; 2^256 − 1 for an unlimited approval. */
  raw: string;
}

export const MAX_BATCH_TEXT = 4000;
/**
 * At most ten actions: the Pharos Skill Engine's batch transfer sends up to ten one transaction each
 * ("simple mode", references/transaction.md at a873387) and, above ten, deploys a disposable distributor
 * contract to send them all in one. This agent deploys no contract, so it keeps to the first.
 */
export const MAX_BATCH = 10;

/**
 * The example batch on Pharos Mainnet, from the example sender: three USDC payments, two of them to the
 * agent's example recipient (merged), and a little PROS to a sample address of the lab (Task 23's).
 */
export const EXAMPLE_BATCH = `send 25 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553 # rent
send 10 USDC to 0x1F3546a29EeC2102c8d52E21a45114124014c85C # payroll
send 5 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553 # utilities
send 0.01 PROS to 0x1F3546a29EeC2102c8d52E21a45114124014c85C # gas money`;

const bad = (message: string) => new AgentError("usage", message);
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const ADDR = String.raw`(0x[0-9a-fA-F]{40})`;
const FORMS: { kind: BatchKind | "revoke"; rule: RegExp }[] = [
  { kind: "send", rule: new RegExp(String.raw`^(?:send|transfer|pay)\s+${AMOUNT}\s+([A-Za-z][A-Za-z0-9]*)\s+to\s+${ADDR}$`, "i") },
  { kind: "approve", rule: new RegExp(String.raw`^approve\s+(${AMOUNT.slice(1, -1)}|max|unlimited)\s+([A-Za-z][A-Za-z0-9]*)\s+for\s+${ADDR}$`, "i") },
  { kind: "revoke", rule: new RegExp(String.raw`^revoke\s+([A-Za-z][A-Za-z0-9]*)\s+(?:for|from)\s+${ADDR}$`, "i") },
  { kind: "wrap", rule: new RegExp(String.raw`^wrap\s+${AMOUNT}\s+([A-Za-z][A-Za-z0-9]*)$`, "i") },
];
const VERBS = new Set(["send", "transfer", "pay", "approve", "revoke", "wrap"]);
const FORMS_SAID = 'send 25 USDC to 0x…, approve 100 USDC for 0x…, revoke USDC for 0x…, or wrap 0.5 PROS';

/** An address as written: a mixed-case one must pass its EIP-55 checksum. */
function addressOf(text: string, line: number): Address {
  if (!isAddress(text, { strict: true }) && /[a-f]/.test(text.slice(2)) && /[A-F]/.test(text.slice(2))) throw bad(`Line ${line}: ${text} fails its checksum. Copy the address again, or write it in lower case.`);
  if (!isAddress(text, { strict: false })) throw bad(`Line ${line}: ${text} is not an address.`);
  return getAddress(text);
}

/** The asset a symbol names on `net`: the native token (null) or an official token. */
function assetOf(symbol: string, net: Network, line: number): Token | null {
  if (symbol.toUpperCase() === net.nativeSymbol) return null;
  const token = net.tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase());
  if (!token) throw bad(`Line ${line}: ${symbol} is not ${net.nativeSymbol} or an official token on ${net.name} (${net.tokens.map((t) => t.symbol).join(", ")}).`);
  return { ...token, address: getAddress(token.address) };
}

function amountOf(text: string, decimals: number, line: number, positive: boolean): bigint {
  let raw: bigint;
  try {
    raw = parseAmount(text, decimals, "the amount");
  } catch (error) {
    throw bad(`Line ${line}: ${(error as Error).message}`);
  }
  if (positive && raw === 0n) throw bad(`Line ${line}: the amount must be more than zero.`);
  return raw;
}

/** One line read into an action, or the reason it cannot be. */
function readLine(text: string, line: number, net: Network): BatchAction {
  const hash = text.indexOf("#");
  const note = hash >= 0 ? text.slice(hash + 1).trim() || null : null;
  const words = (hash >= 0 ? text.slice(0, hash) : text).trim().replace(/\s+/g, " ");
  const verb = words.split(" ")[0]!.toLowerCase();
  if (!VERBS.has(verb)) throw bad(`Line ${line} starts with "${words.split(" ")[0]}": a batch takes send, approve, revoke and wrap, one a line (${FORMS_SAID}).`);
  for (const form of FORMS) {
    const m = form.rule.exec(words);
    if (!m) continue;
    if (form.kind === "send") {
      const token = assetOf(m[2]!, net, line);
      const raw = amountOf(m[1]!, token?.decimals ?? 18, line, true);
      return { line, words, note, kind: "send", token, asset: token?.symbol ?? net.nativeSymbol, to: addressOf(m[3]!, line), amount: m[1]!.replaceAll(",", ""), raw: raw.toString() };
    }
    if (form.kind === "approve" || form.kind === "revoke") {
      const symbol = form.kind === "approve" ? m[2]! : m[1]!;
      const token = assetOf(symbol, net, line);
      if (!token) throw bad(`Line ${line}: ${net.nativeSymbol} is the native token: it is sent, never approved.`);
      const spender = addressOf(form.kind === "approve" ? m[3]! : m[2]!, line);
      const written = form.kind === "approve" ? m[1]!.toLowerCase() : "0";
      const unlimited = written === "max" || written === "unlimited";
      const raw = unlimited ? maxUint256 : amountOf(written, token.decimals, line, false);
      return { line, words, note, kind: "approve", token, asset: token.symbol, to: spender, amount: unlimited ? "max" : written.replaceAll(",", ""), raw: raw.toString() };
    }
    if (m[2]!.toUpperCase() !== net.nativeSymbol) throw bad(`Line ${line}: a wrap takes the native token, like "wrap 0.5 ${net.nativeSymbol}".`);
    const wrapped = wrappedNative(net);
    if (!wrapped) throw bad(`Line ${line}: ${net.name} has no wrapped ${net.nativeSymbol} in the official token list.`);
    const raw = amountOf(m[1]!, 18, line, true);
    return { line, words, note, kind: "wrap", token: wrapped, asset: net.nativeSymbol, to: null, amount: m[1]!.replaceAll(",", ""), raw: raw.toString() };
  }
  const shape = { send: "send 25 USDC to 0x…", transfer: "transfer 25 USDC to 0x…", pay: "pay 25 USDC to 0x…", approve: "approve 100 USDC for 0x… (or max)", revoke: "revoke USDC for 0x…", wrap: `wrap 0.5 ${net.nativeSymbol}` }[verb];
  throw bad(`Line ${line} cannot be read: "${words}". It looks like "${shape}".`);
}

/** The batch's actions, every line read, in order; at most `max` of them. */
export function readBatch(text: string, net: Network, max = MAX_BATCH): BatchAction[] {
  if (typeof text !== "string" || !text.trim()) throw bad(`The batch is empty: write one action a line (${FORMS_SAID}).`);
  if (text.length > MAX_BATCH_TEXT) throw bad(`A batch is at most ${MAX_BATCH_TEXT.toLocaleString("en-US")} characters.`);
  const actions: BatchAction[] = [];
  for (const [k, row] of text.split(/\r?\n/).entries()) {
    if (!row.trim() || row.trim().startsWith("#")) continue;
    actions.push(readLine(row, k + 1, net));
  }
  if (!actions.length) throw bad(`The batch has only notes: write one action a line (${FORMS_SAID}).`);
  if (actions.length > max) throw bad(`A batch is at most ${max} actions here; this one has ${actions.length}.`);
  return actions;
}
