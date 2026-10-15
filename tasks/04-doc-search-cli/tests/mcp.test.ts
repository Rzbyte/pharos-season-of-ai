import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { ASK_TOOL, MCP_ENDPOINT, TOOLS_TTL_MS } from "../src/constants.js";
import { askTool, DeveloperDocsMcpProvider, parseToolList, readToolsCache, toolText, writeToolsCache } from "../src/providers/developer-docs-mcp.js";
import { jsonRpcMessages, McpHttpClient, parseSse, responseFor } from "../src/providers/mcp-http.js";
import { ProviderError, type DocsAnswer } from "../src/providers/provider.js";
import { MCP_GOAL, search } from "../src/search.js";
import { cleanAnswer, explicitNonCoverage, judgeAnswer } from "../src/source-gate.js";
import { answerAndSources } from "../src/text.js";
import { ANSWERS, startFakeMcp, TOOLS, type FakeMcp, type Mode } from "./fake-mcp.js";

// The Developer Docs MCP path: the event-stream and JSON-RPC reading, the client against an in-process
// fake of the verified endpoint, the provider, and the source gate on askQuestion answers. Every answer
// and value here is made up.

let mcp: FakeMcp;
before(async () => {
  mcp = await startFakeMcp();
});
after(async () => {
  await mcp.close();
});
afterEach(() => mcp.reset());

const isProviderError = (kind: string, message?: RegExp) => (error: unknown) => error instanceof ProviderError && error.kind === kind && (!message || message.test(error.message));
const client = (timeoutMs = 2_000) => new McpHttpClient(mcp.url, { timeoutMs });
const provider = (options: ConstructorParameters<typeof DeveloperDocsMcpProvider>[0] = {}) => new DeveloperDocsMcpProvider({ endpoint: mcp.url, timeoutMs: 2_000, ...options });
const DOCS = "https://docs.pharos.xyz";

describe("server-sent events", () => {
  test("one event per frame: event name, data lines joined with a newline, comments skipped, id kept", () => {
    const events = parseSse(': hello\nevent: message\nid: 7\ndata: {"a":\ndata: 1}\n\nevent: other\ndata: x\n\ndata: plain\n\n');
    assert.deepEqual(
      events.map((event) => [event.event, event.data]),
      [
        ["message", '{"a":\n1}'],
        ["other", "x"],
        ["message", "plain"],
      ],
    );
    assert.equal(events[0]!.id, "7");
  });

  test("CRLF, a byte-order mark, no space after the colon, and a last event without its blank line", () => {
    assert.deepEqual(
      parseSse('﻿event:message\r\ndata:{"x":1}\r\n\r\ndata: last').map((event) => [event.event, event.data]),
      [
        ["message", '{"x":1}'],
        ["message", "last"],
      ],
    );
  });

  test("a frame without data is not an event; an empty body has none", () => {
    assert.deepEqual(parseSse("event: message\n\n: keep-alive\n\n"), []);
    assert.deepEqual(parseSse(""), []);
  });
});

describe("JSON-RPC responses", () => {
  test("the response is the message with the request's id; a notification before it is skipped", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(responseFor(jsonRpcMessages(body, "text/event-stream; charset=utf-8"), 2), { ok: true });
  });

  test("a JSON body is read too, one message or a batch", () => {
    assert.deepEqual(responseFor(jsonRpcMessages('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', "application/json; charset=utf-8"), 1), { tools: [] });
    assert.equal(responseFor(jsonRpcMessages('[{"jsonrpc":"2.0","id":3,"result":1}]', "application/json"), 3), 1);
  });

  test("a JSON-RPC error is an upstream error naming its code and message", () => {
    assert.throws(() => responseFor([{ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }], 1), isProviderError("upstream_error", /error -32602: Invalid params/));
  });

  test("malformed: no message event, data that is not JSON, JSON that does not parse, another content type, another id, not 2.0, both result and error", () => {
    const malformed = (read: () => unknown, message: RegExp) => assert.throws(read, isProviderError("malformed_response", message));
    malformed(() => jsonRpcMessages(": keep-alive\n\n", "text/event-stream"), /no message event/);
    malformed(() => jsonRpcMessages("event: endpoint\ndata: /elsewhere\n\n", "text/event-stream"), /no message event/);
    malformed(() => jsonRpcMessages("event: message\ndata: {not json\n\n", "text/event-stream"), /data is not JSON/);
    malformed(() => jsonRpcMessages("{", "application/json"), /does not parse/);
    malformed(() => jsonRpcMessages("hello", "text/plain; charset=utf-8"), /as text\/plain, not JSON or an event stream/);
    malformed(() => jsonRpcMessages("hello", null), /without a content type/);
    malformed(() => responseFor([{ jsonrpc: "2.0", id: 9, result: {} }], 1), /no JSON-RPC answer to request 1/);
    malformed(() => responseFor([{ jsonrpc: "1.0", id: 1, result: {} }], 1), /not JSON-RPC 2\.0/);
    malformed(() => responseFor([{ jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } }], 1), /both a result and an error/);
  });
});

