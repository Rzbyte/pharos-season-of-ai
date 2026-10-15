import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { DocsHttpProvider } from "../src/providers/docs-http.js";
import { ProviderError } from "../src/providers/provider.js";
import { GOAL, search } from "../src/search.js";
import { startFakeDocs, type FakeDocs } from "./fake-docs.js";

let fake: FakeDocs;
before(async () => {
  fake = await startFakeDocs();
});
after(async () => {
  await fake.close();
});
afterEach(() => {
  fake.reset();
});

const provider = (timeoutMs = 2_000) => new DocsHttpProvider({ fetchOrigin: fake.url, timeoutMs });
const pageOf = async (p: DocsHttpProvider, path: string) => (await p.index()).find((page) => page.path === path)!;
const rejects = async (promise: Promise<unknown>, kind: string) => {
  await assert.rejects(promise, (error: unknown) => error instanceof ProviderError && error.kind === kind);
};

describe("docs-http provider against a fake docs site", () => {
  test("reads the index once, then asks a page with exactly ?ask= and &goal=", async () => {
    const p = provider();
    const pages = await p.index();
    await p.index();
    assert.equal(pages.length, 8);
    const page = pages.find((entry) => entry.path === "/developer-guide/foundry")!;
    const response = await p.ask(page, "How do I deploy?", GOAL);
    assert.equal(response.kind, "page");
    assert.equal(response.via, "md-ask");
    assert.deepEqual(
      fake.requests.map((r) => [r.path, r.ask, r.goal]),
      [
        ["/sitemap.md", null, null],
        ["/developer-guide/foundry.md", "How do I deploy?", GOAL],
      ],
    );
    const records = p.requests();
    assert.deepEqual(records.map((r) => r.purpose), ["index", "ask"]);
    assert.equal(records[1]!.status, 200);
    assert.match(records[1]!.sha256!, /^[0-9a-f]{64}$/);
    assert.equal(records[1]!.body!.trim(), response.text, "the full page body is kept for the proof");
    assert.equal(records[0]!.body, null, "the index keeps only an excerpt");
  });

  test("a composed answer and a JSON answer are read as such", async () => {
    const p = provider();
    fake.set("/developer-guide/hardhat", { answer: "Run npx hardhat ignition deploy to deploy a contract." });
    const answer = await p.ask(await pageOf(p, "/developer-guide/hardhat"), "deploy with hardhat", GOAL);
    assert.equal(answer.kind, "answer");
    fake.set("/developer-guide/hardhat", { json: { answer: "Use Hardhat Ignition to deploy.", sources: ["https://docs.pharos.xyz/developer-guide/hardhat"] } });
    const json = await p.ask(await pageOf(p, "/developer-guide/hardhat"), "deploy with hardhat", GOAL);
    assert.equal(json.kind, "json");
    assert.equal(json.declaredSources[0]!.url, "https://docs.pharos.xyz/developer-guide/hardhat");
  });

  test("a missing markdown page falls back to the HTML page", async () => {
    const p = provider();
    fake.set("/getting-started/overview", { html: "<html><body><main><h1>Overview</h1><p>Pharos overview from HTML, long enough to read.</p></main></body></html>" });
    const response = await p.ask(await pageOf(p, "/getting-started/overview"), "what is pharos", GOAL);
    assert.equal(response.via, "html");
    assert.match(response.text, /Pharos overview from HTML/);
    assert.deepEqual(p.requests().slice(1).map((r) => [r.purpose, r.status]), [["ask", 404], ["html-fallback", 200]]);
  });

  test("an empty markdown page falls back too; no content anywhere is page_unavailable", async () => {
    const p = provider();
    fake.set("/getting-started/token-registry", "empty");
    await rejects(p.ask(await pageOf(p, "/getting-started/token-registry"), "tokens", GOAL), "page_unavailable");
  });

  test("timeouts, server errors, rate limits, oversized and malformed bodies, off-site redirects", async () => {
    const p = provider(300);
    const page = await pageOf(p, "/developer-guide/foundry");
    fake.set(page.path, "hang");
    await rejects(p.ask(page, "q", GOAL), "timeout");
    fake.set(page.path, { status: 500 });
    await rejects(p.ask(page, "q", GOAL), "upstream_error");
    fake.set(page.path, { status: 429 });
    await rejects(p.ask(page, "q", GOAL), "upstream_error");
    fake.set(page.path, "huge");
    await rejects(p.ask(page, "q", GOAL), "malformed_response");
    fake.set(page.path, { json: "{not json" });
    await rejects(p.ask(page, "q", GOAL), "malformed_response");
    fake.set(page.path, "offsite");
    await rejects(p.ask(page, "q", GOAL), "malformed_response");
    assert.ok(p.requests().every((record) => record.ms >= 0));
    assert.ok(p.requests().some((record) => /timed out/.test(record.error ?? "")));
  });

  test("an unreachable docs site and a broken index are explained", async () => {
    await rejects(new DocsHttpProvider({ fetchOrigin: "http://127.0.0.1:9", timeoutMs: 1_000 }).index(), "upstream_unreachable");
    fake.set("/sitemap.md", { status: 503 });
    await rejects(provider().index(), "upstream_error");
    fake.set("/sitemap.md", { page: "# Nothing here\n\nNo links at all." });
    await rejects(provider().index(), "malformed_response");
    fake.set("/sitemap.md", { status: 404 });
    await rejects(provider().index(), "index_unavailable");
  });
});

