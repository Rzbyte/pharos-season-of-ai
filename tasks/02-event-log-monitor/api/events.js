// Vercel function behind the Task 02 monitor page: GET /api/events.
//
// One answer for every viewer: the Circle USDC Transfer events of the last WINDOW_BLOCKS blocks up
// to the current head, read through Pharos Chain MCP with the CLI's own monitor (dist/src, compiled
// from src/ during `npm ci`). The page polls it, keeps its own cursor ("last checked block") and
// its own dedup set (transactionHash + logIndex), and shows only events it has not shown before.
//
// Why a shared window instead of a per-viewer cursor: every MCP poll opens a session and makes
// three tool calls, the hosted server limits requests per client IP, and every invocation of this
// function leaves from the same few IPs. With one cacheable answer, the edge serves all viewers
// from one upstream poll every few seconds, however many people watch.
//
// The endpoint is a fixed constant and nothing is read from the environment, so a deployment
// setting can neither redirect it nor add a token. No direct RPC: only get_chain_info,
// get_block_number and get_logs, through the MCP client.
import { DEFAULT_TIMEOUT_MS, EXPECTED_CHAIN_ID, HOSTED_ENDPOINT, TOOL_NAME, TRANSFER_EVENT, TRANSFER_TOPIC, VERSION, WATCHED_TOKEN } from "../dist/src/constants.js";
import { CliError, toCliError } from "../dist/src/errors.js";
import { McpRecorder, PharosMcp } from "../dist/src/mcp-client.js";
import { getLogsArgs, TransferMonitor } from "../dist/src/monitor.js";

/** Blocks per answer: one get_logs call, well under its 1,000-block limit. */
export const WINDOW_BLOCKS = 200n;
/** Shared edge cache: about one upstream poll per this many seconds, whatever the number of viewers. */
export const CACHE_SECONDS = 4;

/** One window read. Tests pass a local fake endpoint. Returns { status, body }. */
export async function readWindow(endpoint = HOSTED_ENDPOINT) {
  const started = performance.now();
  const calls = { get_chain_info: 0, get_block_number: 0, get_logs: 0 };
  const mcp = new PharosMcp(new URL(endpoint), { timeoutMs: DEFAULT_TIMEOUT_MS, recorder: new McpRecorder() });
  const counted = {
    call(name, args) {
      calls[name] = (calls[name] ?? 0) + 1;
      return mcp.call(name, args);
    },
  };
  const base = {
    tool: { name: TOOL_NAME, version: VERSION },
    endpoint,
    filter: { label: WATCHED_TOKEN.label, contract: WATCHED_TOKEN.address, event: TRANSFER_EVENT, topic0: TRANSFER_TOPIC, symbol: WATCHED_TOKEN.symbol, decimals: WATCHED_TOKEN.decimals },
    dedupKey: "transactionHash:logIndex",
  };
  try {
    await mcp.connect();
    const chain = await counted.call("get_chain_info", {});
    if (chain?.chainId !== EXPECTED_CHAIN_ID || chain?.chainIdMatches === false) {
      throw new CliError("WRONG_CHAIN", `The MCP endpoint serves chain ID ${String(chain?.chainId)}, not Pharos Mainnet (${EXPECTED_CHAIN_ID}).`);
    }
    const monitor = new TransferMonitor(counted, { token: WATCHED_TOKEN, topic: TRANSFER_TOPIC, lookback: WINDOW_BLOCKS, maxRangesPerPoll: 1 });
    const result = await monitor.poll();
    if (result.error) throw result.error;
    const range = result.ranges[0];
    return {
      status: 200,
      body: {
        ok: true,
        ...base,
        server: mcp.serverLabel ?? null,
        chainId: EXPECTED_CHAIN_ID,
        head: String(result.head),
        fromBlock: range ? String(range.from) : null,
        toBlock: range ? String(range.to) : null,
        getLogs: range ? getLogsArgs(WATCHED_TOKEN, TRANSFER_TOPIC, range) : null,
        events: result.events.map((event) => ({
          key: event.key,
          type: event.kind,
          from: event.from,
          to: event.to,
          amount: { raw: event.amountRaw.toString(), formatted: event.amount, symbol: event.symbol },
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber.toString(),
          logIndex: event.logIndex,
          summary: event.summary,
        })),
        removedKeys: result.removedKeys,
        skipped: result.skipped,
        toolCalls: { total: calls.get_chain_info + calls.get_block_number + calls.get_logs, byTool: calls },
        elapsedMs: Math.round(performance.now() - started),
        fetchedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    const failure = toCliError(error);
    return {
      status: 502,
      body: { ok: false, ...base, error: { kind: failure.kind, message: failure.message, hint: failure.hint ?? null }, fetchedAt: new Date().toISOString() },
    };
  } finally {
    await mcp.close();
  }
}

export function createHandler(endpoint = HOSTED_ENDPOINT) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" }).end('{"ok":false,"error":{"message":"Use GET."}}\n');
      return;
    }
    let status;
    let body;
    try {
      ({ status, body } = await readWindow(endpoint));
    } catch (error) {
      [status, body] = [500, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }];
    }
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=2` : "no-store",
    });
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  };
}

/** The deployed handler: always the official hosted endpoint. */
export default createHandler();
