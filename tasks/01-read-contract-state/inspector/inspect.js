// Pharos Inspector, server side: read one Pharos object a visitor pasted, through Pharos Chain MCP.
// An address is first checked for contract code (get_code) at one explicit block, and that decides
// what is read: a contract's four standard ERC-20 values, or a wallet-like address's native balance
// and nonce. A transaction hash is looked up with its receipt.
//
// Deliberately separate from the Task 01 proof: /api/state and the CLI behind it are untouched,
// and nothing here can change what they read or report. The proven pieces are reused as they are,
// compiled from src/ during `npm ci`: the MCP client with its 1.0.2 transport fix (no standalone GET
// stream), the ERC-20 calldata and decoders, the error mapping and the amount formatter.
//
// Every chain read is an MCP tool call. There is no JSON-RPC client here: viem is used only to
// checksum addresses and hex-encode the block number.
import { getAddress, toHex } from "viem";
import { CHAIN_NAMES, HOSTED_ENDPOINT, TOOL_NAME, VERSION } from "../dist/src/constants.js";
import { CALLDATA, decodeDecimalsReturn, decodeStringReturn, decodeUint256Return, EmptyReturnError, MalformedReturnError } from "../dist/src/erc20.js";
import { CliError, ToolCallError } from "../dist/src/errors.js";
import { formatTokenAmount, sanitizeForTerminal } from "../dist/src/format.js";
import { McpRecorder, PharosMcp } from "../dist/src/mcp-client.js";
import { classifyInput } from "../public/assets/inspect-input.js";

/** Per MCP request. The live Task 01 proof needed 3.3 s for nine requests, so this is generous. */
export const INSPECT_TIMEOUT_MS = 15_000;
/** The whole inspection, kept under the function's 60 s limit so a slow read still ends in JSON. */
export const INSPECT_DEADLINE_MS = 45_000;
/** Pause before re-reading a value whose first read failed transiently, at the same block. */
export const RETRY_DELAY_MS = 750;

export const NO_ERC20_MESSAGE = "This contract's standard ERC-20 metadata (name, symbol, decimals and totalSupply) was not available. Many contracts are not ERC-20 tokens, so this does not mean anything is wrong with it.";
export const UNDETERMINED_MESSAGE = "The contract-code check through Pharos Chain MCP failed, so this page does not say whether this is a contract or a wallet-like address, and nothing else was read. Inspect it again in a moment.";
export const NO_CODE_TOOL_MESSAGE = "This Pharos Chain MCP server does not offer get_code, so this page cannot tell a contract from a wallet-like address, and nothing else was read.";

/** Set on a result in which a read failed in a way a later try could fix: it is never shared from a cache. */
const RETRYABLE = Symbol("a read failed and may succeed later");

const FIELDS = ["name", "symbol", "decimals", "totalSupply"];
const DECODERS = { name: decodeStringReturn, symbol: decodeStringReturn, decimals: decodeDecimalsReturn, totalSupply: decodeUint256Return };
const DECIMALS_OF_NATIVE_TOKEN = 18;

/**
 * Inspect one pasted value. Returns { status, body } for the HTTP handler and never throws.
 * Invalid input is answered without opening an MCP session.
 */
export async function inspect(raw, options = {}) {
  const { endpoint = HOSTED_ENDPOINT, timeoutMs = INSPECT_TIMEOUT_MS, deadlineMs = INSPECT_DEADLINE_MS, retryDelayMs = RETRY_DELAY_MS } = options;
  const started = performance.now();
  const input = classifyInput(raw);
  if (!input.ok) return { status: 400, body: { ok: false, error: { kind: "INVALID_INPUT", message: input.message }, ...stamp() } };

  const mcp = new PharosMcp(new URL(endpoint), { timeoutMs, recorder: new McpRecorder() });
  try {
    const work = (async () => {
      await mcp.connect();
      return input.kind === "address" ? await inspectAddress(mcp, input.value, { retryDelayMs }) : await inspectTransaction(mcp, input.value);
    })();
    const result = await withDeadline(work, deadlineMs);
    const source = { via: "Pharos Chain MCP", endpoint: new URL(endpoint).href, server: mcp.serverLabel ?? null, toolCalls: mcp.toolCalls };
    // Only a complete answer may be shared from a cache: never a miss, an undetermined address or a
    // result in which a read failed, so inspecting again really reads again.
    const { [RETRYABLE]: retryable = false, ...facts } = result;
    const shareable = !retryable && result.status !== "not-found" && result.status !== "undetermined";
    return { status: 200, shareable, body: { ok: true, ...facts, source, elapsedMs: Math.round(performance.now() - started), ...stamp() } };
  } catch (error) {
    const failure = describeError(error, input.kind);
    return { status: failure.kind === "UNEXPECTED" ? 500 : 502, body: { ok: false, kind: input.kind, error: failure, ...stamp() } };
  } finally {
    await mcp.close();
  }
}

