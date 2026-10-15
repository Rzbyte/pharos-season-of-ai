import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { DOCS_ORIGIN, MCP_ENDPOINT } from "../src/constants.js";
import { applyProof, PROOF_QUERIES, verifyHttpRun, verifyMcpRun, type Check, type HttpTranscript, type McpTranscript } from "../src/proof.js";
import { run } from "../src/run.js";
import { ATLANTIC_ASK_ANSWER, startFakeDocs, type FakeDocs } from "./fake-docs.js";
import { startFakeMcp, type FakeMcp } from "./fake-mcp.js";

// Proof-shaped runs against the in-process fakes. Their endpoints are rewritten to the official ones only
// so the verifiers' other checks can be exercised; nothing here is, or is used as, live proof.
let docs: FakeDocs;
let mcp: FakeMcp;
let dir: string;
before(async () => {
  docs = await startFakeDocs();
  mcp = await startFakeMcp();
  dir = await mkdtemp(join(tmpdir(), "pharos-docs-proof-"));
});
after(async () => {
  await docs.close();
  await mcp.close();
  await rm(dir, { recursive: true, force: true });
});

const failedChecks = (checks: Check[]) => checks.filter((check) => !check.ok).map((check) => check.name);

async function capture(args: string[], env: Record<string, string>): Promise<{ file: string; output: string }> {
  const file = join(dir, `${Math.random()}.json`);
  let output = "";
  await run([...args, "--no-cache", "--transcript", file], { stdout: (text) => void (output += text), stderr: (text) => void (output += text), env: { PHAROS_DOCS_CACHE_DIR: dir, ...env } });
  return { file, output };
}

async function mcpRun(question: string): Promise<{ transcript: McpTranscript; output: string }> {
  const { file, output } = await capture([question], { PHAROS_DOCS_MCP_URL: mcp.url });
  return { transcript: JSON.parse(await readFile(file, "utf8")) as McpTranscript, output };
}

/** The same MCP run, as if it had gone to the official endpoint. */
function asOfficialMcp(transcript: McpTranscript): McpTranscript {
  const copy = structuredClone(transcript);
  copy.endpoint = MCP_ENDPOINT;
  copy.result.meta.endpoint = MCP_ENDPOINT;
  for (const request of copy.requests) request.url = MCP_ENDPOINT;
  return copy;
}

