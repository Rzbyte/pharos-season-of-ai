// GET /api/search against the in-process fake docs site. Needs dist/ (npm run build).
//   node --test tests/web-api.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, afterEach, before, describe, test } from "node:test";
import { answer, createHandler } from "../api/search.js";
import { startFakeDocs } from "../dist/tests/fake-docs.js";

let fake;
before(async () => {
  fake = await startFakeDocs();
});
after(async () => {
  await fake.close();
});
afterEach(() => fake.reset());

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
  test("answers with the same result schema as the CLI, sources on docs.pharos.xyz", async () => {
    const { status, headers, body } = await get(createHandler({ fetchOrigin: fake.url }), "/api/search?q=What%20is%20the%20chain%20ID%20of%20the%20Atlantic%20testnet%3F");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body), ["schema", "status", "question", "answer", "sources", "reason", "suggestions", "error", "meta"]);
    assert.equal(body.status, "answered");
    assert.equal(body.answer, "Chain ID: 424242");
    assert.deepEqual(body.sources, [{ title: "Atlantic Testnet", url: "https://docs.pharos.xyz/getting-started/network/atlantic-testnet" }]);
    assert.equal(body.meta.transport, "docs-http");
    assert.equal(headers.get("cache-control"), "public, s-maxage=300, stale-while-revalidate=600");
  });

  test("the docs index is reused between requests", async () => {
    const handler = createHandler({ fetchOrigin: fake.url });
    await get(handler, "/api/search?q=deploy%20with%20foundry");
    await get(handler, "/api/search?q=deploy%20with%20hardhat");
    assert.equal(fake.requests.filter((request) => request.path === "/sitemap.md").length, 0, "already cached from the first test on this origin");
  });

  test("a no-answer is a 200 with status no_answer", async () => {
    const { status, body } = await answer("Who won the 2018 football world cup?", { fetchOrigin: fake.url });
    assert.equal(status, 200);
    assert.deepEqual([body.status, body.answer, body.reason], ["no_answer", null, "no_matching_page"]);
  });

  test("a missing or oversized question is a 400 before any docs request", async () => {
    for (const path of ["/api/search", "/api/search?q=", "/api/search?q=%20%20", `/api/search?q=${"x".repeat(400)}`]) {
      const { status, headers, body } = await get(createHandler({ fetchOrigin: fake.url }), path);
      assert.equal(status, 400, path);
      assert.equal(body.error.kind, "usage");
      assert.equal(headers.get("cache-control"), "no-store");
    }
    assert.equal(fake.requests.length, 0);
  });

  test("an unreachable docs site is a 502 that is never cached", async () => {
    const { status, headers, body } = await get(createHandler({ fetchOrigin: "http://127.0.0.1:9", timeoutMs: 1000 }), "/api/search?q=deploy%20a%20contract");
    assert.equal(status, 502);
    assert.equal(body.status, "error");
    assert.equal(headers.get("cache-control"), "no-store");
  });

  test("a cold start counts its index request; a failing index is tried once, not twice", async () => {
    const fresh = await startFakeDocs();
    try {
      const cold = await answer("What is the chain ID of the Atlantic testnet?", { fetchOrigin: fresh.url });
      assert.equal(cold.body.meta.requests, 2, "sitemap.md and the page");
      fresh.reset();
      const warm = await answer("What is the chain ID of the Atlantic testnet?", { fetchOrigin: fresh.url });
      assert.equal(warm.body.meta.requests, 1);
    } finally {
      await fresh.close();
    }
    const broken = await startFakeDocs();
    try {
      broken.set("/sitemap.md", { status: 503 });
      const { status } = await answer("deploy a contract", { fetchOrigin: broken.url });
      assert.equal(status, 502);
      assert.equal(broken.requests.filter((request) => request.path === "/sitemap.md").length, 1);
    } finally {
      await broken.close();
    }
  });

  test("only GET", async () => {
    const { status, headers } = await get(createHandler({ fetchOrigin: fake.url }), "/api/search?q=x", "POST");
    assert.equal(status, 405);
    assert.equal(headers.get("allow"), "GET");
  });
});
