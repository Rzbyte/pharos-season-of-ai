import { parseArgs } from "node:util";
import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { CHAIN_NAMES, DEFAULT_TIMEOUT_MS, DEFAULT_TOKEN, HOSTED_ENDPOINT, KNOWN_CONTRACTS, TOOL_NAME, VERSION } from "./constants.js";
import { FIELDS, readTokenState, type TokenState } from "./erc20.js";
import { CliError, errorMessage, shorten, toCliError, ToolCallError } from "./errors.js";
import { createStyle, formatTokenAmount, renderRows, sanitizeForTerminal, wrapText, type Style } from "./format.js";
import { McpRecorder, PharosMcp } from "./mcp-client.js";
import { buildTranscript, writeJsonFile, writeTextFile, type TranscriptOutcome } from "./transcript.js";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  /** Whether stdout is an interactive terminal (enables colors). */
  isTTY: boolean;
  /** Test hook: shorten the pause before re-reading a value at the same block. */
  retryDelayMs?: number;
}

interface Options {
  address: Address;
  endpoint: URL;
  json: boolean;
  verbose: boolean;
  timeoutMs: number;
  bearerToken?: string;
  transcriptPath?: string;
  saveOutputPath?: string;
}

interface Network {
  chainId: number;
  name?: string;
}

interface ContractLabel {
  text: string;
  /** known-address: verified label from constants.ts; on-chain: built from name() and symbol(). */
  source: "known-address" | "on-chain";
}

interface Report {
  endpoint: string;
  server?: string;
  network?: Network;
  token: TokenState;
  label: ContractLabel;
  toolCalls: number;
  elapsedMs: number;
  warnings: string[];
}

const HELP_TEXT = `${TOOL_NAME} ${VERSION}
Pharos Agent Arena Task 01: read a contract's state through the Pharos Chain MCP server.
Every chain read is an MCP tool call; nothing talks to JSON-RPC directly.

Usage
  npm start -- [token-address] [options]
  node dist/src/cli.js [token-address] [options]

Arguments
  token-address            ERC-20 contract to read. Default: Circle USDC Contract
                           on Pharos Mainnet, ${DEFAULT_TOKEN}

Options
  -e, --endpoint <url>     MCP endpoint. Default: $PHAROS_MCP_URL or ${HOSTED_ENDPOINT}
      --json               Print a JSON report (errors too) instead of the table
  -v, --verbose            Trace every MCP request and response on stderr
      --timeout <ms>       Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
      --transcript <file>  Save every raw MCP JSON-RPC message of this run (proof)
      --save-output <file> Save the printed output (without colors) to a file
      --no-color           Disable colors (NO_COLOR is honored as well)
  -h, --help               Show this help

Environment
  PHAROS_MCP_URL           Default MCP endpoint
  PHAROS_MCP_TOKEN         Bearer token for a custom self-hosted endpoint; never sent to mcp.pharos.xyz

Exit codes
  0 success, 1 unexpected error, 2 bad usage, 3 MCP connection failed,
  4 required MCP tools missing, 5 contract read failed
`;

