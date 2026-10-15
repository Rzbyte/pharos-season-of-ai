// GET /api/search against the in-process fake Developer Docs MCP. Needs dist/ (npm run build).
//   node --test tests/web-api.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, afterEach, before, describe, test } from "node:test";
import { answer, createHandler } from "../api/search.js";
import { MCP_ENDPOINT } from "../dist/src/constants.js";
import { startFakeMcp } from "../dist/tests/fake-mcp.js";

let mcp;
before(async () => {
  mcp = await startFakeMcp();
});
after(async () => {
  await mcp.close();
});
afterEach(() => mcp.reset());

async function get(handler, path, method = "GET") {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally {
    server.close();
  }
}

describe("/api/search", () => {
  test("answers through the Developer Docs MCP, with the CLI's result schema and sources on docs.pharos.xyz", async () => {
    const { status, headers, body } = await get(createHandler({ mcpUrl: mcp.url }), "/api/search?q=What%20is%20the%20Atlantic%20chain%20ID%3F");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body), ["schema", "status", "question", "answer", "sources", "reason", "suggestions", "error", "meta"]);
    assert.equal(body.status, "answered");
    assert.equal(body.answer, "The Atlantic testnet chain ID is 424242 (test fixture).");
    assert.deepEqual(body.sources, [{ title: "Atlantic Testnet", url: "https://docs.pharos.xyz/getting-started/network/atlantic-testnet" }]);
    assert.deepEqual([body.meta.provider, body.meta.transport, body.meta.endpoint], ["developer-docs-mcp", "docs-mcp", mcp.url]);
    assert.deepEqual(
      mcp.requests.map((request) => [request.httpMethod, request.rpc?.method, request.rpc?.params?.name ?? null]),
      [
        ["POST", "tools/list", null],
        ["POST", "tools/call", "askQuestion"],
      ],
    );
    assert.equal(headers.get("cache-control"), "public, s-maxage=300, stale-while-revalidate=600");
  });

  test("the deployed handler is fixed to the official endpoint; no setting can point it elsewhere", async () => {
    const source = await readFile(new URL("../api/search.js", import.meta.url), "utf8");
    assert.equal(MCP_ENDPOINT, "https://docs.pharos.xyz/~gitbook/mcp");
    assert.match(source, /\{ mcpUrl = MCP_ENDPOINT, timeoutMs = TIMEOUT_MS \} = \{\}/);
    assert.match(source, /export default createHandler\(\);/);
    assert.doesNotMatch(source, /process\.env|docs-http|DocsHttpProvider/);
  });

  test("a warm instance lists the tools once; after an MCP error it lists them again", async () => {
    const fresh = await startFakeMcp();
    try {
      const cold = await answer("What is the Atlantic chain ID?", { mcpUrl: fresh.url });
      assert.equal(cold.body.meta.requests, 2, "tools/list and askQuestion");
      const warm = await answer("How do I deploy a contract with Foundry?", { mcpUrl: fresh.url });
      assert.equal(warm.body.meta.requests, 1, "askQuestion only");
      assert.deepEqual(fresh.requests.map((request) => request.rpc.method), ["tools/list", "tools/call", "tools/call"]);
      fresh.set("http-500", "tools/call");
      assert.equal((await answer("What is the Atlantic chain ID?", { mcpUrl: fresh.url })).status, 502);
      fresh.reset();
      assert.equal((await answer("What is the Atlantic chain ID?", { mcpUrl: fresh.url })).body.meta.requests, 2);
    } finally {
      await fresh.close();
    }
  });

  test("a question the docs do not cover is a 200 with status no_answer and the nearby pages", async () => {
    const { status, body } = await answer("How do I deploy an Anchor program to Solana?", { mcpUrl: mcp.url });
    assert.equal(status, 200);
    assert.deepEqual([body.status, body.answer, body.sources, body.reason], ["no_answer", null, [], "not_in_docs"]);
    assert.deepEqual(body.suggestions.map((page) => page.title), ["Overview", "Foundry"]);
  });

  test("an Indonesian question the docs do not cover is a no_answer too; an Indonesian answer stays an answer", async () => {
    const none = await answer("Bagaimana cara deploy program fixture ke chain lain?", { mcpUrl: mcp.url });
    assert.deepEqual([none.status, none.body.status, none.body.reason, none.body.answer], [200, "no_answer", "not_in_docs", null]);
    const fact = await answer("Apakah Pharos mendukung fixture blob?", { mcpUrl: mcp.url });
    assert.deepEqual([fact.body.status, fact.body.sources.length], ["answered", 1]);
  });

  test("a missing or oversized question is a 400 before any MCP request", async () => {
    for (const path of ["/api/search", "/api/search?q=", "/api/search?q=%20%20", `/api/search?q=${"x".repeat(400)}`]) {
      const { status, headers, body } = await get(createHandler({ mcpUrl: mcp.url }), path);
      assert.equal(status, 400, path);
      assert.equal(body.error.kind, "usage");
      assert.equal(headers.get("cache-control"), "no-store");
    }
    assert.equal(mcp.requests.length, 0);
  });

  test("the MCP unreachable, failing or too slow: a 502 with the reason, never cached, nothing else tried", async () => {
    const down = await get(createHandler({ mcpUrl: "http://127.0.0.1:9/~gitbook/mcp", timeoutMs: 1000 }), "/api/search?q=deploy%20a%20contract");
    assert.equal(down.status, 502);
    assert.deepEqual([down.body.status, down.body.error.kind, down.body.answer, down.body.meta.transport], ["error", "upstream_unreachable", null, "docs-mcp"]);
    assert.equal(down.headers.get("cache-control"), "no-store");
    mcp.set("rpc-error", "tools/call");
    const failing = await answer("What is the Atlantic chain ID?", { mcpUrl: mcp.url });
    assert.equal(failing.status, 502);
    assert.match(failing.body.error.message, /error -32603: Fixture failure/);
    mcp.reset();
    mcp.set("hang", "tools/call");
    const slow = await answer("What is the Atlantic chain ID?", { mcpUrl: mcp.url, timeoutMs: 1000 });
    assert.deepEqual([slow.status, slow.body.error.kind], [502, "timeout"]);
  });

  test("only GET", async () => {
    const { status, headers } = await get(createHandler({ mcpUrl: mcp.url }), "/api/search?q=x", "POST");
    assert.equal(status, 405);
    assert.equal(headers.get("allow"), "GET");
  });
});
