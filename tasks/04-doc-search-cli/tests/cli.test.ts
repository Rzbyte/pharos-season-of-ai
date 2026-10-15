import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ATLANTIC_ASK_ANSWER, startFakeDocs, type FakeDocs } from "./fake-docs.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let fake: FakeDocs;
let cacheDir: string;

before(async () => {
  fake = await startFakeDocs();
  cacheDir = await mkdtemp(join(tmpdir(), "pharos-docs-cli-"));
});
after(async () => {
  await fake.close();
  await rm(cacheDir, { recursive: true, force: true });
});
afterEach(() => fake.reset());

/** Run the real CLI binary against the fake docs site. Never throws on a non-zero exit. */
async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? "", PHAROS_DOCS_FETCH_ORIGIN: fake.url, PHAROS_DOCS_CACHE_DIR: cacheDir, ...env },
      timeout: 20_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe("pharos-docs CLI", () => {
  test("answers a natural-language question: Answer, then numbered Sources", async () => {
    const { code, stdout, stderr } = await cli(["What is the chain ID of the Atlantic testnet?", "--no-cache"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^Answer\n {2}Chain ID: 424242\n\nSources/m);
    assert.match(stdout, /\nSources\n01 {2}Atlantic Testnet\n {4}https:\/\/docs\.pharos\.xyz\/getting-started\/network\/atlantic-testnet\n/);
    assert.match(stdout, /1 docs page asked · 2 HTTPS requests to docs\.pharos\.xyz · \d+\.\d s\n$/);
    assert.doesNotMatch(stdout, /\u001b\[/, "no ANSI escapes");
  });

  test("a composed answer in the real ?ask= shape: no question heading, no follow-ups, one source", async () => {
    fake.set("/getting-started/network/atlantic-testnet", { answer: ATLANTIC_ASK_ANSWER });
    const { code, stdout, stderr } = await cli(["What is the chain ID of the Atlantic testnet?", "--no-cache"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^Answer\n {2}The Atlantic testnet chain ID is 424242\. See Atlantic Testnet\.\n\nSources\n01 {2}Atlantic Testnet\n {4}https:\/\/docs\.pharos\.xyz\/getting-started\/network\/atlantic-testnet\n\n/);
    assert.doesNotMatch(stdout, /\n02 /, "exactly one source");
    assert.doesNotMatch(stdout, /What is the chain ID|Suggested|Follow-up|foundry|hardhat|token-registry|overview|rpc\b/i);
  });

  test("probe and proof create proof/ and sample-output/ when missing", async () => {
    // Run each script in an empty directory with fetch stubbed to fail, so nothing reaches the network.
    const offline = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new Error("offline (test)"); };')}`;
    for (const [script, dirs] of [["probe.js", ["proof"]], ["run-proof.js", ["proof", "sample-output"]]] as const) {
      const cwd = await mkdtemp(join(tmpdir(), "pharos-docs-dirs-"));
      try {
        const file = fileURLToPath(new URL(`../src/${script}`, import.meta.url));
        const code = await new Promise<number | null>((resolve) =>
          execFile(process.execPath, ["--import", offline, file], { cwd, env: { PATH: process.env.PATH ?? "", PHAROS_DOCS_CACHE_DIR: cwd }, timeout: 20_000 }, (error) =>
            resolve(error ? ((error as { code?: number }).code ?? null) : 0),
          ),
        );
        assert.equal(code, 1, `${script} reports the failed run`);
        for (const dir of dirs) assert.ok((await readdir(join(cwd, dir))).length > 0, `${script} wrote into ${dir}/`);
        assert.deepEqual((await readdir(cwd)).filter((name) => name === "README.md"), [], "a failed proof writes no README");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  test("unquoted words form the question too", async () => {
    const { code, stdout } = await cli(["what", "is", "the", "Atlantic", "testnet", "chain", "ID"]);
    assert.equal(code, 0);
    assert.match(stdout, /424242/);
  });

  test("--json prints the stable result schema", async () => {
    const { code, stdout } = await cli(["How do I set up Foundry and deploy a contract to the Atlantic testnet?", "--json"]);
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.deepEqual(Object.keys(result), ["schema", "status", "question", "answer", "sources", "reason", "suggestions", "error", "meta"]);
    assert.equal(result.schema, "pharos-docs-result/1");
    assert.equal(result.status, "answered");
    assert.equal(result.question, "How do I set up Foundry and deploy a contract to the Atlantic testnet?");
    assert.equal(typeof result.answer, "string");
    for (const source of result.sources) {
      assert.deepEqual(Object.keys(source), ["title", "url"]);
      assert.match(source.url, /^https:\/\/docs\.pharos\.xyz\//);
    }
    assert.equal(result.meta.transport, "docs-http");
    assert.equal(result.meta.pagesConsulted.length, 2);
  });

  test("no good answer: says so, exit 1, never an invented answer", async () => {
    const { code, stdout } = await cli(["Who won the 2018 football world cup?"]);
    assert.equal(code, 1);
    assert.match(stdout, /^No good answer found in the Pharos Developer Docs\.\n {2}No page in the Pharos Developer Docs matches this question\./);
    assert.doesNotMatch(stdout, /^Answer$/m);
    const json = JSON.parse((await cli(["Who won the 2018 football world cup?", "--json"])).stdout);
    assert.deepEqual([json.status, json.answer, json.sources, json.reason], ["no_answer", null, [], "no_matching_page"]);
  });

  test("a value the docs do not state is a no-answer with nearby topics", async () => {
    const { code, stdout } = await cli(["What is the chain ID of Pacific mainnet?"]);
    assert.equal(code, 1);
    assert.match(stdout, /No good answer found/);
    assert.match(stdout, /Nearby documented topics\n01 {2}Pacific Mainnet\n {4}https:\/\/docs\.pharos\.xyz\/getting-started\/network\/pacific-mainnet/);
  });

  test("missing question and bad options: exit 2 with a hint", async () => {
    for (const args of [[], ["--json"], ["   "], ["q", "--max-pages", "9"], ["q", "--timeout", "x"], ["q", "--nope"]]) {
      const { code, stderr, stdout } = await cli(args);
      assert.equal(code, 2, args.join(" "));
      assert.match(stderr, /^Error: /);
      assert.equal(stdout, "");
    }
    assert.equal(fake.requests.length, 0, "no request for a bad invocation");
  });

  test("--help and --version", async () => {
    const help = await cli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage\n {2}pharos-docs "<question>" \[options\]/);
    assert.match(help.stdout, /not MCP/);
    assert.equal((await cli(["--version"])).stdout, "pharos-docs 1.0.0\n");
  });

  test("docs unreachable: an error on stderr, exit 3", async () => {
    const { code, stdout, stderr } = await cli(["What is the chain ID of the Atlantic testnet?", "--no-cache"], { PHAROS_DOCS_FETCH_ORIGIN: "http://127.0.0.1:9", PHAROS_DOCS_CACHE_DIR: join(cacheDir, "none") });
    assert.equal(code, 3);
    assert.equal(stdout, "");
    assert.match(stderr, /^Error: Could not read the docs index \(\/sitemap\.md\): Could not reach 127\.0\.0\.1:9/);
  });

  test("--timeout: a hanging page ends with exit 3 and the timeout named", async () => {
    fake.set("/getting-started/network/atlantic-testnet", "hang");
    const { code, stderr } = await cli(["What is the chain ID of the Atlantic testnet?", "--timeout", "1000"]);
    assert.equal(code, 3);
    assert.match(stderr, /within 1000 ms/);
  });

  test("the index is cached on disk: the second question makes one request less", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-docs-cache2-"));
    try {
      await cli(["What is the chain ID of the Atlantic testnet?"], { PHAROS_DOCS_CACHE_DIR: dir });
      const before = fake.requests.length;
      const second = await cli(["What is the chain ID of the Atlantic testnet?"], { PHAROS_DOCS_CACHE_DIR: dir });
      assert.match(second.stdout, /2 HTTPS requests|1 HTTPS request/);
      assert.deepEqual(fake.requests.slice(before).map((r) => r.path), ["/getting-started/network/atlantic-testnet.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--verbose traces each request on stderr; --transcript saves requests, bodies and result", async () => {
    const file = join(cacheDir, "t.json");
    const { code, stderr } = await cli(["What is the chain ID of the Atlantic testnet?", "--no-cache", "--verbose", "--transcript", file]);
    assert.equal(code, 0);
    assert.match(stderr, /^\[index\] GET http:\/\/127\.0\.0\.1:\d+\/sitemap\.md -> 200 text\/markdown/m);
    assert.match(stderr, /^\[ask\] GET .*atlantic-testnet\.md\?ask=What%20is%20the%20chain%20ID/m);
    const transcript = JSON.parse(await readFile(file, "utf8"));
    assert.equal(transcript.format, "pharos-docs-transcript/1");
    assert.equal(transcript.transport, "docs-http");
    assert.match(transcript.about, /not MCP calls/);
    assert.equal(transcript.requests.length, 2);
    assert.match(transcript.requests[1].body, /424242/);
    assert.equal(transcript.result.status, "answered");
  });
});

describe("what the code never does", () => {
  async function sourceFiles(): Promise<Array<{ file: string; text: string }>> {
    const files: Array<{ file: string; text: string }> = [];
    for (const dir of ["src", "src/providers", "api", "public", "public/assets"]) {
      let names: string[] = [];
      try {
        names = await readdir(join(ROOT, dir));
      } catch {
        continue;
      }
      for (const name of names.filter((n) => /\.(ts|js|mjs|html|css)$/.test(n))) files.push({ file: `${dir}/${name}`, text: await readFile(join(ROOT, dir, name), "utf8") });
    }
    return files;
  }

  test("no network value is hardcoded: no addresses, chain IDs, RPC or other endpoints besides the docs site", async () => {
    for (const { file, text } of await sourceFiles()) {
      assert.doesNotMatch(text, /\b0x[0-9a-fA-F]{40}\b/, `${file}: a contract address`);
      assert.doesNotMatch(text, /chain\s*id\s*[:=]?\s*\d{3,}/i, `${file}: a chain ID`);
      assert.doesNotMatch(text, /\b(?:1672|688688|688689)\b/, `${file}: a Pharos chain ID`);
      for (const match of text.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)) {
        assert.ok(
          // localhost: only the base for parsing a request's own path in api/search.js, never requested.
          // x.com: the author's profile in the shared footer, a link, never requested.
          ["docs.pharos.xyz", "github.com", "www.w3.org", "localhost", "x.com"].includes(match[1]!.toLowerCase()),
          `${file}: unexpected host ${match[1]}`,
        );
      }
    }
  });

  test("HTTP requests are never labelled as MCP", async () => {
    for (const { file, text } of await sourceFiles()) {
      assert.doesNotMatch(text, /transport\s*[:=]\s*["']mcp["']/i, file);
      assert.doesNotMatch(text, /\b(?:via|through|over) (?:the )?(?:Developer Docs )?MCP\b(?! endpoint)/i, `${file} claims MCP`);
    }
  });

  test("no model, no external AI service", async () => {
    for (const { file, text } of await sourceFiles()) {
      assert.doesNotMatch(text, /deepseek|openai|anthropic\.com|api\.groq|generativelanguage/i, file);
    }
  });
});
