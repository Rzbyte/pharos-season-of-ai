import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { encodeAbiParameters, stringToHex, type Hex } from "viem";
import { run, type Io } from "../src/run.js";
import { startFakePharosMcp, type FakeChain, type FakeServer } from "./fake-pharos-mcp.js";

// Test fixtures only: every value below is made up and never used as proof.
const SEL = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" } as const;
const OWNER_SELECTOR = "0x8da5cb5b";
const str = (value: string): Hex => encodeAbiParameters([{ type: "string" }], [value]);
const uint = (value: bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [value]);
const bytes32 = (value: string): Hex => stringToHex(value, { size: 32 });

const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
// Digit-only addresses are trivially valid EIP-55.
const TOKEN = "0x1111111111111111111111111111111111111111";
const BYTES32_TOKEN = "0x2222222222222222222222222222222222222222";
const NO_DECIMALS = "0x3333333333333333333333333333333333333333";
const NOT_ERC20 = "0x4444444444444444444444444444444444444444";
const EMPTY_ADDRESS = "0x5555555555555555555555555555555555555555";
const HOSTILE = "0x6666666666666666666666666666666666666666";

const BLOCK = 4242n;
const BLOCK_HEX = "0x1092";

const erc20 = (name: string, symbol: string, decimals: bigint, supply: bigint) => ({
  [SEL.name]: str(name),
  [SEL.symbol]: str(symbol),
  [SEL.decimals]: uint(decimals),
  [SEL.totalSupply]: uint(supply),
});

const chain: FakeChain = {
  blockNumber: BLOCK,
  contracts: {
    [USDC.toLowerCase()]: erc20("USD Coin", "USDC", 6n, 987_654_321_000_000n),
    [TOKEN]: erc20("Test USD", "TUSD", 6n, 123_456_789_012_345n),
    [BYTES32_TOKEN]: { [SEL.name]: bytes32("Maker"), [SEL.symbol]: bytes32("MKR"), [SEL.decimals]: uint(18n), [SEL.totalSupply]: uint(10n ** 24n) },
    [NO_DECIMALS]: { [SEL.name]: str("Bare"), [SEL.symbol]: str("BARE"), [SEL.totalSupply]: uint(500n) },
    [NOT_ERC20]: {},
    [HOSTILE]: {
      [SEL.name]: str("\u001b[2J\u001b[31mEvil\u0007"),
      [SEL.symbol]: str(`EV${String.fromCharCode(0x202e)}IL`),
      [SEL.decimals]: uint(0n),
      [SEL.totalSupply]: uint(1n),
    },
  },
};

function capture(env: Record<string, string | undefined> = {}, isTTY = false) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), env, isTTY, retryDelayMs: 5 };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

async function runJson(args: string[], env: Record<string, string | undefined> = {}) {
  const c = capture(env);
  const code = await run([...args, "--json"], c.io);
  return { code, report: JSON.parse(c.stdout()), stderr: c.stderr() };
}

