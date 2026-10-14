// Pharos Inspector, server side: read one Pharos object a visitor pasted, through Pharos Chain MCP.
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

export const NO_ERC20_MESSAGE = "Standard ERC-20 state methods were not available for this contract.";

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
      return input.kind === "contract" ? await inspectContract(mcp, input.value, { retryDelayMs }) : await inspectTransaction(mcp, input.value);
    })();
    const result = await withDeadline(work, deadlineMs);
    const source = { via: "Pharos Chain MCP", endpoint: new URL(endpoint).href, server: mcp.serverLabel ?? null, toolCalls: mcp.toolCalls };
    return { status: 200, body: { ok: true, ...result, source, elapsedMs: Math.round(performance.now() - started), ...stamp() } };
  } catch (error) {
    const failure = describeError(error, input.kind);
    return { status: failure.kind === "UNEXPECTED" ? 500 : 502, body: { ok: false, kind: input.kind, error: failure, ...stamp() } };
  } finally {
    await mcp.close();
  }
}

// ---------------------------------------------------------------------------
// Contract mode: the four standard ERC-20 reads, all pinned to one explicit block.

/** Read name, symbol, decimals and totalSupply at one block. Any subset may succeed. */
export async function inspectContract(mcp, value, { retryDelayMs = RETRY_DELAY_MS } = {}) {
  const address = getAddress(value);
  const warnings = [];
  const hex = value.slice(2);
  if (/[a-f]/.test(hex) && /[A-F]/.test(hex) && value !== address) {
    warnings.push("The letter case of this address does not match its EIP-55 checksum, which often means a typo. It was read exactly as entered.");
  }

  const [blockPayload, network] = await Promise.all([mcp.call("get_block_number", {}), readNetwork(mcp, warnings)]);
  const blockNumber = parseBlockNumber(blockPayload);
  const block = toHex(blockNumber);

  const outcomes = await readFields(mcp, address, block, FIELDS);
  // A transient failure (a node a block behind, say) gets one more try at the SAME block, never at
  // "latest", so every value shown belongs to the block shown.
  const retry = FIELDS.filter((field) => isTransient(outcomes[field]));
  if (retry.length > 0) {
    await delay(retryDelayMs);
    Object.assign(outcomes, await readFields(mcp, address, block, retry));
  }

  const symbol = outcomes.symbol.ok ? clean(outcomes.symbol.value, 32) : null;
  const decimals = outcomes.decimals.ok ? outcomes.decimals.value : null;
  const state = {
    name: outcomes.name.ok ? { ok: true, value: clean(outcomes.name.value, 80) } : unavailable(outcomes.name.error),
    symbol: outcomes.symbol.ok ? { ok: true, value: symbol } : unavailable(outcomes.symbol.error),
    decimals: outcomes.decimals.ok ? { ok: true, value: decimals } : unavailable(outcomes.decimals.error),
    totalSupply: outcomes.totalSupply.ok ? supplyEntry(outcomes.totalSupply.value, decimals, symbol) : unavailable(outcomes.totalSupply.error),
  };
  const succeeded = FIELDS.filter((field) => state[field].ok).length;
  const status = succeeded === FIELDS.length ? "success" : succeeded === 0 ? "none" : "partial";

  return {
    kind: "contract",
    status,
    address,
    blockNumber: blockNumber.toString(),
    network,
    state,
    retriedAtSameBlock: retry,
    message: status === "none" ? NO_ERC20_MESSAGE : null,
    warnings,
  };
}

async function readFields(mcp, address, block, fields) {
  const settled = await Promise.allSettled(
    fields.map((field) => ethCall(mcp, address, CALLDATA[field], block).then((data) => DECODERS[field](data))),
  );
  // A broken connection or a server without eth_call ends the inspection instead of reporting
  // four "unavailable" methods that were never really asked.
  for (const outcome of settled) {
    if (outcome.status === "rejected" && isFatal(outcome.reason)) throw outcome.reason;
  }
  return Object.fromEntries(fields.map((field, index) => [field, settled[index].status === "fulfilled" ? { ok: true, value: settled[index].value } : { ok: false, error: settled[index].reason }]));
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
        if (error instanceof CliError && error.kind === "MCP_CONNECTION") throw error;
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
  return { kind: "transaction", status: complete ? "success" : "partial", hash, transaction, network, notes, warnings };
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
    if (error instanceof CliError && error.kind === "MCP_CONNECTION") throw error;
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

/** A failure the page can show as is: a category and one plain sentence, never a stack. */
function describeError(error, kind) {
  if (error instanceof CliError) {
    if (error.kind === "MCP_TOOLS_MISSING") {
      const message = /eth_call/.test(error.message)
        ? "Contract reads are not available: this Pharos Chain MCP server does not offer eth_call."
        : /get_block_number/.test(error.message)
          ? "Contract reads are not available: this Pharos Chain MCP server does not offer get_block_number."
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