describe("MCP proof verifier", () => {
  test("the three README queries are the task's: a fact, a how-to, and one the docs do not cover", () => {
    assert.deepEqual(
      PROOF_QUERIES.map((q) => [q.question, q.expect]),
      [
        ["What is the Atlantic chain ID?", "answered"],
        ["How do I deploy a contract with Foundry?", "answered"],
        ["How do I deploy an Anchor program to Solana?", "no_answer"],
      ],
    );
  });

  test("a clean answered run verifies: tools listed live, askQuestion called once, the result recomputed from the saved stream", async () => {
    for (const query of PROOF_QUERIES.slice(0, 2)) {
      const { transcript, output } = await mcpRun(query.question);
      assert.equal(transcript.format, "pharos-docs-mcp-transcript/1");
      assert.deepEqual(transcript.requests.map((r) => [r.method, r.rpc?.method]), [["POST", "tools/list"], ["POST", "tools/call"]]);
      assert.match(transcript.requests[1]!.body!, /^event: message\ndata: \{"jsonrpc":"2\.0"/, "the raw event stream is saved as received");
      assert.deepEqual(failedChecks(verifyMcpRun(asOfficialMcp(transcript), output, "answered")), [], query.question);
    }
  });

  test("a clean unsupported-question run verifies as a no-answer, with the pages the MCP listed as nearby topics", async () => {
    const { transcript, output } = await mcpRun(PROOF_QUERIES[2].question);
    assert.deepEqual([transcript.result.status, transcript.result.reason, transcript.result.answer], ["no_answer", "not_in_docs", null]);
    assert.ok(transcript.result.suggestions.length > 0);
    assert.deepEqual(failedChecks(verifyMcpRun(asOfficialMcp(transcript), output, "no_answer")), []);
  });

  test("refuses a run against any endpoint but the official Developer Docs MCP", async () => {
    const { transcript, output } = await mcpRun(PROOF_QUERIES[0].question);
    assert.ok(failedChecks(verifyMcpRun(transcript, output, "answered")).includes("official Developer Docs MCP only"));
  });

  test("refuses an edited answer, an unlisted source, a cached tool list, another question, a docs-http label", async () => {
    const { transcript, output } = await mcpRun(PROOF_QUERIES[0].question);
    const edited = asOfficialMcp(transcript);
    edited.result.answer = `${edited.result.answer} The chain ID is 999999.`;
    assert.ok(failedChecks(verifyMcpRun(edited, output, "answered")).includes("result recomputed from the saved MCP response"));

    const unlisted = asOfficialMcp(transcript);
    unlisted.result.sources.push({ title: "Hardhat", url: `${DOCS_ORIGIN}/developer-guide/hardhat` });
    assert.ok(failedChecks(verifyMcpRun(unlisted, `${output}${DOCS_ORIGIN}/developer-guide/hardhat\n`, "answered")).includes("sources are official pages the answer lists"));

    const cached = asOfficialMcp(transcript);
    cached.toolsFromCache = true;
    assert.ok(failedChecks(verifyMcpRun(cached, output, "answered")).includes("tools listed live, askQuestion offered"));

    const other = asOfficialMcp(transcript);
    (other.requests[1]!.rpc!.params!.arguments as Record<string, unknown>).question = "Something else?";
    assert.ok(failedChecks(verifyMcpRun(other, output, "answered")).includes("askQuestion called once, with the question"));

    const http = asOfficialMcp(transcript);
    http.result.meta.transport = "docs-http";
    assert.ok(failedChecks(verifyMcpRun(http, output, "answered")).includes("transport stated as MCP"));
  });

  test("refuses saved bytes that do not give the result, or are not a JSON-RPC answer", async () => {
    const { transcript, output } = await mcpRun(PROOF_QUERIES[0].question);
    const swapped = asOfficialMcp(transcript);
    swapped.requests[1]!.body = swapped.requests[1]!.body!.replace("424242", "777777");
    assert.ok(failedChecks(verifyMcpRun(swapped, output, "answered")).includes("result recomputed from the saved MCP response"));

    const broken = asOfficialMcp(transcript);
    broken.requests[1]!.body = "event: message\ndata: {not json\n\n";
    assert.ok(failedChecks(verifyMcpRun(broken, output, "answered")).includes("JSON-RPC responses well formed"));
  });

  test("the archived docs-http proof still verifies as what it is: HTTP, not MCP", async () => {
    const archive = new URL("../../proof/archive/docs-http-2026-10-15/", import.meta.url);
    const questions = [
      ["a", "answered"],
      ["b", "answered"],
      ["c", "no_answer"],
    ] as const;
    for (const [id, expect] of questions) {
      const transcript = JSON.parse(await readFile(new URL(`query-${id}.json`, archive), "utf8")) as HttpTranscript;
      const output = await readFile(new URL(`sample-output/query-${id}.txt`, archive), "utf8");
      assert.equal(transcript.transport, "docs-http", id);
      assert.deepEqual(failedChecks(verifyHttpRun(transcript, output, expect)), [], id);
      assert.ok(failedChecks(verifyMcpRun(transcript as unknown as McpTranscript, output, expect)).includes("transcript"), `${id} is not MCP proof`);
    }
    assert.match(await readFile(new URL("README.md", archive), "utf8"), /not MCP/);
  });

  test("the README ticks its examples requirement only when the committed MCP proof verifies", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    for (const marker of ["proof-status", "example-a", "example-b", "example-c", "json-example"]) {
      assert.match(readme, new RegExp(`<!-- ${marker}:start -->[\\s\\S]*?<!-- ${marker}:end -->`), marker);
    }
    const proof = new URL("../../proof/", import.meta.url);
    const committed = await access(new URL("query-a.json", proof)).then(
      () => true,
      () => false,
    );
    if (committed) {
      for (const query of PROOF_QUERIES) {
        const transcript = JSON.parse(await readFile(new URL(`query-${query.id}.json`, proof), "utf8")) as McpTranscript;
        const output = await readFile(new URL(`../sample-output/query-${query.id}.txt`, proof), "utf8");
        assert.deepEqual(failedChecks(verifyMcpRun(transcript, output, query.expect)), [], query.id);
      }
      assert.match(readme, /- \[x\] \*\*README with installation, usage and at least 3 example queries with output\.\*\* <!-- req-examples -->/);
    } else {
      // No live MCP proof in this checkout yet: the README must say so, and must not tick the requirement.
      assert.match(readme, /- \[ \] \*\*README with installation, usage and at least 3 example queries with output\.\*\* <!-- req-examples -->/);
      assert.match(readme, /<!-- proof-status:start -->\n\*\*Live MCP proof: pending\.\*\*/);
    }
  });

  test("applyProof fills the README sections and ticks the examples requirement", () => {
    const readme = [
      "- [ ] At least 3 example queries with output <!-- req-examples -->",
      "<!-- proof-status:start -->",
      "pending",
      "<!-- proof-status:end -->",
      ...["a", "b", "c"].flatMap((id) => [`<!-- example-${id}:start -->`, "pending", `<!-- example-${id}:end -->`]),
      "<!-- json-example:start -->",
      "pending",
      "<!-- json-example:end -->",
    ].join("\n");
    const examples = PROOF_QUERIES.map((q) => ({ id: q.id, label: q.label, question: q.question, output: `Answer\n  ${q.id}\n` }));
    const next = applyProof(readme, examples, '{"status":"answered"}\n', ["**Live proof:** captured"]);
    assert.match(next, /- \[x\] At least 3 example queries/);
    assert.doesNotMatch(next, /pending/);
    assert.match(next, /\$ pharos-docs "What is the Atlantic chain ID\?" --json\n\{"status":"answered"\}/);
  });
});

