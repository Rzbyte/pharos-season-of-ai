// Vercel function behind the Task 01 reviewer demo: GET /api/state.
//
// It re-implements nothing. It runs the proven CLI (dist/src/run.js, compiled from src/ during
// `npm ci`) in --json mode, so the MCP reads, the same-block pinning, the "Circle USDC Contract"
// label rules and the 1.0.2 transport fix (no standalone GET stream) are exactly the CLI's.
// The endpoint is a fixed constant and the CLI gets an empty environment, so PHAROS_MCP_URL or
// PHAROS_MCP_TOKEN set on the deployment can neither redirect it nor add a token.
import { HOSTED_ENDPOINT, TOOL_NAME, VERSION } from "../dist/src/constants.js";
import { formatTokenAmount } from "../dist/src/format.js";
import { run } from "../dist/src/run.js";

/** Per MCP request; a whole read normally takes a few seconds. */
const MCP_TIMEOUT_MS = 8_000;

/** One live read of the Circle USDC Contract through Pharos Chain MCP. Tests pass a local fake endpoint. */
export async function readState(endpoint = HOSTED_ENDPOINT) {
  let stdout = "";
  const exitCode = await run(["--json", "--endpoint", endpoint, "--timeout", String(MCP_TIMEOUT_MS)], {
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
    env: {},
    isTTY: false,
  });
  const report = JSON.parse(stdout);
  if (exitCode === 0) {
    const { decimals, symbol, totalSupply } = report.values;
    report.display = { totalSupply: `${formatTokenAmount(BigInt(totalSupply.raw), decimals)} ${symbol}` };
  }
  return { status: exitCode === 0 ? 200 : 502, body: { ...report, tool: { name: TOOL_NAME, version: VERSION }, fetchedAt: new Date().toISOString() } };
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
      ({ status, body } = await readState(endpoint));
    } catch (error) {
      [status, body] = [500, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }];
    }
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      // Short shared cache: each read is about 9 MCP requests, and the hosted server rate-limits per IP.
      "cache-control": status === 200 ? "public, s-maxage=15, stale-while-revalidate=45" : "no-store",
    });
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  };
}

/** The deployed handler: always the official hosted endpoint. */
export default createHandler();
