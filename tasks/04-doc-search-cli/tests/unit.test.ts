import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { docsPath, pageUrl, parseSitemap, readIndexCache, writeIndexCache } from "../src/docs-index.js";
import { choosePages, isMultiPart, MIN_PAGE_SCORE, rankPages } from "../src/page-ranker.js";
import { classify, DocsHttpProvider, interpret, parseJsonBody } from "../src/providers/docs-http.js";
import { ProviderError } from "../src/providers/provider.js";
import { GOAL } from "../src/search.js";
import { bestPassages, cleanAnswer, combineAnswers, dedupeSources, judge, officialSourceUrl, retainedText, saysNotInDocs } from "../src/source-gate.js";
import { answerSegment, clip, hasValue, htmlToText, linksIn, markdownBlocks, pageBody, questionTerms, stem, terms, valueKind } from "../src/text.js";
import { search } from "../src/search.js";
import type { DocPage, PageResponse } from "../src/types.js";
import { ATLANTIC_ASK_ANSWER, PAGES, SITEMAP } from "./fake-docs.js";

const index = parseSitemap(SITEMAP);
const page = (path: string) => index.find((entry) => entry.path === path)!;
const response = (path: string, text: string, kind: PageResponse["kind"] = "page", extra: Partial<PageResponse> = {}): PageResponse => ({
  page: page(path),
  requestUrl: `https://docs.pharos.xyz${path}.md?ask=x`,
  kind,
  via: "md-ask",
  text,
  links: linksIn(text, page(path).url),
  declaredSources: [],
  ...extra,
});