// ---------------------------------------------------------------------------
// The docs-http development transport: its verifier still guards the archived proof.

/** The questions of the archived docs-http proof. */
const HTTP_QUERIES = ["What is the chain ID of the Atlantic testnet?", "How do I set up Foundry and deploy a contract to the Atlantic testnet?", "How do I deploy an Anchor program to Solana?"] as const;

async function httpRun(question: string): Promise<{ transcript: HttpTranscript; output: string }> {
  const { file, output } = await capture([question, "--transport", "docs-http"], { PHAROS_DOCS_FETCH_ORIGIN: docs.url });
  // The development-transport note is on stderr, before the result; the verifier reads the result output.
  return { transcript: JSON.parse(await readFile(file, "utf8")) as HttpTranscript, output: output.replace(/^Note: --transport docs-http .*\n/, "") };
}

/** The same run, as if it had gone to docs.pharos.xyz. */
function asOfficialHttp(transcript: HttpTranscript): HttpTranscript {
  const copy = structuredClone(transcript);
  copy.fetchOrigin = DOCS_ORIGIN;
  for (const request of copy.requests) request.url = request.url.replace(docs.url, DOCS_ORIGIN);
  for (const page of copy.result.meta.pagesConsulted) page.requestUrl = page.requestUrl.replace(docs.url, DOCS_ORIGIN);
  return copy;
}

