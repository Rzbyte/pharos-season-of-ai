// Task 29, Doc-Grounded Builder Agent: the action a how-to question asks for, read from its words, and
// what it names (an amount, a token, an address), with the run's inputs over it and the example's values
// under it. Only actions the agent can prepare and check are read: sending the native token or an
// official token, approving a spender, wrapping the native token, and reading a balance. A question about
// anything else is answered from the docs and not acted on.
import { getAddress, isAddress } from "viem";
import { parseAmount } from "../core/amounts.js";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Network, Token } from "../core/networks.js";
import { EXAMPLE_PAYER, EXAMPLE_RECIPIENT } from "../guardian/presets.js";

export type ActionKind = "native-transfer" | "erc20-transfer" | "erc20-approve" | "wrap" | "balance";

/** Where a value came from: the question's words, the run's inputs, or the example's. */
export type Origin = "question" | "input" | "example";

export interface Param<T = string> {
  value: T;
  from: Origin;
}

export interface Action {
  kind: ActionKind;
  /** The official token it sends, approves, wraps into, or reads; null for the native token. */
  token: Token | null;
  /** The sender, the owner who approves, or the holder whose balance is read. */
  account: Param<Address>;
  /** The recipient, or the spender; null for a balance or a wrap. */
  counterparty: Param<Address> | null;
  /** In the token's units (the native token's for a wrap); "max" for an unlimited approval; null for a balance. */
  amount: Param | null;
}

/** What the run was given besides the question: each overrides what the question says. */
export interface ActionInputs {
  from?: string;
  to?: string;
  amount?: string;
  token?: string;
}

export type ParsedAction = { action: Action; reason: null } | { action: null; reason: string };

const bad = (message: string) => new AgentError("usage", message);
const ADDRESS = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** The verbs of each action; the one the question uses first is the action. */
const VERBS: [ActionKind | "transfer", RegExp][] = [
  ["erc20-approve", /\b(?:approv(?:e|es|ed|ing|al)|allowances?)\b|\ballow\b[^.?!]{0,40}\bspend/i],
  ["wrap", /\bwrap(?:s|ped|ping)?\b/i],
  ["balance", /\bbalances?\b|\bhow much\b[^.?!]{0,40}\b(?:have|has|hold|holds|own|owns)\b/i],
  ["transfer", /\b(?:send|sends|sending|transfer|transfers|transferring|pay|pays|paying|move)\b/i],
];
/** Words after a number that name no asset ("25 to 0x…", "0.5 into WPROS"); any other word there claims to be one. */
const PLAIN = new Set("to of in for and or from at on per into onto worth more less than the a an my your our their its this that token tokens coin coins unit units each times usd".split(" "));
/** Words before a number that make it no amount ("chain 1672", "block 5"). */
const NOT_AMOUNTS = new Set("chain id block network step version eip erc".split(" "));
/** The defaults on Pharos Mainnet, the agent's example addresses (Tasks 05, 08, 11, 25, 27). */
export const EXAMPLE = Object.freeze({ account: getAddress(EXAMPLE_PAYER), counterparty: getAddress(EXAMPLE_RECIPIENT), tokenAmount: "25", nativeAmount: "0.01" });

const address = (value: string, what: string): Address => {
  if (!isAddress(value, { strict: false })) throw bad(`${what} must be a 0x address (40 hex characters).`);
  return getAddress(value);
};

/** The network's wrapped native token: WPROS on Pharos Mainnet, WPHRS on Atlantic (the Skill Engine's list). */
export function wrappedNative(net: Network): Token | null {
  const token = net.tokens.find((t) => t.symbol === `W${net.nativeSymbol}`);
  return token ? { ...token, address: getAddress(token.address) } : null;
}