// ---------------------------------------------------------------------------
// Address mode: whether the address has contract code at one explicit block decides what is read.

/**
 * Inspect an address at one block. get_code decides, and nothing is guessed:
 *   contract code  -> a contract: the four standard ERC-20 reads, as before
 *   no code        -> a wallet-like address: its native balance and nonce, and no eth_call at all
 *   check failed   -> the type is not determined, and nothing else is read: four ERC-20 reads of an
 *                     address that may hold no code would only repeat the misleading "unavailable"
 *                     rows this check exists to avoid, and the user can simply inspect again.
 * Every read is pinned to the block from get_block_number; a transient failure gets one more try at
 * that same block, never at "latest".
 */
export async function inspectAddress(mcp, value, { retryDelayMs = RETRY_DELAY_MS } = {}) {
  const address = getAddress(value);
  const warnings = [];
  const hex = value.slice(2);
  if (/[a-f]/.test(hex) && /[A-F]/.test(hex) && value !== address) {
    warnings.push("The letter case of this address does not match its EIP-55 checksum, which often means a typo. It was read exactly as entered.");
  }

  const [blockPayload, network] = await Promise.all([mcp.call("get_block_number", {}), readNetwork(mcp, warnings)]);
  const blockNumber = parseBlockNumber(blockPayload);
  const block = toHex(blockNumber);
  const base = { address, blockNumber: blockNumber.toString(), network };

  // Only a broken connection ends the inspection here: a server without get_code, or a failing one,
  // leaves the type undetermined instead.
  const code = await settle({ code: () => readCode(mcp, address, block) }, retryDelayMs, isConnectionLoss);
  if (!code.outcomes.code.ok) {
    const { error } = code.outcomes.code;
    const message = isMissing(error) ? NO_CODE_TOOL_MESSAGE : UNDETERMINED_MESSAGE;
    return { kind: "address", status: "undetermined", ...base, reason: toolProblem("get_code", error), retriedAtSameBlock: code.retried, message, warnings };
  }
  return code.outcomes.code.value
    ? await readContract(mcp, base, block, { retryDelayMs, retried: code.retried, warnings })
    : await readWalletLike(mcp, base, block, { retryDelayMs, retried: code.retried, warnings });
}

/** get_code at the block: true when the address holds contract code, false for "0x". */
async function readCode(mcp, address, block) {
  const payload = await mcp.call("get_code", { address, block });
  const code = isRecord(payload) ? payload.code : undefined;
  if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new CliError("MCP_TOOL_ERROR", "its answer was not bytecode");
  return code.length > 2;
}

/** A contract: name, symbol, decimals and totalSupply at the block. Any subset may succeed. */
async function readContract(mcp, base, block, { retryDelayMs, retried, warnings }) {
  const reads = Object.fromEntries(FIELDS.map((field) => [field, () => ethCall(mcp, base.address, CALLDATA[field], block).then((data) => DECODERS[field](data))]));
  // A server without eth_call ends the inspection instead of reporting four "unavailable" methods
  // that were never really asked.
  const { outcomes, retried: again } = await settle(reads, retryDelayMs, isFatal);

  const symbol = outcomes.symbol.ok ? clean(outcomes.symbol.value, 32) : null;
  const decimals = outcomes.decimals.ok ? outcomes.decimals.value : null;
  const state = {
    name: outcomes.name.ok ? { ok: true, value: clean(outcomes.name.value, 80) } : unavailable(outcomes.name.error),
    symbol: outcomes.symbol.ok ? { ok: true, value: symbol } : unavailable(outcomes.symbol.error),
    decimals: outcomes.decimals.ok ? { ok: true, value: decimals } : unavailable(outcomes.decimals.error),
    totalSupply: outcomes.totalSupply.ok ? supplyEntry(outcomes.totalSupply.value, decimals, symbol) : unavailable(outcomes.totalSupply.error),
  };
  const succeeded = FIELDS.filter((field) => state[field].ok).length;
  // "None" only when the contract itself answered every call, just not as an ERC-20 token would
  // (reverted, no data, data of another type). Reads that failed on the server say nothing about
  // the contract: that is a partial result, each failure shown with its reason.
  const answeredAll = FIELDS.every((field) => !outcomes[field].ok && contractAnswered(outcomes[field].error));
  const status = succeeded === FIELDS.length ? "success" : succeeded === 0 && answeredAll ? "none" : "partial";
  const result = { kind: "contract", status, ...base, state, retriedAtSameBlock: [...retried, ...again], message: status === "none" ? NO_ERC20_MESSAGE : null, warnings };
  if (FIELDS.some((field) => !outcomes[field].ok && !contractAnswered(outcomes[field].error))) result[RETRYABLE] = true;
  return result;
}