/** search() over the fixture pages, with some paths answering with the given composed answers instead. */
async function searchWith(question: string, answers: Record<string, string>, maxPages?: number) {
  const fetch = async (url: string) => {
    const path = new URL(url).pathname.replace(/\.md$/, "");
    const body = path === "/sitemap" ? SITEMAP : (answers[path] ?? PAGES[path]);
    return body === undefined ? new Response("Not found", { status: 404 }) : new Response(body, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
  };
  return search(question, { provider: new DocsHttpProvider({ fetch }), maxPages });
}

describe("terms and question parsing", () => {
  test("natural language becomes stems without stopwords", () => {
    assert.deepEqual(terms("How do I deploy my contracts?"), ["deploy", "contract"]);
    assert.equal(stem("deploying"), "deploy");
    assert.equal(stem("deployment"), "deploy");
    assert.equal(stem("registries"), "registry");
    assert.equal(stem("gas"), "gas");
    assert.deepEqual(terms("JSON-RPC methods"), ["jsonrpc", "method"]);
    assert.deepEqual(terms("Chain ID"), ["chainid"], "phrases join in any text, so pages and questions match");
  });

  test("phrases are joined before splitting, and related topic words are added", () => {
    const { direct, related } = questionTerms("What is the chain ID of the Atlantic testnet?");
    assert.deepEqual(direct, ["chainid", "atlantic", "testnet"]);
    assert.ok(related.includes("network"));
    assert.ok(!related.includes("atlantic"), "a direct word is never repeated as related");
  });

  test("value questions are recognised by kind", () => {
    assert.equal(valueKind("What is the Atlantic chain ID?"), "chain-id");
    assert.equal(valueKind("what is the USDC contract address"), "address");
    assert.equal(valueKind("which RPC endpoint should I use"), "endpoint");
    assert.equal(valueKind("how do I deploy a contract?"), null);
    assert.equal(hasValue("Chain ID | 424242", "chain-id"), true);
    assert.equal(hasValue("no digits here", "chain-id"), false);
    assert.equal(hasValue(`at 0x${"4".repeat(40)}`, "address"), true);
    assert.equal(hasValue("https://rpc.fixture.invalid", "endpoint"), true);
  });
});

describe("reading markdown and HTML", () => {
  test("markdown becomes headings, paragraphs, items, table rows and code", () => {
    const blocks = markdownBlocks(PAGES["/getting-started/network/atlantic-testnet"]!);
    assert.equal(blocks[0]!.text, "Atlantic Testnet", "front matter is skipped");
    const row = blocks.find((block) => block.kind === "row" && block.text.includes("Chain ID"));
    assert.equal(row?.text, "Chain ID: 424242", "a two-column table reads as name: value");
    const wide = markdownBlocks("| Network | Chain ID | Symbol |\n| --- | --- | --- |\n| A | 1 | X |");
    assert.equal(wide[0]!.text, "Network: A; Chain ID: 1; Symbol: X");
    assert.equal(row?.heading, "Network details");
    const code = markdownBlocks(PAGES["/developer-guide/foundry"]!).find((block) => block.kind === "code");
    assert.match(code!.text, /^forge create/);
  });

  test("HTML is reduced to text with headings, list items and table cells", () => {
    const text = htmlToText(`<html><body><nav>menu</nav><main><h1>Title</h1><p>One &amp; two</p><ul><li>Item</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><script>x()</script></main></body></html>`);
    assert.match(text, /# Title/);
    assert.match(text, /One & two/);
    assert.match(text, /- Item/);
    assert.match(text, /\| A \| B/);
    assert.doesNotMatch(text, /menu|x\(\)/);
  });

  test("links are made absolute; clip cuts at a boundary", () => {
    assert.deepEqual(linksIn("see [p](/a/b) and https://docs.pharos.xyz/c.", "https://docs.pharos.xyz/x"), ["https://docs.pharos.xyz/a/b", "https://docs.pharos.xyz/c"]);
    assert.equal(clip("short", 10), "short");
    assert.equal(clip("One sentence. Two sentence that is long.", 20), "One sentence.…");
  });
});

describe("docs index", () => {
  test("parses every docs link once, with its section, whatever the link form", () => {
    assert.deepEqual(
      index.map((entry) => [entry.path, entry.section]),
      [
        ["/getting-started/overview", "Getting Started"],
        ["/getting-started/network/atlantic-testnet", "Getting Started"],
        ["/getting-started/network/pacific-mainnet", "Getting Started"],
        ["/getting-started/canonical-contracts", "Getting Started"],
        ["/getting-started/token-registry", "Getting Started"],
        ["/developer-guide/foundry", "Developer Guide"],
        ["/developer-guide/hardhat", "Developer Guide"],
        ["/api-and-sdk/json-rpc-methods", "API & SDK"],
      ],
    );
    assert.equal(page("/developer-guide/foundry").url, "https://docs.pharos.xyz/developer-guide/foundry");
  });

  test("only https docs.pharos.xyz pages count", () => {
    assert.equal(docsPath("https://docs.pharos.xyz/a/b.md"), "/a/b");
    assert.equal(docsPath("/a/b/"), "/a/b");
    assert.equal(docsPath("http://docs.pharos.xyz/a"), null);
    assert.equal(docsPath("https://docs.pharos.xyz.evil.com/a"), null);
    assert.equal(docsPath("https://docs.pharos.xyz/llms-full.txt"), null);
    assert.equal(docsPath("https://docs.pharos.xyz/sitemap.md"), null);
    assert.equal(docsPath("https://docs.pharos.xyz/img/a.png"), null);
    assert.equal(pageUrl("/a"), "https://docs.pharos.xyz/a");
  });

  describe("disk cache", () => {
    let dir: string;
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "pharos-docs-cache-"));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("round-trips, expires, and rejects tampered entries", async () => {
      const file = join(dir, "index.json");
      await writeIndexCache(file, index, 1_000);
      assert.equal((await readIndexCache(file, 2_000))?.length, index.length);
      assert.equal(await readIndexCache(file, 1_000 + 7 * 60 * 60 * 1000), null, "expired after the TTL");
      const data = JSON.parse(await readFile(file, "utf8"));
      data.pages = [{ title: "x", path: "https://evil.example.com/a" }];
      await writeFile(file, JSON.stringify(data));
      assert.equal(await readIndexCache(file, 2_000), null);
      assert.equal(await readIndexCache(join(dir, "missing.json")), null);
    });
  });
});

