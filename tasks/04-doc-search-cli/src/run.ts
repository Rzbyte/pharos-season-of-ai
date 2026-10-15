import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ASK_TOOL, DEFAULT_MAX_PAGES, DEFAULT_TIMEOUT_MS, DOCS_ORIGIN, HARD_MAX_PAGES, MCP_ENDPOINT, MCP_TIMEOUT_MS, TOOL_NAME, VERSION } from "./constants.js";
import { readIndexCache, writeIndexCache } from "./docs-index.js";
import { formatJson, formatRequest, formatText } from "./formatter.js";
import { DeveloperDocsMcpProvider, readToolsCache, writeToolsCache } from "./providers/developer-docs-mcp.js";
import { DocsHttpProvider, type FetchLike } from "./providers/docs-http.js";
import type { DocsAnswer } from "./providers/provider.js";
import { search } from "./search.js";
import type { SearchResult } from "./types.js";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  /** Tests only: replaces global fetch. */
  fetch?: FetchLike;
}

/** 0 answered · 1 no good answer in the docs · 2 bad usage · 3 the docs could not be reached or read · 4 unexpected. */
export const EXIT = { answered: 0, no_answer: 1, usage: 2, upstream: 3, unexpected: 4 } as const;

const HELP = `${TOOL_NAME} ${VERSION}
Search the official Pharos Developer Docs from one command, through the Pharos Developer Docs MCP.
Answers come with the docs.pharos.xyz pages they cite; when the docs do not answer, it says so.

Usage
  pharos-docs "<question>" [options]

Examples
  pharos-docs "what is the Atlantic chain ID?"
  pharos-docs "how do I deploy a contract with Foundry?"
  pharos-docs "how do I deploy a contract with Foundry?" --json

Options
      --json             Print the result as JSON (schema pharos-docs-result/1)
      --timeout <ms>     Per-request timeout. Default: ${MCP_TIMEOUT_MS} (${DEFAULT_TIMEOUT_MS} with docs-http)
      --no-cache         List the MCP tools again instead of using the local copy
  -v, --verbose          Print every request on stderr
      --transcript <f>   Save every request, raw response and the result as JSON (used by the proof)
      --transport <t>    docs-mcp (default) or docs-http (development only, see below)
      --max-pages <n>    docs-http only: ask at most n docs pages (1-${HARD_MAX_PAGES}). Default: ${DEFAULT_MAX_PAGES}
  -h, --help             Show this help
      --version          Show the version

How it asks the docs
  The Pharos Developer Docs MCP at ${MCP_ENDPOINT} (MCP over Streamable HTTP):
  JSON-RPC tools/list to check that ${ASK_TOOL} is offered, then tools/call ${ASK_TOOL}
  with the question. The answer's Sources become the source links; only docs.pharos.xyz pages.
  --transport docs-http instead uses the docs' HTTP query interface (sitemap.md and
  <page>.md?ask=): a development transport, not MCP, and never used unless asked for.

Exit codes
  0 answered, 1 no good answer in the docs, 2 bad usage, 3 docs unreachable or unreadable, 4 unexpected
`;

interface Options {
  question: string;
  json: boolean;
  transport: "docs-mcp" | "docs-http";
  maxPages: number;
  timeoutMs: number | null;
  cache: boolean;
  verbose: boolean;
  transcript?: string;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let options: Options | "help" | "version";
  try {
    options = parse(argv);
  } catch (error) {
    io.stderr(`Error: ${(error as Error).message}\nRun pharos-docs --help for usage.\n`);
    return EXIT.usage;
  }
  if (options === "help") {
    io.stdout(HELP);
    return 0;
  }
  if (options === "version") {
    io.stdout(`${TOOL_NAME} ${VERSION}\n`);
    return 0;
  }

  const cacheDir = io.env.PHAROS_DOCS_CACHE_DIR?.trim() || join(io.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "pharos-docs");
  const onRequest = options.verbose ? (record: Parameters<typeof formatRequest>[0]) => io.stderr(`${formatRequest(record)}\n`) : undefined;
  const startedAt = new Date().toISOString();
  let result: SearchResult;
  let transcript: Record<string, unknown>;

