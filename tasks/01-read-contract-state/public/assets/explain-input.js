// "Explain this result": the request rules, shared by the page (it builds the request from the
// Inspector's result) and /api/explain (it accepts nothing else). Pure functions: no DOM, no network.
//
// The request is never free text and never the Inspector's whole answer. It is a fixed set of facts
// from one successful inspection (a contract, a wallet-like address or a transaction), and every
// message the Inspector wrote (a reason, a note, a warning) becomes a code from a fixed list. The only
// text from the chain that can reach it is a token's name and symbol and the network's native symbol,
// and those are treated as untrusted data.

/** No valid request comes near this; a larger body is refused before it is parsed. */
export const MAX_BODY_BYTES = 4096;

export const FIELDS = ["name", "symbol", "decimals", "totalSupply"];

/** Why a value is unavailable, from the Inspector's reasons. */
export const REASONS = ["no-data", "wrong-type", "reverted", "failed", "unexpected-response", "not-offered"];

/** What a wallet-like address's inspection reads, and may have retried: its code check, balance and nonce. */
export const WALLET_READS = ["code", "balance", "nonce"];
/** The values a wallet-like address's result shows. */
const WALLET_VALUES = ["balance", "nonce"];

/** The Inspector's notes and warnings, as codes. Anything else it says is left out of the request. */
export const CONTRACT_NOTES = ["checksum-case", "network-unconfirmed", "chain-id-mismatch"];
export const TRANSACTION_NOTES = ["network-unconfirmed", "chain-id-mismatch", "not-in-block-yet", "receipt-missing", "transaction-unreadable", "receipt-unreadable"];

export const TRANSACTION_STATUSES = ["success", "failed", "pending"];

const CONTRACT_KEYS = ["kind", "chainId", "address", "blockNumber", "name", "symbol", "decimals", "totalSupply", "retried", "notes"];
const TRANSACTION_KEYS = ["kind", "chainId", "nativeSymbol", "hash", "status", "blockNumber", "from", "to", "contractCreation", "createdContract", "valueWei", "gasLimit", "gasUsed", "logs", "notes"];
const WALLET_KEYS = ["kind", "chainId", "nativeSymbol", "address", "blockNumber", "balance", "nonce", "retried", "notes"];

/** Longest text accepted (in UTF-16 units), and the longest kept once cleaned (in characters). */
const TEXT_LIMITS = { name: [120, 80], symbol: [60, 32], nativeSymbol: [24, 12] };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BLOCK = /^(?:0|[1-9]\d{0,19})$/;
/** A uint256 in decimal: at most 78 digits. */
const UINT = /^(?:0|[1-9]\d{0,77})$/;