describe("MCP client against a fake Developer Docs MCP", () => {
  test("POSTs JSON-RPC 2.0 with the Streamable HTTP headers, one id per request, and keeps each raw response", async () => {
    const c = client();
    assert.deepEqual(
      parseToolList(await c.call("tools/list")).map((tool) => tool.name),
      ["searchDocumentation", "getPage", "askQuestion", "sendFeedback"],
    );
    await c.call("tools/call", { name: ASK_TOOL, arguments: { question: "What is the Atlantic chain ID?" } });
    assert.deepEqual(
      mcp.requests.map((r) => [r.httpMethod, r.contentType, r.accept, r.rpc?.jsonrpc, r.rpc?.id, r.rpc?.method]),
      [
        ["POST", "application/json", "application/json, text/event-stream", "2.0", 1, "tools/list"],
        ["POST", "application/json", "application/json, text/event-stream", "2.0", 2, "tools/call"],
      ],
    );
    const records = c.requests();
    assert.deepEqual(
      records.map((r) => [r.seq, r.method, r.url, r.purpose, r.status, r.contentType, r.error]),
      [
        [1, "POST", mcp.url, "tools/list", 200, "text/event-stream", null],
        [2, "POST", mcp.url, "tools/call", 200, "text/event-stream", null],
      ],
    );
    assert.deepEqual(records[1]!.rpc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: ASK_TOOL, arguments: { question: "What is the Atlantic chain ID?" } } });
    const body = records[1]!.body!;
    assert.match(body, /^event: message\ndata: \{"jsonrpc":"2\.0","id":2,"result":/);
    assert.equal(records[1]!.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(records[1]!.bytes, Buffer.byteLength(body));
    // A record is the JSON-RPC payload and what came back: no request headers, so nothing secret to leak.
    assert.deepEqual(Object.keys(records[0]!).sort(), ["body", "bytes", "contentType", "error", "excerpt", "method", "ms", "purpose", "rpc", "seq", "sha256", "status", "url"]);
  });

  test("the endpoint answers GET with 405; the client only ever POSTs", async () => {
    const response = await fetch(mcp.url);
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    mcp.reset();
    await provider().answer("What is the Atlantic chain ID?", MCP_GOAL);
    assert.ok(mcp.requests.length === 2 && mcp.requests.every((r) => r.httpMethod === "POST"));
  });

  test("a JSON response and a notification before the response are both read", async () => {
    for (const mode of ["json-response", "notification-first"] as const) {
      mcp.reset();
      mcp.set(mode);
      assert.equal(parseToolList(await client().call("tools/list")).length, 4, mode);
    }
  });

  test("every way a request can fail has a kind and a message, after one request: no retry, no redirect followed", async () => {
    const cases: Array<[Mode, string, RegExp]> = [
      ["http-500", "upstream_error", /answered HTTP 500/],
      ["redirect", "upstream_error", /redirected \(HTTP 307\) instead of answering/],
      ["plain-text", "malformed_response", /as text\/plain/],
      ["no-message", "malformed_response", /no message event/],
      ["bad-data", "malformed_response", /data is not JSON/],
      ["wrong-id", "malformed_response", /no JSON-RPC answer to request 1/],
      ["not-jsonrpc", "malformed_response", /not JSON-RPC 2\.0/],
      ["rpc-error", "upstream_error", /error -32603: Fixture failure/],
      ["huge", "malformed_response", /2000000/],
    ];
    for (const [mode, kind, message] of cases) {
      mcp.reset();
      mcp.set(mode);
      const c = client();
      await assert.rejects(c.call("tools/list"), isProviderError(kind, message), mode);
      assert.ok(c.requests()[0]!.error, `${mode}: the record says what went wrong`);
      assert.equal(mcp.requests.length, 1, `${mode}: one request`);
    }
  });

  test("a hanging endpoint times out with the limit named", async () => {
    mcp.set("hang");
    const c = client(300);
    await assert.rejects(c.call("tools/list"), isProviderError("timeout", /within 300 ms/));
    assert.equal(c.requests()[0]!.error, "timed out after 300 ms");
  });

  test("an unreachable endpoint is upstream_unreachable", async () => {
    const c = new McpHttpClient("http://127.0.0.1:9/~gitbook/mcp", { timeoutMs: 2_000 });
    await assert.rejects(c.call("tools/list"), isProviderError("upstream_unreachable", /^Could not reach the Developer Docs MCP \(127\.0\.0\.1:9\)/));
  });
});