/** The contract answered the call itself: it reverted, returned nothing, or returned another type. */
function contractAnswered(error) {
  return error instanceof EmptyReturnError || error instanceof MalformedReturnError || (error instanceof ToolCallError && error.isRevert);
}

/**
 * A wallet-like address (no contract code at the block): its native balance (get_balance) and its
 * nonce, the number of transactions it has sent (get_transaction_count). No eth_call: there is no
 * code to answer one. A read that fails, or a server without the tool, leaves that value unavailable.
 */
async function readWalletLike(mcp, base, block, { retryDelayMs, retried, warnings }) {
  const reads = {
    balance: () => readQuantity(mcp, "get_balance", base.address, block, ["balanceWei", "balanceHex"]),
    nonce: () => readQuantity(mcp, "get_transaction_count", base.address, block, ["nonce", "nonceHex"]),
  };
  const { outcomes, retried: again } = await settle(reads, retryDelayMs, isConnectionLoss);
  const state = {
    balance: outcomes.balance.ok ? { ok: true, ...nativeAmount(outcomes.balance.value, base.network?.nativeSymbol ?? null) } : unavailable(outcomes.balance.error),
    nonce: outcomes.nonce.ok ? { ok: true, value: outcomes.nonce.value } : unavailable(outcomes.nonce.error),
  };
  const status = state.balance.ok && state.nonce.ok ? "success" : "partial";
  const result = { kind: "wallet-like", status, ...base, state, retriedAtSameBlock: [...retried, ...again], message: null, warnings };
  if (status !== "success") result[RETRYABLE] = true;
  return result;
}

/** A count or an amount from a Pharos MCP tool, as a decimal string: its decimal field, else its hex one. */
async function readQuantity(mcp, tool, address, block, [decimalField, hexField]) {
  const payload = await mcp.call(tool, { address, block });
  const record = isRecord(payload) ? payload : {};
  const value = typeof record[decimalField] === "string" && /^(?:0|[1-9]\d{0,77})$/.test(record[decimalField]) ? record[decimalField] : quantity(record[hexField]);
  if (value === null) throw new CliError("MCP_TOOL_ERROR", `${tool} returned an unexpected payload`);
  return value;
}

/**
 * Run named reads together. A read that failed transiently (the server answered with an error that
 * is not a revert or a rejected request) gets one more try after a pause; every read closes over the
 * same block, so a retry reads that block again. An error `fatal` picks ends the inspection.
 */
async function settle(reads, retryDelayMs, fatal) {
  const run = async (names) => {
    const settled = await Promise.allSettled(names.map((name) => reads[name]()));
    for (const outcome of settled) {
      if (outcome.status === "rejected" && fatal(outcome.reason)) throw outcome.reason;
    }
    return Object.fromEntries(names.map((name, index) => [name, settled[index].status === "fulfilled" ? { ok: true, value: settled[index].value } : { ok: false, error: settled[index].reason }]));
  };
  const outcomes = await run(Object.keys(reads));
  const retried = Object.keys(reads).filter((name) => isTransient(outcomes[name]));
  if (retried.length > 0) {
    await delay(retryDelayMs);
    Object.assign(outcomes, await run(retried));
  }
  return { outcomes, retried };
}

/** One MCP eth_call. The Pharos server answers with {"result": "0x..."}. */
async function ethCall(mcp, to, data, block) {
  const payload = await mcp.call("eth_call", { transaction: { to, data }, block });
  const result = payload !== null && typeof payload === "object" ? payload.result : undefined;
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) throw new CliError("MCP_TOOL_ERROR", "eth_call returned an unexpected payload");
  return result;
}

function supplyEntry(raw, decimals, symbol) {
  if (decimals === null) return { ok: true, raw: raw.toString(), formatted: null, display: null };
  const formatted = formatTokenAmount(raw, decimals);
  return { ok: true, raw: raw.toString(), formatted, display: symbol ? `${formatted} ${symbol}` : formatted };
}

