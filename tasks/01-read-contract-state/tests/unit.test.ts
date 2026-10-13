import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { encodeAbiParameters, stringToHex, type Hex } from "viem";
import { HOSTED_ENDPOINT } from "../src/constants.js";
import {
  CALLDATA,
  decodeDecimalsReturn,
  decodeStringReturn,
  decodeUint256Return,
  EmptyReturnError,
  MalformedReturnError,
  readTokenState,
} from "../src/erc20.js";
import { CliError, isUnknownToolMessage, missingToolError, toTransportError, ToolCallError } from "../src/errors.js";
import { formatTokenAmount, groupDigits, sanitizeForTerminal, wrapText } from "../src/format.js";
import { McpRecorder, parseToolPayload, type ToolCaller } from "../src/mcp-client.js";
import { applyLiveRun, evidenceFromRun, MARKERS } from "../src/readme-proof.js";
import { bearerTokenFor } from "../src/run.js";
import { buildTranscript } from "../src/transcript.js";

const ENDPOINT = new URL(HOSTED_ENDPOINT);
const uint = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);
const str = (value: string) => encodeAbiParameters([{ type: "string" }], [value]);

describe("formatting", () => {
  test("groups digits without float rounding", () => {
    assert.equal(groupDigits("1234567"), "1,234,567");
    assert.equal(groupDigits("123"), "123");
    assert.equal(groupDigits("123456789012345678901234567890"), "123,456,789,012,345,678,901,234,567,890");
  });

  test("applies token decimals exactly", () => {
    assert.equal(formatTokenAmount(48_213_906_551_270n, 6), "48,213,906.55127");
    assert.equal(formatTokenAmount(1n, 18), "0.000000000000000001");
    assert.equal(formatTokenAmount(10n ** 24n, 18), "1,000,000");
    assert.equal(formatTokenAmount(1_234n, 0), "1,234");
    assert.equal(formatTokenAmount(0n, 6), "0");
  });

  test("neutralizes control, zero-width and bidi characters", () => {
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const cleaned = sanitizeForTerminal(`\u001b[31mRed\u0007${rlo}${zwsp}x`);
    assert.ok(!/[\u0000-\u001f]/.test(cleaned));
    assert.ok(!cleaned.includes(rlo) && !cleaned.includes(zwsp));
    assert.match(cleaned, /Red/);
    assert.equal(sanitizeForTerminal("a".repeat(10), 4), "aaaa...");
  });

  test("wraps prose", () => {
    assert.equal(wrapText("one two three four", 9, ""), "one two\nthree\nfour");
  });
});