describe("docs-http verifier (development transport, archived proof)", () => {
  test("a clean answered run verifies, multi-page included", async () => {
    for (const question of HTTP_QUERIES.slice(0, 2)) {
      const { transcript, output } = await httpRun(question);
      assert.deepEqual(failedChecks(verifyHttpRun(asOfficialHttp(transcript), output, "answered")), [], question);
    }
  });

  test("a clean no-answer run verifies", async () => {
    const { transcript, output } = await httpRun(HTTP_QUERIES[2]);
    assert.equal(transcript.result.status, "no_answer");
    assert.deepEqual(failedChecks(verifyHttpRun(asOfficialHttp(transcript), output, "no_answer")), []);
  });

  test("refuses a run that went anywhere but docs.pharos.xyz", async () => {
    const { transcript, output } = await httpRun(HTTP_QUERIES[0]);
    assert.ok(failedChecks(verifyHttpRun(transcript, output, "answered")).includes("official docs only"));
  });

  test("refuses an answer with a value that is not in any fetched page", async () => {
    const { transcript, output } = await httpRun(HTTP_QUERIES[0]);
    const official = asOfficialHttp(transcript);
    official.result.answer = `${official.result.answer} The chain ID is 999999.`;
    assert.ok(failedChecks(verifyHttpRun(official, output, "answered")).includes("answer grounded in the fetched docs"));
  });

  test("refuses a source that was not read, a malformed ?ask= URL, a wrong status, a cached index", async () => {
    const { transcript, output } = await httpRun(HTTP_QUERIES[0]);
    const unread = asOfficialHttp(transcript);
    unread.result.sources.push({ title: "Hardhat", url: `${DOCS_ORIGIN}/developer-guide/hardhat` });
    assert.ok(failedChecks(verifyHttpRun(unread, output, "answered")).includes("sources are pages asked in this run"));

    const malformed = asOfficialHttp(transcript);
    malformed.requests[1]!.url = malformed.requests[1]!.url.replace("?ask=", "?q=");
    assert.ok(failedChecks(verifyHttpRun(malformed, output, "answered")).includes("?ask= requests well formed and bounded"));

    assert.ok(failedChecks(verifyHttpRun(asOfficialHttp(transcript), output, "no_answer")).includes("status is no_answer"));

    const cached = asOfficialHttp(transcript);
    cached.indexFromCache = true;
    assert.ok(failedChecks(verifyHttpRun(cached, output, "answered")).includes("index read live"));
  });

  test("a real-shape composed answer verifies with one direct source; follow-up links and text are refused", async () => {
    docs.set("/getting-started/network/atlantic-testnet", { answer: ATLANTIC_ASK_ANSWER });
    try {
      const { transcript, output } = await httpRun(HTTP_QUERIES[0]);
      const clean = asOfficialHttp(transcript);
      assert.equal(clean.result.answer, "The Atlantic testnet chain ID is 424242. See Atlantic Testnet.");
      assert.deepEqual(clean.result.sources.map((s) => s.url), [`${DOCS_ORIGIN}/getting-started/network/atlantic-testnet`]);
      assert.deepEqual(failedChecks(verifyHttpRun(clean, output, "answered")), []);

      // Pages linked only from the generated follow-up questions, relative and absolute: not sources.
      for (const url of [`${DOCS_ORIGIN}/developer-guide/hardhat`, `${DOCS_ORIGIN}/tooling-and-infrastructure/rpc`]) {
        const leaked = asOfficialHttp(transcript);
        leaked.result.sources.push({ title: "Follow-up", url });
        assert.ok(failedChecks(verifyHttpRun(leaked, `${output}${url}\n`, "answered")).includes("sources are pages asked in this run"), url);
      }

      // Answer text taken from the restated question or the follow-ups is not grounded, though it is in the body.
      const borrowed = asOfficialHttp(transcript);
      borrowed.result.answer = "Which canonical contracts are deployed on Pharos? Which tokens are listed in the token registry? How do bridges move assets between networks?";
      assert.ok(transcript.requests.some((r) => r.body?.includes("How do bridges move assets between networks?")));
      assert.ok(failedChecks(verifyHttpRun(borrowed, output, "answered")).includes("answer grounded in the fetched docs"));
    } finally {
      docs.reset();
    }
  });

  test("a multi-page run whose answers overlap verifies: shown once, grounded, both pages as sources", async () => {
    const question = HTTP_QUERIES[1];
    const body = (extra: string) =>
      `# ${question}\n\nInstall Foundry with foundryup, then run forge init. Deploy with forge create and --rpc-url; the chain ID is 424242.${extra}\n\n# Suggested Follow-up Questions:\n\n- [Hardhat?](/developer-guide/hardhat.md)\n`;
    docs.set("/developer-guide/foundry", { answer: body(" Verify it with forge verify-contract.") });
    docs.set("/getting-started/network/atlantic-testnet", { answer: body("") });
    try {
      const { transcript, output } = await httpRun(question);
      const official = asOfficialHttp(transcript);
      assert.equal(official.result.answer!.split("forge init").length - 1, 1, "the shared statement is shown once");
      assert.match(official.result.answer!, /forge verify-contract/);
      assert.equal(official.result.sources.length, 2);
      assert.deepEqual(failedChecks(verifyHttpRun(official, output, "answered")), []);
    } finally {
      docs.reset();
    }
  });
});
