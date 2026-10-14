// GET /api/events against the in-process fake Pharos Chain MCP. Needs dist/ (built by `npm ci`).
//   node --test tests/demo-api.test.mjs
// Every value is made up and never used as proof.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { createHandler, readWindow, WINDOW_BLOCKS } from "../api/events.js";
import { startFakePharosMcp } from "../dist/tests/fake-pharos-mcp.js";
import { makeLog, TOPIC, USDC, ZERO } from "../dist/tests/fixtures.js";

const HEAD = 20_248_479n;

async function withFake(chain, body) {
  const fake = await startFakePharosMcp(chain);
  try {
    await body(fake);
  } finally {
    await fake.close();
  }
}

describe("readWindow", () => {
  test("reads the last 200 blocks with one exactly filtered get_logs call and decodes the events", async () => {
    const logs = [makeLog({ block: HEAD - 199n, index: 0 }), makeLog({ block: HEAD - 200n }), makeLog({ block: HEAD, index: 4, from: ZERO, amount: 1n })];
    await withFake({ head: HEAD, logs }, async (fake) => {
      const { status, body } = await readWindow(fake.url);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.head, String(HEAD));
      assert.equal(body.fromBlock, String(HEAD - WINDOW_BLOCKS + 1n));
      assert.equal(body.toBlock, String(HEAD));
      assert.deepEqual(body.getLogs, { address: USDC, topics: [TOPIC], fromBlock: `0x${(HEAD - 199n).toString(16)}`, toBlock: `0x${HEAD.toString(16)}` });
      assert.deepEqual(body.events.map((event) => [event.blockNumber, event.type]), [[String(HEAD - 199n), "Transfer"], [String(HEAD), "Mint"]]);
      const mint = body.events[1];
      assert.equal(mint.amount.formatted, "0.000001");
      assert.equal(mint.from, ZERO);
      assert.match(mint.key, /^0x[0-9a-f]{64}:4$/);
      assert.equal(mint.summary.startsWith("0.000001 USDC minted to 0x"), true);
      assert.deepEqual(body.toolCalls.byTool, { get_chain_info: 1, get_block_number: 1, get_logs: 1 });
      assert.deepEqual(fake.calls.map((call) => call.tool), ["get_chain_info", "get_block_number", "get_logs"]);
      assert.deepEqual(fake.calls[2].args, body.getLogs);
      assert.equal(fake.openSessions(), 0, "MCP session closed");
    });
  });

  test("lists removed logs by key and never as events", async () => {
    const removed = makeLog({ block: HEAD - 5n, index: 2, removed: true });
    await withFake({ head: HEAD, logs: [removed] }, async (fake) => {
      const { body } = await readWindow(fake.url);
      assert.deepEqual(body.events, []);
      assert.deepEqual(body.removedKeys, [`${removed.transactionHash}:2`]);
      assert.equal(body.skipped.removed, 1);
    });
  });

  test("refuses another chain", async () => {
    await withFake({ head: HEAD, logs: [], chainId: 1 }, async (fake) => {
      const { status, body } = await readWindow(fake.url);
      assert.equal(status, 502);
      assert.equal(body.error.kind, "WRONG_CHAIN");
      assert.equal(fake.calls.some((call) => call.tool === "get_logs"), false);
    });
  });

  test("a get_logs failure is retried once on the same range, then reported as 502", async () => {
    await withFake({ head: HEAD, logs: [], getLogsFailures: 2 }, async (fake) => {
      const { status, body } = await readWindow(fake.url);
      assert.equal(status, 502);
      assert.match(body.error.message, /header not found/);
      const ranges = fake.calls.filter((call) => call.tool === "get_logs").map((call) => call.args);
      assert.equal(ranges.length, 2);
      assert.deepEqual(ranges[0], ranges[1]);
    });
  });

  test("an unreachable endpoint is a 502 with a reason", async () => {
    const { status, body } = await readWindow("http://127.0.0.1:9/mcp");
    assert.equal(status, 502);
    assert.equal(body.error.kind, "MCP_CONNECTION");
  });
});

describe("handler", () => {
  async function request(handler, method = "GET") {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, { method });
      return { status: response.status, headers: response.headers, body: await response.json() };
    } finally {
      server.close();
    }
  }

  test("a good answer is shared at the edge for a few seconds", async () => {
    await withFake({ head: HEAD, logs: [] }, async (fake) => {
      const { status, headers, body } = await request(createHandler(fake.url));
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(headers.get("cache-control"), "public, s-maxage=4, stale-while-revalidate=2");
      assert.match(headers.get("content-type"), /application\/json/);
    });
  });

  test("errors are never cached", async () => {
    await withFake({ head: HEAD, logs: [], chainId: 5 }, async (fake) => {
      const { status, headers } = await request(createHandler(fake.url));
      assert.equal(status, 502);
      assert.equal(headers.get("cache-control"), "no-store");
    });
  });

  test("only GET", async () => {
    const { status, headers } = await request(createHandler("http://127.0.0.1:9/mcp"), "POST");
    assert.equal(status, 405);
    assert.equal(headers.get("allow"), "GET");
  });
});