describe("ABI decoding", () => {
  test("calldata is exactly the four ERC-20 selectors", () => {
    assert.deepEqual(CALLDATA, { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" });
  });

  test("decodes ABI strings and bytes32 fallbacks", () => {
    assert.equal(decodeStringReturn(str("USD Coin")), "USD Coin");
    assert.equal(decodeStringReturn(stringToHex("MKR", { size: 32 })), "MKR");
    assert.throws(() => decodeStringReturn("0x"), EmptyReturnError);
    assert.throws(() => decodeStringReturn("0x1234"), MalformedReturnError);
  });

  test("decodes uint256 and validates the decimals range", () => {
    assert.equal(decodeUint256Return(uint(2n ** 255n)), 2n ** 255n);
    assert.equal(decodeDecimalsReturn(uint(18n)), 18);
    assert.throws(() => decodeDecimalsReturn(uint(300n)), MalformedReturnError);
    assert.throws(() => decodeUint256Return("0x"), EmptyReturnError);
    assert.throws(() => decodeUint256Return("0x01"), MalformedReturnError);
  });
});

describe("MCP payloads and errors", () => {
  test("parses JSON text content, raw text and structuredContent", () => {
    assert.deepEqual(parseToolPayload({ content: [{ type: "text", text: '{"result":"0x"}' }] }), { result: "0x" });
    assert.equal(parseToolPayload({ content: [{ type: "text", text: "MCP error -32602: bad" }] }), "MCP error -32602: bad");
    assert.deepEqual(parseToolPayload({ structuredContent: { a: 1 }, content: [] }), { a: 1 });
    assert.equal(parseToolPayload({ content: [] }), undefined);
  });

  test("classifies tool errors", () => {
    const revert = ToolCallError.fromPayload("eth_call", { error: { message: "execution reverted", code: 3 } });
    assert.equal(revert.isRevert, true);
    const invalid = ToolCallError.fromPayload("eth_call", "MCP error -32602: Input validation error: Invalid arguments");
    assert.equal(invalid.isInvalidParams, true);
    const lag = ToolCallError.fromPayload("eth_call", { error: { message: "header not found", code: -32000 } });
    assert.equal(lag.isRevert || lag.isInvalidParams, false);
    assert.equal(lag.exitCode, 5);
  });

  test("recognizes a no-such-tool reply in each MCP SDK's wording, and nothing else", () => {
    for (const message of ["MCP error -32602: Tool eth_call not found", "Tool eth_call not found", 'Tool "eth_call" not found', "Unknown tool: eth_call"]) {
      assert.equal(isUnknownToolMessage("eth_call", message), true, message);
    }
    for (const message of [
      "header not found",
      "execution reverted",
      "MCP error -32602: Input validation error: Invalid arguments for tool eth_call",
      "Tool get_code not found",
      "Tool eth_call_v2 not found",
    ]) {
      assert.equal(isUnknownToolMessage("eth_call", message), false, message);
    }
    const missing = missingToolError("eth_call", ENDPOINT);
    assert.equal(missing.kind, "MCP_TOOLS_MISSING");
    assert.equal(missing.exitCode, 4);
    assert.match(missing.message, /does not expose: eth_call/);
  });

  test("tells a lost session apart from a wrong URL", () => {
    const lost = toTransportError(new StreamableHTTPError(404, 'Error POSTing to endpoint: {"error":"Unknown MCP session"}'), ENDPOINT, 20_000, "call");
    assert.match(lost.message, /no longer recognizes this session/);
    const wrongPath = toTransportError(new StreamableHTTPError(404, 'Error POSTing to endpoint: {"error":"Not found"}'), ENDPOINT, 20_000, "connect");
    assert.match(wrongPath.message, /No MCP endpoint/);
    assert.match(wrongPath.hint ?? "", /mcp\.pharos\.xyz\/mcp/);
  });

  test("maps HTTP, timeout, socket and proxy failures to connection errors with hints", () => {
    const rateLimited = toTransportError(new StreamableHTTPError(429, "Error POSTing to endpoint: {}"), ENDPOINT, 20_000, "call");
    assert.equal(rateLimited.kind, "MCP_CONNECTION");
    assert.equal(rateLimited.exitCode, 3);
    assert.match(rateLimited.hint ?? "", /minute/);

    const timeout = toTransportError(new McpError(ErrorCode.RequestTimeout, "Request timed out"), ENDPOINT, 1_500, "call");
    assert.match(timeout.message, /1500 ms/);

    const refused = toTransportError(
      new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }),
      ENDPOINT,
      20_000,
      "connect",
    );
    assert.match(refused.message, /Connection refused by mcp\.pharos\.xyz/);

    // Shape undici produces when an HTTPS proxy rejects the CONNECT tunnel.
    const proxyRoot = Object.assign(new Error("Proxy response (403) !== 200 when HTTP Tunneling"), { code: "UND_ERR_ABORTED" });
    const proxied = toTransportError(
      new TypeError("fetch failed", { cause: new Error("Request was cancelled.", { cause: proxyRoot }) }),
      ENDPOINT,
      20_000,
      "connect",
    );
    assert.match(proxied.message, /proxy .* refused the connection \(HTTP 403\)/);
  });

  test("PHAROS_MCP_TOKEN is never sent to the hosted endpoint, only to custom ones", () => {
    const env = { PHAROS_MCP_TOKEN: "abc123" };
    assert.equal(bearerTokenFor(new URL(HOSTED_ENDPOINT), env), undefined);
    assert.equal(bearerTokenFor(new URL("https://mcp.pharos.xyz/mcp/"), env), undefined);
    assert.equal(bearerTokenFor(new URL("https://MCP.PHAROS.XYZ:443/other"), env), undefined);
    assert.equal(bearerTokenFor(new URL("http://mcp.pharos.xyz/mcp"), env), undefined);
    assert.equal(bearerTokenFor(new URL("http://127.0.0.1:3001/mcp"), env), "abc123");
    assert.equal(bearerTokenFor(new URL("https://mcp.pharos.xyz.attacker.example/mcp"), env), "abc123", "only the exact hosted hostname is exempt");
    assert.equal(bearerTokenFor(new URL("http://127.0.0.1:3001/mcp"), {}), undefined);
  });

  test("a JSON-RPC endpoint is rejected at the handshake with a pointed hint", () => {
    const error = toTransportError(new McpError(ErrorCode.MethodNotFound, "the method initialize does not exist"), ENDPOINT, 20_000, "connect");
    assert.equal(error.kind, "MCP_CONNECTION");
    assert.match(error.hint ?? "", /not a JSON-RPC endpoint/);
  });
});