/** Entry point shared by the bin script and the tests. Returns the process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const wantsJson = argv.includes("--json");
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  const style = createStyle(io.isTTY && !wantsJson && !io.env.NO_COLOR && !argv.includes("--no-color"));

  let options: Options;
  try {
    const parsed = parseOptions(argv, io);
    if (parsed === "help") {
      io.stdout(HELP_TEXT);
      return 0;
    }
    options = parsed;
  } catch (error) {
    return reportFailure(toCliError(error), io, style, wantsJson, verbose);
  }
  if (io.env.PHAROS_MCP_TOKEN?.trim() && !options.bearerToken) {
    io.stderr("Note: PHAROS_MCP_TOKEN is not sent to the hosted endpoint, which needs no key.\n");
  }

  const recorder = new McpRecorder();
  let outcome: TranscriptOutcome | undefined;
  try {
    const report = await collect(options, io, style, recorder);
    const jsonReport = toJsonReport(report);
    const json = options.json ? `${JSON.stringify(jsonReport, null, 2)}\n` : undefined;
    outcome = { ok: true, report: jsonReport };
    io.stdout(json ?? renderReport(report, style));

    // Transcript first: it is the stronger proof, so it should survive a failure to write the output file.
    if (options.transcriptPath) await saveTranscript(options, recorder, outcome, io);
    if (options.saveOutputPath) {
      const path = options.saveOutputPath;
      await save(path, () => writeTextFile(path, json ?? renderReport(report, createStyle(false))));
      io.stderr(`Saved output: ${path}\n`);
    }
    return 0;
  } catch (error) {
    const failure = toCliError(error);
    if (options.transcriptPath && !outcome) {
      const failed: TranscriptOutcome = { ok: false, error: { kind: failure.kind, message: failure.message, hint: failure.hint ?? null } };
      await saveTranscript(options, recorder, failed, io).catch((saveError: unknown) => io.stderr(`${errorMessage(saveError)}\n`));
    }
    return reportFailure(failure, io, style, wantsJson, verbose);
  }
}

async function collect(options: Options, io: Io, style: Style, recorder: McpRecorder): Promise<Report> {
  const started = performance.now();
  const trace = options.verbose ? (line: string) => io.stderr(`${style.dim(`[mcp] ${sanitizeForTerminal(line, 400)}`)}\n`) : undefined;
  const mcp = new PharosMcp(options.endpoint, { timeoutMs: options.timeoutMs, bearerToken: options.bearerToken, trace, recorder });

  try {
    await mcp.connect();

    // No tools/list preflight: each tool is called by its known name, and a tool the server
    // lacks fails its own call with MCP_TOOLS_MISSING (exit 4).
    const warnings: string[] = [];
    // Chain info is context for the output, not a requirement: a failure becomes a warning.
    const chainInfo = mcp.call<unknown>("get_chain_info", {}).catch((error: unknown) => {
      if (error instanceof CliError && error.kind === "MCP_CONNECTION") throw error;
      // Not offered at all: labelContract() already warns that the chain ID went unconfirmed.
      if (error instanceof CliError && error.kind === "MCP_TOOLS_MISSING") return undefined;
      const detail = error instanceof ToolCallError ? error.detail : errorMessage(error);
      warnings.push(`get_chain_info failed (${detail}), so the network is shown as unknown.`);
      return undefined;
    });
    const [blockPayload, chainPayload] = await Promise.all([mcp.call<unknown>("get_block_number", {}), chainInfo]);

    const blockNumber = parseBlockNumber(blockPayload);
    const network = parseChainInfo(chainPayload, warnings);
    const token = await readTokenState(mcp, options.address, blockNumber, { retryDelayMs: io.retryDelayMs });

    return {
      endpoint: options.endpoint.href,
      server: mcp.serverLabel,
      network,
      token,
      label: labelContract(token, network, warnings),
      toolCalls: mcp.toolCalls,
      elapsedMs: Math.round(performance.now() - started),
      warnings,
    };
  } finally {
    await mcp.close();
  }
}

/**
 * The verified label for a known address ("Circle USDC Contract"), applied only when all three hold:
 * the address matches, the endpoint CONFIRMED the expected chain ID via get_chain_info, and symbol()
 * matches. Otherwise a label built from the token's own on-chain name and symbol, with a warning,
 * so an address can never be shown under a name the run did not verify.
 */
function labelContract(token: TokenState, network: Network | undefined, warnings: string[]): ContractLabel {
  const onChain: ContractLabel = { text: `${tokenTitle(token)} token contract`, source: "on-chain" };
  const known = KNOWN_CONTRACTS[token.address.toLowerCase()];
  if (!known) return onChain;
  if (network?.chainId !== known.chainId) {
    warnings.push(
      network
        ? `${token.address} is the ${known.label} on chain ID ${known.chainId}, but this endpoint serves chain ID ${network.chainId}, so it is labelled from its on-chain name instead.`
        : `The endpoint did not confirm the chain ID (get_chain_info unavailable), so ${token.address} is labelled from its on-chain name instead of "${known.label}".`,
    );
    return onChain;
  }
  if (token.symbol !== known.symbol) {
    warnings.push(
      `${token.address} is listed as the ${known.label}, but symbol() returned "${sanitizeForTerminal(token.symbol, 32)}" instead of "${known.symbol}", so it is labelled from its on-chain name instead.`,
    );
    return onChain;
  }
  return { text: known.label, source: "known-address" };
}

/** "USD Coin (USDC)", or just "USDC" when name and symbol match or one of them is empty. */
function tokenTitle(token: TokenState): string {
  const name = sanitizeForTerminal(token.name);
  const symbol = sanitizeForTerminal(token.symbol, 32);
  if (name && symbol && name !== symbol) return `${name} (${symbol})`;
  return symbol || name || "unnamed";
}

async function saveTranscript(options: Options, recorder: McpRecorder, outcome: TranscriptOutcome, io: Io): Promise<void> {
  const path = options.transcriptPath!;
  await save(path, () => writeJsonFile(path, buildTranscript(recorder, options.endpoint.href, outcome)));
  io.stderr(`Saved MCP transcript: ${path} (${recorder.messages.length} JSON-RPC messages)\n`);
}

async function save(path: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    throw new CliError("UNEXPECTED", `Could not write ${path}: ${errorMessage(error)}`, "Check that the folder is writable.", error);
  }
}

