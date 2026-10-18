// Task 19: payment links. An EIP-681 link is the "ethereum:" payment request a wallet reads from a QR
// code or a link: the payee, the chain, and an amount in base units.
//
//   ethereum:0xPAYEE@1672?value=1e16                               PROS, the value in wei
//   ethereum:0xTOKEN@1672/transfer?address=0xPAYEE&uint256=2e7     a token, the amount in base units
//
// Only payments are read: a native value sent to an address, or a token's transfer. Anything else (another
// function, an ENS name, a parameter it does not read, an amount that is not a whole number of base
// units) is refused, never guessed. Which network and token a link may name is checked by the invoice
// reader, against the run's network.
import { getAddress } from "viem";
import type { Address } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Network } from "../core/networks.js";

export interface PaymentLink {
  /** The link as written. */
  uri: string;
  /** The chain it names; null when it names none. */
  chainId: number | null;
  /** Who is paid. */
  to: Address;
  /** The token whose transfer it asks for; null for the native token. */
  token: Address | null;
  /** In base units: wei, or the token's smallest unit. */
  raw: bigint;
  /** Parameters a wallet may use that the agent does not: the dry run sets the gas. */
  ignored: string[];
}

/** Finds a link in an invoice's text. */
export const LINK = /\bethereum:[^\s<>"'()]+/gi;
export const MAX_LINK = 600;

const bad = (message: string) => new AgentError("usage", message);
const GAS_KEYS = new Set(["gas", "gaslimit", "gasprice"]);

/** An EIP-681 number ("1", "2.014e18", "1e6") as a whole number of base units. */
function wholeNumber(text: string, what: string): bigint {
  const m = /^\+?(\d*)(?:\.(\d+))?(?:[eE](\d+))?$/.exec(text);
  if (!m || !(m[1] || m[2])) throw bad(`The link's ${what} is not a number: "${text}".`);
  const digits = BigInt(`${m[1] ?? ""}${m[2] ?? ""}` || "0");
  const shift = Number(m[3] ?? "0") - (m[2]?.length ?? 0);
  if (shift > 80) throw bad(`The link's ${what} is too large: "${text}".`);
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const unit = 10n ** BigInt(-shift);
  if (digits % unit !== 0n) throw bad(`The link's ${what} is not a whole number of base units: "${text}".`);
  return digits / unit;
}

/** The payment an EIP-681 link asks for. Refuses, saying why, a link that is not a plain payment. */
export function parseLink(text: string): PaymentLink {
  const uri = text.trim();
  if (uri.length > MAX_LINK) throw bad(`A payment link is at most ${MAX_LINK} characters.`);
  const m = /^ethereum:(?:pay-)?([^@/?]+)(?:@([^/?]*))?(?:\/([^?]*))?(?:\?(.*))?$/i.exec(uri);
  if (!m) throw bad(`Not a payment link: "${uri.slice(0, 80)}".`);
  const [, target, chain, fn, query] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined];
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw bad(/\./.test(target) ? `The link names ${target}, an ENS name: a Pharos payment here is to a 0x address.` : `The link's address is not 0x and 40 hex characters: "${target}".`);
  if (chain !== undefined && !/^\d{1,12}$/.test(chain)) throw bad(`The link's chain is not a chain ID: "${chain}".`);
  const params = new Map<string, string>();
  const ignored: string[] = [];
  for (const pair of query ? query.split("&") : []) {
    const at = pair.indexOf("=");
    if (at <= 0) throw bad(`The link has a parameter it cannot read: "${pair.slice(0, 40)}".`);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(pair.slice(0, at));
      value = decodeURIComponent(pair.slice(at + 1));
    } catch {
      throw bad(`The link has a parameter it cannot read: "${pair.slice(0, 40)}".`);
    }
    if (GAS_KEYS.has(key.toLowerCase())) {
      ignored.push(key);
      continue;
    }
    if (params.has(key)) throw bad(`The link gives "${key}" twice.`);
    params.set(key, value);
  }
  const allow = (keys: string[]) => {
    for (const key of params.keys()) if (!keys.includes(key)) throw bad(`The link has a parameter the agent does not read: "${key}". It reads value, or address and uint256 for a token transfer.`);
  };
  const chainId = chain === undefined || chain === "" ? null : Number(chain);
  if (fn === undefined || fn === "") {
    allow(["value"]);
    const value = params.get("value");
    if (value === undefined) throw bad("The link names no amount: a payment link gives value=… (in wei).");
    const raw = wholeNumber(value, "value");
    if (raw === 0n) throw bad("The link asks for nothing: its value is 0.");
    return { uri, chainId, to: getAddress(target.toLowerCase()), token: null, raw, ignored };
  }
  if (fn !== "transfer") throw bad(`The link calls ${fn.slice(0, 40)}, not a payment: only a token's transfer is read.`);
  allow(["address", "uint256", "value"]);
  if (params.has("value") && wholeNumber(params.get("value")!, "value") !== 0n) throw bad("The link sends the native token along with a token transfer: it is not a plain payment.");
  const to = params.get("address");
  if (to === undefined || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw bad(to === undefined ? "The link's transfer names no payee: address=0x…" : `The link's payee is not 0x and 40 hex characters: "${to.slice(0, 50)}".`);
  const amount = params.get("uint256");
  if (amount === undefined) throw bad("The link's transfer names no amount: uint256=… (in the token's base units).");
  const raw = wholeNumber(amount, "amount");
  if (raw === 0n) throw bad("The link asks for nothing: its amount is 0.");
  return { uri, chainId, to: getAddress(to.toLowerCase()), token: getAddress(target.toLowerCase()), raw, ignored };
}

/** The EIP-681 link of a payment on `net`, with the amount as a whole number of base units. */
export function formatLink(net: Network, payment: { to: Address; token: Address | null; raw: bigint }): string {
  return payment.token ? `ethereum:${payment.token}@${net.chainId}/transfer?address=${payment.to}&uint256=${payment.raw}` : `ethereum:${payment.to}@${net.chainId}?value=${payment.raw}`;
}
