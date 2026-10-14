import { parseArgs } from "node:util";
import {
  CHAIN_NAME,
  DEFAULT_FINITE_BLOCKS,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_MS,
  EXPECTED_CHAIN_ID,
  HOSTED_ENDPOINT,
  MAX_BLOCK_RANGE,
  MAX_SCAN_BLOCKS,
  TOOL_NAME,
  TOOLS,
  TRANSFER_EVENT,
  TRANSFER_TOPIC,
  VERSION,
  WATCHED_TOKEN,
} from "./constants.js";
import { CliError, errorMessage, shorten, toCliError, ToolCallError } from "./errors.js";
import { createStyle, renderRows, sanitizeForTerminal, type Style } from "./format.js";
import { McpRecorder, PharosMcp, type ToolCaller } from "./mcp-client.js";
import { TransferMonitor, type Malformed, type PollResult, type Retraction } from "./monitor.js";
import { buildTranscript, writeJsonFile, writeTextFile, type TranscriptOutcome } from "./transcript.js";
import type { TransferEvent } from "./transfer.js";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  /** Whether stdout is an interactive terminal (enables colors). */
  isTTY: boolean;
  /** Aborted on Ctrl+C: the current poll finishes, then the monitor stops and prints its summary. */
  signal?: AbortSignal;
  /** Test hook: replaces the wait between polls. Must resolve early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test hook: shorten the pause before repeating a failed get_logs range. */
  retryDelayMs?: number;
}

type Mode = { kind: "finite"; from?: bigint; to?: bigint; blocks: bigint } | { kind: "watch"; intervalSeconds: number; lookback: bigint; cycles?: number };

interface Options {
  mode: Mode;
  endpoint: URL;
  json: boolean;
  verbose: boolean;
  timeoutMs: number;
  bearerToken?: string;
  transcriptPath?: string;
  reportPath?: string;
  saveOutputPath?: string;
}

export const REMOVED_LOG_POLICY =
  "A log with removed: true is never reported as an event. If the same transactionHash + logIndex was reported earlier, " +
  "a retraction is reported and the key is forgotten; otherwise the removed log is only counted.";