function unavailable(error) {
  return { ok: false, reason: describeFailure(error) };
}

/** Worth one retry: the server answered with an error that is not a revert or a rejected request. */
function isTransient(outcome) {
  return !outcome.ok && outcome.error instanceof ToolCallError && !outcome.error.isRevert && !outcome.error.isInvalidParams;
}

function describeFailure(error) {
  if (isMissing(error)) return "not offered by this Pharos Chain MCP server";
  if (error instanceof EmptyReturnError) return "no data returned";
  if (error instanceof MalformedReturnError) return "returned data of the wrong type";
  if (error instanceof ToolCallError) return error.isRevert ? "reverted" : `failed: ${clean(error.detail, 120)}`;
  if (error instanceof CliError) return "unexpected MCP response";
  return "failed";
}

// ---------------------------------------------------------------------------
// Transaction mode: get_transaction and get_transaction_receipt. Only fields MCP returned are shown.

export async function inspectTransaction(mcp, hash) {
  const warnings = [];
  const notes = [];
  const lookup = (tool) =>
    mcp.call(tool, { hash }).then(
      (payload) => (payload === null || isRecord(payload) ? { ok: true, payload } : { ok: false, error: new CliError("MCP_TOOL_ERROR", `${tool} returned an unexpected payload`) }),
      (error) => {
        if (isConnectionLoss(error)) throw error;
        return { ok: false, error };
      },
    );
  const [tx, receipt, network] = await Promise.all([lookup("get_transaction"), lookup("get_transaction_receipt"), readNetwork(mcp, warnings)]);

  if (!tx.ok && !receipt.ok) {
    if (isMissing(tx.error) && isMissing(receipt.error)) {
      throw new CliError("MCP_TOOLS_MISSING", "Transaction lookup is not available: this Pharos Chain MCP server offers neither get_transaction nor get_transaction_receipt.");
    }
    throw isMissing(tx.error) ? receipt.error : tx.error;
  }
  if (tx.ok && tx.payload === null && (!receipt.ok || receipt.payload === null)) {
    return { kind: "transaction", status: "not-found", hash, transaction: null, network, notes, warnings };
  }
  // Without the transaction itself, an empty receipt says nothing either way: report the failure.
  if (!tx.ok && receipt.ok && receipt.payload === null) throw tx.error;

  const t = tx.ok ? tx.payload : null;
  const r = receipt.ok ? receipt.payload : null;
  const mined = t !== null && quantity(t.blockNumber) !== null;
  if (!tx.ok) notes.push(`${toolProblem("get_transaction", tx.error)} From, value and gas limit are not shown.`);
  if (!receipt.ok) notes.push(`${toolProblem("get_transaction_receipt", receipt.error)} Status, gas used and logs are not shown.`);
  else if (r === null) {
    notes.push(
      mined
        ? "get_transaction_receipt returned no receipt for this mined transaction, so status, gas used and logs are not shown."
        : "No receipt yet: the transaction has not been included in a block, so status, gas used and logs do not exist yet.",
    );
  }

  const to = t ? t.to : r ? r.to : undefined;
  const transaction = {
    hash: hexString(t?.hash, 64) ?? hexString(r?.transactionHash, 64) ?? hash,
    status: r ? receiptStatus(r.status) : t !== null && receipt.ok && !mined ? "pending" : null,
    blockNumber: quantity(t?.blockNumber) ?? quantity(r?.blockNumber),
    from: address(t?.from) ?? address(r?.from),
    to: address(to),
    contractCreation: to === null ? { address: address(r?.contractAddress) } : null,
    value: nativeAmount(quantity(t?.value), network?.nativeSymbol ?? null),
    gasLimit: quantity(t?.gas),
    gasUsed: quantity(r?.gasUsed),
    logs: Array.isArray(r?.logs) ? r.logs.length : null,
  };
  const complete = tx.ok && receipt.ok && t !== null && r !== null;
  const result = { kind: "transaction", status: complete ? "success" : "partial", hash, transaction, network, notes, warnings };
  if (!tx.ok || !receipt.ok) result[RETRYABLE] = true;
  return result;
}

function receiptStatus(status) {
  if (status === "0x1") return "success";
  if (status === "0x0") return "failed";
  return null;
}

function nativeAmount(wei, symbol) {
  if (wei === null) return null;
  return { wei, display: symbol ? `${formatTokenAmount(BigInt(wei), DECIMALS_OF_NATIVE_TOKEN)} ${symbol}` : `${wei} wei` };
}