describe("against a fake Pharos MCP server", () => {
  let server: FakeServer;
  before(async () => {
    server = await startFakePharosMcp(chain);
  });
  after(async () => {
    await server.close();
  });

  test("reads the four required values over MCP, all pinned to the block from get_block_number", async () => {
    server.calls.length = 0;
    const { code, report, stderr } = await runJson([USDC, "--endpoint", server.url]);
    assert.equal(code, 0, stderr);

    assert.equal(report.ok, true);
    assert.deepEqual(report.contract, { address: USDC, label: "Circle USDC Contract", labelSource: "known-address" });
    assert.equal(report.blockNumber, "4242");
    assert.deepEqual(report.network, { chainId: 1672, name: "Pharos Mainnet" });
    assert.deepEqual(report.values, {
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      totalSupply: { raw: "987654321000000", formatted: "987654321" },
    });
    assert.equal(report.source.toolCalls, 6);
    assert.deepEqual(report.retriedAtSameBlock, []);
    assert.deepEqual(report.warnings, []);

    const ethCalls = server.calls.filter((call) => call.tool === "eth_call");
    assert.deepEqual(ethCalls.map((call) => (call.args.transaction as { data: string }).data).sort(), Object.values(SEL).slice().sort());
    for (const call of ethCalls) assert.equal(call.args.block, BLOCK_HEX);
    assert.equal(server.openSessions(), 0, "the CLI should terminate its MCP session");
  });

  test("opens no standalone GET event stream: every request is an MCP POST to the endpoint, plus the closing DELETE", async () => {
    server.calls.length = 0;
    server.requests.length = 0;
    const seen: Array<{ url: string; method: string; rpc: string; status: number; contentType: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string; params?: { name?: string } }) : undefined;
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        rpc: [body?.method, body?.params?.name].filter(Boolean).join(" "),
        status: response.status,
        contentType: response.headers.get("content-type"),
      });
      return response;
    };
    let code: number;
    try {
      code = await run([USDC, "-e", server.url], capture().io);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(code, 0);
    assert.ok(!server.requests.some((method) => method.startsWith("GET")), "the server must see no GET");
    assert.deepEqual([...new Set(seen.map((entry) => entry.url))], [server.url], "all traffic goes to the MCP endpoint");
    assert.deepEqual([...new Set(seen.map((entry) => entry.method))].sort(), ["DELETE", "POST"]);
    // Tool results still arrive on each POST's own SSE stream, all through MCP tools/call.
    const toolCalls = seen.filter((entry) => entry.rpc.startsWith("tools/call"));
    assert.deepEqual(toolCalls.map((entry) => entry.rpc).sort(), ["tools/call eth_call", "tools/call eth_call", "tools/call eth_call", "tools/call eth_call", "tools/call get_block_number", "tools/call get_chain_info"]);
    for (const entry of toolCalls) {
      assert.equal(entry.status, 200);
      assert.match(entry.contentType ?? "", /^text\/event-stream/);
    }
    assert.deepEqual(server.calls.filter((call) => call.tool === "eth_call").map((call) => call.args.block), [BLOCK_HEX, BLOCK_HEX, BLOCK_HEX, BLOCK_HEX]);
  });

  test("never calls owner() or get_code", async () => {
    server.calls.length = 0;
    assert.equal(await run([USDC, "-e", server.url], capture().io), 0);
    assert.ok(!server.calls.some((call) => call.tool === "get_code"));
    assert.ok(!server.calls.some((call) => (call.args.transaction as { data?: string } | undefined)?.data === OWNER_SELECTOR));
    assert.deepEqual([...new Set(server.calls.map((call) => call.tool))].sort(), ["eth_call", "get_block_number", "get_chain_info"]);
  });

  test("human output labels the address, names the block and explains decimals in plain words", async () => {
    const c = capture();
    assert.equal(await run([USDC, "-e", server.url], c.io), 0);
    const out = c.stdout();
    assert.match(out, /Contract\s+Circle USDC Contract\n\s+Contract address\s+0xC879C018dB60520F4355C26eD1a6D572cdAC1815/);
    assert.match(out, /Read at block\s+4242/);
    assert.match(out, /Total supply\s+987,654,321 USDC/);
    assert.match(out, /raw value 987654321000000, divided by 10\^6/);
    // The plain-language paragraph is word-wrapped, so match prose on whitespace-collapsed text.
    const prose = out.replace(/\s+/g, " ");
    assert.match(prose, /In plain words: At Pharos Mainnet block 4242, the Circle USDC Contract reports a total supply of 987,654,321 USDC\./);
    assert.match(prose, /with 6 decimals, so its raw value 987654321000000 is divided by 10\^6/);
    assert.match(prose, /Read with MCP eth_call at block 4242: name\(\), symbol\(\), decimals\(\), totalSupply\(\)\./);
  });

  test("other contracts are labelled from their on-chain name, never as Circle USDC", async () => {
    const { report } = await runJson([TOKEN, "-e", server.url]);
    assert.deepEqual(report.contract, { address: TOKEN, label: "Test USD (TUSD) token contract", labelSource: "on-chain" });
    assert.deepEqual(report.values.totalSupply, { raw: "123456789012345", formatted: "123456789.012345" });
  });

  test("decodes bytes32 name and symbol (MKR-style tokens)", async () => {
    const { report } = await runJson([BYTES32_TOKEN, "-e", server.url]);
    assert.equal(report.values.name, "Maker");
    assert.equal(report.values.symbol, "MKR");
    assert.equal(report.values.totalSupply.formatted, "1000000");
  });

  test("all four reads are required: a missing decimals() fails with exit 5", async () => {
    const { code, report } = await runJson([NO_DECIMALS, "-e", server.url]);
    assert.equal(code, 5);
    assert.equal(report.error.kind, "NOT_ERC20");
    assert.match(report.error.message, /decimals\(\) reverted/);
    assert.doesNotMatch(report.error.message, /totalSupply\(\)/);
  });

  test("an address without code exits 5 and says why", async () => {
    const { code, report } = await runJson([EMPTY_ADDRESS, "-e", server.url]);
    assert.equal(code, 5);
    assert.equal(report.error.kind, "NOT_ERC20");
    assert.match(report.error.message, /returned no data for any required read at block 4242/);
  });

  test("a contract without ERC-20 functions exits 5", async () => {
    const c = capture();
    assert.equal(await run([NOT_ERC20, "-e", server.url], c.io), 5);
    assert.match(c.stderr(), /did not answer every required ERC-20 read at block 4242/);
  });

  test("on-chain strings cannot inject terminal escapes or bidi overrides", async () => {
    const c = capture();
    assert.equal(await run([HOSTILE, "-e", server.url], c.io), 0);
    const out = c.stdout();
    assert.ok(!out.includes("\u001b"), "no ESC characters may reach the terminal");
    assert.ok(!out.includes("\u0007"), "no BEL characters may reach the terminal");
    assert.ok(!out.includes(String.fromCharCode(0x202e)), "no bidi overrides may reach the terminal");
    assert.match(out, /Evil/);
    assert.match(out.replace(/\s+/g, " "), /uses 0 decimals/);
  });

  test("--transcript records every JSON-RPC message, never HTTP headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rcs-"));
    try {
      const file = join(dir, "proof", "mcp-transcript.json");
      const c = capture({ PHAROS_MCP_TOKEN: "secret-token-value" });
      assert.equal(await run([USDC, "-e", server.url, "--transcript", file], c.io), 0);
      const raw = await readFile(file, "utf8");
      assert.ok(!raw.includes("secret-token-value"), "the bearer token must never be written");

      const transcript = JSON.parse(raw);
      assert.equal(transcript.format, "pharos-mcp-transcript/1");
      assert.equal(transcript.outcome.ok, true);
      assert.equal(transcript.outcome.report.blockNumber, "4242");
      assert.equal(transcript.session.terminated, true);
      const methods = transcript.messages.map((entry: { message: { method?: string } }) => entry.message.method).filter(Boolean);
      assert.equal(methods[0], "initialize");
      assert.ok(!methods.includes("tools/list"), "the run must not depend on tools/list");
      assert.deepEqual([...new Set(methods)], ["initialize", "notifications/initialized", "tools/call"]);
      const ethCalls = transcript.messages.filter(
        (entry: { direction: string; message: { params?: { name?: string } } }) => entry.direction === "client->server" && entry.message.params?.name === "eth_call",
      );
      assert.equal(ethCalls.length, 4);
      for (const entry of ethCalls) assert.equal(entry.message.params.arguments.block, BLOCK_HEX);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--transcript is written on failure too, with the error as the outcome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rcs-"));
    try {
      const file = join(dir, "t.json");
      assert.equal(await run([EMPTY_ADDRESS, "-e", server.url, "--transcript", file], capture().io), 5);
      const transcript = JSON.parse(await readFile(file, "utf8"));
      assert.equal(transcript.outcome.ok, false);
      assert.equal(transcript.outcome.error.kind, "NOT_ERC20");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("PHAROS_MCP_TOKEN reaches a custom endpoint as a bearer token, and nothing is sent without it", async () => {
    server.authorizations.length = 0;
    assert.equal(await run([USDC, "-e", server.url], capture({ PHAROS_MCP_TOKEN: "custom-token" }).io), 0);
    assert.deepEqual(new Set(server.authorizations), new Set(["Bearer custom-token"]));

    server.authorizations.length = 0;
    assert.equal(await run([USDC, "-e", server.url], capture().io), 0);
    assert.deepEqual(new Set(server.authorizations), new Set([""]));
  });

  test("--save-output writes exactly the printed table, without colors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rcs-"));
    try {
      const file = join(dir, "sample-output", "live-run.txt");
      const c = capture({}, true);
      assert.equal(await run([USDC, "-e", server.url, "--save-output", file], c.io), 0);
      const saved = await readFile(file, "utf8");
      assert.ok(c.stdout().includes("\u001b["), "the terminal copy is colored");
      assert.ok(!saved.includes("\u001b"), "the saved copy is plain text");
      assert.equal(saved, c.stdout().replace(/\u001b\[\d+m/g, ""));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("degraded servers", () => {
  test("the Circle USDC label is withheld when the endpoint serves another chain", async () => {
    const server = await startFakePharosMcp({ ...chain, chainId: 1 });
    try {
      const { code, report } = await runJson([USDC, "-e", server.url]);
      assert.equal(code, 0);
      assert.deepEqual(report.contract, { address: USDC, label: "USD Coin (USDC) token contract", labelSource: "on-chain" });
      assert.ok(report.warnings.some((warning: string) => /serves chain ID 1, so it is labelled from its on-chain name/.test(warning)));
    } finally {
      await server.close();
    }
  });

  test("the Circle USDC label is withheld when the server does not offer get_chain_info", async () => {
    const server = await startFakePharosMcp({ ...chain, tools: ["get_block_number", "eth_call"] });
    try {
      const { code, report } = await runJson([USDC, "-e", server.url]);
      assert.equal(code, 0);
      assert.equal(report.network, null);
      assert.deepEqual(report.contract, { address: USDC, label: "USD Coin (USDC) token contract", labelSource: "on-chain" });
      assert.ok(report.warnings.some((warning: string) => /did not confirm the chain ID \(get_chain_info unavailable\)/.test(warning)));
    } finally {
      await server.close();
    }
  });

  test("the Circle USDC label is withheld when get_chain_info fails", async () => {
    const server = await startFakePharosMcp({ ...chain, chainInfoFails: true });
    try {
      const { code, report } = await runJson([USDC, "-e", server.url]);
      assert.equal(code, 0, "a failed get_chain_info must not fail the run");
      assert.equal(report.network, null);
      assert.equal(report.contract.labelSource, "on-chain");
      assert.equal(report.values.symbol, "USDC");
      assert.ok(report.warnings.some((warning: string) => /get_chain_info failed \(upstream unavailable\)/.test(warning)));
      assert.ok(report.warnings.some((warning: string) => /did not confirm the chain ID/.test(warning)));
    } finally {
      await server.close();
    }
  });

  test("the Circle USDC label is withheld when symbol() does not say USDC", async () => {
    const server = await startFakePharosMcp({ ...chain, contracts: { ...chain.contracts, [USDC.toLowerCase()]: erc20("Impostor", "FAKE", 6n, 1n) } });
    try {
      const { report } = await runJson([USDC, "-e", server.url]);
      assert.equal(report.contract.label, "Impostor (FAKE) token contract");
      assert.ok(report.warnings.some((warning: string) => /symbol\(\) returned "FAKE"/.test(warning)));
    } finally {
      await server.close();
    }
  });

  test("a lagging RPC node is retried at the same block, never at latest", async () => {
    const server = await startFakePharosMcp({ ...chain, transientEthCallFailures: 2 });
    try {
      const { code, report, stderr } = await runJson([USDC, "-e", server.url]);
      assert.equal(code, 0, stderr);
      assert.equal(report.blockNumber, "4242");
      assert.equal(report.retriedAtSameBlock.length, 2);
      assert.equal(report.values.totalSupply.formatted, "987654321");
      const blocks = server.calls.filter((call) => call.tool === "eth_call").map((call) => call.args.block);
      assert.equal(blocks.length, 6);
      assert.ok(blocks.every((block) => block === BLOCK_HEX));
    } finally {
      await server.close();
    }
  });

  test("a block the RPC cannot serve fails clearly instead of silently switching to latest", async () => {
    const server = await startFakePharosMcp({ ...chain, pinnedBlockUnavailable: true });
    try {
      const { code, report } = await runJson([USDC, "-e", server.url]);
      assert.equal(code, 5);
      assert.equal(report.error.kind, "MCP_TOOL_ERROR");
      assert.match(report.error.message, /at block 4242: header not found/);
      assert.ok(!server.calls.some((call) => call.args.block === "latest"));
    } finally {
      await server.close();
    }
  });

  test("a session the server forgot is reported as such, not as a wrong URL", async () => {
    const server = await startFakePharosMcp({ ...chain, dropSessionAfterToolCalls: 2 });
    try {
      const c = capture();
      assert.equal(await run([USDC, "-e", server.url], c.io), 3);
      assert.match(c.stderr(), /no longer recognizes this session \(HTTP 404: Unknown MCP session\)/);
      assert.doesNotMatch(c.stderr(), /No MCP endpoint/);
    } finally {
      await server.close();
    }
  });

  test("tools/list left unanswered, as seen live: the run never waits on it and reads all four values at one block", async () => {
    const server = await startFakePharosMcp({ ...chain, toolsList: "hang" });
    try {
      // A short timeout, so a regression that waits on tools/list fails in 2 s instead of hanging.
      const { code, report, stderr } = await runJson([USDC, "-e", server.url, "--timeout", "2000"]);
      assert.equal(code, 0, stderr);
      assert.ok(!server.methods.includes("tools/list"));
      assert.deepEqual(report.contract, { address: USDC, label: "Circle USDC Contract", labelSource: "known-address" });
      assert.deepEqual(report.network, { chainId: 1672, name: "Pharos Mainnet" });
      assert.deepEqual(report.values.totalSupply, { raw: "987654321000000", formatted: "987654321" });
      assert.equal(report.source.toolCalls, 6);
      const ethCalls = server.calls.filter((call) => call.tool === "eth_call");
      assert.deepEqual(ethCalls.map((call) => (call.args.transaction as { data: string }).data).sort(), Object.values(SEL).slice().sort());
      assert.deepEqual(ethCalls.map((call) => call.args.block), [BLOCK_HEX, BLOCK_HEX, BLOCK_HEX, BLOCK_HEX]);
    } finally {
      await server.close();
    }
  });

  test("a server that does not implement tools/list at all still gives a full read", async () => {
    const server = await startFakePharosMcp({ ...chain, toolsList: "unsupported" });
    try {
      const { code, report, stderr } = await runJson([USDC, "-e", server.url]);
      assert.equal(code, 0, stderr);
      assert.ok(!server.methods.includes("tools/list"));
      assert.equal(report.contract.label, "Circle USDC Contract");
      assert.equal(report.values.decimals, 6);
    } finally {
      await server.close();
    }
  });

  test("a server that stops answering once a GET event stream is open, as seen live, still gives a full read", async () => {
    const server = await startFakePharosMcp({ ...chain, getStreamStallsSession: true });
    try {
      // A short timeout, so a regression that opens the GET stream fails in 2 s instead of hanging.
      const { code, report, stderr } = await runJson([USDC, "-e", server.url, "--timeout", "2000"]);
      assert.equal(code, 0, stderr);
      assert.ok(!server.requests.some((method) => method.startsWith("GET")));
      assert.deepEqual(report.contract, { address: USDC, label: "Circle USDC Contract", labelSource: "known-address" });
      assert.deepEqual(report.network, { chainId: 1672, name: "Pharos Mainnet" });
      assert.deepEqual(report.values.totalSupply, { raw: "987654321000000", formatted: "987654321" });
      const ethCalls = server.calls.filter((call) => call.tool === "eth_call");
      assert.deepEqual(ethCalls.map((call) => (call.args.transaction as { data: string }).data).sort(), Object.values(SEL).slice().sort());
      assert.deepEqual(ethCalls.map((call) => call.args.block), [BLOCK_HEX, BLOCK_HEX, BLOCK_HEX, BLOCK_HEX]);
    } finally {
      await server.close();
    }
  });

  test("a server without get_block_number exits 4 from that call's own error, before any eth_call", async () => {
    const server = await startFakePharosMcp({ ...chain, tools: ["get_chain_info", "eth_call"] });
    try {
      const c = capture();
      assert.equal(await run([USDC, "-e", server.url], c.io), 4);
      assert.match(c.stderr(), /does not expose: get_block_number/);
      assert.ok(!server.calls.some((call) => call.tool === "eth_call"));
      assert.ok(!server.methods.includes("tools/list"));
    } finally {
      await server.close();
    }
  });

  test("an unknown-tool reply is not retried as if the RPC node were lagging", async () => {
    const server = await startFakePharosMcp({ ...chain, tools: ["get_chain_info", "get_block_number"] });
    try {
      const { code, report } = await runJson([USDC, "-e", server.url]);
      assert.equal(code, 4);
      assert.equal(report.error.kind, "MCP_TOOLS_MISSING");
      assert.equal(server.calls.filter((call) => call.tool === "eth_call").length, 4);
    } finally {
      await server.close();
    }
  });

  test("an unknown tool rejected with a JSON-RPC error (older MCP SDKs) also exits 4", async () => {
    const server = await startFakePharosMcp({ ...chain, tools: ["get_chain_info", "get_block_number"], unknownToolAsRpcError: true });
    try {
      const c = capture();
      assert.equal(await run([USDC, "-e", server.url], c.io), 4);
      assert.match(c.stderr(), /does not expose: eth_call/);
    } finally {
      await server.close();
    }
  });

  test("a server without eth_call exits 4", async () => {
    const server = await startFakePharosMcp({ ...chain, tools: ["get_block_number"] });
    try {
      const c = capture();
      assert.equal(await run([USDC, "-e", server.url], c.io), 4);
      assert.match(c.stderr(), /does not expose: eth_call/);
    } finally {
      await server.close();
    }
  });

  test("an unreachable endpoint exits 3", async () => {
    const port = await freePort();
    const { code, report } = await runJson([USDC, "-e", `http://127.0.0.1:${port}/mcp`]);
    assert.equal(code, 3);
    assert.equal(report.error.kind, "MCP_CONNECTION");
  });

  test("a bad address exits 2 before any network call", async () => {
    const c = capture();
    assert.equal(await run(["0x123", "-e", "http://127.0.0.1:9/mcp"], c.io), 2);
    assert.match(c.stderr(), /Not a valid EVM address/);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
