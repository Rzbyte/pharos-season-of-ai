// Pharos Inspector input rules, shared by the page (instant feedback) and /api/inspect (the rule
// that counts). Pure functions: no DOM, no network.
//
//   address            0x + 40 hex characters (42 in all)
//   transaction hash   0x + 64 hex characters (66 in all)
//
// Anything else is rejected before any request is made, and nothing malformed ever reaches MCP.

/** Longer than any valid input; anything past this is rejected without further parsing. */
export const MAX_INPUT_LENGTH = 100;

/**
 * Classify a pasted value. Surrounding whitespace is ignored; nothing else is changed.
 * Returns { ok: true, kind: "contract" | "transaction", value } or { ok: false, message }.
 * A message never repeats the input, so nothing pasted is ever echoed back.
 */
export function classifyInput(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return { ok: false, message: "Paste a contract address or a transaction hash." };
  if (value.length > MAX_INPUT_LENGTH) {
    return { ok: false, message: `That is ${value.length} characters long. An address is 42 characters and a transaction hash 66.` };
  }
  if (!value.startsWith("0x")) return { ok: false, message: "It must start with 0x." };
  const hex = value.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(hex)) return { ok: false, message: "After 0x, only hex characters (0-9 and a-f) are allowed." };
  if (hex.length === 40) return { ok: true, kind: "contract", value };
  if (hex.length === 64) return { ok: true, kind: "transaction", value: value.toLowerCase() };
  return { ok: false, message: `That has ${hex.length} hex characters after 0x. An address has 40 and a transaction hash 64.` };
}