// ---------------------------------------------------------------------------
// Argument parsing

function parseOptions(argv: string[], io: Io): Options | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        endpoint: { type: "string", short: "e" },
        json: { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        timeout: { type: "string" },
        transcript: { type: "string" },
        "save-output": { type: "string" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    // Node's parseArgs messages carry a long second sentence; the first one is the useful part.
    const firstSentence = errorMessage(error).split(". ")[0] ?? "Invalid arguments";
    throw new CliError("USAGE", `${shorten(firstSentence, 160)}.`, "Run with --help to see the available options.");
  }

  const { values, positionals } = parsed;
  if (values.help) return "help";
  if (positionals.length > 1) {
    throw new CliError("USAGE", `Expected at most one contract address, got ${positionals.length}.`, "Run with --help to see usage.");
  }

  const endpoint = parseEndpoint(values.endpoint ?? (io.env.PHAROS_MCP_URL || HOSTED_ENDPOINT));
  return {
    address: parseAddress(positionals[0] ?? DEFAULT_TOKEN),
    endpoint,
    json: values.json ?? false,
    verbose: values.verbose ?? false,
    timeoutMs: parseTimeout(values.timeout),
    bearerToken: bearerTokenFor(endpoint, io.env),
    transcriptPath: parsePath(values.transcript, "--transcript"),
    saveOutputPath: parsePath(values["save-output"], "--save-output"),
  };
}

/**
 * The hosted Pharos endpoint is public and takes no key, so PHAROS_MCP_TOKEN is never sent to its
 * host (any scheme, port or path). The token exists only for custom, self-hosted endpoints.
 */
export function bearerTokenFor(endpoint: URL, env: Record<string, string | undefined>): string | undefined {
  if (endpoint.hostname === new URL(HOSTED_ENDPOINT).hostname) return undefined;
  return env.PHAROS_MCP_TOKEN?.trim() || undefined;
}

function parseAddress(input: string): Address {
  const value = input.trim();
  if (isAddress(value)) return getAddress(value);
  if (isAddress(value, { strict: false })) {
    throw new CliError(
      "USAGE",
      `Address checksum mismatch: ${value}`,
      "Mixed-case addresses must match their EIP-55 checksum, so this is probably a typo. Re-copy it, or pass it in all lowercase.",
    );
  }
  throw new CliError("USAGE", `Not a valid EVM address: ${shorten(value, 80)}`, "Expected 0x followed by 40 hex characters.");
}

function parseEndpoint(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError("USAGE", `Invalid endpoint URL: ${shorten(input, 120)}`, `Example: ${HOSTED_ENDPOINT}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError("USAGE", `Endpoint must be an http(s) URL, got ${url.protocol}`, `Example: ${HOSTED_ENDPOINT}`);
  }
  return url;
}

function parseTimeout(input: string | undefined): number {
  if (input === undefined) return DEFAULT_TIMEOUT_MS;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1_000 || value > 600_000) {
    throw new CliError("USAGE", `--timeout must be a whole number of milliseconds between 1000 and 600000, got ${shorten(input, 40)}.`);
  }
  return value;
}

function parsePath(input: string | undefined, flag: string): string | undefined {
  if (input === undefined) return undefined;
  if (input.trim() === "") throw new CliError("USAGE", `${flag} needs a file path.`);
  return input;
}

// ---------------------------------------------------------------------------
// MCP payload parsing

function parseBlockNumber(payload: unknown): bigint {
  const record = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const { blockNumber, blockNumberHex } = record;
  if (typeof blockNumber === "string" && /^\d+$/.test(blockNumber)) return BigInt(blockNumber);
  if (typeof blockNumber === "number" && Number.isSafeInteger(blockNumber) && blockNumber >= 0) return BigInt(blockNumber);
  if (typeof blockNumberHex === "string" && /^0x[0-9a-fA-F]+$/.test(blockNumberHex)) return BigInt(blockNumberHex);
  throw new CliError("MCP_TOOL_ERROR", `get_block_number returned an unexpected payload: ${shorten(JSON.stringify(payload) ?? "undefined", 160)}`);
}

function parseChainInfo(payload: unknown, warnings: string[]): Network | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const { chainId, chainIdMatches, expectedChainId } = payload as Record<string, unknown>;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) return undefined;
  if (chainIdMatches === false) {
    warnings.push(`The server's upstream RPC reports chain ID ${chainId}, but the server expects ${String(expectedChainId)}.`);
  }
  return { chainId, name: CHAIN_NAMES[chainId] };
}

function describeNetwork(network: Network): string {
  return network.name ? `${network.name} (chain ID ${network.chainId})` : `chain ID ${network.chainId}`;
}