describe("Developer Docs MCP provider", () => {
  test("the official endpoint by default", () => {
    assert.equal(MCP_ENDPOINT, "https://docs.pharos.xyz/~gitbook/mcp");
    assert.equal(new DeveloperDocsMcpProvider().endpoint, MCP_ENDPOINT);
    assert.deepEqual([new DeveloperDocsMcpProvider().name, new DeveloperDocsMcpProvider().transport], ["developer-docs-mcp", "docs-mcp"]);
  });

  test("lists the tools once, then calls askQuestion with the question and the goal", async () => {
    const p = provider();
    const answer = await p.answer("What is the Atlantic chain ID?", MCP_GOAL);
    await p.answer("How do I deploy a contract with Foundry?", MCP_GOAL);
    assert.deepEqual(mcp.requests.map((r) => r.rpc?.method), ["tools/list", "tools/call", "tools/call"]);
    assert.deepEqual(mcp.requests[1]!.rpc?.params, { name: ASK_TOOL, arguments: { question: "What is the Atlantic chain ID?", goal: MCP_GOAL } });
    assert.equal(MCP_GOAL, "Answer a developer question using the Pharos Developer Docs", "the goal the live endpoint was verified with");
    assert.deepEqual(answer, {
      tool: ASK_TOOL,
      text: ANSWERS.chainId.trim(),
      body: "The Atlantic testnet chain ID is 424242 (test fixture).",
      sources: [{ title: "Atlantic Testnet", url: `${DOCS}/getting-started/network/atlantic-testnet` }],
      sourceSection: true,
    });
    assert.equal(p.toolsFromCache, false);
    assert.deepEqual(p.verifiedTools()?.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  });

  test("a verified tool list given up front skips tools/list", async () => {
    const p = provider({ tools: parseToolList({ tools: TOOLS }) });
    await p.answer("What is the Atlantic chain ID?", MCP_GOAL);
    assert.deepEqual(mcp.requests.map((r) => r.rpc?.method), ["tools/call"]);
    assert.equal(p.toolsFromCache, true);
  });

  test("an askQuestion that takes no goal gets the question only", async () => {
    const tools = parseToolList({ tools: TOOLS.map((tool) => (tool.name === ASK_TOOL ? { ...tool, inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } } : tool)) });
    await provider({ tools }).answer("What is the Atlantic chain ID?", MCP_GOAL);
    assert.deepEqual(mcp.requests[0]!.rpc?.params?.arguments, { question: "What is the Atlantic chain ID?" });
  });

  test("no askQuestion, or one that needs more than a question: an upstream error naming why, and no tools/call", async () => {
    mcp.set("no-ask-tool");
    await assert.rejects(provider().answer("What is the Atlantic chain ID?", MCP_GOAL), isProviderError("upstream_error", /does not offer askQuestion \(it lists: searchDocumentation, getPage, sendFeedback\)/));
    mcp.reset();
    mcp.set("ask-requires-more");
    await assert.rejects(provider().answer("What is the Atlantic chain ID?", MCP_GOAL), isProviderError("upstream_error", /askQuestion now requires space/));
    assert.deepEqual(mcp.requests.map((r) => r.rpc?.method), ["tools/list"]);
  });

  test("a tools/call result without content, or a tool error, is never an answer", async () => {
    mcp.set("no-content", "tools/call");
    await assert.rejects(provider().answer("What is the Atlantic chain ID?", MCP_GOAL), isProviderError("malformed_response", /no content array/));
    mcp.reset();
    mcp.set("is-error", "tools/call");
    await assert.rejects(provider().answer("What is the Atlantic chain ID?", MCP_GOAL), isProviderError("upstream_error", /reported an error\): The fixture could not answer\./));
  });

  test("tool lists and tool results are checked, not trusted", () => {
    assert.throws(() => parseToolList({}), isProviderError("malformed_response", /no tools array/));
    assert.throws(() => parseToolList({ tools: [{ description: "nameless" }] }), isProviderError("malformed_response", /has no tools/));
    assert.deepEqual(parseToolList({ tools: [{ name: ASK_TOOL }, 3, { name: "" }] }), [{ name: ASK_TOOL, description: null, inputSchema: null }]);
    assert.throws(() => askTool(parseToolList({ tools: [{ name: ASK_TOOL }] })), isProviderError("upstream_error", /no longer takes a string "question"/));
    assert.throws(() => askTool(parseToolList({ tools: [{ name: ASK_TOOL, inputSchema: { properties: { question: { type: "number" } } } }] })), isProviderError("upstream_error", /string "question"/));
    assert.equal(askTool(parseToolList({ tools: TOOLS })).goal, true);
    assert.equal(toolText({ content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }] }), "a\n\nb");
    assert.throws(() => toolText({ content: [] }), isProviderError("malformed_response", /no text content/));
    assert.throws(() => toolText({ content: [{ type: "text", text: "boom" }], isError: true }), isProviderError("upstream_error", /boom/));
  });

  test("the tool list cache: same endpoint, still fresh, still offering askQuestion; anything else is ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-docs-tools-"));
    try {
      const file = join(dir, "tools.json");
      const tools = parseToolList({ tools: TOOLS });
      await writeToolsCache(file, MCP_ENDPOINT, tools, 1_000);
      assert.deepEqual(await readToolsCache(file, MCP_ENDPOINT, 2_000), tools);
      assert.equal(await readToolsCache(file, "http://127.0.0.1:1/~gitbook/mcp", 2_000), null, "another endpoint");
      assert.equal(await readToolsCache(file, MCP_ENDPOINT, 1_000 + TOOLS_TTL_MS + 1), null, "expired");
      assert.equal(await readToolsCache(file, MCP_ENDPOINT, 500), null, "saved in the future");
      await writeToolsCache(file, MCP_ENDPOINT, tools.filter((tool) => tool.name !== ASK_TOOL), 1_000);
      assert.equal(await readToolsCache(file, MCP_ENDPOINT, 2_000), null, "a list without askQuestion");
      await writeFile(file, "{not json");
      assert.equal(await readToolsCache(file, MCP_ENDPOINT, 2_000), null, "garbage");
      assert.equal(await readToolsCache(join(dir, "missing.json"), MCP_ENDPOINT), null, "missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("an askQuestion answer and its sources", () => {
  test("the verified shape: the answer, then a Sources list of docs pages", () => {
    const parsed = answerAndSources(`Atlantic Testnet’s chain ID is 424242 (test fixture).\n\n# Sources\n\n- [Atlantic Testnet](${DOCS}/getting-started/network/atlantic-testnet)\n- [Overview](${DOCS}/getting-started/overview.md)\n`);
    assert.deepEqual(parsed, {
      body: "Atlantic Testnet’s chain ID is 424242 (test fixture).",
      sources: [
        { title: "Atlantic Testnet", url: `${DOCS}/getting-started/network/atlantic-testnet` },
        { title: "Overview", url: `${DOCS}/getting-started/overview.md` },
      ],
      sourceSection: true,
    });
  });

  test("the Sources heading in its usual spellings; relative links made absolute; a following section ends it", () => {
    for (const heading of ["# Sources:", "## Sources", "Sources:", "**Sources**", "References", "### Source"]) {
      const parsed = answerAndSources(`Use forge create (test fixture).\n\n${heading}\n- [Foundry](/developer-guide/foundry)\n\n## Related questions\n- [Hardhat?](${DOCS}/developer-guide/hardhat)\n`);
      assert.equal(parsed.body, "Use forge create (test fixture).", heading);
      assert.deepEqual(parsed.sources, [{ title: "Foundry", url: `${DOCS}/developer-guide/foundry` }], heading);
    }
  });

  test("pages the answer itself links to come first, then its Sources list", () => {
    const parsed = answerAndSources(`See [Write Your First Token](/developer-guide/foundry/write-your-first-token.md) (test fixture).\n\n# Sources\n\n- [Atlantic Testnet](${DOCS}/getting-started/network/atlantic-testnet)\n`);
    assert.deepEqual(parsed.sources.map((source) => source.title), ["Write Your First Token", "Atlantic Testnet"]);
  });

  test("no Sources section: the answer's own links; no links: no sources", () => {
    const parsed = answerAndSources(`See [Foundry](${DOCS}/developer-guide/foundry) and https://github.com/example/fixture.`);
    assert.equal(parsed.sourceSection, false);
    assert.deepEqual(parsed.sources.map((source) => source.url), [`${DOCS}/developer-guide/foundry`, "https://github.com/example/fixture"]);
    assert.deepEqual(answerAndSources("Just text (test fixture)."), { body: "Just text (test fixture).", sources: [], sourceSection: false });
  });

  test("code keeps its lines as written: placeholders, indentation, no fences", () => {
    assert.equal(
      cleanAnswer("Broadcast it:\n\n```sh\nexport PRIVATE_KEY=<your-private-key>\nforge script Deploy.s.sol \\\n  --rpc-url $RPC_URL **x** `y`\n```\n\nDone."),
      "Broadcast it:\n\nexport PRIVATE_KEY=<your-private-key>\nforge script Deploy.s.sol \\\n  --rpc-url $RPC_URL **x** `y`\n\nDone.",
    );
  });
});