const HELP_TEXT = `${TOOL_NAME} ${VERSION}
Pharos Agent Arena Task 02: watch Circle USDC Transfer events through the Pharos Chain MCP server.
Every chain read is an MCP tool call (get_chain_info, get_block_number, get_logs); no direct RPC.

Usage
  npm start -- [options]                 one finite scan, then exit
  npm run watch -- [options]             keep polling until Ctrl+C

Finite scan (default: the last ${DEFAULT_FINITE_BLOCKS} blocks)
      --blocks <n>         Scan the last n blocks up to the head
      --from-block <n>     Scan from this block (decimal or 0x hex) ...
      --to-block <n>       ... to this block. Default: the head

Watch mode
  -w, --watch              Poll continuously and print only new events
      --interval <sec>     Seconds between polls. Default: ${DEFAULT_INTERVAL_SECONDS}
      --lookback <n>       First poll also covers the last n blocks. Default: 0
      --cycles <n>         Stop after n polls (used by the proof run)

Output
      --json               One JSON object per line (events, then the report)
      --report <file>      Save the final JSON report
      --transcript <file>  Save every raw MCP JSON-RPC message of this run (proof)
      --save-output <file> Save the printed output (without colors)
  -v, --verbose            Print each poll, and trace MCP requests on stderr
      --no-color           Disable colors (NO_COLOR is honored as well)

Connection
  -e, --endpoint <url>     MCP endpoint. Default: $PHAROS_MCP_URL or ${HOSTED_ENDPOINT}
      --timeout <ms>       Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  -h, --help               Show this help

Exit codes
  0 success (watch: stopped by Ctrl+C or --cycles), 1 unexpected error, 2 bad usage,
  3 MCP connection failed, 4 required MCP tools missing, 5 MCP tool failed,
  6 the endpoint is not Pharos Mainnet (chain ID ${EXPECTED_CHAIN_ID}), 130 finite scan interrupted
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
    return reportFailure(toCliError(error), io, style, wantsJson, verbose, undefined);
  }
  return new Session(options, io, style).run();
}

/** Counts tool calls by name and refuses any tool outside the three this monitor needs. */
class CountingCaller implements ToolCaller {
  readonly byTool: Record<string, number> = Object.fromEntries(TOOLS.map((tool) => [tool, 0]));
  constructor(public inner: ToolCaller) {}
  call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!(TOOLS as readonly string[]).includes(name)) throw new CliError("UNEXPECTED", `Refusing to call MCP tool ${name}: not one of ${TOOLS.join(", ")}.`);
    this.byTool[name] = (this.byTool[name] ?? 0) + 1;
    return this.inner.call<T>(name, args);
  }
  get total(): number {
    return Object.values(this.byTool).reduce((sum, count) => sum + count, 0);
  }
}

interface EventRecord {
  event: TransferEvent;
  cycle: number;
  /** Watch mode: the event's block is after the head resolved by the first poll, so it was mined while the monitor ran. */
  afterStart: boolean;
}

/** Keep the report bounded in a long watch session; totals stay exact. */
const MAX_REPORTED_POLLS = 1_000;
const MAX_REPORTED_EVENTS = 5_000;

class Session {
  private readonly recorder = new McpRecorder();
  private readonly started = performance.now();
  private readonly startedAt = new Date();
  private readonly caller: CountingCaller;
  private readonly monitor: TransferMonitor;
  private mcp: PharosMcp;
  private serverLabel: string | undefined;
  private readonly polls: PollResult[] = [];
  private droppedPolls = 0;
  private readonly events: EventRecord[] = [];
  private droppedEvents = 0;
  private readonly retractions: Array<Retraction & { cycle: number }> = [];
  private readonly malformed: Array<Malformed & { cycle: number }> = [];
  private readonly warnings: string[] = [];
  private readonly plain: string[] = [];
  private startHead: bigint | undefined;
  private firstBlock: bigint | undefined;
  private stoppedBy: "completed" | "cycles" | "signal" | "error" = "completed";

  constructor(
    private readonly options: Options,
    private readonly io: Io,
    private readonly style: Style,
  ) {
    this.mcp = this.newMcp();
    this.caller = new CountingCaller(this.mcp);
    this.monitor = new TransferMonitor(this.caller, {
      token: WATCHED_TOKEN,
      topic: TRANSFER_TOPIC,
      lookback: options.mode.kind === "watch" ? options.mode.lookback : 0n,
      retryDelayMs: io.retryDelayMs,
    });
  }

  async run(): Promise<number> {
    const { options, io } = this;
    if (io.env.PHAROS_MCP_TOKEN?.trim() && !options.bearerToken) {
      io.stderr("Note: PHAROS_MCP_TOKEN is not sent to the hosted endpoint, which needs no key.\n");
    }
    let failure: CliError | undefined;
    try {
      await this.mcp.connect();
      this.serverLabel = this.mcp.serverLabel;
      await this.confirmChain();
      this.emit((style) => this.renderHeader(style), { type: "start", ...this.describe() });
      failure = options.mode.kind === "finite" ? await this.runFinite(options.mode) : await this.runWatch(options.mode);
    } catch (error) {
      failure = toCliError(error);
    } finally {
      await this.mcp.close();
    }
    if (failure) this.stoppedBy = "error";

    const report = this.buildReport(failure);
    if (!failure || this.polls.length > 0) this.emit((style) => this.renderSummary(style), { type: "report", report });
    try {
      await this.saveFiles(report, failure);
    } catch (error) {
      failure ??= toCliError(error);
    }
    if (failure) return reportFailure(failure, io, this.style, options.json, options.verbose, this.plain);
    return this.stoppedBy === "signal" && options.mode.kind === "finite" ? 130 : 0;
  }

  private newMcp(): PharosMcp {
    const trace = this.options.verbose ? (line: string) => this.io.stderr(`${this.style.dim(`[mcp] ${sanitizeForTerminal(line, 400)}`)}\n`) : undefined;
    return new PharosMcp(this.options.endpoint, { timeoutMs: this.options.timeoutMs, bearerToken: this.options.bearerToken, trace, recorder: this.recorder });
  }

  /** The monitor only runs against Pharos Mainnet: get_chain_info must report chain ID 1672. */
  private async confirmChain(): Promise<void> {
    const payload = await this.caller.call<unknown>("get_chain_info", {});
    const { chainId, chainIdMatches } = (payload !== null && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (typeof chainId !== "number") throw new CliError("MCP_TOOL_ERROR", `get_chain_info returned no chain ID: ${shorten(JSON.stringify(payload) ?? "undefined", 160)}`);
    if (chainId !== EXPECTED_CHAIN_ID) {
      throw new CliError("WRONG_CHAIN", `The endpoint serves chain ID ${chainId}, not ${CHAIN_NAME} (${EXPECTED_CHAIN_ID}).`, `Circle USDC ${WATCHED_TOKEN.address} is only watched on ${CHAIN_NAME}.`);
    }
    if (chainIdMatches === false) throw new CliError("WRONG_CHAIN", `The server's upstream RPC does not match the chain ID it expects.`);
  }

  private async runFinite(mode: Extract<Mode, { kind: "finite" }>): Promise<CliError | undefined> {
    const head = await this.monitor.readHead();
    const to = mode.to ?? head;
    const from = mode.from ?? (head - mode.blocks + 1n < 0n ? 0n : head - mode.blocks + 1n);
    if (to > head) throw new CliError("USAGE", `--to-block ${to} is ahead of the chain head (${head}).`, "Pick a block at or below the head, or leave --to-block out.");
    if (from > to) throw new CliError("USAGE", `--from-block ${from} is after --to-block ${to}.`);
    if (to - from + 1n > MAX_SCAN_BLOCKS) throw new CliError("USAGE", `A finite scan covers at most ${MAX_SCAN_BLOCKS} blocks; ${from}..${to} is ${to - from + 1n}.`);
    this.startHead = head;
    this.firstBlock = from;
    this.monitor.cursor = from - 1n;
    while ((this.monitor.cursor ?? -1n) < to) {
      const result = await this.monitor.poll({ head, upTo: to });
      this.record(result);
      if (result.error) return result.error;
      if (this.io.signal?.aborted && this.monitor.cursor < to) {
        this.stoppedBy = "signal";
        return undefined;
      }
    }
    return undefined;
  }

  private async runWatch(mode: Extract<Mode, { kind: "watch" }>): Promise<CliError | undefined> {
    let reconnect = false;
    for (let cycle = 1; ; cycle += 1) {
      if (reconnect) {
        await this.mcp.close();
        this.mcp = this.newMcp();
        try {
          await this.mcp.connect();
          this.caller.inner = this.mcp;
          reconnect = false;
        } catch (error) {
          this.warn(`Reconnect failed, retrying at the next poll: ${toCliError(error).message}`);
        }
      }
      let result: PollResult | undefined;
      if (!reconnect) {
        result = await this.monitor.poll();
        if (this.startHead === undefined && result.head !== undefined) {
          this.startHead = result.head;
          this.firstBlock = (result.cursorBefore ?? result.head) + 1n;
          this.emit(
            (style) => `${style.dim(`Started at head ${result!.head}. Watching blocks from ${this.firstBlock} on.`)}\n`,
            { type: "started", head: String(result.head), fromBlock: String(this.firstBlock) },
          );
        }
        this.record(result);
        const error = result.error;
        if (error) {
          if (isFatal(error)) return error;
          if (error.kind === "MCP_CONNECTION") reconnect = true;
          const failed = result.ranges.find((range) => !range.ok);
          const again = failed ? `blocks ${failed.from}..${failed.to} are asked for again, unchanged, next poll` : "the next poll starts from the same block";
          this.warn(`Poll ${result.cycle} failed, the cursor stays at block ${this.monitor.cursor ?? "unset"} and ${again}: ${error.message}`);
        }
      }
      if (mode.cycles !== undefined && cycle >= mode.cycles) {
        this.stoppedBy = "cycles";
        return undefined;
      }
      if (this.io.signal?.aborted) {
        this.stoppedBy = "signal";
        return undefined;
      }
      // Behind by more than one poll's worth of ranges: keep going without waiting.
      if (result && !result.error && !result.caughtUp) continue;
      await (this.io.sleep ?? sleep)(mode.intervalSeconds * 1000, this.io.signal);
      if (this.io.signal?.aborted) {
        this.stoppedBy = "signal";
        return undefined;
      }
    }
  }

  private record(result: PollResult): void {
    this.polls.push(result);
    if (this.polls.length > MAX_REPORTED_POLLS) {
      this.polls.shift();
      this.droppedPolls += 1;
    }
    const verbose = this.options.verbose;
    if (verbose) this.emit((style) => `${style.dim(describePoll(result))}\n`, undefined);
    for (const event of result.events) {
      const afterStart = this.options.mode.kind === "watch" && this.startHead !== undefined && event.blockNumber > this.startHead;
      this.events.push({ event, cycle: result.cycle, afterStart });
      if (this.events.length > MAX_REPORTED_EVENTS) {
        this.events.shift();
        this.droppedEvents += 1;
      }
      this.emit((style) => renderEvent(event, style), { type: "event", event: eventJson(event, result.cycle, afterStart) });
    }
    for (const retraction of result.retractions) {
      this.retractions.push({ ...retraction, cycle: result.cycle });
      this.emit((style) => renderRetraction(retraction, style), { type: "retraction", retraction: { ...retractionJson(retraction), cycle: result.cycle } });
    }
    for (const entry of result.malformed) {
      this.malformed.push({ ...entry, cycle: result.cycle });
      this.warn(`Skipped a malformed Transfer log${entry.blockNumber ? ` at block ${entry.blockNumber}` : ""}${entry.key ? ` (${entry.key})` : ""}: ${entry.reason}.`);
    }
    if (result.skipped.wrongFilter > 0) this.warn(`get_logs returned ${result.skipped.wrongFilter} log(s) that do not match the address and topic filter; ignored.`);
    if (result.skipped.outsideRange > 0) this.warn(`get_logs returned ${result.skipped.outsideRange} log(s) outside the requested block range; ignored until their own range is queried.`);
    if (verbose && result.skipped.duplicate > 0) this.emit((style) => `${style.dim(`  ${result.skipped.duplicate} duplicate log(s) skipped.`)}\n`, undefined);
    if (verbose && result.skipped.removed > 0) this.emit((style) => `${style.dim(`  ${result.skipped.removed} removed log(s) skipped (never reported).`)}\n`, undefined);
  }

  private warn(message: string): void {
    this.warnings.push(message);
    if (this.warnings.length > MAX_REPORTED_EVENTS) this.warnings.shift();
    this.emit((style) => `${style.yellow(`! ${sanitizeForTerminal(message, 400)}`)}\n`, { type: "warning", message });
  }

  /** Print one block of output (styled, or as a JSON line) and keep its plain text for --save-output. */
  private emit(render: (style: Style) => string, json: Record<string, unknown> | undefined): void {
    if (this.options.json) {
      if (json) {
        const line = `${JSON.stringify(json)}\n`;
        this.io.stdout(line);
        this.plain.push(line);
      }
      return;
    }
    this.io.stdout(render(this.style));
    if (this.options.saveOutputPath) this.plain.push(render(createStyle(false)));
  }

  private describe() {
    return {
      tool: { name: TOOL_NAME, version: VERSION },
      endpoint: this.options.endpoint.href,
      server: this.serverLabel ?? null,
      network: { chainId: EXPECTED_CHAIN_ID, name: CHAIN_NAME },
      filter: {
        label: WATCHED_TOKEN.label,
        contract: WATCHED_TOKEN.address,
        event: TRANSFER_EVENT,
        topic0: TRANSFER_TOPIC,
        symbol: WATCHED_TOKEN.symbol,
        decimals: WATCHED_TOKEN.decimals,
        maxBlocksPerGetLogs: Number(MAX_BLOCK_RANGE),
      },
      mode: modeJson(this.options.mode),
    };
  }

  private renderHeader(style: Style): string {
    const mode = this.options.mode;
    const rows: Array<readonly [string, string]> = [
      ["Watching", style.bold(`${WATCHED_TOKEN.label} · Transfer`)],
      ["Contract", style.cyan(WATCHED_TOKEN.address)],
      ["Event", `${TRANSFER_EVENT}`],
      ["Topic0", style.dim(TRANSFER_TOPIC)],
      ["Network", `${CHAIN_NAME} (chain ID ${EXPECTED_CHAIN_ID})`],
      ["Data source", `Pharos Chain MCP${this.serverLabel ? style.dim(` (server: ${sanitizeForTerminal(this.serverLabel, 60)})`) : ""}`],
      ["", this.options.endpoint.href],
      [
        "Mode",
        mode.kind === "watch"
          ? `Watch, polling every ${mode.intervalSeconds}s${mode.lookback > 0n ? `, first poll covers the last ${mode.lookback} blocks` : ""}${mode.cycles ? `, ${mode.cycles} polls` : ". Ctrl+C to stop"}`
          : mode.from !== undefined
            ? `Finite scan of blocks ${mode.from}..${mode.to ?? "head"}`
            : `Finite scan of the last ${mode.blocks} blocks`,
      ],
    ];
    return `${style.bold("Pharos Event / Log Monitor")}\n\n${renderRows(rows, style)}\n\n`;
  }

  private renderSummary(style: Style): string {
    const totals = this.monitor.totals;
    const kinds = countKinds(this.events);
    const scanned = this.scannedRange();
    const how = { completed: "Finished", cycles: `Stopped after ${totals.polls} polls`, signal: "Stopped (Ctrl+C)", error: "Stopped by an error" }[this.stoppedBy];
    const byTool = TOOLS.map((tool) => `${tool} ${this.caller.byTool[tool] ?? 0}`).join(", ");
    const rows: Array<readonly [string, string]> = [
      ["Checked blocks", scanned ? `${scanned.from}..${scanned.to} (${scanned.to - scanned.from + 1n} blocks)` : "none"],
      ["Reported", `${totals.reported} event${totals.reported === 1 ? "" : "s"} (${kinds.Transfer} Transfer, ${kinds.Mint} Mint, ${kinds.Burn} Burn)`],
      ["Skipped", `${totals.duplicate} duplicate, ${totals.removed} removed, ${totals.malformed} malformed`],
      ...(totals.retracted > 0 ? [["Retracted", `${totals.retracted} (removed after being reported)`] as const] : []),
      ["MCP tool calls", `${this.caller.total} (${byTool})`],
      ["Elapsed", `${((performance.now() - this.started) / 1000).toFixed(1)}s`],
    ];
    const none = totals.reported === 0 && scanned ? `${style.dim("No Transfer events in the checked blocks.")}\n` : "";
    // Event blocks already end with a blank line.
    const gap = this.events.length > 0 && !none ? "" : "\n";
    return `${none}${gap}${style.bold(`${how}.`)}\n${renderRows(rows, style)}\n`;
  }

  private scannedRange(): { from: bigint; to: bigint } | undefined {
    const cursor = this.monitor.cursor;
    if (this.firstBlock === undefined || cursor === undefined || cursor < this.firstBlock) return undefined;
    return { from: this.firstBlock, to: cursor };
  }

  private buildReport(failure: CliError | undefined) {
    const totals = this.monitor.totals;
    const scanned = this.scannedRange();
    return {
      ok: failure === undefined,
      ...this.describe(),
      dedupKey: "transactionHash:logIndex",
      removedLogPolicy: REMOVED_LOG_POLICY,
      startHead: this.startHead?.toString() ?? null,
      scanned: scanned ? { fromBlock: scanned.from.toString(), toBlock: scanned.to.toString() } : null,
      cursor: this.monitor.cursor?.toString() ?? null,
      stoppedBy: this.stoppedBy,
      ...(failure ? { error: { kind: failure.kind, message: failure.message, hint: failure.hint ?? null } } : {}),
      totals: { ...totals, eventsAfterStart: this.events.filter((record) => record.afterStart).length },
      toolCalls: { total: this.caller.total, byTool: { ...this.caller.byTool } },
      events: this.events.map((record) => eventJson(record.event, record.cycle, record.afterStart)),
      retractions: this.retractions.map((entry) => ({ ...retractionJson(entry), cycle: entry.cycle })),
      malformed: this.malformed,
      polls: this.polls.map(pollJson),
      truncated: { polls: this.droppedPolls, events: this.droppedEvents },
      warnings: this.warnings,
      startedAt: this.startedAt.toISOString(),
      elapsedMs: Math.round(performance.now() - this.started),
    };
  }

  private async saveFiles(report: ReturnType<Session["buildReport"]>, failure: CliError | undefined): Promise<void> {
    const { options, io } = this;
    // Transcript first: it is the stronger proof, so it should survive a failure to write the other files.
    if (options.transcriptPath) {
      const path = options.transcriptPath;
      const outcome: TranscriptOutcome = failure
        ? { ok: false, error: { kind: failure.kind, message: failure.message, hint: failure.hint ?? null } }
        : { ok: true, report };
      await save(path, () => writeJsonFile(path, buildTranscript(this.recorder, options.endpoint.href, outcome)));
      io.stderr(`Saved MCP transcript: ${path} (${this.recorder.messages.length} JSON-RPC messages)\n`);
    }
    if (options.reportPath) {
      const path = options.reportPath;
      await save(path, () => writeJsonFile(path, report));
      io.stderr(`Saved report: ${path}\n`);
    }
    if (options.saveOutputPath) {
      const path = options.saveOutputPath;
      await save(path, () => writeTextFile(path, this.plain.join("")));
      io.stderr(`Saved output: ${path}\n`);
    }
  }
}

