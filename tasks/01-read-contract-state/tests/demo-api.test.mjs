// Tests for the Vercel demo function, api/state.js. They need dist/ (built by `npm ci`):
//   node --test tests/demo-api.test.mjs
// Everything runs against the in-process fake Pharos MCP server or a stubbed fetch; nothing here
// reaches the network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { encodeAbiParameters } from "viem";
import handler, { createHandler, MCP_TIMEOUT_MS, readState } from "../api/state.js";
import { DEFAULT_TIMEOUT_MS } from "../dist/src/constants.js";
import { startFakePharosMcp } from "../dist/tests/fake-pharos-mcp.js";

// Test fixtures only: made up, never used as proof.
const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const BLOCK_HEX = "0x1092"; // 4242
const str = (value) => encodeAbiParameters([{ type: "string" }], [value]);
const uint = (value) => encodeAbiParameters([{ type: "uint256" }], [value]);
const bool = (value) => encodeAbiParameters([{ type: "bool" }], [value]);
const chain = {
  blockNumber: 4242n,
  contracts: {
    // name, symbol, decimals, totalSupply and paused(): the Task 01 contract's five reads.
    [USDC.toLowerCase()]: { "0x06fdde03": str("USDC"), "0x95d89b41": str("USDC"), "0x313ce567": uint(6n), "0x18160ddd": uint(123_456_789_012_345n), "0x5c975abb": bool(false) },
  },
};

/** Call a handler with the minimum of Node's request/response it uses. */
function call(handlerFn, method = "GET") {
  return new Promise((resolve) => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
        return this;
      },
      end(text) {
        resolve({ status: this.status, headers: this.headers, body: JSON.parse(text) });
      },
    };
    handlerFn({ method }, res);
  });
}

