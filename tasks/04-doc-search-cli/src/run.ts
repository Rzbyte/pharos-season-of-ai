import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_PAGES, DEFAULT_TIMEOUT_MS, DOCS_ORIGIN, HARD_MAX_PAGES, TOOL_NAME, VERSION } from "./constants.js";
import { readIndexCache, writeIndexCache } from "./docs-index.js";
import { formatJson, formatRequest, formatText } from "./formatter.js";
import { DocsHttpProvider, type FetchLike } from "./providers/docs-http.js";
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
Search the official Pharos Developer Docs from one command. Answers come only from
docs.pharos.xyz, with the pages they come from; when the docs do not answer, it says so.

Usage
  pharos-docs "<question>" [options]

Examples
  pharos-docs "what is the Atlantic testnet chain ID?"
  pharos-docs "how do I deploy a contract with Foundry?"
  pharos-docs "how do I deploy a contract with Foundry?" --json

Options
      --json             Print the result as JSON (schema pharos-docs-result/1)
      --max-pages <n>    Ask at most n docs pages (1-${HARD_MAX_PAGES}). Default: ${DEFAULT_MAX_PAGES}
      --timeout <ms>     Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
      --no-cache         Re-read the docs index instead of using the local copy
  -v, --verbose          Print every docs request on stderr
      --transcript <f>   Save every request and the result as JSON (used by the proof)
  -h, --help             Show this help
      --version          Show the version

How it reads the docs
  HTTPS GET https://docs.pharos.xyz/sitemap.md for the page list, then
  HTTPS GET https://docs.pharos.xyz/<page>.md?ask=<question>&goal=<goal> for one or two pages.
  This is the docs' public dynamic query interface over HTTP, not MCP.

Exit codes
  0 answered, 1 no good answer in the docs, 2 bad usage, 3 docs unreachable or unreadable, 4 unexpected
`;

interface Options {
  question: string;
  json: boolean;
  maxPages: number;
  timeoutMs: number;
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

  // Tests point requests at a local fake; sources stay docs.pharos.xyz URLs either way.
  const fetchOrigin = io.env.PHAROS_DOCS_FETCH_ORIGIN?.trim() || DOCS_ORIGIN;
  const cacheFile = join(
    io.env.PHAROS_DOCS_CACHE_DIR?.trim() || join(io.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "pharos-docs"),
    `index-${createHash("sha256").update(fetchOrigin).digest("hex").slice(0, 12)}.json`,
  );
  const cached = options.cache ? await readIndexCache(cacheFile) : null;
  const provider = new DocsHttpProvider({
    fetchOrigin,
    timeoutMs: options.timeoutMs,
    fetch: io.fetch,
    index: cached ?? undefined,
    onRequest: options.verbose ? (record) => io.stderr(`${formatRequest(record)}\n`) : undefined,
  });
  const startedAt = new Date().toISOString();
  let result: SearchResult;
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

  if (options.json) io.stdout(formatJson(result));
  else if (result.status === "error") io.stderr(formatText(result));
  else io.stdout(formatText(result));

  if (options.transcript) {
    const file = options.transcript;
    const transcript = {
      format: "pharos-docs-transcript/1",
      about: "Every HTTPS request this run made to the Pharos docs, in order, then the result. These are plain HTTP GET requests to the public docs site, not MCP calls.",
      tool: { name: TOOL_NAME, version: VERSION },
      runtime: { node: process.version, platform: process.platform },
      transport: provider.transport,
      fetchOrigin,
      indexFromCache: cached !== null,
      startedAt,
      finishedAt: new Date().toISOString(),
      argv,
      requests: provider.requests(),
      result,
    };
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
  const options: Omit<Options, "question"> = { json: false, maxPages: DEFAULT_MAX_PAGES, timeoutMs: DEFAULT_TIMEOUT_MS, cache: true, verbose: false };
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
    else if (arg === "--max-pages") options.maxPages = whole(value(), arg, 1, HARD_MAX_PAGES);
    else if (arg === "--timeout") options.timeoutMs = whole(value(), arg, 1_000, 120_000);
    else if (arg === "--transcript") options.transcript = value();
    else if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) throw new Error(`Unknown option ${arg}.`);
    else words.push(arg);
  }
  const question = words.join(" ").trim();
  if (!question) throw new Error('Ask a question, for example: pharos-docs "how do I deploy a contract?"');
  return { question, ...options };
}

function whole(input: string, flag: string, min: number, max: number): number {
  const value = Number(input);
  if (!/^\d+$/.test(input) || value < min || value > max) throw new Error(`${flag} must be a whole number from ${min} to ${max}.`);
  return value;
}
