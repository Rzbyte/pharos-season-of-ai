import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { DOCS_ORIGIN } from "../src/constants.js";
import { applyProof, PROOF_QUERIES, verifyRun, type Transcript } from "../src/proof.js";
import { run } from "../src/run.js";
import { startFakeDocs, type FakeDocs } from "./fake-docs.js";

// Proof-shaped runs against the in-process fake docs site. Their URLs are rewritten to docs.pharos.xyz
// only so the verifier's other checks can be exercised; nothing here is, or is used as, live proof.
let fake: FakeDocs;
let dir: string;
before(async () => {
  fake = await startFakeDocs();
  dir = await mkdtemp(join(tmpdir(), "pharos-docs-proof-"));
});
after(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

async function proofRun(question: string): Promise<{ transcript: Transcript; output: string }> {
  const file = join(dir, `${Math.random()}.json`);
  let output = "";
  await run([question, "--no-cache", "--transcript", file], {
    stdout: (text) => void (output += text),
    stderr: (text) => void (output += text),
    env: { PHAROS_DOCS_FETCH_ORIGIN: fake.url, PHAROS_DOCS_CACHE_DIR: dir },
  });
  return { transcript: JSON.parse(await readFile(file, "utf8")) as Transcript, output };
}

/** The same run, as if it had gone to docs.pharos.xyz. */
function asOfficial(transcript: Transcript): Transcript {
  const copy = structuredClone(transcript);
  copy.fetchOrigin = DOCS_ORIGIN;
  for (const request of copy.requests) request.url = request.url.replace(fake.url, DOCS_ORIGIN);
  for (const page of copy.result.meta.pagesConsulted) page.requestUrl = page.requestUrl.replace(fake.url, DOCS_ORIGIN);
  return copy;
}
const failedChecks = (checks: ReturnType<typeof verifyRun>) => checks.filter((check) => !check.ok).map((check) => check.name);

describe("proof verifier", () => {
  test("the three README queries are a fact, a workflow and an unsupported question", () => {
    assert.deepEqual(PROOF_QUERIES.map((q) => q.expect), ["answered", "answered", "no_answer"]);
  });

  test("a clean answered run verifies, multi-page included", async () => {
    for (const query of PROOF_QUERIES.slice(0, 2)) {
      const { transcript, output } = await proofRun(query.question);
      assert.deepEqual(failedChecks(verifyRun(asOfficial(transcript), output, "answered")), [], query.question);
    }
  });

  test("a clean no-answer run verifies", async () => {
    const { transcript, output } = await proofRun(PROOF_QUERIES[2].question);
    assert.equal(transcript.result.status, "no_answer");
    assert.deepEqual(failedChecks(verifyRun(asOfficial(transcript), output, "no_answer")), []);
  });

  test("refuses a run that went anywhere but docs.pharos.xyz", async () => {
    const { transcript, output } = await proofRun(PROOF_QUERIES[0].question);
    assert.ok(failedChecks(verifyRun(transcript, output, "answered")).includes("official docs only"));
  });

  test("refuses an answer with a value that is not in any fetched page", async () => {
    const { transcript, output } = await proofRun(PROOF_QUERIES[0].question);
    const official = asOfficial(transcript);
    official.result.answer = `${official.result.answer} The chain ID is 999999.`;
    assert.ok(failedChecks(verifyRun(official, output, "answered")).includes("answer grounded in the fetched docs"));
  });

  test("refuses a source that was not read, a malformed ?ask= URL, a wrong status, a cached index", async () => {
    const { transcript, output } = await proofRun(PROOF_QUERIES[0].question);
    const unread = asOfficial(transcript);
    unread.result.sources.push({ title: "Hardhat", url: `${DOCS_ORIGIN}/developer-guide/hardhat` });
    assert.ok(failedChecks(verifyRun(unread, output, "answered")).includes("sources are official pages read in this run"));

    const malformed = asOfficial(transcript);
    malformed.requests[1]!.url = malformed.requests[1]!.url.replace("?ask=", "?q=");
    assert.ok(failedChecks(verifyRun(malformed, output, "answered")).includes("?ask= requests well formed and bounded"));

    assert.ok(failedChecks(verifyRun(asOfficial(transcript), output, "no_answer")).includes("status is no_answer"));

    const cached = asOfficial(transcript);
    cached.indexFromCache = true;
    assert.ok(failedChecks(verifyRun(cached, output, "answered")).includes("index read live"));
  });

  test("the real README has every marker, with the examples requirement still open", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    assert.match(readme, /- \[ \] \*\*README with installation, usage and at least 3 example queries with output\.\*\* <!-- req-examples -->/);
    const examples = PROOF_QUERIES.map((q) => ({ id: q.id, label: q.label, question: q.question, output: "Answer\n  x\n" }));
    const next = applyProof(readme, examples, "{}\n", ["**Live proof:** captured"]);
    assert.match(next, /- \[x\] \*\*README with installation/);
    assert.doesNotMatch(next, /_Pending `npm run proof`/);
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
    assert.match(next, /\$ pharos-docs "What is the chain ID of the Atlantic testnet\?" --json\n\{"status":"answered"\}/);
  });
});