describe("page ranking", () => {
  test("the specific page wins: chain ID on Atlantic -> the Atlantic Testnet page", () => {
    const ranked = rankPages("What is the chain ID of the Atlantic testnet?", index);
    assert.equal(ranked[0]!.path, "/getting-started/network/atlantic-testnet");
    assert.ok(ranked[0]!.score >= MIN_PAGE_SCORE);
    assert.deepEqual(choosePages("What is the chain ID of the Atlantic testnet?", ranked).map((p) => p.path), ["/getting-started/network/atlantic-testnet"]);
  });

  test("synonyms reach the right pages: deploy -> Foundry/Hardhat", () => {
    const ranked = rankPages("how do I deploy a contract?", index);
    assert.ok(["/developer-guide/foundry", "/developer-guide/hardhat"].includes(ranked[0]!.path));
  });

  test("one page by default; a second only for a multi-part question, bounded by --max-pages", () => {
    const question = "How do I set up Foundry and deploy a contract to the Atlantic testnet?";
    assert.equal(isMultiPart(question), true);
    const chosen = choosePages(question, rankPages(question, index));
    assert.deepEqual(chosen.map((p) => p.path).sort(), ["/developer-guide/foundry", "/getting-started/network/atlantic-testnet"]);
    assert.equal(choosePages(question, rankPages(question, index), 1).length, 1);
    assert.ok(choosePages(question, rankPages(question, index), 99).length <= 3);
  });

  test("RPC questions reach the JSON-RPC page", () => {
    assert.equal(rankPages("which RPC methods are supported?", index)[0]!.path, "/api-and-sdk/json-rpc-methods");
  });

  test("nothing related: no page is chosen", () => {
    assert.deepEqual(choosePages("Who won the 2018 football world cup?", rankPages("Who won the 2018 football world cup?", index)), []);
    assert.deepEqual(rankPages("???", index), []);
  });
});

