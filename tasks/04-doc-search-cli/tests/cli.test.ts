import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ATLANTIC_ASK_ANSWER, startFakeDocs, type FakeDocs } from "./fake-docs.js";
import { startFakeMcp, type FakeMcp } from "./fake-mcp.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NOTE = "Note: --transport docs-http is a development transport (HTTPS GET to the docs' query interface), not MCP and not the Task 04 runtime.\n";
let mcp: FakeMcp;
let docs: FakeDocs;
let cacheDir: string;

before(async () => {
  mcp = await startFakeMcp();
  docs = await startFakeDocs();
  cacheDir = await mkdtemp(join(tmpdir(), "pharos-docs-cli-"));
});
after(async () => {
  await mcp.close();
  await docs.close();
  await rm(cacheDir, { recursive: true, force: true });
});
afterEach(() => {
  mcp.reset();
  docs.reset();
});

/** Run the real CLI binary against the fake Developer Docs MCP (and the fake docs site, for docs-http). Never throws on a non-zero exit. */
async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? "", PHAROS_DOCS_MCP_URL: mcp.url, PHAROS_DOCS_FETCH_ORIGIN: docs.url, PHAROS_DOCS_CACHE_DIR: cacheDir, ...env },
      timeout: 20_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const methods = () => mcp.requests.map((r) => r.rpc?.method);