describe("the source gate on MCP answers", () => {
  const asked = (text: string): DocsAnswer => ({ tool: ASK_TOOL, text, ...answerAndSources(text) });
  const NEARBY = `\n\n# Sources\n\n- [Overview](${DOCS}/getting-started/overview)\n- [Foundry](${DOCS}/developer-guide/foundry.md)\n`;

  test("an answer on topic is shown, with the official pages it lists as sources", () => {
    assert.deepEqual(judgeAnswer(asked(ANSWERS.chainId), "What is the Atlantic chain ID?"), {
      status: "answered",
      answer: "The Atlantic testnet chain ID is 424242 (test fixture).",
      sources: [{ title: "Atlantic Testnet", url: `${DOCS}/getting-started/network/atlantic-testnet` }],
      reason: null,
      suggestions: [],
    });
  });

  test("a how-to keeps its numbered steps and its command", () => {
    const verdict = judgeAnswer(asked(ANSWERS.foundry), "How do I deploy a contract with Foundry?");
    assert.equal(verdict.status, "answered");
    assert.match(verdict.answer!, /^To deploy a contract with Foundry \(test fixture\):\n\n1\. Install Foundry with foundryup\.\n2\. Deploy it with forge create/);
    assert.match(verdict.answer!, /\nforge create src\/Counter\.sol:Counter --rpc-url \$RPC_URL --private-key \$PRIVATE_KEY$/);
    assert.deepEqual(verdict.sources.map((source) => source.title), ["Foundry", "Atlantic Testnet"]);
  });

  test("the verified no-coverage shape: no answer, reason not_in_docs, the listed pages as nearby topics", () => {
    assert.deepEqual(judgeAnswer(asked(`No. The Pharos Developer Docs don’t cover deploying fixture programs to another chain.${NEARBY}`), "How do I deploy a fixture program to another chain?"), {
      status: "no_answer",
      answer: null,
      sources: [],
      reason: "not_in_docs",
      suggestions: [
        { title: "Overview", url: `${DOCS}/getting-started/overview` },
        { title: "Foundry", url: `${DOCS}/developer-guide/foundry` },
      ],
    });
  });

  test("generic: any topic, many phrasings, plain or typographic quotes", () => {
    const statements = [
      "No. The Pharos Developer Docs don’t cover deploying fixture programs to another chain.",
      "The documentation does not mention zebra-striped validators.",
      "Unfortunately, the Pharos docs do not currently include a guide for running a node on a toaster.",
      "The docs site doesn't explain how to bake fixture bread.",
      "Quantum fixture bridges are not covered in the Pharos documentation.",
      "Moon-landing tokens aren’t mentioned anywhere in the docs.",
      "Fixture sharding is not documented.",
      "The Pharos Developer Docs have no information about fixture lotteries.",
      "There is no documentation about fixture lotteries.",
      "I couldn't find anything about fixture lotteries in the Pharos documentation.",
      "I wasn’t able to find details on fixture lotteries.",
      "That question is outside the scope of the Pharos Developer Docs.",
      "Not covered. The documentation doesn't contain instructions for fixture lotteries.",
      "Short answer: no. The documentation doesn’t mention fixture lotteries.",
      "It’s not covered in the Pharos docs.",
      "Based on the Pharos Developer Docs, there’s no information about fixture lotteries.",
      "There isn’t any guide for fixture lotteries in the docs.",
      "Nothing in the Pharos docs covers fixture lotteries.",
      "The Pharos Developer Docs focus on EVM development and don’t include fixture lottery guides.",
      "I don’t see any mention of fixture lotteries in the docs.",
    ];
    for (const statement of statements) {
      assert.equal(explicitNonCoverage(statement), true, statement);
      assert.equal(judgeAnswer(asked(`${statement} Pharos is EVM compatible (test fixture).${NEARBY}`), "How do I play the fixture lottery?").reason, "not_in_docs", statement);
    }
  });

  test("a negative answer about Pharos itself is an answer, not a no-answer", () => {
    const answers: Array<[string, string]> = [
      ["Does Pharos support fixture blobs?", ANSWERS.factualNo],
      ["Can fixture validators skip staking?", `No. Fixture validators cannot skip staking on Pharos; every validator stakes (test fixture).${NEARBY}`],
      ["Is the fixture bridge permissionless?", `No, the fixture bridge is not permissionless: relayers are approved by governance (test fixture).${NEARBY}`],
    ];
    for (const [question, text] of answers) {
      assert.equal(explicitNonCoverage(cleanAnswer(answerAndSources(text).body)), false, question);
      assert.equal(judgeAnswer(asked(text), question).status, "answered", question);
    }
  });

  test("an answer that answers, then notes a gap in the docs, is still an answer, however short its first sentence", () => {
    const text = `To deploy a contract with Foundry, run forge create with the RPC URL and your key (test fixture). The docs do not cover verifying it on other explorers.${NEARBY}`;
    assert.equal(judgeAnswer(asked(text), "How do I deploy a contract with Foundry?").status, "answered");
    const short = `Atlantic’s chain ID is 424242. The docs don’t mention a separate devnet ID (test fixture).\n\n# Sources\n\n- [Atlantic Testnet](${DOCS}/getting-started/network/atlantic-testnet)\n`;
    assert.equal(judgeAnswer(asked(short), "What is the Atlantic chain ID?").status, "answered");
    for (const statement of ["The Pharos docs say the explorer does not include fixture traces.", "There is no reference implementation for fixture lotteries.", "Yes, you can deploy fixture contracts with Foundry."]) {
      assert.equal(explicitNonCoverage(statement), false, statement);
    }
  });

  test("no docs.pharos.xyz page cited: not shown (unsourced), nothing invented", () => {
    const offsite = `The Atlantic testnet chain ID is 424242 (test fixture).\n\n# Sources\n\n- [Blog](https://blog.example.invalid/chain)\n- [Lookalike](https://docs.pharos.xyz.example.invalid/getting-started)\n- [Plain http](http://docs.pharos.xyz/getting-started/network/atlantic-testnet)\n`;
    assert.deepEqual(judgeAnswer(asked(offsite), "What is the Atlantic chain ID?"), { status: "no_answer", answer: null, sources: [], reason: "unsourced", suggestions: [] });
    assert.equal(judgeAnswer(asked("The Atlantic testnet chain ID is 424242 (test fixture)."), "What is the Atlantic chain ID?").reason, "unsourced");
  });

  test("only official pages are sources, each once, at most five; at most three nearby topics", () => {
    const pages = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `- [Page ${name}](${DOCS}/fixture/${name}.md)`).join("\n");
    const many = `The Atlantic testnet chain ID is 424242 (test fixture).\n\n# Sources\n\n- [Atlantic Testnet](${DOCS}/getting-started/network/atlantic-testnet)\n- [Again](${DOCS}/getting-started/network/atlantic-testnet.md#chain)\n- [GitHub](https://github.com/example/fixture)\n${pages}\n`;
    assert.deepEqual(
      judgeAnswer(asked(many), "What is the Atlantic chain ID?").sources.map((source) => source.url),
      [`${DOCS}/getting-started/network/atlantic-testnet`, `${DOCS}/fixture/a`, `${DOCS}/fixture/b`, `${DOCS}/fixture/c`, `${DOCS}/fixture/d`],
    );
    assert.equal(judgeAnswer(asked(`The Pharos Developer Docs do not cover this (test fixture).\n\n# Sources\n\n${pages}\n`), "How do I play the fixture lottery?").suggestions.length, 3);
  });

  test("off topic is a weak match; a value question without the value is value_not_found", () => {
    assert.equal(judgeAnswer(asked(`Hardhat is another way to compile and deploy contracts (test fixture).${NEARBY}`), "What is the Atlantic chain ID?").reason, "weak_match");
    assert.equal(judgeAnswer(asked(`The Atlantic testnet chain ID is listed on its network page (test fixture).${NEARBY}`), "What is the Atlantic chain ID?").reason, "value_not_found");
  });
});