// Characters that can hide or reorder text: C0 and C1 controls, the Arabic letter mark, zero-width
// characters and directional marks, line and paragraph separators, bidi embeddings, overrides and
// isolates, invisible operators, the byte order mark and interlinear annotation marks.
const HIDDEN_RANGES = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x061c, 0x061c], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
];
const hex4 = (code) => code.toString(16).padStart(4, "0");
/** Every hiding or reordering character, built from code points so none appears in this file. */
export const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([from, to]) => `\\u${hex4(from)}-\\u${hex4(to)}`).join("")}]`, "g");
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * On-chain text made inert: every hiding or reordering character becomes U+FFFD (so it stays visible
 * that something was there), runs of spaces collapse, and it is cut to `max` characters.
 */
export function cleanText(value, max) {
  const characters = [...String(value).replace(HIDDEN, REPLACEMENT).replace(/\s+/g, " ").trim()];
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : characters.join("");
}

// ---------------------------------------------------------------------------
// The page: the request for one Inspector result, or null when there is nothing to explain.

/** A successful inspection's request; null for "not found", a failure or anything unexpected. */
export function explainPayload(result) {
  if (!isRecord(result) || result.ok !== true) return null;
  // Only a result with something to explain: at least one value read, or a contract that answered
  // every standard call, just not as a token would. Reads that all failed leave nothing to explain.
  const read = (fields) => fields.some((field) => result.state?.[field]?.ok === true);
  if (result.kind === "contract") return result.status === "none" || read(FIELDS) ? contractPayload(result) : null;
  if (result.kind === "wallet-like") return read(WALLET_VALUES) ? walletPayload(result) : null;
  if (result.kind === "transaction" && result.status !== "not-found" && isRecord(result.transaction)) return transactionPayload(result);
  // An address whose type could not be determined has nothing to explain: nothing about it was read.
  return null;
}

function contractPayload(result) {
  const state = isRecord(result.state) ? result.state : {};
  return {
    kind: "contract",
    chainId: result.network?.chainId ?? null,
    address: result.address,
    blockNumber: result.blockNumber,
    name: readEntry(state, "name", (entry) => ({ value: entry.value })),
    symbol: readEntry(state, "symbol", (entry) => ({ value: entry.value })),
    decimals: readEntry(state, "decimals", (entry) => ({ value: entry.value })),
    totalSupply: readEntry(state, "totalSupply", (entry) => ({ raw: entry.raw })),
    retried: Array.isArray(result.retriedAtSameBlock) ? result.retriedAtSameBlock.filter((field) => FIELDS.includes(field)) : [],
    notes: noteCodes(result.warnings, CONTRACT_NOTES),
  };
}

function walletPayload(result) {
  const state = isRecord(result.state) ? result.state : {};
  return {
    kind: "wallet-like",
    chainId: result.network?.chainId ?? null,
    nativeSymbol: result.network?.nativeSymbol ?? null,
    address: result.address,
    blockNumber: result.blockNumber,
    balance: readEntry(state, "balance", (entry) => ({ raw: entry.wei })),
    nonce: readEntry(state, "nonce", (entry) => ({ value: entry.value })),
    retried: Array.isArray(result.retriedAtSameBlock) ? result.retriedAtSameBlock.filter((name) => WALLET_READS.includes(name)) : [],
    notes: noteCodes(result.warnings, CONTRACT_NOTES),
  };
}

function transactionPayload(result) {
  const tx = result.transaction;
  const creation = isRecord(tx.contractCreation);
  return {
    kind: "transaction",
    chainId: result.network?.chainId ?? null,
    nativeSymbol: result.network?.nativeSymbol ?? null,
    hash: tx.hash,
    status: tx.status ?? null,
    blockNumber: tx.blockNumber ?? null,
    from: tx.from ?? null,
    to: tx.to ?? null,
    contractCreation: creation,
    createdContract: creation ? (tx.contractCreation.address ?? null) : null,
    valueWei: tx.value?.wei ?? null,
    gasLimit: tx.gasLimit ?? null,
    gasUsed: tx.gasUsed ?? null,
    logs: tx.logs ?? null,
    notes: noteCodes([...(result.notes ?? []), ...(result.warnings ?? [])], TRANSACTION_NOTES),
  };
}

/** A value of the Inspector's state as a request entry: picked when it was read, its reason as a code when not. */
function readEntry(state, field, pick) {
  return state[field]?.ok === true ? pick(state[field]) : { unavailable: reasonCode(state[field]?.reason) };
}

/** The Inspector's reason for an unavailable value, as a code. */
function reasonCode(reason) {
  const text = String(reason ?? "");
  if (text === "no data returned") return "no-data";
  if (text === "returned data of the wrong type") return "wrong-type";
  if (text === "reverted") return "reverted";
  if (text === "unexpected MCP response") return "unexpected-response";
  if (text === "not offered by this Pharos Chain MCP server") return "not-offered";
  return "failed";
}

/** The Inspector's notes and warnings that have a code; the rest are left out. */
function noteCodes(messages, allowed) {
  const codes = (Array.isArray(messages) ? messages : []).map((message) => noteCode(String(message)));
  return [...new Set(codes)].filter((code) => code !== null && allowed.includes(code));
}

function noteCode(text) {
  if (/EIP-55 checksum/.test(text)) return "checksum-case";
  if (/network is not confirmed/.test(text)) return "network-unconfirmed";
  if (/reports chain ID .* but the server expects/.test(text)) return "chain-id-mismatch";
  if (/^No receipt yet/.test(text)) return "not-in-block-yet";
  if (/returned no receipt for this mined transaction/.test(text)) return "receipt-missing";
  if (/get_transaction_receipt/.test(text)) return "receipt-unreadable";
  if (/get_transaction\b/.test(text)) return "transaction-unreadable";
  return null;
}

// ---------------------------------------------------------------------------
// The server: accept exactly one of the three shapes above, and return it normalized.

/**
 * Check a parsed request body. Returns { ok: true, payload } with addresses and hashes in lowercase,
 * text cleaned and lists sorted, or { ok: false, message }. A message names the field, never repeats
 * its value.
 */
export function validateExplainPayload(body) {
  try {
    if (!isRecord(body)) fail("The request must be one inspection result, as a JSON object.");
    if (body.kind === "contract") return { ok: true, payload: contractRequest(body) };
    if (body.kind === "wallet-like") return { ok: true, payload: walletRequest(body) };
    if (body.kind === "transaction") return { ok: true, payload: transactionRequest(body) };
    fail("Only a contract, a wallet-like address or a transaction inspection result can be explained.");
  } catch (error) {
    if (error instanceof RequestError) return { ok: false, message: error.message };
    throw error;
  }
}

function contractRequest(body) {
  exactKeys(body, CONTRACT_KEYS, "The request");
  return {
    kind: "contract",
    chainId: chainId(body.chainId),
    address: hex(body.address, ADDRESS, "address", false),
    blockNumber: decimal(body.blockNumber, BLOCK, "blockNumber", false),
    name: entry(body.name, "name", (value) => text(value, "name")),
    symbol: entry(body.symbol, "symbol", (value) => text(value, "symbol")),
    decimals: entry(body.decimals, "decimals", (value) => {
      if (!Number.isInteger(value) || value < 0 || value > 255) fail("decimals.value must be a whole number from 0 to 255.");
      return value;
    }),
    totalSupply: amount(body.totalSupply, "totalSupply"),
    retried: codeList(body.retried, FIELDS, "retried"),
    notes: codeList(body.notes, CONTRACT_NOTES, "notes"),
  };
}

function walletRequest(body) {
  exactKeys(body, WALLET_KEYS, "The request");
  return {
    kind: "wallet-like",
    chainId: chainId(body.chainId),
    nativeSymbol: body.nativeSymbol === null ? null : text(body.nativeSymbol, "nativeSymbol"),
    address: hex(body.address, ADDRESS, "address", false),
    blockNumber: decimal(body.blockNumber, BLOCK, "blockNumber", false),
    balance: amount(body.balance, "balance"),
    nonce: entry(body.nonce, "nonce", (value) => decimal(value, UINT, "nonce.value", false)),
    retried: codeList(body.retried, WALLET_READS, "retried"),
    notes: codeList(body.notes, CONTRACT_NOTES, "notes"),
  };
}

function transactionRequest(body) {
  exactKeys(body, TRANSACTION_KEYS, "The request");
  if (typeof body.contractCreation !== "boolean") fail("contractCreation must be true or false.");
  const request = {
    kind: "transaction",
    chainId: chainId(body.chainId),
    nativeSymbol: body.nativeSymbol === null ? null : text(body.nativeSymbol, "nativeSymbol"),
    hash: hex(body.hash, HASH, "hash", false),
    status: body.status === null || TRANSACTION_STATUSES.includes(body.status) ? body.status : fail("status must be success, failed, pending or null."),
    blockNumber: decimal(body.blockNumber, BLOCK, "blockNumber", true),
    from: hex(body.from, ADDRESS, "from", true),
    to: hex(body.to, ADDRESS, "to", true),
    contractCreation: body.contractCreation,
    createdContract: hex(body.createdContract, ADDRESS, "createdContract", true),
    valueWei: decimal(body.valueWei, UINT, "valueWei", true),
    gasLimit: decimal(body.gasLimit, UINT, "gasLimit", true),
    gasUsed: decimal(body.gasUsed, UINT, "gasUsed", true),
    logs: body.logs === null ? null : Number.isInteger(body.logs) && body.logs >= 0 && body.logs <= 100_000 ? body.logs : fail("logs must be a count from 0 to 100000, or null."),
    notes: codeList(body.notes, TRANSACTION_NOTES, "notes"),
  };
  if (request.contractCreation && request.to !== null) fail("A contract creation has no recipient: to must be null.");
  if (!request.contractCreation && request.createdContract !== null) fail("createdContract is only for a contract creation.");
  return request;
}

/** A read value: { value } when it was read, { unavailable: reason } when it was not. */
function entry(value, field, check) {
  if (!isRecord(value)) fail(`${field} must be an object.`);
  if ("unavailable" in value) {
    exactKeys(value, ["unavailable"], field);
    if (!REASONS.includes(value.unavailable)) fail(`${field}.unavailable is not a known reason.`);
    return { unavailable: value.unavailable };
  }
  exactKeys(value, ["value"], field);
  return { value: check(value.value) };
}

/** An amount in its smallest unit: { raw } when it was read, { unavailable: reason } when it was not. */
function amount(value, field) {
  if (isRecord(value) && "raw" in value) {
    exactKeys(value, ["raw"], field);
    return { raw: decimal(value.raw, UINT, `${field}.raw`, false) };
  }
  return entry(value, field, () => fail(`${field} must be { raw } or { unavailable }.`));
}

function text(value, field) {
  const [accepted, kept] = TEXT_LIMITS[field];
  if (typeof value !== "string") fail(`${field} must be text.`);
  if (value.length > accepted) fail(`${field} is longer than ${accepted} characters.`);
  return cleanText(value, kept);
}

function hex(value, pattern, field, nullable) {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !pattern.test(value)) fail(`${field} is not a well-formed ${pattern === HASH ? "transaction hash" : "address"}.`);
  return value.toLowerCase();
}

function decimal(value, pattern, field, nullable) {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !pattern.test(value)) fail(`${field} must be a whole number written in decimal digits.`);
  return value;
}

function chainId(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) fail("chainId must be a positive whole number, or null.");
  return value;
}

/** A list of known codes, each at most once, sorted so the same facts always read the same. */
function codeList(value, allowed, field) {
  if (!Array.isArray(value) || value.length > allowed.length) fail(`${field} must be a list of at most ${allowed.length} known codes.`);
  if (value.some((code) => !allowed.includes(code))) fail(`${field} contains an unknown code.`);
  if (new Set(value).size !== value.length) fail(`${field} repeats a code.`);
  return [...value].sort();
}

function exactKeys(value, allowed, where) {
  // The names of unknown fields come from the sender, so they are not repeated back.
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${where} has fields that are not allowed.`);
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) fail(`${where} is missing ${missing.join(", ")}.`);
}

class RequestError extends Error {}

function fail(message) {
  throw new RequestError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