describe("readTokenState with a stub MCP caller", () => {
  const token = "0x1111111111111111111111111111111111111111" as const;
  const answers: Record<string, Hex> = {
    [CALLDATA.name]: str("Token"),
    [CALLDATA.symbol]: str("TKN"),
    [CALLDATA.decimals]: uint(8n),
    [CALLDATA.totalSupply]: uint(21_000_000n * 10n ** 8n),
  };

  function stub(handler: (name: string, args: Record<string, unknown>) => unknown): ToolCaller & { log: string[] } {
    const log: string[] = [];
    return {
      log,
      async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
        const data = (args.transaction as { data?: string } | undefined)?.data ?? "";
        log.push(`${name}:${data}:${String(args.block)}`);
        const outcome = handler(name, args);
        if (outcome instanceof Error) throw outcome;
        return outcome as T;
      },
    };
  }
  const answer = (args: Record<string, unknown>) => ({ result: answers[(args.transaction as { data: string }).data] });

  test("pins all four eth_calls to the given block and makes no other calls", async () => {
    const mcp = stub((_, args) => answer(args));
    const state = await readTokenState(mcp, token, 255n, { retryDelayMs: 1 });
    assert.deepEqual(
      { name: state.name, symbol: state.symbol, decimals: state.decimals, totalSupply: state.totalSupply, block: state.blockNumber },
      { name: "Token", symbol: "TKN", decimals: 8, totalSupply: 2_100_000_000_000_000n, block: 255n },
    );
    assert.equal(mcp.log.length, 4);
    assert.ok(mcp.log.every((entry) => entry.startsWith("eth_call:") && entry.endsWith(":0xff")));
  });

  test("re-reads only the values that failed transiently, at the same block", async () => {
    let failures = 1;
    const mcp = stub((_, args) => {
      if ((args.transaction as { data: string }).data === CALLDATA.decimals && failures-- > 0) {
        return new ToolCallError("eth_call", "header not found", -32000);
      }
      return answer(args);
    });
    const state = await readTokenState(mcp, token, 7n, { retryDelayMs: 1 });
    assert.deepEqual(state.retried, ["decimals"]);
    assert.equal(state.decimals, 8);
    assert.equal(mcp.log.filter((entry) => entry.startsWith(`eth_call:${CALLDATA.decimals}`)).length, 2);
    assert.ok(!mcp.log.some((entry) => entry.endsWith(":latest")));
  });

  test("a transient failure that persists names the block and fails", async () => {
    const mcp = stub((_, args) =>
      (args.transaction as { data: string }).data === CALLDATA.totalSupply ? new ToolCallError("eth_call", "header not found", -32000) : answer(args),
    );
    await assert.rejects(readTokenState(mcp, token, 7n, { retryDelayMs: 1 }), (error: unknown) => {
      return error instanceof CliError && error.kind === "MCP_TOOL_ERROR" && /totalSupply\(\) at block 7: header not found/.test(error.message);
    });
  });

  test("any missing required read fails the run, and reverts are not retried", async () => {
    const mcp = stub((_, args) =>
      (args.transaction as { data: string }).data === CALLDATA.symbol ? new ToolCallError("eth_call", "execution reverted", 3) : answer(args),
    );
    await assert.rejects(readTokenState(mcp, token, 7n, { retryDelayMs: 1 }), (error: unknown) => {
      return error instanceof CliError && error.kind === "NOT_ERC20" && /symbol\(\) reverted/.test(error.message);
    });
    assert.equal(mcp.log.length, 4);
  });

  test("a connection failure mid-read aborts the whole read", async () => {
    const mcp = stub(() => new CliError("MCP_CONNECTION", "socket hang up"));
    await assert.rejects(readTokenState(mcp, token, 1n, { retryDelayMs: 1 }), (error: unknown) => {
      return error instanceof CliError && error.kind === "MCP_CONNECTION";
    });
  });
});

