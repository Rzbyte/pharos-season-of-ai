// Tests for the Pharos Inspector: the shared input rules, inspector/inspect.js and GET /api/inspect.
// They need dist/ (built by `npm ci`):
//   node --test tests/inspector.test.mjs
// Everything runs against in-process fake MCP servers or a stubbed fetch; nothing reaches the network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { encodeAbiParameters, getAddress } from "viem";
import handler, { createHandler } from "../api/inspect.js";
import { readState } from "../api/state.js";
import { NO_CODE_TOOL_MESSAGE, NO_ERC20_MESSAGE, UNDETERMINED_MESSAGE, inspect } from "../inspector/inspect.js";
import { classifyInput, MAX_INPUT_LENGTH } from "../public/assets/inspect-input.js";
import { startFakePharosMcp } from "../dist/tests/fake-pharos-mcp.js";
import { ALL_TOOLS, startFakeInspectorMcp } from "./fake-inspector-mcp.mjs";

// Test fixtures only: made up, never used as proof.
const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const BLOCK = 4242n;
const BLOCK_HEX = "0x1092";
const SEL = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" };
const str = (value) => encodeAbiParameters([{ type: "string" }], [value]);
const uint = (value) => encodeAbiParameters([{ type: "uint256" }], [value]);
const bool = (value) => encodeAbiParameters([{ type: "bool" }], [value]);
const addr = (digit) => `0x${digit.repeat(40)}`;
const hash = (digit) => `0x${digit.repeat(64)}`;
const erc20 = (overrides = {}) => ({
  [SEL.name]: str("USDC"),
  [SEL.symbol]: str("USDC"),
  [SEL.decimals]: uint(6n),
  [SEL.totalSupply]: uint(20_262_168_134_328n),
  ...overrides,
});

const PARTIAL = addr("1"); // name only, symbol reverts, decimals returns nothing, totalSupply reverts
const NONE = addr("2"); // a contract that is not an ERC-20: it has code, and every standard call reverts
const NO_DECIMALS = addr("3");
const NO_SUPPLY = addr("4");
const FLAKY = addr("5"); // totalSupply fails once with a transient RPC error
const HANGS = addr("6");
const HOSTILE = addr("7"); // a name made to spoof the page
const WALLET = addr("8"); // no code: a wallet-like address with a balance and a nonce
const EMPTY = addr("9"); // no code, nothing held, nothing sent
const NO_CODE_CHECK = addr("a"); // get_code keeps failing
const FLAKY_CODE = addr("b"); // get_code fails once, then answers "no code"; its balance read fails once too

const MINED = {
  hash: hash("a"),
  blockNumber: "0x1090",
  from: "0x00000000000000000000000000000000000000aa",
  to: "0x00000000000000000000000000000000000000bb",
  value: "0x14d1120d7b160000", // 1.5 PROS
  gas: "0x5208",
  nonce: "0x7",
  input: "0x",
};
const RECEIPT = { transactionHash: hash("a"), blockNumber: "0x1090", from: MINED.from, to: MINED.to, status: "0x1", gasUsed: "0x5208", logs: [{}, {}], contractAddress: null };

const chain = {
  blockNumber: BLOCK,
  contracts: {
    [USDC.toLowerCase()]: erc20(),
    [PARTIAL]: { [SEL.name]: str("Partial Token"), [SEL.symbol]: { revert: "execution reverted" }, [SEL.decimals]: "0x", [SEL.totalSupply]: { revert: "execution reverted" } },
    [NO_DECIMALS]: erc20({ [SEL.decimals]: { revert: "execution reverted" } }),
    [NO_SUPPLY]: erc20({ [SEL.totalSupply]: { revert: "execution reverted" } }),
    [FLAKY]: erc20({ [SEL.totalSupply]: { failTimes: 1, then: uint(5_000_000n) } }),
    [HANGS]: erc20({ [SEL.name]: { hang: true } }),
    [HOSTILE]: erc20({ [SEL.name]: str(`Safe‮token\u0007${"x".repeat(200)}`) }),
    [NONE]: {},
  },
  code: { [NO_CODE_CHECK]: { rpcError: "upstream unavailable" }, [FLAKY_CODE]: { failTimes: 1, then: "0x" } },
  accounts: {
    [WALLET]: { balance: 1_500_000_000_000_000_000n, nonce: 37n },
    [FLAKY_CODE]: { balance: { failTimes: 1, then: 2_000_000_000_000_000_000n }, nonce: 4n },
  },
  transactions: {
    [hash("a")]: { tx: MINED, receipt: RECEIPT },
    [hash("b")]: { tx: { ...MINED, hash: hash("b"), blockNumber: null }, receipt: null }, // pending
    [hash("c")]: { tx: { ...MINED, hash: hash("c") }, receipt: { rpcError: "receipt backend unavailable" } },
    [hash("d")]: { tx: { ...MINED, hash: hash("d") }, receipt: { ...RECEIPT, transactionHash: hash("d"), status: "0x0", logs: [] } },
    [hash("e")]: { tx: { ...MINED, hash: hash("e"), to: null }, receipt: { ...RECEIPT, transactionHash: hash("e"), to: null, contractAddress: "0x00000000000000000000000000000000000000cc" } },
    [hash("f")]: { tx: { rpcError: "upstream down" }, receipt: { rpcError: "upstream down" } },
  },
};