describe("pharos-docs CLI: the Developer Docs MCP (default)", () => {
  test("answers through the Developer Docs MCP: Answer, numbered Sources, the MCP named in the last line", async () => {
    const { code, stdout, stderr } = await cli(["What is the Atlantic chain ID?", "--no-cache"]);
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    assert.match(stdout, /^Answer\n {2}The Atlantic testnet chain ID is 424242 \(test fixture\)\.\n\nSources\n01 {2}Atlantic Testnet\n {4}https:\/\/docs\.pharos\.xyz\/getting-started\/network\/atlantic-testnet\n\n/);
    assert.match(stdout, new RegExp(`\\nDeveloper Docs MCP \\(askQuestion\\) · 2 requests to ${escape(new URL(mcp.url).host)}/~gitbook/mcp · \\d+\\.\\d s\\n$`));
    assert.doesNotMatch(stdout, /\u001b\[/, "no ANSI escapes");
    assert.deepEqual(
      mcp.requests.map((r) => [r.httpMethod, r.rpc?.method, r.rpc?.params?.name ?? null]),
      [
        ["POST", "tools/list", null],
        ["POST", "tools/call", "askQuestion"],
      ],
    );
    assert.deepEqual(mcp.requests[1]!.rpc?.params?.arguments, { question: "What is the Atlantic chain ID?", goal: "Answer a developer question using the Pharos Developer Docs" });
    assert.equal(docs.requests.length, 0, "nothing goes over docs-http");
  });

  test("a how-to keeps its numbered steps and its command; each page it cites is a source", async () => {
    const { code, stdout } = await cli(["How do I deploy a contract with Foundry?", "--no-cache"]);
    assert.equal(code, 0);
    assert.match(stdout, /^Answer\n {2}To deploy a contract with Foundry \(test fixture\):\n\n {2}1\. Install Foundry with foundryup\.\n {2}2\. Deploy it with forge create/);
    assert.match(stdout, /\n {2}forge create src\/Counter\.sol:Counter --rpc-url \$RPC_URL --private-key \$PRIVATE_KEY\n/);
    assert.match(stdout, /\nSources\n01 {2}Foundry\n {4}https:\/\/docs\.pharos\.xyz\/developer-guide\/foundry\n02 {2}Atlantic Testnet\n {4}https:\/\/docs\.pharos\.xyz\/getting-started\/network\/atlantic-testnet\n/);
  });

  test("--json prints the stable result schema; meta says what answered and over what", async () => {
    const { code, stdout } = await cli(["What is the Atlantic chain ID?", "--json", "--no-cache"]);
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.deepEqual(Object.keys(result), ["schema", "status", "question", "answer", "sources", "reason", "suggestions", "error", "meta"]);
    assert.deepEqual(
      [result.schema, result.status, result.question, result.answer, result.reason, result.suggestions, result.error],
      ["pharos-docs-result/1", "answered", "What is the Atlantic chain ID?", "The Atlantic testnet chain ID is 424242 (test fixture).", null, [], null],
    );
    assert.deepEqual(result.sources, [{ title: "Atlantic Testnet", url: "https://docs.pharos.xyz/getting-started/network/atlantic-testnet" }]);
    assert.deepEqual(Object.keys(result.meta), ["tool", "version", "provider", "transport", "endpoint", "pagesConsulted", "requests", "elapsedMs"]);
    assert.deepEqual([result.meta.provider, result.meta.transport, result.meta.endpoint, result.meta.pagesConsulted, result.meta.requests], ["developer-docs-mcp", "docs-mcp", mcp.url, [], 2]);
  });

  test("a question the docs do not cover: no answer, exit 1, the pages the MCP listed as nearby topics", async () => {
    const { code, stdout } = await cli(["How do I deploy an Anchor program to Solana?", "--no-cache"]);
    assert.equal(code, 1);
    assert.match(
      stdout,
      /^No good answer found in the Pharos Developer Docs\.\n {2}The Pharos Developer Docs say they do not cover this\.\n\nNearby documented topics\n01 {2}Overview\n {4}https:\/\/docs\.pharos\.xyz\/getting-started\/overview\n02 {2}Foundry\n/,
    );
    assert.doesNotMatch(stdout, /^Answer$/m);
    const json = JSON.parse((await cli(["How do I deploy an Anchor program to Solana?", "--json"])).stdout);
    assert.deepEqual([json.status, json.answer, json.sources, json.reason, json.suggestions.length], ["no_answer", null, [], "not_in_docs", 2]);
  });

  test("a negative answer about Pharos itself is still an answer", async () => {
    const { code, stdout } = await cli(["Does Pharos support fixture blobs?", "--no-cache"]);
    assert.equal(code, 0);
    assert.match(stdout, /^Answer\n {2}No\. Pharos does not support fixture blobs/);
  });

  test("an answer that cites no docs.pharos.xyz page is not shown", async () => {
    mcp.answer("The Atlantic testnet chain ID is 424242 (test fixture).\n\n# Sources\n\n- [Blog](https://blog.example.invalid/chain)\n");
    const { code, stdout } = await cli(["What is the Atlantic chain ID?", "--no-cache"]);
    assert.equal(code, 1);
    assert.match(stdout, /^No good answer found in the Pharos Developer Docs\.\n {2}The docs answered without citing a docs\.pharos\.xyz page, so the answer is not shown\.\n/);
    assert.doesNotMatch(stdout, /424242|blog\.example/);
  });

  test("the MCP unreachable: exit 3, the reason on stderr, and no request anywhere else (no fallback)", async () => {
    const env = { PHAROS_DOCS_MCP_URL: "http://127.0.0.1:9/~gitbook/mcp", PHAROS_DOCS_CACHE_DIR: join(cacheDir, "none") };
    const { code, stdout, stderr } = await cli(["What is the Atlantic chain ID?", "--no-cache"], env);
    assert.equal(code, 3);
    assert.equal(stdout, "");
    assert.match(stderr, /^Error: Could not reach the Developer Docs MCP \(127\.0\.0\.1:9\)/);
    assert.match(stderr, /\nDeveloper Docs MCP \(askQuestion\) · 1 request to 127\.0\.0\.1:9\/~gitbook\/mcp · /);
    const json = JSON.parse((await cli(["What is the Atlantic chain ID?", "--json"], env)).stdout);
    assert.deepEqual([json.status, json.error.kind, json.answer, json.meta.provider, json.meta.transport], ["error", "upstream_unreachable", null, "developer-docs-mcp", "docs-mcp"]);
    assert.equal(docs.requests.length, 0, "docs-http is never tried");
  });

  test("an MCP that errors or answers badly: exit 3 with the reason, never an answer from elsewhere", async () => {
    for (const [mode, only, message] of [
      ["http-500", undefined, /answered HTTP 500/],
      ["rpc-error", "tools/call", /error -32603: Fixture failure/],
      ["no-message", "tools/call", /no message event/],
      ["is-error", "tools/call", /askQuestion reported an error/],
      ["no-ask-tool", undefined, /does not offer askQuestion/],
    ] as const) {
      mcp.reset();
      mcp.set(mode, only);
      const { code, stdout, stderr } = await cli(["What is the Atlantic chain ID?", "--no-cache"]);
      assert.equal(code, 3, mode);
      assert.equal(stdout, "", mode);
      assert.match(stderr, message, mode);
    }
    assert.equal(docs.requests.length, 0);
  });

  test("--timeout: a hanging MCP ends with exit 3 and the timeout named", async () => {
    mcp.set("hang", "tools/call");
    const { code, stderr } = await cli(["What is the Atlantic chain ID?", "--timeout", "1000"]);
    assert.equal(code, 3);
    assert.match(stderr, /No answer from the Developer Docs MCP \(127\.0\.0\.1:\d+\) within 1000 ms/);
  });

  test("the verified tool list is cached on disk: the next question only calls askQuestion; --no-cache lists again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-docs-tools-"));
    try {
      mcp.set("no-ask-tool");
      assert.equal((await cli(["What is the Atlantic chain ID?"], { PHAROS_DOCS_CACHE_DIR: dir })).code, 3);
      assert.deepEqual(await readdir(dir).catch(() => []), [], "a failed run caches nothing");
      mcp.reset();
      await cli(["What is the Atlantic chain ID?"], { PHAROS_DOCS_CACHE_DIR: dir });
      assert.deepEqual(methods(), ["tools/list", "tools/call"]);
      mcp.reset();
      const second = await cli(["How do I deploy a contract with Foundry?"], { PHAROS_DOCS_CACHE_DIR: dir });
      assert.equal(second.code, 0);
      assert.match(second.stdout, /· 1 request to /);
      assert.deepEqual(methods(), ["tools/call"]);
      mcp.reset();
      await cli(["What is the Atlantic chain ID?", "--no-cache"], { PHAROS_DOCS_CACHE_DIR: dir });
      assert.deepEqual(methods(), ["tools/list", "tools/call"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--verbose traces each JSON-RPC request; --transcript saves the requests, raw event streams, the answer and the result", async () => {
    const file = join(cacheDir, "mcp.json");
    const { code, stderr } = await cli(["What is the Atlantic chain ID?", "--no-cache", "--verbose", "--transcript", file]);
    assert.equal(code, 0);
    assert.match(stderr, /^\[tools\/list\] POST http:\/\/127\.0\.0\.1:\d+\/~gitbook\/mcp -> 200 text\/event-stream \d+\.\d kB \(\d+ ms\)$/m);
    assert.match(stderr, /^\[tools\/call askQuestion\] POST http:\/\/127\.0\.0\.1:\d+\/~gitbook\/mcp -> 200 text\/event-stream \d+\.\d kB \(\d+ ms\)$/m);
    const transcript = JSON.parse(await readFile(file, "utf8"));
    assert.equal(transcript.format, "pharos-docs-mcp-transcript/1");
    assert.deepEqual([transcript.provider, transcript.transport, transcript.endpoint, transcript.toolsFromCache], ["developer-docs-mcp", "docs-mcp", mcp.url, false]);
    assert.deepEqual(transcript.tools.map((tool: { name: string }) => tool.name), ["searchDocumentation", "getPage", "askQuestion", "sendFeedback"]);
    assert.equal(transcript.selectedTool, "askQuestion");
    assert.deepEqual(transcript.requests.map((r: { method: string; rpc: { method: string } }) => [r.method, r.rpc.method]), [["POST", "tools/list"], ["POST", "tools/call"]]);
    assert.match(transcript.requests[1].body, /^event: message\ndata: \{"jsonrpc":"2\.0","id":2,"result":\{"content":\[\{"type":"text","text":"The Atlantic testnet chain ID is 424242/);
    assert.equal(transcript.answer.tool, "askQuestion");
    assert.equal(transcript.answer.body, "The Atlantic testnet chain ID is 424242 (test fixture).");
    assert.equal(transcript.result.status, "answered");
    assert.doesNotMatch(JSON.stringify(transcript), /authorization|cookie|api[_-]?key|bearer/i, "no credentials in the transcript");
  });

  test("unquoted words form the question too", async () => {
    const { code, stdout } = await cli(["what", "is", "the", "Atlantic", "chain", "ID"]);
    assert.equal(code, 0);
    assert.match(stdout, /424242/);
  });

  test("missing question and bad options: exit 2 with a hint, and no request", async () => {
    for (const args of [[], ["--json"], ["   "], ["q", "--max-pages", "2"], ["q", "--transport", "mcp"], ["q", "--transport"], ["q", "--transport", "docs-http", "--max-pages", "9"], ["q", "--timeout", "x"], ["q", "--nope"]]) {
      const { code, stderr, stdout } = await cli(args);
      assert.equal(code, 2, args.join(" "));
      assert.match(stderr, /^Error: /);
      assert.equal(stdout, "");
    }
    assert.match((await cli(["q", "--max-pages", "2"])).stderr, /--max-pages applies to --transport docs-http only/);
    assert.equal(mcp.requests.length + docs.requests.length, 0, "no request for a bad invocation");
  });

  test("--help and --version", async () => {
    const help = await cli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage\n {2}pharos-docs "<question>" \[options\]/);
    assert.match(help.stdout, /The Pharos Developer Docs MCP at https:\/\/docs\.pharos\.xyz\/~gitbook\/mcp/);
    assert.match(help.stdout, /tools\/call askQuestion/);
    assert.match(help.stdout, /a development transport, not MCP, and never used unless asked for/);
    assert.equal((await cli(["--version"])).stdout, "pharos-docs 1.0.0\n");
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
});

describe("pharos-docs CLI: --transport docs-http (development only)", () => {
  test("says on stderr that it is a development transport, not MCP; meta says docs-http; the MCP is not called", async () => {
    const { code, stdout, stderr } = await cli(["What is the chain ID of the Atlantic testnet?", "--transport", "docs-http", "--no-cache"]);
    assert.equal(code, 0, stderr);
    assert.equal(stderr, NOTE);
    assert.match(stdout, /^Answer\n {2}Chain ID: 424242\n\nSources\n01 {2}Atlantic Testnet\n {4}https:\/\/docs\.pharos\.xyz\/getting-started\/network\/atlantic-testnet\n/);
    assert.match(stdout, /1 docs page asked · 2 HTTPS requests to docs\.pharos\.xyz · \d+\.\d s\n$/);
    const json = JSON.parse((await cli(["What is the chain ID of the Atlantic testnet?", "--transport", "docs-http", "--json"])).stdout);
    assert.deepEqual([json.meta.provider, json.meta.transport, json.meta.endpoint], ["docs-http", "docs-http", "https://docs.pharos.xyz"]);
    assert.equal(mcp.requests.length, 0);
  });

  test("a composed answer in the real ?ask= shape: no question heading, no follow-ups, one source", async () => {
    docs.set("/getting-started/network/atlantic-testnet", { answer: ATLANTIC_ASK_ANSWER });
    const { code, stdout, stderr } = await cli(["What is the chain ID of the Atlantic testnet?", "--transport", "docs-http", "--no-cache"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^Answer\n {2}The Atlantic testnet chain ID is 424242\. See Atlantic Testnet\.\n\nSources\n01 {2}Atlantic Testnet\n {4}https:\/\/docs\.pharos\.xyz\/getting-started\/network\/atlantic-testnet\n\n/);
    assert.doesNotMatch(stdout, /\n02 /, "exactly one source");
    assert.doesNotMatch(stdout, /What is the chain ID|Suggested|Follow-up|foundry|hardhat|token-registry|overview|rpc\b/i);
  });

  test("--json with several pages asked", async () => {
    const { code, stdout } = await cli(["How do I set up Foundry and deploy a contract to the Atlantic testnet?", "--transport", "docs-http", "--json"]);
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "answered");
    for (const source of result.sources) assert.match(source.url, /^https:\/\/docs\.pharos\.xyz\//);
    assert.equal(result.meta.transport, "docs-http");
    assert.equal(result.meta.pagesConsulted.length, 2);
  });

  test("no good answer: no matching page, or a value the page does not state", async () => {
    const none = await cli(["Who won the 2018 football world cup?", "--transport", "docs-http"]);
    assert.equal(none.code, 1);
    assert.match(none.stdout, /^No good answer found in the Pharos Developer Docs\.\n {2}No page in the Pharos Developer Docs matches this question\./);
    const value = await cli(["What is the chain ID of Pacific mainnet?", "--transport", "docs-http"]);
    assert.equal(value.code, 1);
    assert.match(value.stdout, /Nearby documented topics\n01 {2}Pacific Mainnet\n {4}https:\/\/docs\.pharos\.xyz\/getting-started\/network\/pacific-mainnet/);
  });

  test("docs unreachable: exit 3; a hanging page: the timeout named", async () => {
    const down = await cli(["What is the chain ID of the Atlantic testnet?", "--transport", "docs-http", "--no-cache"], { PHAROS_DOCS_FETCH_ORIGIN: "http://127.0.0.1:9", PHAROS_DOCS_CACHE_DIR: join(cacheDir, "none") });
    assert.equal(down.code, 3);
    assert.equal(down.stdout, "");
    assert.match(down.stderr, /^Note: .*\nError: Could not read the docs index \(\/sitemap\.md\): Could not reach 127\.0\.0\.1:9/);
    docs.set("/getting-started/network/atlantic-testnet", "hang");
    const slow = await cli(["What is the chain ID of the Atlantic testnet?", "--transport", "docs-http", "--timeout", "1000"]);
    assert.equal(slow.code, 3);
    assert.match(slow.stderr, /within 1000 ms/);
    assert.equal(mcp.requests.length, 0);
  });

  test("the index is cached on disk: the second question makes one request less", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-docs-cache2-"));
    try {
      await cli(["What is the chain ID of the Atlantic testnet?", "--transport", "docs-http"], { PHAROS_DOCS_CACHE_DIR: dir });
      const before = docs.requests.length;
      const second = await cli(["What is the chain ID of the Atlantic testnet?", "--transport", "docs-http"], { PHAROS_DOCS_CACHE_DIR: dir });
      assert.match(second.stdout, /2 HTTPS requests|1 HTTPS request/);
      assert.deepEqual(docs.requests.slice(before).map((r) => r.path), ["/getting-started/network/atlantic-testnet.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--verbose and --transcript: GET requests, labelled docs-http, not MCP", async () => {
    const file = join(cacheDir, "t.json");
    const { code, stderr } = await cli(["What is the chain ID of the Atlantic testnet?", "--transport", "docs-http", "--no-cache", "--verbose", "--transcript", file]);
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
          // pharos-task-NN.vercel.app: the other task pages, in the shared task manifest, links only.
          ["docs.pharos.xyz", "github.com", "www.w3.org", "localhost", "x.com"].includes(match[1]!.toLowerCase()) || /^pharos-task-\d\d\.vercel\.app$/.test(match[1]!.toLowerCase()),
          `${file}: unexpected host ${match[1]}`,
        );
      }
    }
  });

  test("docs-http never presents itself as MCP; the MCP path and the web endpoint never reach for docs-http", async () => {
    const read = (path: string) => readFile(join(ROOT, path), "utf8");
    const http = await read("src/providers/docs-http.ts");
    assert.match(http, /readonly name = "docs-http";\n {2}readonly transport = "docs-http";/);
    assert.doesNotMatch(http, /docs-mcp|McpHttpClient|~gitbook\/mcp/);
    for (const path of ["src/providers/developer-docs-mcp.ts", "src/providers/mcp-http.ts", "api/search.js"]) {
      assert.doesNotMatch(await read(path), /DocsHttpProvider|providers\/docs-http|sitemap|\?ask=|fetchOrigin/, path);
    }
    assert.doesNotMatch(await read("api/search.js"), /process\.env/, "the web endpoint cannot be pointed elsewhere by a setting");
    for (const { file, text } of await sourceFiles()) assert.doesNotMatch(text, /transport\s*[:=]\s*["']mcp["']/i, file);
  });

  test("no topic is hardcoded where answers are judged: the no-answer rule names no product, chain or question", async () => {
    for (const path of ["src/source-gate.ts", "src/search.ts", "src/text.ts", "src/formatter.ts", "src/run.ts", "src/providers/developer-docs-mcp.ts", "src/providers/mcp-http.ts", "api/search.js", "public/assets/search.js", "public/assets/command.js"]) {
      assert.doesNotMatch(await readFile(join(ROOT, path), "utf8"), /\b(?:anchor|solana)\b/i, path);
    }
  });

  test("no model, no external AI service", async () => {
    for (const { file, text } of await sourceFiles()) {
      assert.doesNotMatch(text, /deepseek|openai|anthropic\.com|api\.groq|generativelanguage/i, file);
    }
  });
});