// ---------------------------------------------------------------------------
// Output

function renderReport(report: Report, style: Style): string {
  const { token } = report;
  const symbol = sanitizeForTerminal(token.symbol, 32);
  const block = token.blockNumber.toString();

  const rows: Array<readonly [string, string] | null> = [
    ["Contract", style.bold(report.label.text)],
    ["Contract address", style.cyan(token.address)],
    ["Read at block", style.bold(block)],
    ["Network", report.network ? describeNetwork(report.network) : style.dim("unknown")],
    ["Data source", `Pharos Chain MCP${report.server ? style.dim(` (server: ${sanitizeForTerminal(report.server, 60)})`) : ""}`],
    ["", report.endpoint],
    null,
    ["Token name", sanitizeForTerminal(token.name)],
    ["Symbol", symbol],
    ["Decimals", String(token.decimals)],
    ["Total supply", `${style.bold(formatTokenAmount(token.totalSupply, token.decimals))} ${symbol}`],
    ["", style.dim(`raw value ${token.totalSupply}, divided by 10^${token.decimals}`)],
  ];

  const calls = FIELDS.map((field) => `${field}()`).join(", ");
  const seconds = (report.elapsedMs / 1000).toFixed(2);
  const lines = [
    style.bold("Pharos Contract State Reader"),
    "",
    renderRows(rows, style),
    "",
    wrapText(`In plain words: ${plainSummary(report)}`, 76),
    "",
    style.dim(wrapText(`Read with MCP eth_call at block ${block}: ${calls}. ${report.toolCalls} MCP tool calls in ${seconds}s.`, 76)),
  ];
  if (token.retried.length > 0) {
    lines.push(style.dim(wrapText(`Retried once at the same block after a transient error: ${token.retried.map((field) => `${field}()`).join(", ")}.`, 76)));
  }
  if (report.warnings.length > 0) {
    lines.push("");
    for (const warning of report.warnings) lines.push(style.yellow(`  ! ${sanitizeForTerminal(warning, 400)}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Two sentences a non-developer can read, built only from values read in this run. */
function plainSummary(report: Report): string {
  const { token, label } = report;
  const symbol = sanitizeForTerminal(token.symbol, 32);
  const where = `${report.network?.name ?? "Pharos"} block ${token.blockNumber}`;
  const supply = `${formatTokenAmount(token.totalSupply, token.decimals)} ${symbol}`;
  const decimals =
    token.decimals === 0
      ? "The contract uses 0 decimals, so its raw value is already the token amount."
      : `The contract stores amounts as whole numbers with ${token.decimals} decimals, so its raw value ${token.totalSupply} is divided by 10^${token.decimals} to get that figure.`;
  return `At ${where}, the ${label.text} reports a total supply of ${supply}. ${decimals}`;
}

function renderFailure(error: CliError, style: Style, verbose: boolean): string {
  const lines = [`${style.red(style.bold("Error:"))} ${sanitizeForTerminal(error.message, 400)}`];
  if (error.hint) lines.push(`${style.dim("Hint:")}  ${sanitizeForTerminal(error.hint, 400)}`);
  if (error.kind === "UNEXPECTED") {
    const detail = error.cause instanceof Error ? error.cause.stack : undefined;
    if (verbose && detail) lines.push(style.dim(detail));
    else lines.push(`${style.dim("Hint:")}  Rerun with --verbose for the full MCP trace.`);
  }
  return `${lines.join("\n")}\n`;
}

function reportFailure(failure: CliError, io: Io, style: Style, json: boolean, verbose: boolean): number {
  if (json) {
    io.stdout(`${JSON.stringify({ ok: false, error: { kind: failure.kind, message: failure.message, hint: failure.hint ?? null, exitCode: failure.exitCode } }, null, 2)}\n`);
  } else {
    io.stderr(renderFailure(failure, style, verbose));
  }
  return failure.exitCode;
}

function toJsonReport(report: Report) {
  const { token } = report;
  return {
    ok: true,
    contract: { address: token.address, label: report.label.text, labelSource: report.label.source },
    blockNumber: token.blockNumber.toString(),
    network: report.network ? { chainId: report.network.chainId, name: report.network.name ?? null } : null,
    source: { via: "Pharos Chain MCP", endpoint: report.endpoint, server: report.server ?? null, toolCalls: report.toolCalls },
    values: {
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      totalSupply: { raw: token.totalSupply.toString(), formatted: formatUnits(token.totalSupply, token.decimals) },
    },
    summary: plainSummary(report),
    retriedAtSameBlock: token.retried,
    warnings: report.warnings,
    elapsedMs: report.elapsedMs,
  };
}