describe("source gate", () => {
  test("only https pages on docs.pharos.xyz are sources, deduplicated by canonical URL", () => {
    assert.equal(officialSourceUrl("https://docs.pharos.xyz/a/b.md?ask=x#h"), "https://docs.pharos.xyz/a/b");
    for (const bad of ["http://docs.pharos.xyz/a", "https://evil.com/a", "https://docs.pharos.xyz.evil.com/a", "https://user@docs.pharos.xyz/a", "https://docs.pharos.xyz:8443/a", "javascript:alert(1)", "not a url"]) {
      assert.equal(officialSourceUrl(bad), null, bad);
    }
    const sources = dedupeSources(
      [
        { title: "Foundry", url: "https://docs.pharos.xyz/developer-guide/foundry" },
        { title: null, url: "https://docs.pharos.xyz/developer-guide/foundry.md?ask=q" },
        { title: "Blog", url: "https://blog.example.com/x" },
        { title: null, url: "https://docs.pharos.xyz/getting-started/token-registry/" },
      ],
      new Map([["https://docs.pharos.xyz/getting-started/token-registry", "Token Registry"]]),
    );
    assert.deepEqual(sources, [
      { title: "Foundry", url: "https://docs.pharos.xyz/developer-guide/foundry" },
      { title: "Token Registry", url: "https://docs.pharos.xyz/getting-started/token-registry" },
    ]);
  });

  test("a page answer is its best passages, verbatim, with the value the question asks for", () => {
    const verdict = judge(response("/getting-started/network/atlantic-testnet", PAGES["/getting-started/network/atlantic-testnet"]!), "What is the chain ID of the Atlantic testnet?");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.answer, "Chain ID: 424242");
  });

  test("a value the page does not state is never filled in", () => {
    const verdict = judge(response("/getting-started/network/pacific-mainnet", PAGES["/getting-started/network/pacific-mainnet"]!), "What is the chain ID of Pacific mainnet?");
    assert.equal(verdict.ok, false);
    assert.ok(["value_not_found", "weak_match"].includes(verdict.reason!));
  });

  test("a composed answer that says the docs do not cover it is a no-answer", () => {
    assert.equal(saysNotInDocs("I couldn't find information about Solana in these docs."), true);
    assert.equal(saysNotInDocs("The documentation does not mention staking rewards."), true);
    assert.equal(saysNotInDocs("Deploy with forge create."), false);
    const verdict = judge(response("/developer-guide/foundry", "I could not find anything about Anchor programs here.", "answer"), "How do I deploy an Anchor program?");
    assert.deepEqual([verdict.ok, verdict.reason], [false, "not_in_docs"]);
  });

  test("a composed answer on topic is shown as given, its links reduced to their labels", () => {
    const text = "Deploy the contract with `forge create`, pointing **--rpc-url** at the network. See [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet) and [a blog](https://blog.example.com/x).";
    const verdict = judge(response("/developer-guide/foundry", text, "answer"), "How do I deploy a contract with Foundry?");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.answer, "Deploy the contract with forge create, pointing --rpc-url at the network. See Atlantic Testnet and a blog.");
  });

  test("a composed answer about something else is a weak match, even if it shares a word", () => {
    const verdict = judge(response("/developer-guide/foundry", "To deploy, run forge create with your RPC URL and key.", "answer"), "How do I deploy an Anchor program to Solana?");
    assert.deepEqual([verdict.ok, verdict.reason], [false, "weak_match"]);
  });

  test("an off-topic composed answer is a weak match", () => {
    const verdict = judge(response("/developer-guide/foundry", "Welcome to the documentation home page.", "answer"), "How do I deploy a contract?");
    assert.deepEqual([verdict.ok, verdict.reason], [false, "weak_match"]);
  });

  test("a JSON answer and its declared sources", () => {
    const parsed = parseJsonBody(JSON.stringify({ answer: "Use forge create to deploy a contract.", sources: [{ title: "Foundry", url: "https://docs.pharos.xyz/developer-guide/foundry" }, "https://evil.com/x"] }));
    assert.equal(parsed.text, "Use forge create to deploy a contract.");
    assert.equal(parsed.sources.length, 2);
    assert.throws(() => parseJsonBody("{not json"), ProviderError);
    assert.throws(() => parseJsonBody(JSON.stringify({ nothing: true })), /no answer text/);
  });

  test("passages need to cover the question", () => {
    const blocks = markdownBlocks(PAGES["/developer-guide/foundry"]!);
    const { direct, related } = questionTerms("How do I deploy a contract with Foundry?");
    assert.ok(bestPassages(blocks, direct, related, null));
    const off = questionTerms("What is the staking APR for validators?");
    assert.equal(bestPassages(blocks, off.direct, off.related, null), null);
    assert.equal(cleanAnswer("# Head\n\n- **one**\n> two"), "Head\n\n- one\ntwo");
  });
});

describe("docs-http provider: URLs and classification", () => {
  const provider = new DocsHttpProvider({ fetch: async () => new Response("") });
  const atlantic: DocPage = page("/getting-started/network/atlantic-testnet");

  test("the ask URL is the .md page with ?ask= and &goal=, percent-encoded", () => {
    const url = provider.askUrl(atlantic, "what's the chain ID & RPC? 100% sure/ok #1", GOAL);
    assert.equal(
      url,
      `https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md?ask=what's%20the%20chain%20ID%20%26%20RPC%3F%20100%25%20sure%2Fok%20%231&goal=${encodeURIComponent(GOAL)}`,
    );
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("ask"), "what's the chain ID & RPC? 100% sure/ok #1");
    assert.equal(parsed.searchParams.get("goal"), GOAL);
    assert.equal(parsed.hash, "");
  });

  test("a body is page content or a composed answer", () => {
    assert.equal(classify(PAGES["/getting-started/network/atlantic-testnet"]!, atlantic), "page");
    assert.equal(classify("# Atlantic Testnet\n\nshort", atlantic), "page");
    assert.equal(classify("The chain ID is shown in the network table.", atlantic), "answer");
    assert.equal(classify("x".repeat(3_500), atlantic), "page");
  });
});