/** Errors that a later poll cannot fix: rejected arguments, a missing tool, anything unexpected. */
function isFatal(error: CliError): boolean {
  if (error instanceof ToolCallError) return error.isInvalidParams || /block range too large/i.test(error.detail);
  return error.kind === "MCP_TOOLS_MISSING" || error.kind === "UNEXPECTED" || error.kind === "USAGE";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function save(path: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    throw new CliError("UNEXPECTED", `Could not write ${path}: ${errorMessage(error)}`, "Check that the folder is writable.", error);
  }
}

// ---------------------------------------------------------------------------
// Output

const KIND_WIDTH = "Transfer".length;

export function renderEvent(event: TransferEvent, style: Style): string {
  const color = event.kind === "Mint" ? style.green : event.kind === "Burn" ? style.yellow : style.cyan;
  const rows: Array<readonly [string, string]> = [
    ["From", event.from],
    ["To", event.to],
    ["Amount", `${style.bold(`${event.amount} ${event.symbol}`)} ${style.dim(`(raw ${event.amountRaw})`)}`],
    ["Tx hash", event.transactionHash],
    ["Block", `${event.blockNumber} ${style.dim(`(log index ${event.logIndex})`)}`],
  ];
  return `${color(style.bold(event.kind.padEnd(KIND_WIDTH)))}  ${event.summary}\n${renderRows(rows, style, "  ")}\n\n`;
}

