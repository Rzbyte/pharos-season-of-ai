// Read-only capability check of a Pharos Chain MCP server, for the Pharos Inspector.
//
//   node scripts/check-mcp-capabilities.mjs [endpoint]      (default: the hosted endpoint)
//
// Lists the tools the server really offers, then looks at one real transaction to show the fields
// get_transaction and get_transaction_receipt return, and checks the address tools the Inspector
// classifies with: get_code for the Task 01 contract and for that transaction's sender, then
// get_balance and get_transaction_count (on that sender, or the zero address without one), all at
// one explicit block. It prints which tools answer and the fields they return, not anyone's balance. Every request is an
// MCP call, through the same transport as the CLI (no standalone GET stream). Nothing is written,
// signed or sent on-chain, and no key or token is used. Needs `npm ci` first (it uses dist/ and the
// MCP SDK).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_TOKEN, HOSTED_ENDPOINT } from "../dist/src/constants.js";
import { fetchWithoutStandaloneSse, parseToolPayload } from "../dist/src/mcp-client.js";

const endpoint = new URL(process.argv[2] ?? HOSTED_ENDPOINT);
const TIMEOUT_MS = 20_000;
const BLOCKS_TO_SCAN = 25;
const RELEVANT = ["get_transaction", "get_transaction_receipt", "get_block", "get_logs", "eth_call", "get_block_number", "get_chain_info", "get_code", "get_balance", "get_transaction_count"];

const client = new Client({ name: "pharos-inspector-capability-check", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(endpoint, { fetch: fetchWithoutStandaloneSse });
const line = (text = "") => process.stdout.write(`${text}\n`);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT_MS });
  const payload = parseToolPayload(result);
  if (result.isError) throw new Error(typeof payload === "string" ? payload : JSON.stringify(payload));
  return payload;
}

const fields = (value) => (value && typeof value === "object" ? Object.keys(value).sort().join(", ") : String(value));

try {
  await client.connect(transport, { timeout: TIMEOUT_MS });
  const server = client.getServerVersion();
  line(`Endpoint   ${endpoint.href}`);
  line(`Server     ${server?.name ?? "?"} ${server?.version ?? ""}`);
  line();

  let offered = null;
  try {
    const { tools } = await client.listTools(undefined, { timeout: TIMEOUT_MS });
    offered = new Set(tools.map((tool) => tool.name));
    line(`tools/list ${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`);
    for (const tool of tools.filter((t) => RELEVANT.includes(t.name))) {
      line(`  ${tool.name.padEnd(24)} input: ${Object.keys(tool.inputSchema?.properties ?? {}).join(", ") || "(none)"}`);
    }
  } catch (error) {
    line(`tools/list failed (${error.message}); checking each tool by calling it instead.`);
  }
  line();

  const latest = BigInt((await call("get_block_number", {})).blockNumber);
  line(`get_block_number  ${latest}`);

  let hash = null;
  let sender = null;
  let scanned = true;
  try {
    for (let block = latest; block > latest - BigInt(BLOCKS_TO_SCAN) && !hash; block -= 1n) {
      const payload = await call("get_block", { block: `0x${block.toString(16)}`, includeTransactions: false });
      if (block === latest) line(`get_block         fields: ${fields(payload)}`);
      const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
      if (transactions.length > 0) hash = typeof transactions[0] === "string" ? transactions[0] : transactions[0].hash;
    }
  } catch (error) {
    // The address checks below do not need a sample transaction.
    line(`get_block         FAILED: ${error.message}`);
    scanned = false;
  }
  if (!hash) {
    line(scanned ? `No transaction in the last ${BLOCKS_TO_SCAN} blocks; transaction tools not exercised.` : "No sample transaction; transaction tools not exercised.");
  } else {
    line(`sample tx         ${hash}`);
    for (const tool of ["get_transaction", "get_transaction_receipt"]) {
      try {
        const payload = await call(tool, { hash });
        line(`${tool.padEnd(17)} fields: ${fields(payload)}`);
        if (tool === "get_transaction" && typeof payload?.from === "string") sender = payload.from;
        if (tool === "get_transaction_receipt" && payload) line(`${"".padEnd(17)} status ${payload.status}, gasUsed ${payload.gasUsed}, logs ${Array.isArray(payload.logs) ? payload.logs.length : "?"}`);
      } catch (error) {
        line(`${tool.padEnd(17)} FAILED: ${error.message}`);
      }
    }
    const unknown = `0x${"0".repeat(63)}1`;
    const missing = await call("get_transaction", { hash: unknown }).catch((error) => `FAILED: ${error.message}`);
    line(`get_transaction   unknown hash -> ${JSON.stringify(missing)}`);
  }

  // Address mode: the code check decides; an address without code gets its balance and nonce. All at
  // one explicit block, as the Inspector reads them. Each tool is tried on its own, and named if it fails.
  const block = `0x${latest.toString(16)}`;
  const probe = (tool, address) => call(tool, { address, block }).catch((error) => void line(`${tool.padEnd(17)} FAILED: ${error.message}`));
  for (const [label, address] of [["Task 01 contract", DEFAULT_TOKEN], ...(sender ? [["sample sender", sender]] : [])]) {
    const payload = await probe("get_code", address);
    if (payload === undefined) continue;
    const code = payload !== null && typeof payload === "object" ? payload.code : undefined;
    const bytes = typeof code === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(code) ? (code.length - 2) / 2 : null;
    line(`get_code          ${label}: ${bytes === null ? `unexpected answer ${JSON.stringify(payload)}` : bytes > 0 ? `${bytes} bytes of code (contract)` : "no code (wallet-like)"}`);
  }
  // The balance and nonce tools answer for any address; their shapes are what matter here.
  for (const tool of ["get_balance", "get_transaction_count"]) {
    const payload = await probe(tool, sender ?? `0x${"0".repeat(40)}`);
    if (payload !== undefined) line(`${tool.padEnd(17)} fields: ${fields(payload)}`);
  }
  line();
  if (offered) {
    line("Inspector capabilities");
    line(`  address type      ${["get_block_number", "get_code"].every((t) => offered.has(t)) ? "available" : "MISSING"} (get_block_number, get_code)`);
    line(`  contract mode     ${["get_block_number", "get_code", "eth_call"].every((t) => offered.has(t)) ? "available" : "MISSING"} (get_block_number, get_code, eth_call)`);
    line(`  wallet-like mode  ${["get_block_number", "get_code", "get_balance", "get_transaction_count"].every((t) => offered.has(t)) ? "available" : "MISSING"} (get_block_number, get_code, get_balance, get_transaction_count)`);
    line(`  transaction mode  ${["get_transaction", "get_transaction_receipt"].every((t) => offered.has(t)) ? "available" : "MISSING"} (get_transaction, get_transaction_receipt)`);
    line(`  block lookup      ${offered.has("get_block") ? "available" : "missing"} (get_block)`);
    line(`  logs              ${offered.has("get_logs") ? "available" : "missing"} (get_logs)`);
  }
} catch (error) {
  line(`Check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await transport.terminateSession().catch(() => undefined);
  await client.close().catch(() => undefined);
}