describe("review fixes (regressions)", () => {
  test("a malformed %-escape in a link is ignored, never a crash", () => {
    assert.equal(docsPath("https://docs.pharos.xyz/a/50%"), null);
    assert.deepEqual(dedupeSources([{ title: null, url: "https://docs.pharos.xyz/a%zz" }]), []);
    assert.equal(parseSitemap("- [Bad](https://docs.pharos.xyz/a%zz)\n- [Good](/developer-guide/foundry)").length, 1);
  });

  test("the best passage is always in the answer, even after a long earlier runner-up", () => {
    const filler = "Deploy contracts with Foundry tooling. ".repeat(17);
    const blocks = markdownBlocks(`# Foundry\n\n${filler}\n\nTo deploy with foundry run forge create against the network.`);
    const { direct, related } = questionTerms("how do I deploy with foundry run forge create");
    assert.match(bestPassages(blocks, direct, related, null)!.text, /forge create/);
  });

  test("HTML tables become name/value rows; HTML fallback is always page content", () => {
    const blocks = markdownBlocks(htmlToText("<html><body><main><table><tr><th>Name</th><th>Value</th></tr><tr><td>Chain ID</td><td>424242</td></tr></table></main></body></html>"));
    assert.deepEqual(blocks.map((block) => [block.kind, block.text]), [["row", "Chain ID: 424242"]]);
  });

  test("plurals stem like their singulars", () => {
    assert.deepEqual(terms("bridges oracles fees addresses guides status"), ["bridge", "oracle", "fee", "address", "guide", "status"]);
    assert.deepEqual(terms("bridge oracle fee address guide"), ["bridge", "oracle", "fee", "address", "guide"]);
  });

  test("a full page's own links are not sources of the answer", async () => {
    const result = await searchWith("How do I deploy a contract with Foundry?", {}, 1);
    assert.equal(result.status, "answered");
    assert.deepEqual(result.sources.map((s) => s.url), ["https://docs.pharos.xyz/developer-guide/foundry"], "the page links to Atlantic Testnet, but that is navigation");
  });

  test("a value stated after the clip point of a long composed answer is still found and shown", () => {
    const text = `${"The Atlantic testnet is the public test network for Pharos. ".repeat(14)}\nThe Atlantic testnet chain ID is 424242.`;
    const verdict = judge(response("/getting-started/network/atlantic-testnet", text, "answer"), "What is the chain ID of the Atlantic testnet?");
    assert.equal(verdict.ok, true);
    assert.match(verdict.answer!, /424242/);
  });

  test("control and escape characters never reach the output", async () => {
    const { formatText } = await import("../src/formatter.js");
    const { search: _search } = await import("../src/search.js");
    void _search;
    assert.equal(cleanAnswer("evil\u001b]0;title\u0007 text\u001b[2J"), "evil]0;title text[2J");
    const result = { schema: "pharos-docs-result/1", status: "answered", question: "q", answer: "a\u001b[31mred", sources: [], reason: null, suggestions: [], error: null, meta: { tool: "t", version: "v", transport: "docs-http", pagesConsulted: [], requests: 0, elapsedMs: 0 } } as const;
    assert.doesNotMatch(formatText(structuredClone(result) as never), /\u001b/);
  });

  test("a redirect to plain http on the same host is refused, without requesting it", async () => {
    const requested: string[] = [];
    const fetch = async (url: string) => {
      requested.push(url);
      return new Response(null, { status: 301, headers: { location: "http://docs.pharos.xyz/developer-guide/foundry.md" } });
    };
    const provider = new DocsHttpProvider({ fetch, index: index });
    await assert.rejects(provider.ask(page("/developer-guide/foundry"), "q", GOAL), (error: unknown) => error instanceof ProviderError && error.kind === "malformed_response");
    assert.equal(requested.length, 1);
  });
});