function renderRetraction(retraction: Retraction, style: Style): string {
  return (
    `${style.red(style.bold("Removed".padEnd(KIND_WIDTH)))}  Log ${retraction.transactionHash} (log index ${retraction.logIndex}) at block ` +
    `${retraction.blockNumber} came back with removed: true. It was reported earlier; treat that event as retracted.\n\n`
  );
}

function describePoll(result: PollResult): string {
  const ranges = result.ranges.map((range) => `${range.from}..${range.to}${range.attempts > 1 ? ` (${range.attempts} attempts)` : ""}${range.ok ? "" : " FAILED"}`);
  const head = result.head === undefined ? "head unknown" : `head ${result.head}`;
  const checked = ranges.length > 0 ? `checked ${ranges.join(", ")}` : "no new blocks";
  return `[poll ${result.cycle}] ${head}, ${checked}, ${result.events.length} new event${result.events.length === 1 ? "" : "s"}`;
}

function countKinds(events: EventRecord[]): Record<TransferEvent["kind"], number> {
  const counts = { Transfer: 0, Mint: 0, Burn: 0 };
  for (const { event } of events) counts[event.kind] += 1;
  return counts;
}

export function eventJson(event: TransferEvent, cycle: number, afterStart: boolean) {
  return {
    key: event.key,
    type: event.kind,
    from: event.from,
    to: event.to,
    amount: { raw: event.amountRaw.toString(), formatted: event.amount, symbol: event.symbol },
    transactionHash: event.transactionHash,
    blockNumber: event.blockNumber.toString(),
    logIndex: event.logIndex,
    summary: event.summary,
    cycle,
    afterStart,
  };
}

