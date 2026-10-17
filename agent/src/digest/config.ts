// Task 28: what a digest is about, from untrusted input: a protocol (an official token, by its symbol or
// its address) or a wallet (any other address); and how often (hour, day, week).
import { getAddress } from "viem";
import { AgentError } from "../core/errors.js";
import { knownToken, type Network } from "../core/networks.js";
import { EVERY, type Every } from "./calendar.js";
import type { Subject } from "./run.js";

export function parseSubject(text: unknown, net: Network): Subject {
  const value = typeof text === "string" ? text.trim() : "";
  const bySymbol = net.tokens.find((t) => t.symbol.toLowerCase() === value.toLowerCase());
  if (bySymbol) return { kind: "token", token: bySymbol };
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    const token = knownToken(net, value);
    return token ? { kind: "token", token } : { kind: "wallet", address: getAddress(value.toLowerCase()) };
  }
  throw new AgentError("usage", `A digest is of an official token (${net.tokens.map((t) => t.symbol).join(", ")}) or of a 0x address.`);
}

/** The subject as one word, for a store's key and a proof's input: the token's symbol or the address. */
export const subjectName = (subject: Subject): string => (subject.kind === "token" ? subject.token.symbol.toLowerCase() : subject.address.toLowerCase());

export function parseEvery(text: unknown): Every {
  const value = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (!EVERY.includes(value as Every)) throw new AgentError("usage", "A digest comes every hour, day or week.");
  return value as Every;
}