describe("composed ?ask= answers in the real response shape", () => {
  const question = "What is the chain ID of the Atlantic testnet?";
  const atlantic = page("/getting-started/network/atlantic-testnet");
  const fetched = async () => {
    const fetch = async () => new Response(ATLANTIC_ASK_ANSWER, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
    return new DocsHttpProvider({ fetch, index }).ask(atlantic, question, GOAL);
  };

  test("the answer is the segment between the question heading and the generated sections", async () => {
    const response = await fetched();
    assert.equal(response.kind, "answer");
    assert.equal(response.text, ATLANTIC_ASK_ANSWER.trim(), "the response keeps the whole body; only the gate narrows it");
    assert.equal(retainedText(response), "The Atlantic testnet chain ID is **424242**. See [Atlantic Testnet](/getting-started/network/atlantic-testnet.md).");
    const verdict = judge(response, question);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.answer, "The Atlantic testnet chain ID is 424242. See Atlantic Testnet.");
    assert.doesNotMatch(verdict.answer!, /What is the chain ID/, "the restated question heading is metadata");
    assert.doesNotMatch(verdict.answer!, /Suggested|Follow-up|Foundry|Hardhat|RPC URL/, "the follow-up questions are not the answer");
  });

  test("links in the generated follow-ups are not sources; the one direct source is the page asked", async () => {
    const response = await fetched();
    assert.deepEqual(response.links, ["https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md"], "only the link inside the answer segment");
    assert.ok(linksIn(ATLANTIC_ASK_ANSWER, atlantic.url).length >= 10, "the body itself links to many pages");
    const result = await searchWith(question, { "/getting-started/network/atlantic-testnet": ATLANTIC_ASK_ANSWER });
    assert.deepEqual(result.sources.map((s) => s.url), [atlantic.url]);
  });

  test("end to end, a simple one-page query has exactly one source and stays grounded", async () => {
    const fetch = async (url: string) =>
      new Response(url.endsWith("/sitemap.md") ? SITEMAP : ATLANTIC_ASK_ANSWER, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
    const provider = new DocsHttpProvider({ fetch });
    const result = await search(question, { provider });
    assert.equal(result.status, "answered");
    assert.deepEqual(result.sources, [{ title: "Atlantic Testnet", url: "https://docs.pharos.xyz/getting-started/network/atlantic-testnet" }]);
    assert.match(result.answer!, /424242/);
    // Grounded: the value and every line of the answer come from the answer segment of the fetched body.
    const body = provider.requests().find((r) => r.purpose === "ask")!.body!;
    const segment = answerSegment(body);
    assert.ok(body.includes(segment));
    assert.ok(segment.includes("424242"));
    for (const word of result.answer!.toLowerCase().match(/[a-z]{4,}/g)!) assert.ok(segment.toLowerCase().includes(word), word);
  });

  test("a page the answer only links to was never read, so it is not a source", async () => {
    const text = `# How do I deploy to the Atlantic testnet?

Deploy the contract with forge create, as in [Foundry](/developer-guide/foundry.md) and [Foundry again](https://docs.pharos.xyz/developer-guide/foundry), using the [Atlantic Testnet](/getting-started/network/atlantic-testnet.md) RPC URL.

## Related Questions

- [How do I deploy with Hardhat?](/developer-guide/hardhat.md)`;
    const result = await searchWith("How do I deploy a contract to the Atlantic testnet?", { "/getting-started/network/atlantic-testnet": text }, 1);
    assert.equal(result.status, "answered");
    assert.deepEqual(result.sources.map((s) => s.url), ["https://docs.pharos.xyz/getting-started/network/atlantic-testnet"]);
  });

  test("generated sections end the answer in their usual spellings; real page sections do not", () => {
    for (const heading of ["# Suggested Follow-up Questions:", "## Follow-up questions", "**Related Questions:**", "Related questions:", "### Sources", "## References", "## See also", "Suggested followup questions"]) {
      assert.equal(answerSegment(`# Q?\n\nThe answer.\n\n${heading}\n\n- [x](/developer-guide/hardhat.md)`), "The answer.", heading);
    }
    assert.equal(answerSegment("The answer, no heading.\n## Steps\n1. One"), "The answer, no heading.\n## Steps\n1. One", "a real section inside the answer stays");
    assert.equal(pageBody("# Page\n\nText.\n\n## See also\n\nMore text.\n\n# Suggested Follow-up Questions:\n\n- [q](/x.md)"), "# Page\n\nText.\n\n## See also\n\nMore text.", "a page keeps its own sections; only follow-ups go");
  });

  test("a long follow-up list does not turn a short answer into a page", () => {
    const long = `${ATLANTIC_ASK_ANSWER}\n${"- [Another generated question about something else?](/developer-guide/hardhat.md)\n".repeat(60)}`;
    assert.ok(long.length > 3_000);
    assert.equal(classify(long, page("/getting-started/network/atlantic-testnet")), "answer");
    assert.equal(interpret(page("/getting-started/network/atlantic-testnet"), "u", long, "text/markdown", "md-ask").links.length, 1);
  });
});

describe("several pages: each statement shown once", () => {
  const question = "How do I set up Foundry and deploy a contract to the Atlantic testnet?";
  const FOUNDRY = "https://docs.pharos.xyz/developer-guide/foundry";
  const ATLANTIC = "https://docs.pharos.xyz/getting-started/network/atlantic-testnet";
  // Composed answers in the live shape; every value and name is a fixture value.
  const COMMON =
    "Install Foundry with foundryup, then run forge init to create a project. Add the Atlantic testnet RPC URL https://rpc.fixture.invalid to foundry.toml. Deploy with forge create, passing --rpc-url and --private-key. The chain ID is 424242.";
  const UNIQUE = "Verify the deployed contract with forge verify-contract after deployment.";
  const composed = (body: string) =>
    `# ${question}\n\n${body} See [Foundry](/developer-guide/foundry.md) and [Hardhat](/developer-guide/hardhat.md).\n\n# Suggested Follow-up Questions:\n\n- [Which tokens are listed?](/getting-started/token-registry.md)\n- [Which RPC providers serve Pharos?](https://docs.pharos.xyz/tooling-and-infrastructure/rpc)\n`;
  const count = (text: string, part: string) => text.split(part).length - 1;

  test("two identical composed answers: one answer, both pages as sources, no labels", async () => {
    const result = await searchWith(question, { "/developer-guide/foundry": composed(COMMON), "/getting-started/network/atlantic-testnet": composed(COMMON) });
    assert.equal(result.status, "answered");
    assert.equal(result.meta.pagesConsulted.length, 2);
    assert.equal(result.answer, `${COMMON} See Foundry and Hardhat.`);
    assert.doesNotMatch(result.answer!, /^(Foundry|Atlantic Testnet):$/m);
    assert.deepEqual(result.sources.map((s) => s.url), result.meta.pagesConsulted.map((p) => p.url), "the pages asked, in their ranked order");
    assert.deepEqual(new Set(result.sources.map((s) => s.url)), new Set([FOUNDRY, ATLANTIC]));
  });

  test("two highly overlapping answers: the shared statements once, the extra sentence once", async () => {
    const result = await searchWith(question, { "/developer-guide/foundry": composed(`${COMMON} ${UNIQUE}`), "/getting-started/network/atlantic-testnet": composed(COMMON) });
    const answer = result.answer!;
    for (const sentence of [...COMMON.split(/(?<=\.) /), UNIQUE]) assert.equal(count(answer, sentence), 1, sentence);
    assert.equal(count(answer, "424242"), 1);
    assert.equal(result.sources.length, 2);

    // The same, combined in a fixed order: the first answer whole, then only what is new, labelled.
    assert.equal(
      combineAnswers([
        { title: "Atlantic Testnet", answer: COMMON },
        { title: "Foundry", answer: `${COMMON} ${UNIQUE}` },
      ]),
      `Atlantic Testnet:\n${COMMON}\n\nFoundry:\n${UNIQUE}`,
    );
  });

  test("genuinely different answers are both kept, whole and labelled", async () => {
    const a = "Run forge create with --rpc-url to deploy a contract.";
    const b = "The Atlantic testnet chain ID is 424242 and its currency is FIX.";
    assert.equal(combineAnswers([{ title: "Foundry", answer: a }, { title: "Atlantic Testnet", answer: b }]), `Foundry:\n${a}\n\nAtlantic Testnet:\n${b}`);
    // The fixture pages themselves answer different parts of the question.
    const result = await searchWith(question, {});
    assert.match(result.answer!, /^Foundry:\n/m);
    assert.match(result.answer!, /^Atlantic Testnet:\n/m);
    assert.equal(result.sources.length, 2);
  });

  test("a different value is never folded into an earlier statement", () => {
    const combined = combineAnswers([
      { title: "A", answer: "The chain ID of the network is 424242." },
      { title: "B", answer: "The chain ID of the network is 424243." },
    ]);
    assert.equal(combined, "A:\nThe chain ID of the network is 424242.\n\nB:\nThe chain ID of the network is 424243.");
  });

  test("the same text split into sentences differently counts as already said", () => {
    const combined = combineAnswers([
      { title: "A", answer: "Install Foundry with foundryup. Then deploy the contract with forge create and the RPC URL." },
      { title: "B", answer: "Install Foundry with foundryup and deploy the contract with forge create and the RPC URL." },
    ]);
    assert.equal(combined, "Install Foundry with foundryup. Then deploy the contract with forge create and the RPC URL.");
  });

  test("sources are only the pages asked and used: no linked, see-also or follow-up pages", async () => {
    const result = await searchWith(question, { "/developer-guide/foundry": composed(`${COMMON} ${UNIQUE}`), "/getting-started/network/atlantic-testnet": composed(COMMON) });
    assert.deepEqual(new Set(result.sources.map((s) => s.url)), new Set([FOUNDRY, ATLANTIC]));
    assert.doesNotMatch(JSON.stringify(result.sources), /hardhat|token-registry|tooling-and-infrastructure/);
  });

  test("order is deterministic: the same run gives the same answer and sources, ties in ranked page order", async () => {
    const answers = { "/developer-guide/foundry": composed(`${COMMON} ${UNIQUE}`), "/getting-started/network/atlantic-testnet": composed(COMMON) };
    const first = await searchWith(question, answers);
    for (let i = 0; i < 3; i += 1) {
      const again = await searchWith(question, answers);
      assert.equal(again.answer, first.answer);
      assert.deepEqual(again.sources, first.sources);
    }
    const tie = await searchWith(question, { "/developer-guide/foundry": composed(COMMON), "/getting-started/network/atlantic-testnet": composed(COMMON) });
    assert.deepEqual(tie.sources.map((s) => s.url), tie.meta.pagesConsulted.map((p) => p.url));
    assert.deepEqual(combineAnswers([{ title: "A", answer: "x is y." }]), "x is y.");
  });
});