function retractionJson(retraction: Retraction) {
  return { key: retraction.key, transactionHash: retraction.transactionHash, logIndex: retraction.logIndex, blockNumber: retraction.blockNumber.toString() };
}

function pollJson(result: PollResult) {
  return {
    cycle: result.cycle,
    head: result.head?.toString() ?? null,
    cursorBefore: result.cursorBefore?.toString() ?? null,
    cursorAfter: result.cursorAfter?.toString() ?? null,
    ranges: result.ranges.map((range) => ({
      fromBlock: range.from.toString(),
      toBlock: range.to.toString(),
      blocks: Number(range.to - range.from + 1n),
      ok: range.ok,
      attempts: range.attempts,
      logs: range.logs,
      ...(range.error ? { error: range.error } : {}),
    })),
    newEvents: result.events.length,
    retractions: result.retractions.length,
    skipped: result.skipped,
    caughtUp: result.caughtUp,
    ...(result.error ? { error: { kind: result.error.kind, message: result.error.message } } : {}),
  };
}

function modeJson(mode: Mode) {
  if (mode.kind === "watch") {
    return { kind: "watch", intervalSeconds: mode.intervalSeconds, lookback: mode.lookback.toString(), cycles: mode.cycles ?? null };
  }
  return { kind: "finite", fromBlock: mode.from?.toString() ?? null, toBlock: mode.to?.toString() ?? null, blocks: mode.from === undefined ? mode.blocks.toString() : null };
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

function reportFailure(failure: CliError, io: Io, style: Style, json: boolean, verbose: boolean, plain: string[] | undefined): number {
  if (json) {
    const line = `${JSON.stringify({ type: "error", ok: false, error: { kind: failure.kind, message: failure.message, hint: failure.hint ?? null, exitCode: failure.exitCode } })}\n`;
    io.stdout(line);
    plain?.push(line);
  } else {
    io.stderr(renderFailure(failure, style, verbose));
  }
  return failure.exitCode;
}

// ---------------------------------------------------------------------------
// Argument parsing

function parseOptions(argv: string[], io: Io): Options | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        watch: { type: "boolean", short: "w" },
        blocks: { type: "string" },
        "from-block": { type: "string" },
        "to-block": { type: "string" },
        interval: { type: "string" },
        lookback: { type: "string" },
        cycles: { type: "string" },
        endpoint: { type: "string", short: "e" },
        json: { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        timeout: { type: "string" },
        transcript: { type: "string" },
        report: { type: "string" },
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

  const { values } = parsed;
  if (values.help) return "help";

  let mode: Mode;
  if (values.watch) {
    const finiteFlag = (["blocks", "from-block", "to-block"] as const).find((flag) => values[flag] !== undefined);
    if (finiteFlag) throw new CliError("USAGE", `--${finiteFlag} is for a finite scan and cannot be combined with --watch.`, "Use --lookback to include recent blocks in watch mode.");
    mode = {
      kind: "watch",
      intervalSeconds: parseInterval(values.interval),
      lookback: values.lookback === undefined ? 0n : parseCount(values.lookback, "--lookback", 0n, MAX_SCAN_BLOCKS),
      cycles: values.cycles === undefined ? undefined : Number(parseCount(values.cycles, "--cycles", 1n, 1_000_000n)),
    };
  } else {
    const watchFlag = (["interval", "lookback", "cycles"] as const).find((flag) => values[flag] !== undefined);
    if (watchFlag) throw new CliError("USAGE", `--${watchFlag} only applies to --watch.`);
    if (values.blocks !== undefined && (values["from-block"] !== undefined || values["to-block"] !== undefined)) {
      throw new CliError("USAGE", "Use either --blocks or --from-block/--to-block, not both.");
    }
    if (values["to-block"] !== undefined && values["from-block"] === undefined) throw new CliError("USAGE", "--to-block needs --from-block.");
    const from = values["from-block"] === undefined ? undefined : parseBlock(values["from-block"], "--from-block");
    const to = values["to-block"] === undefined ? undefined : parseBlock(values["to-block"], "--to-block");
    if (from !== undefined && to !== undefined && from > to) throw new CliError("USAGE", `--from-block ${from} is after --to-block ${to}.`);
    const blocks = values.blocks === undefined ? DEFAULT_FINITE_BLOCKS : parseCount(values.blocks, "--blocks", 1n, MAX_SCAN_BLOCKS);
    mode = { kind: "finite", from, to, blocks };
  }

  const endpoint = parseEndpoint(values.endpoint ?? (io.env.PHAROS_MCP_URL || HOSTED_ENDPOINT));
  return {
    mode,
    endpoint,
    json: values.json ?? false,
    verbose: values.verbose ?? false,
    timeoutMs: parseTimeout(values.timeout),
    bearerToken: bearerTokenFor(endpoint, io.env),
    transcriptPath: parsePath(values.transcript, "--transcript"),
    reportPath: parsePath(values.report, "--report"),
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

function parseBlock(input: string, flag: string): bigint {
  const value = input.trim();
  if (/^\d+$/.test(value)) return BigInt(value);
  if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  throw new CliError("USAGE", `${flag} must be a block number (decimal or 0x hex), got ${shorten(input, 40)}.`);
}

function parseCount(input: string, flag: string, min: bigint, max: bigint): bigint {
  if (!/^\d+$/.test(input.trim()) || BigInt(input.trim()) < min || BigInt(input.trim()) > max) {
    throw new CliError("USAGE", `${flag} must be a whole number between ${min} and ${max}, got ${shorten(input, 40)}.`);
  }
  return BigInt(input.trim());
}

function parseInterval(input: string | undefined): number {
  if (input === undefined) return DEFAULT_INTERVAL_SECONDS;
  const value = Number(input);
  if (!/^\d+(\.\d+)?$/.test(input.trim()) || !Number.isFinite(value) || value < 1 || value > 3_600) {
    throw new CliError("USAGE", `--interval must be a number of seconds between 1 and 3600, got ${shorten(input, 40)}.`);
  }
  return value;
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