describe("README proof update", () => {
  const block = 4242n;
  const contract = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
  const output = `Pharos Contract State Reader\n\n  Contract address  ${contract}\n  Read at block     ${block}\n                    ${HOSTED_ENDPOINT}\n`;
  const readme = [
    "# Task",
    MARKERS.statusStart,
    "_Live run pending._",
    MARKERS.statusEnd,
    `- [ ] Short README with sample output ${MARKERS.requirement4}`,
    MARKERS.outputStart,
    "_Pending._",
    MARKERS.outputEnd,
    "",
  ].join("\n");

  // An in-memory transcript in the shape the CLI writes. Test fixture only, never proof.
  function transcript(overrides: { endpoint?: string; ok?: boolean; block?: string; failSelector?: string } = {}) {
    const recorder = new McpRecorder();
    let id = 0;
    const call = (name: string, args: Record<string, unknown>, text: string, isError = false) => {
      id += 1;
      recorder.record("client->server", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      recorder.record("server->client", { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) } });
    };
    call("get_block_number", {}, `{"blockNumber":"${block}"}`);
    for (const data of Object.values(CALLDATA)) {
      const failed = data === overrides.failSelector;
      call("eth_call", { transaction: { to: contract, data }, block: overrides.block ?? "0x1092" }, failed ? '{"error":{"message":"execution reverted","code":3}}' : '{"result":"0x00"}', failed);
    }
    const outcome = overrides.ok === false
      ? { ok: false as const, error: { kind: "NOT_ERC20", message: "x", hint: null } }
      : { ok: true as const, report: { blockNumber: block.toString(), contract: { address: contract } } };
    return buildTranscript(recorder, overrides.endpoint ?? HOSTED_ENDPOINT, outcome);
  }

  test("fills the marked sections from a valid hosted run and ticks requirement 4", () => {
    const evidence = evidenceFromRun(transcript(), output);
    assert.equal(evidence.blockNumber, "4242");
    assert.equal(evidence.ethCalls, 4);
    const next = applyLiveRun(readme, evidence, { transcript: "proof/mcp-transcript.json", output: "sample-output/live-run.txt" });
    assert.match(next, /- \[x\] Short README/);
    assert.match(next, /\[Live Sample Output\]\(#live-sample-output\)/, "the status line must link to the README's real section");
    assert.match(next, /```text\nPharos Contract State Reader/);
    assert.match(next, /block 4242/);
    assert.doesNotMatch(next, /_Pending\._/);
    assert.equal(applyLiveRun(next, evidence, { transcript: "a", output: "b" }).split(MARKERS.outputStart).length, 2, "re-running replaces, never duplicates");
  });

  test("refuses runs that cannot serve as proof", () => {
    assert.throws(() => evidenceFromRun(transcript({ endpoint: "http://127.0.0.1:3001/mcp" }), output), /not the hosted endpoint/);
    assert.throws(() => evidenceFromRun(transcript({ ok: false }), output), /the run failed/);
    assert.throws(() => evidenceFromRun(transcript({ block: "latest" }), output), /not pinned to block 4242/);
    assert.throws(() => evidenceFromRun(transcript({ failSelector: CALLDATA.decimals }), output), /without a successful eth_call response: decimals\(\)/);
    assert.throws(() => evidenceFromRun(transcript(), output.replace("4242", "9999")), /does not show the block number/);
    assert.throws(() => evidenceFromRun(transcript(), output.replace(HOSTED_ENDPOINT, "http://127.0.0.1:3001/mcp")), /not produced against the hosted endpoint/);
  });

  test("fails loudly when the README markers are gone", () => {
    const evidence = evidenceFromRun(transcript(), output);
    assert.throws(() => applyLiveRun("# no markers", evidence, { transcript: "a", output: "b" }), /missing/);
  });
});
