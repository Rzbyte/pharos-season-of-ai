// Read-only capability check of a Pharos Chain MCP server, for the Pharos Inspector.
//
//   node scripts/check-mcp-capabilities.mjs [endpoint]      (default: the hosted endpoint)
//
// Lists the tools the server really offers, then looks at one real transaction to show the fields
// get_transaction and get_transaction_receipt return. Every request is an MCP call, through the
// same transport as the CLI (no standalone GET stream). Nothing is written, signed or sent on-chain,
// and no key or token is used. Needs `npm ci` first (it uses dist/ and the MCP SDK).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HOSTED_ENDPOINT } from "../dist/src/constants.js";
import { fetchWithoutStandaloneSse, parseToolPayload } from "../dist/src/mcp-client.js";

const endpoint = new URL(process.argv[2] ?? HOSTED_ENDPOINT);
const TIMEOUT_MS = 20_000;
const BLOCKS_TO_SCAN = 25;
const RELEVANT = ["get_transaction", "get_transaction_receipt", "get_block", "get_logs", "eth_call", "get_block_number", "get_chain_info"];

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
  for (let block = latest; block > latest - BigInt(BLOCKS_TO_SCAN) && !hash; block -= 1n) {
    const payload = await call("get_block", { block: `0x${block.toString(16)}`, includeTransactions: false });
    if (block === latest) line(`get_block         fields: ${fields(payload)}`);
    const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
    if (transactions.length > 0) hash = typeof transactions[0] === "string" ? transactions[0] : transactions[0].hash;
  }
  if (!hash) {
    line(`No transaction in the last ${BLOCKS_TO_SCAN} blocks; transaction tools not exercised.`);
  } else {
    line(`sample tx         ${hash}`);
    for (const tool of ["get_transaction", "get_transaction_receipt"]) {
      try {
        const payload = await call(tool, { hash });
        line(`${tool.padEnd(17)} fields: ${fields(payload)}`);
        if (tool === "get_transaction_receipt" && payload) line(`${"".padEnd(17)} status ${payload.status}, gasUsed ${payload.gasUsed}, logs ${Array.isArray(payload.logs) ? payload.logs.length : "?"}`);
      } catch (error) {
        line(`${tool.padEnd(17)} FAILED: ${error.message}`);
      }
    }
    const unknown = `0x${"0".repeat(63)}1`;
    const missing = await call("get_transaction", { hash: unknown }).catch((error) => `FAILED: ${error.message}`);
    line(`get_transaction   unknown hash -> ${JSON.stringify(missing)}`);
  }
  line();
  if (offered) {
    line("Inspector capabilities");
    line(`  contract mode     ${["get_block_number", "eth_call"].every((t) => offered.has(t)) ? "available" : "MISSING"} (get_block_number, eth_call)`);
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