function toolProblem(tool, error) {
  return isMissing(error) ? `This Pharos Chain MCP server does not offer ${tool}.` : `${tool} failed: ${clean(error instanceof ToolCallError ? error.detail : error?.message ?? "unknown error", 120)}.`;
}

// ---------------------------------------------------------------------------
// Shared helpers

/** Network context from get_chain_info. Never fatal: a failure only becomes a warning. */
async function readNetwork(mcp, warnings) {
  try {
    const payload = await mcp.call("get_chain_info", {});
    if (!isRecord(payload) || typeof payload.chainId !== "number" || !Number.isSafeInteger(payload.chainId)) {
      warnings.push("get_chain_info returned no chain ID, so the network is not confirmed.");
      return null;
    }
    if (payload.chainIdMatches === false) warnings.push(`The server's RPC reports chain ID ${payload.chainId}, but the server expects ${String(payload.expectedChainId)}.`);
    const nativeSymbol = typeof payload.nativeSymbol === "string" ? clean(payload.nativeSymbol, 12) : null;
    return { chainId: payload.chainId, name: CHAIN_NAMES[payload.chainId] ?? null, nativeSymbol };
  } catch (error) {
    if (isConnectionLoss(error)) throw error;
    warnings.push(isMissing(error) ? "This MCP server does not offer get_chain_info, so the network is not confirmed." : "get_chain_info failed, so the network is not confirmed.");
    return null;
  }
}

function parseBlockNumber(payload) {
  const record = isRecord(payload) ? payload : {};
  if (typeof record.blockNumber === "string" && /^\d+$/.test(record.blockNumber)) return BigInt(record.blockNumber);
  if (typeof record.blockNumberHex === "string" && /^0x[0-9a-fA-F]+$/.test(record.blockNumberHex)) return BigInt(record.blockNumberHex);
  throw new CliError("MCP_TOOL_ERROR", "get_block_number returned an unexpected payload");
}

/** A JSON-RPC quantity ("0x1a") as a decimal string, or null if absent or malformed. */
function quantity(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value) ? BigInt(value).toString() : null;
}

function hexString(value, bytes) {
  return typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes}}$`).test(value) ? value.toLowerCase() : null;
}

function address(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? getAddress(value) : null;
}

/** On-chain text is attacker-controlled: strip control and bidi characters and cap the length. */
function clean(value, max) {
  return sanitizeForTerminal(String(value), max);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error) {
  return error instanceof CliError && error.kind === "MCP_TOOLS_MISSING";
}

function isFatal(error) {
  return error instanceof CliError && (error.kind === "MCP_CONNECTION" || error.kind === "MCP_TOOLS_MISSING");
}

function isConnectionLoss(error) {
  return error instanceof CliError && error.kind === "MCP_CONNECTION";
}

/** A failure the page can show as is: a category and one plain sentence, never a stack. */
function describeError(error, kind) {
  if (error instanceof CliError) {
    if (error.kind === "MCP_TOOLS_MISSING") {
      const message = /eth_call/.test(error.message)
        ? "Contract reads are not available: this Pharos Chain MCP server does not offer eth_call."
        : /get_block_number/.test(error.message)
          ? "Address reads are not available: this Pharos Chain MCP server does not offer get_block_number."
          : clean(error.message, 300);
      return { kind: "MCP_TOOLS_MISSING", message };
    }
    if (error.kind === "MCP_CONNECTION") {
      return { kind: "MCP_CONNECTION", message: clean(error.message, 300), hint: "Pharos Chain MCP could not be reached or did not answer in time. Try again in a moment." };
    }
    if (error.kind === "MCP_TOOL_ERROR") {
      const detail = error instanceof ToolCallError ? `${error.tool} failed: ${error.detail}` : error.message;
      return { kind: "MCP_TOOL_ERROR", message: clean(detail, 300), hint: `The ${kind} could not be read through Pharos Chain MCP. Try again in a moment.` };
    }
  }
  return { kind: "UNEXPECTED", message: "Something went wrong while inspecting. Try again in a moment." };
}

function withDeadline(work, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    const limit = ms >= 1_000 ? `${Math.round(ms / 1_000)} s` : `${ms} ms`;
    timer = setTimeout(() => reject(new CliError("MCP_CONNECTION", `The inspection did not finish within ${limit} and was stopped.`)), ms);
  });
  // The work keeps running for a moment after a deadline; its late failure is expected and ignored.
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function stamp() {
  return { tool: { name: TOOL_NAME, version: VERSION }, fetchedAt: new Date().toISOString() };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