  if (options.transport === "docs-mcp") {
    // Tests point requests at a local fake MCP server; sources stay docs.pharos.xyz URLs either way, and
    // the proof verifier refuses any endpoint but the official one.
    const endpoint = io.env.PHAROS_DOCS_MCP_URL?.trim() || MCP_ENDPOINT;
    const cacheFile = join(cacheDir, `mcp-tools-${createHash("sha256").update(endpoint).digest("hex").slice(0, 12)}.json`);
    const cached = options.cache ? await readToolsCache(cacheFile, endpoint) : null;
    const provider = new DeveloperDocsMcpProvider({ endpoint, timeoutMs: options.timeoutMs ?? MCP_TIMEOUT_MS, fetch: io.fetch, tools: cached ?? undefined, onRequest });
    let received: DocsAnswer | null = null;
    try {
      result = await search(options.question, { provider, onAnswer: (answer) => void (received = answer) });
    } catch (error) {
      io.stderr(`Error: ${(error as Error).message}\n`);
      return EXIT.unexpected;
    }
    const tools = provider.verifiedTools();
    if (!cached && tools && result.status !== "error") await writeToolsCache(cacheFile, endpoint, tools);
    transcript = {
      format: "pharos-docs-mcp-transcript/1",
      about: "Every JSON-RPC request this run POSTed to the Pharos Developer Docs MCP (Streamable HTTP), each raw response body as received, the answer as askQuestion returned it, and the result.",
      tool: { name: TOOL_NAME, version: VERSION },
      runtime: { node: process.version, platform: process.platform },
      provider: provider.name,
      transport: provider.transport,
      endpoint,
      toolsFromCache: provider.toolsFromCache,
      tools: tools ?? null,
      selectedTool: ASK_TOOL,
      startedAt,
      finishedAt: "",
      argv,
      requests: provider.requests(),
      answer: received,
      result,
    };
  } else {
    // Development transport, never chosen implicitly: say so where it cannot be missed.
    io.stderr("Note: --transport docs-http is a development transport (HTTPS GET to the docs' query interface), not MCP and not the Task 04 runtime.\n");
    const fetchOrigin = io.env.PHAROS_DOCS_FETCH_ORIGIN?.trim() || DOCS_ORIGIN;
    const cacheFile = join(cacheDir, `index-${createHash("sha256").update(fetchOrigin).digest("hex").slice(0, 12)}.json`);
    const cached = options.cache ? await readIndexCache(cacheFile) : null;
    const provider = new DocsHttpProvider({ fetchOrigin, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, fetch: io.fetch, index: cached ?? undefined, onRequest });
    try {
      result = await search(options.question, { provider, maxPages: options.maxPages });
    } catch (error) {
      io.stderr(`Error: ${(error as Error).message}\n`);
      return EXIT.unexpected;
    }
    if (!cached && result.status !== "error") {
      const pages = await provider.index().catch(() => null);
      if (pages) await writeIndexCache(cacheFile, pages);
    }
    transcript = {
      format: "pharos-docs-transcript/1",
      about: "Every HTTPS request this run made to the Pharos docs, in order, then the result. These are plain HTTP GET requests to the public docs site (the docs-http development transport), not MCP calls.",
      tool: { name: TOOL_NAME, version: VERSION },
      runtime: { node: process.version, platform: process.platform },
      transport: provider.transport,
      fetchOrigin,
      indexFromCache: cached !== null,
      startedAt,
      finishedAt: "",
      argv,
      requests: provider.requests(),
      result,
    };
  }

  if (options.json) io.stdout(formatJson(result));
  else if (result.status === "error") io.stderr(formatText(result));
  else io.stdout(formatText(result));

  if (options.transcript) {
    const file = options.transcript;
    transcript.finishedAt = new Date().toISOString();
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
    } catch (error) {
      io.stderr(`Error: could not write ${file}: ${(error as Error).message}\n`);
      return EXIT.unexpected;
    }
  }

  if (result.status === "answered") return EXIT.answered;
  if (result.status === "no_answer") return EXIT.no_answer;
  if (result.error?.kind === "usage") return EXIT.usage;
  return result.error?.kind === "unexpected" ? EXIT.unexpected : EXIT.upstream;
}

function parse(argv: string[]): Options | "help" | "version" {
  const words: string[] = [];
  const options: Omit<Options, "question"> = { json: false, transport: "docs-mcp", maxPages: DEFAULT_MAX_PAGES, timeoutMs: null, cache: true, verbose: false };
  let maxPagesGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value.`);
      i += 1;
      return next;
    };
    if (arg === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--version") return "version";
    if (arg === "--json") options.json = true;
    else if (arg === "-v" || arg === "--verbose") options.verbose = true;
    else if (arg === "--no-cache") options.cache = false;
    else if (arg === "--max-pages") {
      options.maxPages = whole(value(), arg, 1, HARD_MAX_PAGES);
      maxPagesGiven = true;
    } else if (arg === "--transport") {
      const transport = value();
      if (transport !== "docs-mcp" && transport !== "docs-http") throw new Error("--transport must be docs-mcp or docs-http.");
      options.transport = transport;
    }
    else if (arg === "--timeout") options.timeoutMs = whole(value(), arg, 1_000, 120_000);
    else if (arg === "--transcript") options.transcript = value();
    else if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) throw new Error(`Unknown option ${arg}.`);
    else words.push(arg);
  }
  const question = words.join(" ").trim();
  if (!question) throw new Error('Ask a question, for example: pharos-docs "how do I deploy a contract?"');
  if (maxPagesGiven && options.transport !== "docs-http") throw new Error("--max-pages applies to --transport docs-http only; the Developer Docs MCP chooses its own pages.");
  return { question, ...options };
}

function whole(input: string, flag: string, min: number, max: number): number {
  const value = Number(input);
  if (!/^\d+$/.test(input) || value < min || value > max) throw new Error(`${flag} must be a whole number from ${min} to ${max}.`);
  return value;
}