/** An official token (its address checksummed), or the native token (null), by symbol or address; undefined when it is neither. */
function assetNamed(net: Network, text: string): Token | null | undefined {
  const wanted = text.trim();
  if (wanted.toUpperCase() === net.nativeSymbol) return null;
  const token = net.tokens.find((t) => t.symbol.toUpperCase() === wanted.toUpperCase() || t.address.toLowerCase() === wanted.toLowerCase());
  return token && { ...token, address: getAddress(token.address) };
}

/** The question's addresses, each with the word before it ("from", "to", "for", "of"). */
function addressesOf(question: string): { address: Address; before: string }[] {
  return [...question.matchAll(ADDRESS)].map((m) => ({ address: getAddress(m[0].toLowerCase()), before: (/(\w+)\s*$/.exec(question.slice(0, m.index)) ?? ["", ""])[1]!.toLowerCase() }));
}

/**
 * The action a question asks for, its values from the question, the inputs over them, the example's
 * under them (Pharos Mainnet only). Inputs are checked first, so a bad one is refused before any call.
 */
export function parseAction(question: string, inputs: ActionInputs, net: Network): ParsedAction {
  const given = {
    from: inputs.from?.trim() ? address(inputs.from.trim(), "from") : null,
    to: inputs.to?.trim() ? address(inputs.to.trim(), "to") : null,
    token: inputs.token?.trim() ? inputs.token.trim() : null,
    amount: inputs.amount?.trim() ? inputs.amount.trim() : null,
  };
  let inputToken: Token | null | undefined;
  if (given.token !== null) {
    inputToken = assetNamed(net, given.token);
    if (inputToken === undefined) throw bad(`token must be ${net.nativeSymbol} or an official ${net.name} token: ${net.tokens.map((t) => t.symbol).join(", ")}.`);
  }

  // The words alone: an address stands for one word, so it neither reads as an amount nor pushes a
  // verb's object out of reach.
  const text = question.replace(ADDRESS, "address");
  const verbs = VERBS.map(([kind, rule]) => ({ kind, at: rule.exec(text)?.index ?? -1 })).filter((v) => v.at >= 0).sort((x, y) => x.at - y.at);
  const verb = verbs[0]?.kind;
  if (!verb) return { action: null, reason: "The question asks for nothing this agent prepares: sending, approving, wrapping, or a balance." };

  // What the question names: assets (official symbols and the native one), amounts, addresses.
  const mentions = [...text.matchAll(/\b[A-Za-z][A-Za-z0-9]{1,9}\b/g)].map((m) => ({ word: m[0], at: m.index!, asset: assetNamed(net, m[0]) })).filter((m) => m.asset !== undefined);
  const amountOf = [...text.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z0-9]{0,9})?\b/g)]
    .filter((m) => !NOT_AMOUNTS.has((/(\w+)\W*$/.exec(text.slice(0, m.index)) ?? ["", ""])[1]!.toLowerCase()))
    .map((m) => ({ value: m[1]!, unit: m[2] ?? null }));
  const claims = (unit: string | null) => unit !== null && !PLAIN.has(unit.toLowerCase());
  const unknown = amountOf.find((a) => claims(a.unit) && assetNamed(net, a.unit!) === undefined);
  if (unknown) return { action: null, reason: `${unknown.unit} is not ${net.nativeSymbol} or an official ${net.name} token (${net.tokens.map((t) => t.symbol).join(", ")}), so nothing is prepared.` };
  const addresses = addressesOf(question);
  const fromQuestion = addresses.find((a) => a.before === "from")?.address ?? null;
  const toQuestion = addresses.find((a) => ["to", "for", "spender"].includes(a.before))?.address ?? addresses.find((a) => a.before !== "from")?.address ?? null;

  const param = <T>(input: T | null, question: T | null, example: T | null): Param<T> | null => (input !== null ? { value: input, from: "input" } : question !== null ? { value: question, from: "question" } : example !== null ? { value: example, from: "example" } : null);
  const mainnet = net.id === "pharos-mainnet";
  const need = <T>(p: Param<T> | null, what: string): Param<T> => {
    if (!p) throw bad(`Name ${what}: in the question, or as an input${mainnet ? "" : " (on Atlantic there is no example to fall back on)"}.`);
    return p;
  };

  // The asset: an input, else the question's first official one (for a wrap, the wrapped native token).
  let kind: ActionKind;
  let token: Token | null;
  if (verb === "wrap") {
    const wrapped = wrappedNative(net);
    if (!wrapped) return { action: null, reason: `${net.name} has no wrapped ${net.nativeSymbol} in the Skill Engine's token list.` };
    kind = "wrap";
    token = wrapped;
  } else {
    const named = inputToken !== undefined ? inputToken : (mentions.find((m) => m.asset !== null)?.asset ?? (mentions.length ? null : undefined));
    if (verb === "erc20-approve") {
      if (named === null) return { action: null, reason: `Only a token can be approved, not ${net.nativeSymbol}.` };
      kind = "erc20-approve";
      token = named ?? assetNamed(net, "USDC") ?? null;
      if (!token) throw bad("Name the token to approve.");
    } else if (verb === "balance") {
      kind = "balance";
      token = named ?? null;
    } else {
      token = named ?? null;
      kind = token ? "erc20-transfer" : "native-transfer";
    }
  }

  // The amount: an input, else the one the question gives (with the asset's unit when it names one).
  const decimals = kind === "wrap" || !token ? 18 : token.decimals;
  let amountText: string | null = null;
  if (kind !== "balance") {
    const unit = kind === "wrap" ? net.nativeSymbol : (token?.symbol ?? net.nativeSymbol);
    const asked = amountOf.find((a) => a.unit?.toUpperCase() === unit.toUpperCase()) ?? amountOf.find((a) => !claims(a.unit));
    amountText = asked?.value ?? null;
    if (kind === "erc20-approve" && /\b(?:unlimited|max(?:imum)?|infinite)\b/i.test(question)) amountText = "max";
  }
  const exampleAmount = kind === "balance" ? null : kind === "erc20-transfer" || kind === "erc20-approve" ? EXAMPLE.tokenAmount : EXAMPLE.nativeAmount;
  const amount = kind === "balance" ? null : need(param(given.amount, amountText, mainnet ? exampleAmount : null), "the amount");
  if (amount && amount.value !== "max") {
    const raw = parseAmount(amount.value, decimals, "amount");
    if (raw === 0n) throw bad("amount must be more than zero.");
  } else if (amount?.value === "max" && kind !== "erc20-approve") throw bad('"max" is an amount only for an approval.');

  const account = need(param(given.from, fromQuestion ?? (kind === "balance" ? toQuestion : null), mainnet ? EXAMPLE.account : null), kind === "balance" ? "the address to read" : "the sender");
  const counterparty = kind === "balance" || kind === "wrap" ? null : need(param(given.to, toQuestion, mainnet ? EXAMPLE.counterparty : null), kind === "erc20-approve" ? "the spender" : "the recipient");
  return { action: { kind, token, account, counterparty, amount }, reason: null };
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** An action in words: "Send 25 USDC from 0x912c…f647 to 0xB274…9553". */
export function describeAction(action: Action, net: Network): string {
  const asset = action.token?.symbol ?? net.nativeSymbol;
  const amount = action.amount?.value === "max" ? "unlimited" : action.amount?.value;
  switch (action.kind) {
    case "native-transfer":
    case "erc20-transfer":
      return `Send ${amount} ${asset} from ${short(action.account.value)} to ${short(action.counterparty!.value)}`;
    case "erc20-approve":
      return `Approve ${short(action.counterparty!.value)} to spend ${amount} ${asset} of ${short(action.account.value)}`;
    case "wrap":
      return `Wrap ${amount} ${net.nativeSymbol} into ${asset} for ${short(action.account.value)}`;
    case "balance":
      return `Read the ${asset} balance of ${short(action.account.value)}`;
  }
}