/** Record every request sent while `fn` runs; `respond`, if given, answers instead of the network. */
async function withFetchSpy(fn, respond) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return respond ? respond(input, init) : realFetch(input, init);
  };
  try {
    return { result: await fn(), sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("demo API against a fake Pharos MCP server", () => {
  let server;
  before(async () => {
    server = await startFakePharosMcp(chain);
  });
  after(async () => {
    await server.close();
  });

  test("serves the CLI's JSON report with every value the page shows, cached briefly", async () => {
    const { status, headers, body } = await call(createHandler(server.url));
    assert.equal(status, 200);
    assert.equal(headers["content-type"], "application/json; charset=utf-8");
    assert.equal(headers["cache-control"], "public, s-maxage=15, stale-while-revalidate=45");
    assert.equal(body.ok, true);
    assert.deepEqual(body.contract, { address: USDC, label: "Circle USDC Contract", labelSource: "known-address" });
    assert.deepEqual(body.network, { chainId: 1672, name: "Pharos Mainnet" });
    assert.equal(body.blockNumber, "4242");
    assert.deepEqual(body.values, { name: "USDC", symbol: "USDC", decimals: 6, totalSupply: { raw: "123456789012345", formatted: "123456789.012345" }, paused: false });
    assert.deepEqual(body.display, { totalSupply: "123,456,789.012345 USDC" });
    // The call model the page derives its counts from: 2 context calls + 5 contract reads = 7 tool calls.
    assert.deepEqual(body.source, {
      via: "Pharos Chain MCP",
      endpoint: server.url,
      server: "fake-pharos-mcp 0.0.0",
      toolCalls: 7,
      contextCalls: ["get_chain_info", "get_block_number"],
      contractReads: ["name", "symbol", "decimals", "totalSupply", "paused"],
    });
    assert.deepEqual(body.tool, { name: "read-contract-state", version: "1.0.2" });
    assert.match(body.summary, /At Pharos Mainnet block 4242, the Circle USDC Contract reports a total supply of 123,456,789\.012345 USDC\./);
    assert.ok(!Number.isNaN(Date.parse(body.fetchedAt)));
  });

  test("reads only through MCP: every request goes to the MCP endpoint, no standalone GET, five eth_calls on one block", async () => {
    server.calls.length = 0;
    server.requests.length = 0;
    const { result, sent } = await withFetchSpy(() => readState(server.url));
    assert.equal(result.status, 200);
    assert.deepEqual([...new Set(sent.map((request) => request.url))], [server.url]);
    assert.deepEqual([...new Set(sent.map((request) => request.method))].sort(), ["DELETE", "POST"]);
    assert.ok(!server.requests.some((method) => method.startsWith("GET")));
    assert.ok(!server.methods.includes("tools/list"));
    const tools = sent.filter((request) => request.body?.method === "tools/call").map((request) => request.body.params.name);
    assert.deepEqual(tools.sort(), ["eth_call", "eth_call", "eth_call", "eth_call", "eth_call", "get_block_number", "get_chain_info"]);
    const ethCalls = server.calls.filter((entry) => entry.tool === "eth_call");
    assert.deepEqual(ethCalls.map((entry) => entry.args.block), Array(5).fill(BLOCK_HEX));
    assert.deepEqual(ethCalls.map((entry) => entry.args.transaction.data).sort(), ["0x06fdde03", "0x18160ddd", "0x313ce567", "0x5c975abb", "0x95d89b41"]);
  });

  test("keeps the 1.0.2 transport fix: a server that stalls once a GET stream is open still gives a full read", async () => {
    const stalling = await startFakePharosMcp({ ...chain, getStreamStallsSession: true });
    try {
      const { status, body } = await readState(stalling.url);
      assert.equal(status, 200, JSON.stringify(body.error));
      assert.equal(body.display.totalSupply, "123,456,789.012345 USDC");
      assert.ok(!stalling.requests.some((method) => method.startsWith("GET")));
    } finally {
      await stalling.close();
    }
  });
});

describe("deployed handler", () => {
  test("always targets the hosted endpoint without a token, whatever PHAROS_MCP_URL / PHAROS_MCP_TOKEN say; failures are 502 and not cached", async () => {
    const saved = { PHAROS_MCP_URL: process.env.PHAROS_MCP_URL, PHAROS_MCP_TOKEN: process.env.PHAROS_MCP_TOKEN };
    process.env.PHAROS_MCP_URL = "http://127.0.0.1:9/elsewhere";
    process.env.PHAROS_MCP_TOKEN = "must-not-be-sent";
    try {
      // Answered locally with 503, so the test never reaches the real endpoint.
      const { result, sent } = await withFetchSpy(() => call(handler), () => new Response("unavailable in tests", { status: 503 }));
      assert.ok(sent.length > 0);
      assert.ok(sent.every((request) => request.url === "https://mcp.pharos.xyz/mcp"), JSON.stringify(sent.map((request) => request.url)));
      assert.ok(sent.every((request) => request.authorization === null));
      assert.equal(result.status, 502);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.equal(result.body.ok, false);
      assert.equal(result.body.error.kind, "MCP_CONNECTION");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("uses the proven CLI's 20000 ms MCP timeout, and Vercel gives the function room for it", () => {
    assert.equal(MCP_TIMEOUT_MS, 20_000);
    assert.equal(MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    // Initialize, the get_chain_info/get_block_number pair and the four eth_calls each get the full
    // timeout before Vercel cuts the function off, so a slow read ends with the API's JSON, not a 504.
    const { maxDuration } = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).functions["api/state.js"];
    assert.ok(maxDuration >= 30);
    assert.ok(maxDuration * 1000 >= 3 * MCP_TIMEOUT_MS, `maxDuration ${maxDuration}s is too short for three ${MCP_TIMEOUT_MS} ms phases`);
  });

  test("answers only GET", async () => {
    const { status, headers, body } = await call(handler, "POST");
    assert.equal(status, 405);
    assert.equal(headers.allow, "GET");
    assert.equal(body.ok, false);
  });
});