describe("search over the fake docs site", () => {
  test("answers from the page, with its docs.pharos.xyz URL as the source", async () => {
    fake.set("/sitemap.md", { page: (await import("./fake-docs.js")).SITEMAP });
    const p = provider();
    const result = await search("What is the chain ID of the Atlantic testnet?", { provider: p });
    assert.equal(result.status, "answered");
    assert.match(result.answer!, /424242/);
    assert.deepEqual(result.sources, [{ title: "Atlantic Testnet", url: "https://docs.pharos.xyz/getting-started/network/atlantic-testnet" }]);
    assert.equal(result.meta.transport, "docs-http");
    assert.equal(result.meta.requests, 2);
    assert.deepEqual(result.meta.pagesConsulted.map((page) => page.outcome), ["used"]);
  });

  test("a multi-part question asks two pages and labels each part", async () => {
    const result = await search("How do I set up Foundry and deploy a contract to the Atlantic testnet?", { provider: provider() });
    assert.equal(result.status, "answered");
    assert.equal(result.meta.pagesConsulted.length, 2);
    assert.match(result.answer!, /^(Foundry|Atlantic Testnet):\n/m);
    assert.deepEqual(result.sources.map((s) => s.url).sort(), ["https://docs.pharos.xyz/developer-guide/foundry", "https://docs.pharos.xyz/getting-started/network/atlantic-testnet"]);
    assert.equal(new Set(result.sources.map((s) => s.url)).size, result.sources.length, "no duplicate sources");
  });

  test("never more requests than the index plus the chosen pages", async () => {
    const p = provider();
    await search("How do I set up Foundry and deploy a contract to the Atlantic testnet?", { provider: p, maxPages: 1 });
    assert.equal(p.requests().filter((r) => r.purpose === "ask").length, 1);
  });

  test("no answer: an unrelated question asks no page at all", async () => {
    const p = provider();
    const result = await search("Who won the 2018 football world cup?", { provider: p });
    assert.equal(result.status, "no_answer");
    assert.equal(result.reason, "no_matching_page");
    assert.equal(result.answer, null);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(p.requests().map((r) => r.purpose), ["index"]);
  });

  test("no answer: the docs answer that they do not cover it", async () => {
    fake.set("/developer-guide/foundry", { answer: "I couldn't find information about Anchor or Solana programs in this documentation." });
    fake.set("/developer-guide/hardhat", { answer: "The documentation does not mention Anchor." });
    const result = await search("How do I deploy an Anchor program to Solana?", { provider: provider() });
    assert.equal(result.status, "no_answer");
    assert.equal(result.reason, "not_in_docs");
    assert.ok(result.suggestions.length > 0, "nearby documented topics are offered");
    fake.set("/developer-guide/foundry", { page: (await import("./fake-docs.js")).PAGES["/developer-guide/foundry"]! });
    fake.set("/developer-guide/hardhat", { page: (await import("./fake-docs.js")).PAGES["/developer-guide/hardhat"]! });
  });

  test("no answer: a value the page does not state is not invented", async () => {
    const result = await search("What is the chain ID of Pacific mainnet?", { provider: provider() });
    assert.equal(result.status, "no_answer");
    assert.ok(["value_not_found", "weak_match"].includes(result.reason!));
    assert.equal(result.answer, null);
  });

  test("an unreachable docs site is an error, not a no-answer", async () => {
    const result = await search("What is the chain ID of the Atlantic testnet?", { provider: new DocsHttpProvider({ fetchOrigin: "http://127.0.0.1:9", timeoutMs: 1_000 }) });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "upstream_unreachable");
  });

  test("a page that times out is an error with the kind", async () => {
    fake.set("/getting-started/network/atlantic-testnet", "hang");
    const result = await search("What is the chain ID of the Atlantic testnet?", { provider: provider(300) });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "timeout");
    fake.set("/getting-started/network/atlantic-testnet", { page: (await import("./fake-docs.js")).PAGES["/getting-started/network/atlantic-testnet"]! });
  });

  test("a missing question is refused before any request", async () => {
    const p = provider();
    const result = await search("   ", { provider: p });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "usage");
    assert.equal(p.requests().length, 0);
    assert.equal((await search("??? !!!", { provider: p })).error?.kind, "usage");
    assert.equal((await search("x".repeat(301), { provider: p })).error?.kind, "usage");
  });
});