describe("search through the Developer Docs MCP", () => {
  test("the result says what answered and over what: developer-docs-mcp, docs-mcp, the endpoint", async () => {
    let seen: DocsAnswer | null = null;
    const result = await search("What is the Atlantic chain ID?", { provider: provider(), onAnswer: (answer) => void (seen = answer) });
    assert.equal(result.status, "answered");
    assert.equal(result.answer, "The Atlantic testnet chain ID is 424242 (test fixture).");
    const { provider: name, transport, endpoint, pagesConsulted, requests } = result.meta;
    assert.deepEqual({ name, transport, endpoint, pagesConsulted, requests }, { name: "developer-docs-mcp", transport: "docs-mcp", endpoint: mcp.url, pagesConsulted: [], requests: 2 });
    assert.equal(seen!.text, ANSWERS.chainId.trim());
  });

  test("an MCP failure is an error that still says docs-mcp: nothing else is tried", async () => {
    for (const mode of ["http-500", "rpc-error", "is-error"] as const) {
      mcp.reset();
      mcp.set(mode, mode === "is-error" ? "tools/call" : undefined);
      const result = await search("What is the Atlantic chain ID?", { provider: provider() });
      assert.deepEqual([result.status, result.answer, result.sources], ["error", null, []], mode);
      assert.equal(result.meta.transport, "docs-mcp", mode);
      assert.ok(result.error && result.error.kind !== "usage", mode);
    }
  });

  test("a bad question is refused before any request", async () => {
    const result = await search("   ", { provider: provider() });
    assert.equal(result.error?.kind, "usage");
    assert.equal(mcp.requests.length, 0);
  });
});