const ethCalls = (server) => server.calls.filter((call) => call.tool === "eth_call");
/** The tools an inspection called, in order, each with the block it was pinned to. */
const toolLog = (server) => server.calls.map((call) => (call.args.block ? `${call.tool}@${call.args.block}` : call.tool));

describe("input rules (shared by the page and /api/inspect)", () => {
  test("a 40-hex value is an address, in any letter case; surrounding whitespace is ignored", () => {
    // An address, not a contract: only its code, read on the server, says which it is.
    for (const value of [USDC, USDC.toLowerCase(), `0x${USDC.slice(2).toUpperCase()}`]) {
      assert.deepEqual(classifyInput(`  ${value}\n`), { ok: true, kind: "address", value });
    }
    assert.equal(classifyInput("").message, "Paste an address or a transaction hash.");
  });

  test("a 64-hex hash is a transaction, in any letter case, normalized to lowercase", () => {
    assert.deepEqual(classifyInput(hash("A")), { ok: true, kind: "transaction", value: hash("a") });
    assert.deepEqual(classifyInput(` ${hash("f")} `), { ok: true, kind: "transaction", value: hash("f") });
  });

  test("wrong lengths are rejected with the count, never sent anywhere", () => {
    for (const length of [0, 1, 39, 41, 63, 65]) {
      const result = classifyInput(`0x${"a".repeat(length)}`);
      assert.equal(result.ok, false, String(length));
      assert.match(result.message, length === 0 ? /0 hex characters/ : new RegExp(`${length} hex characters`));
    }
    assert.equal(classifyInput("").ok, false);
    assert.equal(classifyInput(undefined).ok, false);
    assert.equal(classifyInput(null).ok, false);
  });

  test("non-hex characters and a missing or uppercase 0x prefix are rejected", () => {
    assert.match(classifyInput(`0x${"g".repeat(40)}`).message, /only hex characters/);
    assert.match(classifyInput(`0x${"a".repeat(20)} ${"a".repeat(19)}`).message, /only hex characters/);
    assert.match(classifyInput("a".repeat(40)).message, /must start with 0x/);
    assert.match(classifyInput(`0X${"a".repeat(40)}`).message, /must start with 0x/);
  });

  test("HTML or script-like input is rejected, and no message repeats it", () => {
    const hostile = [
      "<script>alert(1)</script>",
      `0x<img src=x onerror=alert(1)>${"a".repeat(10)}`,
      "javascript:alert(document.cookie)",
      `0x${"a".repeat(38)}"><`,
      `${"0x".padEnd(42, "a")}<svg/onload=alert(1)>`,
      "x".repeat(10_000),
    ];
    for (const value of hostile) {
      const result = classifyInput(value);
      assert.equal(result.ok, false, value.slice(0, 40));
      assert.doesNotMatch(result.message, /[<>"]|script|alert|onerror|javascript/i);
    }
    assert.match(classifyInput("x".repeat(MAX_INPUT_LENGTH + 1)).message, new RegExp(`${MAX_INPUT_LENGTH + 1} characters long`));
  });
});

describe("contract mode against a fake Pharos Chain MCP", () => {
  let server;
  before(async () => {
    server = await startFakeInspectorMcp(chain);
  });
  after(async () => {
    await server.close();
  });
  const run = (value, options = {}) => inspect(value, { endpoint: server.url, retryDelayMs: 5, ...options });

  test("full ERC-20: four reads at one explicit block, decimals applied", async () => {
    server.calls.length = 0;
    const { status, body } = await run(USDC);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.kind, "contract");
    assert.equal(body.status, "success");
    assert.equal(body.address, USDC);
    assert.equal(body.blockNumber, "4242");
    assert.deepEqual(body.network, { chainId: 1672, name: "Pharos Mainnet", nativeSymbol: "PROS" });
    assert.deepEqual(body.state, {
      name: { ok: true, value: "USDC" },
      symbol: { ok: true, value: "USDC" },
      decimals: { ok: true, value: 6 },
      totalSupply: { ok: true, raw: "20262168134328", formatted: "20,262,168.134328", display: "20,262,168.134328 USDC" },
    });
    assert.equal(body.message, null);
    // The code check first, at the block, then the four reads at that same block: seven tool calls.
    assert.deepEqual(body.source, { via: "Pharos Chain MCP", endpoint: server.url, server: "fake-pharos-mcp 0.0.0", toolCalls: 7 });
    assert.deepEqual(toolLog(server).slice(2), [`get_code@${BLOCK_HEX}`, ...Array(4).fill(`eth_call@${BLOCK_HEX}`)]);
    assert.deepEqual(ethCalls(server).map((call) => call.args.block), [BLOCK_HEX, BLOCK_HEX, BLOCK_HEX, BLOCK_HEX]);
    assert.deepEqual(ethCalls(server).map((call) => call.args.transaction.data).sort(), Object.values(SEL).sort());
  });

  test("partial support: what succeeded is shown, the rest is marked unavailable with a reason", async () => {
    const { status, body } = await run(PARTIAL);
    assert.equal(status, 200);
    assert.equal(body.status, "partial");
    assert.deepEqual(body.state, {
      name: { ok: true, value: "Partial Token" },
      symbol: { ok: false, reason: "reverted" },
      decimals: { ok: false, reason: "no data returned" },
      totalSupply: { ok: false, reason: "reverted" },
    });
    assert.equal(body.message, null);
  });

  test("a contract whose four reads all fail on the server is partial, each failure shown: never called a non-token", async () => {
    const failing = await startFakeInspectorMcp({ ...chain, contracts: { [USDC.toLowerCase()]: Object.fromEntries(Object.values(SEL).map((selector) => [selector, { rpcError: "header not found" }])) } });
    try {
      const { status, body, shareable } = await inspect(USDC, { endpoint: failing.url, retryDelayMs: 5 });
      assert.equal(status, 200);
      assert.deepEqual([body.kind, body.status, body.message], ["contract", "partial", null]);
      for (const entry of Object.values(body.state)) assert.deepEqual(entry, { ok: false, reason: "failed: header not found" });
      assert.equal(shareable, false, "a failed read is never shared from a cache");
    } finally {
      await failing.close();
    }
  });

  test("a contract with code but no ERC-20 methods: still a contract, described without blame", async () => {
    const { status, body } = await run(NONE);
    assert.equal(status, 200);
    assert.deepEqual([body.kind, body.status], ["contract", "none"]);
    assert.equal(body.message, NO_ERC20_MESSAGE);
    assert.equal(NO_ERC20_MESSAGE, "This contract's standard ERC-20 metadata (name, symbol, decimals and totalSupply) was not available. Many contracts are not ERC-20 tokens, so this does not mean anything is wrong with it.");
    assert.doesNotMatch(NO_ERC20_MESSAGE, /invalid|unsafe|broken|scam/i);
    for (const entry of Object.values(body.state)) assert.deepEqual(entry, { ok: false, reason: "reverted" });
  });

  test("decimals unavailable: totalSupply is shown raw, never with guessed decimals", async () => {
    const { body } = await run(NO_DECIMALS);
    assert.equal(body.status, "partial");
    assert.deepEqual(body.state.decimals, { ok: false, reason: "reverted" });
    assert.deepEqual(body.state.totalSupply, { ok: true, raw: "20262168134328", formatted: null, display: null });
  });

  test("totalSupply unavailable: the other three are still shown", async () => {
    const { body } = await run(NO_SUPPLY);
    assert.equal(body.status, "partial");
    assert.deepEqual(body.state.totalSupply, { ok: false, reason: "reverted" });
    assert.equal(body.state.decimals.value, 6);
  });

  test("a transient failure is retried once at the SAME block; every read is pinned to it", async () => {
    server.calls.length = 0;
    const { body } = await run(FLAKY);
    assert.equal(body.status, "success");
    assert.deepEqual(body.retriedAtSameBlock, ["totalSupply"]);
    assert.equal(body.state.totalSupply.formatted, "5");
    assert.equal(ethCalls(server).length, 5);
    assert.ok(ethCalls(server).every((call) => call.args.block === BLOCK_HEX));
  });

  test("an MCP timeout ends in a clean 502 error, not a hang or a crash", async () => {
    const { status, body } = await run(HANGS, { timeoutMs: 300 });
    assert.equal(status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, "MCP_CONNECTION");
    assert.match(body.error.message, /No response from the MCP server within 300 ms/);
  });

  test("the whole inspection has a deadline", async () => {
    const { status, body } = await run(HANGS, { timeoutMs: 5_000, deadlineMs: 400 });
    assert.equal(status, 502);
    assert.match(body.error.message, /The inspection did not finish within 400 ms and was stopped\./);
  });

  test("on-chain text is cleaned: control and bidi characters replaced, length capped", async () => {
    const { body } = await run(HOSTILE);
    const name = body.state.name.value;
    assert.doesNotMatch(name, /[\u0000-\u001f‮]/);
    assert.ok([...name].length <= 83, String([...name].length));
  });

  test("a mixed-case address whose checksum does not match gets a warning, and is still read", async () => {
    const wrongCase = USDC.replace("dB60", "DB60");
    const { body } = await run(wrongCase);
    assert.equal(body.status, "success");
    assert.equal(body.address, USDC);
    assert.match(body.warnings.join(" "), /EIP-55 checksum/);
    const { body: lower } = await run(USDC.toLowerCase());
    assert.deepEqual(lower.warnings, []);
  });
});

describe("address classification: get_code at the block decides what is read", () => {
  let server;
  before(async () => {
    server = await startFakeInspectorMcp(chain);
  });
  after(async () => {
    await server.close();
  });
  const run = async (value, options = {}) => {
    server.calls.length = 0;
    return inspect(value, { endpoint: server.url, retryDelayMs: 5, ...options });
  };

  test("no contract code: a wallet-like address with its native balance and nonce, and no eth_call", async () => {
    const { status, body } = await run(WALLET);
    assert.equal(status, 200);
    assert.deepEqual([body.ok, body.kind, body.status], [true, "wallet-like", "success"]);
    assert.equal(body.address, getAddress(WALLET));
    assert.equal(body.blockNumber, "4242");
    assert.deepEqual(body.network, { chainId: 1672, name: "Pharos Mainnet", nativeSymbol: "PROS" });
    // PROS is the network's own currency: an amount in wei, shown with 18 decimals, never an ERC-20 balance.
    assert.deepEqual(body.state, { balance: { ok: true, wei: "1500000000000000000", display: "1.5 PROS" }, nonce: { ok: true, value: "37" } });
    assert.deepEqual([body.message, body.retriedAtSameBlock, body.warnings], [null, [], []]);
    assert.equal(body.source.toolCalls, 5);
    assert.deepEqual(toolLog(server), ["get_block_number", "get_chain_info", `get_code@${BLOCK_HEX}`, `get_balance@${BLOCK_HEX}`, `get_transaction_count@${BLOCK_HEX}`]);
    assert.deepEqual(ethCalls(server), [], "no ERC-20 read for a confirmed wallet-like address");
    assert.ok(!("name" in body.state) && !("totalSupply" in body.state));
  });

  test("a zero balance and no transactions sent are values, not failures", async () => {
    const { body } = await run(EMPTY);
    assert.deepEqual([body.kind, body.status], ["wallet-like", "success"]);
    assert.deepEqual(body.state, { balance: { ok: true, wei: "0", display: "0 PROS" }, nonce: { ok: true, value: "0" } });
    assert.deepEqual(ethCalls(server), []);
  });

  test("contract code: the four ERC-20 reads follow at the same block, and no balance or nonce read", async () => {
    const { body } = await run(USDC);
    assert.deepEqual([body.kind, body.status], ["contract", "success"]);
    assert.deepEqual(toolLog(server).filter((call) => !call.startsWith("eth_call")), ["get_block_number", "get_chain_info", `get_code@${BLOCK_HEX}`]);
    assert.equal(ethCalls(server).length, 4);
  });

  test("the code check failing: the type is not determined, nothing is guessed, and nothing else is read", async () => {
    const { status, body } = await run(NO_CODE_CHECK);
    assert.equal(status, 200);
    assert.deepEqual([body.ok, body.kind, body.status], [true, "address", "undetermined"]);
    assert.equal(body.reason, "get_code failed: upstream unavailable.");
    assert.equal(body.message, UNDETERMINED_MESSAGE);
    assert.match(UNDETERMINED_MESSAGE, /does not say whether this is a contract or a wallet-like address/);
    assert.ok(!("state" in body), "no balance, nonce or ERC-20 value");
    // One retry of the code check at the same block, then nothing else.
    assert.deepEqual(body.retriedAtSameBlock, ["code"]);
    assert.deepEqual(toolLog(server), ["get_block_number", "get_chain_info", `get_code@${BLOCK_HEX}`, `get_code@${BLOCK_HEX}`]);
  });

  test("a code check that fails once is retried at the same block; a wallet read that fails once is too", async () => {
    const { body } = await run(FLAKY_CODE);
    assert.deepEqual([body.kind, body.status], ["wallet-like", "success"]);
    assert.deepEqual(body.retriedAtSameBlock, ["code", "balance"]);
    assert.equal(body.state.balance.display, "2 PROS");
    assert.ok(server.calls.every((call) => !("block" in call.args) || call.args.block === BLOCK_HEX), "every read at the one block");
  });

  test("a wallet read that keeps failing leaves that value unavailable, with the reason; the rest stays", async () => {
    const failing = await startFakeInspectorMcp({ ...chain, accounts: { [WALLET]: { balance: { rpcError: "balance backend down" }, nonce: 37n } } });
    try {
      const { body } = await inspect(WALLET, { endpoint: failing.url, retryDelayMs: 5 });
      assert.deepEqual([body.kind, body.status], ["wallet-like", "partial"]);
      assert.deepEqual(body.state, { balance: { ok: false, reason: "failed: balance backend down" }, nonce: { ok: true, value: "37" } });
      assert.deepEqual(ethCalls(failing), []);
    } finally {
      await failing.close();
    }
  });

  test("a server without get_code: the type is not determined, said plainly; without balance or nonce tools, those are unavailable", async () => {
    const noCode = await startFakeInspectorMcp({ ...chain, tools: ALL_TOOLS.filter((tool) => tool !== "get_code") });
    const noAccount = await startFakeInspectorMcp({ ...chain, tools: ALL_TOOLS.filter((tool) => tool !== "get_balance" && tool !== "get_transaction_count") });
    try {
      const undetermined = (await inspect(WALLET, { endpoint: noCode.url, retryDelayMs: 5 })).body;
      assert.deepEqual([undetermined.kind, undetermined.status, undetermined.reason], ["address", "undetermined", "This Pharos Chain MCP server does not offer get_code."]);
      // A tool the server does not offer will not appear on a retry: the note says so, and does not ask for one.
      assert.equal(undetermined.message, NO_CODE_TOOL_MESSAGE);
      assert.doesNotMatch(NO_CODE_TOOL_MESSAGE, /again/);
      assert.deepEqual(noCode.calls.map((call) => call.tool), ["get_block_number", "get_chain_info", "get_code"]);
      const partial = (await inspect(WALLET, { endpoint: noAccount.url, retryDelayMs: 5 })).body;
      assert.deepEqual([partial.kind, partial.status], ["wallet-like", "partial"]);
      assert.deepEqual(partial.state, { balance: { ok: false, reason: "not offered by this Pharos Chain MCP server" }, nonce: { ok: false, reason: "not offered by this Pharos Chain MCP server" } });
      assert.deepEqual(ethCalls(noAccount), []);
    } finally {
      await noCode.close();
      await noAccount.close();
    }
  });

  test("a malformed code answer is not read as code or as no code", async () => {
    for (const code of [42, "0xabc", "6080", null]) {
      const odd = await startFakeInspectorMcp({ ...chain, code: { [WALLET]: code === null ? { rpcError: "x" } : code } });
      try {
        const { body } = await inspect(WALLET, { endpoint: odd.url, retryDelayMs: 5 });
        assert.deepEqual([body.kind, body.status], ["address", "undetermined"], String(code));
        if (code !== null) assert.equal(body.reason, "get_code failed: its answer was not bytecode.");
        assert.deepEqual(ethCalls(odd), []);
      } finally {
        await odd.close();
      }
    }
  });

  test("without a confirmed network, a balance stays in wei rather than taking a guessed currency name", async () => {
    const unconfirmed = await startFakeInspectorMcp({ ...chain, chainInfo: "fail" });
    try {
      const { body } = await inspect(WALLET, { endpoint: unconfirmed.url, retryDelayMs: 5 });
      assert.equal(body.network, null);
      assert.deepEqual(body.state.balance, { ok: true, wei: "1500000000000000000", display: "1500000000000000000 wei" });
      assert.match(body.warnings.join(" "), /network is not confirmed/);
    } finally {
      await unconfirmed.close();
    }
  });

  test("a connection lost during the code check is an error (502), never a guess", async () => {
    const hanging = await startFakeInspectorMcp({ ...chain, code: { [WALLET]: { hang: true } } });
    try {
      const { status, body } = await inspect(WALLET, { endpoint: hanging.url, timeoutMs: 300, retryDelayMs: 5 });
      assert.equal(status, 502);
      assert.equal(body.error.kind, "MCP_CONNECTION");
      assert.equal(body.kind, "address");
      assert.equal(body.error.hint, "Pharos Chain MCP could not be reached or did not answer in time. Try again in a moment.");
    } finally {
      await hanging.close();
    }
  });
});

describe("contract mode: MCP errors", () => {
  test("get_block_number failing is an MCP tool error (502)", async () => {
    const server = await startFakeInspectorMcp({ ...chain, blockNumberFails: true });
    try {
      const { status, body } = await inspect(USDC, { endpoint: server.url });
      assert.equal(status, 502);
      assert.equal(body.error.kind, "MCP_TOOL_ERROR");
      assert.match(body.error.message, /get_block_number failed: upstream unavailable/);
    } finally {
      await server.close();
    }
  });

  test("a server without eth_call: contract reads are unavailable, said plainly", async () => {
    const server = await startFakeInspectorMcp({ ...chain, tools: ALL_TOOLS.filter((tool) => tool !== "eth_call") });
    try {
      const { status, body } = await inspect(USDC, { endpoint: server.url });
      assert.equal(status, 502);
      assert.equal(body.error.kind, "MCP_TOOLS_MISSING");
      assert.equal(body.error.message, "Contract reads are not available: this Pharos Chain MCP server does not offer eth_call.");
    } finally {
      await server.close();
    }
  });

  test("get_chain_info failing is only a warning: network unconfirmed, state still read", async () => {
    const server = await startFakeInspectorMcp({ ...chain, chainInfo: "fail" });
    try {
      const { status, body } = await inspect(USDC, { endpoint: server.url });
      assert.equal(status, 200);
      assert.equal(body.network, null);
      assert.match(body.warnings.join(" "), /network is not confirmed/);
      assert.equal(body.status, "success");
    } finally {
      await server.close();
    }
  });

  test("an unreachable MCP endpoint is a connection error (502)", async () => {
    const { status, body } = await inspect(USDC, { endpoint: "http://127.0.0.1:9/mcp", timeoutMs: 2_000 });
    assert.equal(status, 502);
    assert.equal(body.error.kind, "MCP_CONNECTION");
  });
});

describe("transaction mode against a fake Pharos Chain MCP", () => {
  let server;
  before(async () => {
    server = await startFakeInspectorMcp(chain);
  });
  after(async () => {
    await server.close();
  });
  const run = (value, options = {}) => inspect(value, { endpoint: server.url, ...options });

  test("a mined transaction: only fields MCP returned, decoded", async () => {
    server.calls.length = 0;
    const { status, body } = await run(hash("A"));
    assert.equal(status, 200);
    assert.equal(body.kind, "transaction");
    assert.equal(body.status, "success");
    assert.deepEqual(body.transaction, {
      hash: hash("a"),
      status: "success",
      blockNumber: "4240",
      from: getAddress(MINED.from),
      to: getAddress(MINED.to),
      contractCreation: null,
      value: { wei: "1500000000000000000", display: "1.5 PROS" },
      gasLimit: "21000",
      gasUsed: "21000",
      logs: 2,
    });
    assert.deepEqual(body.notes, []);
    assert.deepEqual(server.calls.map((call) => call.tool).sort(), ["get_chain_info", "get_transaction", "get_transaction_receipt"]);
    assert.ok(server.calls.filter((call) => call.tool !== "get_chain_info").every((call) => call.args.hash === hash("a")));
  });

  test("an unknown hash is a clean not-found, not an error", async () => {
    const { status, body } = await run(hash("9"));
    assert.equal(status, 200);
    assert.equal(body.status, "not-found");
    assert.equal(body.transaction, null);
  });

  test("a pending transaction (no receipt yet) is partial: status pending, no invented block, gas used or logs", async () => {
    const { body } = await run(hash("b"));
    assert.equal(body.status, "partial");
    assert.equal(body.transaction.status, "pending");
    assert.equal(body.transaction.blockNumber, null);
    assert.equal(body.transaction.gasUsed, null);
    assert.equal(body.transaction.logs, null);
    assert.match(body.notes.join(" "), /No receipt yet/);
  });

  test("a receipt failure leaves the transaction fields and says what is missing", async () => {
    const { status, body } = await run(hash("c"));
    assert.equal(status, 200);
    assert.equal(body.status, "partial");
    assert.equal(body.transaction.status, null);
    assert.equal(body.transaction.gasLimit, "21000");
    assert.match(body.notes.join(" "), /get_transaction_receipt failed: receipt backend unavailable/);
  });

  test("a reverted transaction reads as failed; a contract creation shows the created address", async () => {
    assert.equal((await run(hash("d"))).body.transaction.status, "failed");
    const creation = (await run(hash("e"))).body.transaction;
    assert.equal(creation.to, null);
    assert.deepEqual(creation.contractCreation, { address: getAddress("0x00000000000000000000000000000000000000cc") });
  });

  test("both lookups failing is an MCP error (502)", async () => {
    const { status, body } = await run(hash("f"));
    assert.equal(status, 502);
    assert.equal(body.error.kind, "MCP_TOOL_ERROR");
    assert.match(body.error.message, /get_transaction failed: upstream down/);
  });

  test("a server without transaction tools: transaction lookup is unavailable, said plainly", async () => {
    const bare = await startFakeInspectorMcp({ ...chain, tools: ["get_chain_info", "get_block_number", "eth_call"] });
    try {
      const { status, body } = await inspect(hash("a"), { endpoint: bare.url });
      assert.equal(status, 502);
      assert.equal(body.error.kind, "MCP_TOOLS_MISSING");
      assert.match(body.error.message, /Transaction lookup is not available/);
    } finally {
      await bare.close();
    }
  });
});

describe("GET /api/inspect", () => {
  let server;
  before(async () => {
    server = await startFakeInspectorMcp(chain);
  });
  after(async () => {
    await server.close();
  });

  /** Call a handler with the minimum of Node's request/response it uses. */
  function call(handlerFn, url, method = "GET") {
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
      handlerFn({ method, url }, res);
    });
  }

  test("answers only GET", async () => {
    const { status, headers, body } = await call(createHandler(server.url), `/api/inspect?q=${USDC}`, "POST");
    assert.equal(status, 405);
    assert.equal(headers.allow, "GET");
    assert.equal(body.ok, false);
  });

  test("invalid input is a 400 and never reaches MCP; the input is not echoed", async () => {
    const before = server.httpRequests();
    for (const q of ["", "0x123", "<script>alert(1)</script>", `0x${"z".repeat(40)}`]) {
      const { status, headers, body } = await call(createHandler(server.url), `/api/inspect?q=${encodeURIComponent(q)}`);
      assert.equal(status, 400, q);
      assert.equal(headers["cache-control"], "no-store");
      assert.equal(body.error.kind, "INVALID_INPUT");
      assert.ok(!JSON.stringify(body).includes("script"));
    }
    assert.equal((await call(createHandler(server.url), "/api/inspect")).status, 400);
    assert.equal(server.httpRequests(), before, "no MCP request was made for invalid input");
  });

  test("only a complete answer is cached: never an undetermined address or a result in which a read failed", async () => {
    const shared = "public, s-maxage=15, stale-while-revalidate=45";
    const { status, headers, body } = await call(createHandler(server.url), `/api/inspect?q=${NO_CODE_CHECK}`);
    assert.deepEqual([status, body.status, headers["cache-control"]], [200, "undetermined", "no-store"]);
    const wallet = await call(createHandler(server.url), `/api/inspect?q=${WALLET}`);
    assert.deepEqual([wallet.body.kind, wallet.headers["cache-control"]], ["wallet-like", shared]);
    // A contract's own answers (a revert, no data) are facts, and may be shared; a read that failed is not.
    const partial = await call(createHandler(server.url), `/api/inspect?q=${PARTIAL}`);
    assert.deepEqual([partial.body.status, partial.headers["cache-control"]], ["partial", shared]);
    const failing = await startFakeInspectorMcp({ ...chain, accounts: { [WALLET]: { balance: { rpcError: "balance backend down" }, nonce: 37n } } });
    try {
      const unread = await call(createHandler(failing.url, { retryDelayMs: 5 }), `/api/inspect?q=${WALLET}`);
      assert.deepEqual([unread.body.status, unread.headers["cache-control"]], ["partial", "no-store"]);
      const receipt = await call(createHandler(server.url), `/api/inspect?q=${hash("c")}`);
      assert.deepEqual([receipt.body.status, receipt.headers["cache-control"]], ["partial", "no-store"], "a receipt that failed to load");
    } finally {
      await failing.close();
    }
  });

  test("a good read is JSON, shared briefly; a not-found is never cached", async () => {
    const good = await call(createHandler(server.url), `/api/inspect?q=${USDC}`);
    assert.equal(good.status, 200);
    assert.equal(good.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(good.headers["cache-control"], "public, s-maxage=15, stale-while-revalidate=45");
    assert.equal(good.headers["x-content-type-options"], "nosniff");
    assert.equal(good.body.state.totalSupply.display, "20,262,168.134328 USDC");
    const missing = await call(createHandler(server.url), `/api/inspect?q=${hash("9")}`);
    assert.equal(missing.status, 200);
    assert.equal(missing.headers["cache-control"], "no-store");
  });

  test("the deployed handler always targets the hosted endpoint without a token, whatever the environment says", async () => {
    const saved = { PHAROS_MCP_URL: process.env.PHAROS_MCP_URL, PHAROS_MCP_TOKEN: process.env.PHAROS_MCP_TOKEN };
    process.env.PHAROS_MCP_URL = "http://127.0.0.1:9/elsewhere";
    process.env.PHAROS_MCP_TOKEN = "must-not-be-sent";
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (input, init) => {
      sent.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return new Response("unavailable in tests", { status: 503 });
    };
    try {
      const { status, headers, body } = await call(handler, `/api/inspect?q=${USDC}`);
      assert.ok(sent.length > 0);
      assert.ok(sent.every((request) => request.url === "https://mcp.pharos.xyz/mcp"), JSON.stringify(sent));
      assert.ok(sent.every((request) => request.authorization === null));
      assert.equal(status, 502);
      assert.equal(headers["cache-control"], "no-store");
      assert.equal(body.error.kind, "MCP_CONNECTION");
      assert.ok(!JSON.stringify(body).includes("must-not-be-sent"));
    } finally {
      globalThis.fetch = realFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("regression: the Task 01 proof is untouched and cannot be broken by the inspector", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  test("an inspector failure does not affect a concurrent /api/state read", async () => {
    const task01 = await startFakePharosMcp({
      blockNumber: BLOCK,
      // /api/state also reads paused() (0x5c975abb) of the Task 01 contract; the Inspector never does.
      contracts: { [USDC.toLowerCase()]: { [SEL.name]: str("USDC"), [SEL.symbol]: str("USDC"), [SEL.decimals]: uint(6n), [SEL.totalSupply]: uint(123_456_789_012_345n), "0x5c975abb": bool(false) } },
    });
    const hanging = await startFakeInspectorMcp({ ...chain, contracts: { [USDC.toLowerCase()]: erc20({ [SEL.name]: { hang: true } }) } });
    try {
      const [state, deadInspect, hangingInspect] = await Promise.all([
        readState(task01.url),
        inspect(USDC, { endpoint: "http://127.0.0.1:9/mcp", timeoutMs: 1_000 }),
        inspect(USDC, { endpoint: hanging.url, timeoutMs: 300 }),
      ]);
      assert.equal(deadInspect.status, 502);
      assert.equal(hangingInspect.status, 502);
      assert.equal(state.status, 200);
      assert.equal(state.body.display.totalSupply, "123,456,789.012345 USDC");
      assert.equal(state.body.values.paused, false);
    } finally {
      await task01.close();
      await hanging.close();
    }
  });

  test("the two endpoints share no code path: api/state.js does not know the inspector", () => {
    assert.doesNotMatch(read("api/state.js"), /inspect/i);
    assert.doesNotMatch(read("inspector/inspect.js"), /from ["'][^"']*api\/state|readState/);
    assert.doesNotMatch(read("api/inspect.js"), /from ["'][^"']*api\/state|readState/);
    assert.match(read("vercel.json"), /"api\/state\.js": \{ "maxDuration": 60 \}/);
  });

  test("no direct JSON-RPC: the inspector reads only through the MCP client, and no dependency was added", () => {
    const sources = ["inspector/inspect.js", "api/inspect.js", "public/assets/inspect-input.js", "public/assets/inspector.js"].map((path) => [path, read(path)]);
    for (const [path, text] of sources) {
      assert.doesNotMatch(text, /createPublicClient|createWalletClient|createClient|webSocket\(|\bhttp\(|jsonrpc|eth_getTransaction|eth_blockNumber|eth_getLogs|XMLHttpRequest|WebSocket/, path);
      assert.doesNotMatch(text, /mcp\.pharos\.xyz|https?:\/\/(?!localhost)/, path);
    }
    assert.doesNotMatch(read("inspector/inspect.js"), /\bfetch\(/);
    assert.match(read("inspector/inspect.js"), /from "\.\.\/dist\/src\/mcp-client\.js"/);
    assert.deepEqual(JSON.parse(read("package.json")).dependencies, { "@modelcontextprotocol/sdk": "1.32.1", viem: "2.57.5" });
  });
});
