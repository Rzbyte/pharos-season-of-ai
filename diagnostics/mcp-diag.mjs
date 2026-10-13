#!/usr/bin/env node
// TEMPORARY Task 01 diagnostic. Not part of the deliverable: never commit it.
//
// It drives Task 01's own compiled MCP client (dist/src/mcp-client.js) without changing it, so the
// MCP SDK, the Streamable HTTP transport and the client options are exactly the production ones.
// Each test runs in a fresh Node process: a fresh MCP session and fresh HTTP connections.
// It never calls tools/list or eth_call, and sends no credentials.
//
//   TEST A  initialize -> get_block_number -> close
//   TEST B  initialize -> get_chain_info -> close
//   TEST C  initialize -> get_chain_info, wait for its response -> get_block_number -> close
//   TEST D  optional, only with --with-test-d: TEST A with the optional GET event stream suppressed
//
// Recorded per test: initialize result, session ID prefix, each request, its response or timeout,
// durations, the raw MCP messages, and a passive log of every HTTP request (status, content type,
// time until response headers). Results print as they happen and are saved as JSON next to this file.
//
// Run from tasks/01-read-contract-state with this file in .temp/ (git ignores .temp):
//   node .temp/mcp-diag.mjs
// Options: --endpoint <url> (default https://mcp.pharos.xyz/mcp), --timeout <ms> per request
// (default 60000), --project <Task 01 dir> (default: parent of this file's folder), --out <file>,
// --tests <list> (default A,B,C; e.g. --tests B to rerun one), --with-test-d.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HOSTED_ENDPOINT = "https://mcp.pharos.xyz/mcp";
const SCRIPT = fileURLToPath(import.meta.url);
const TESTS = {
  A: { title: "initialize -> get_block_number -> close", calls: ["get_block_number"] },
  B: { title: "initialize -> get_chain_info -> close", calls: ["get_chain_info"] },
  C: { title: "initialize -> get_chain_info -> get_block_number (one at a time) -> close", calls: ["get_chain_info", "get_block_number"] },
  D: { title: "TEST A with the optional GET event stream suppressed", calls: ["get_block_number"], noGetStream: true },
};

const { values: opts } = parseArgs({
  options: {
    endpoint: { type: "string", default: HOSTED_ENDPOINT },
    timeout: { type: "string", default: "60000" },
    project: { type: "string", default: resolve(dirname(SCRIPT), "..") },
    out: { type: "string", default: join(dirname(SCRIPT), "mcp-diag-report.json") },
    child: { type: "string" },
    tests: { type: "string", default: "A,B,C" },
    "with-test-d": { type: "boolean", default: false },
  },
});
const timeoutMs = Number(opts.timeout);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error(`--timeout must be a whole number of ms >= 1000, got ${opts.timeout}`);
const project = resolve(opts.project);
const clientModule = join(project, "dist/src/mcp-client.js");
// Declared before the top-level await below, which pauses evaluation of anything after it.
let finished = false;

if (opts.child) {
  await childMain(opts.child);
} else {
  await parentMain();
}

// ---------------------------------------------------------------------------
// Parent: runs each test in its own process, prints a summary, writes the report.

async function parentMain() {
  if (!existsSync(clientModule)) {
    console.error(`Cannot find ${clientModule}.\nRun this from tasks/01-read-contract-state after "npm ci" (or pass --project <dir>).`);
    process.exit(2);
  }
  const env = {
    endpoint: opts.endpoint,
    perRequestTimeoutMs: timeoutMs,
    task01Version: readVersion(join(project, "package.json")),
    mcpSdkVersion: readVersion(join(project, "node_modules/@modelcontextprotocol/sdk/package.json")),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    startedAt: new Date().toISOString(),
  };
  console.log("Task 01 MCP diagnostic (temporary, not committed)");
  for (const [key, value] of Object.entries(env)) console.log(`  ${key.padEnd(20)} ${value}`);
  if (opts.endpoint !== HOSTED_ENDPOINT) console.log(`  NOTE: not the hosted endpoint`);

  const ids = [...new Set([...opts.tests.toUpperCase().split(",").map((id) => id.trim()).filter(Boolean), ...(opts["with-test-d"] ? ["D"] : [])])];
  const unknown = ids.filter((id) => !TESTS[id]);
  if (unknown.length > 0) {
    console.error(`Unknown test(s): ${unknown.join(", ")}. Available: ${Object.keys(TESTS).join(", ")}`);
    process.exit(2);
  }
  const results = [];
  for (const id of ids) {
    console.log(`\nTEST ${id}: ${TESTS[id].title}`);
    const result = await runChild(id);
    results.push(result);
    printTest(result);
  }

  const report = { about: "Temporary Task 01 diagnostic: separate fresh MCP sessions, no tools/list, no eth_call.", env, results };
  writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log("\nSUMMARY");
  for (const result of results) console.log(`  ${summaryLine(result)}`);
  console.log(`\nFull report (raw MCP messages + HTTP log): ${opts.out}`);
}

function runChild(id) {
  return new Promise((resolveResult) => {
    const args = [SCRIPT, "--child", id, "--endpoint", opts.endpoint, "--timeout", String(timeoutMs), "--project", project];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) => {
      try {
        resolveResult(JSON.parse(stdout));
      } catch {
        resolveResult({ test: id, title: TESTS[id].title, crashed: true, exitCode: code, stdoutTail: stdout.slice(-2000) });
      }
    });
  });
}

function printTest(r) {
  if (r.crashed) return console.log(`  CRASHED (exit ${r.exitCode}): ${r.stdoutTail}`);
  const init = r.initialize;
  console.log(
    init.ok
      ? `  initialize        OK in ${init.durationMs} ms | server ${init.server ? `${init.server.name} ${init.server.version}` : "?"} | protocol ${init.protocolVersion ?? "?"} | session ${init.sessionIdPrefix ?? "(none)"}...`
      : `  initialize        FAILED after ${init.durationMs} ms: ${init.error?.message}`,
  );
  for (const call of r.calls) {
    if (!call.sent) {
      console.log(`  ${call.tool.padEnd(17)} ${call.note}`);
      continue;
    }
    console.log(`  ${call.tool.padEnd(17)} sent at +${call.sentAtMs} ms (request id ${call.requestId}) -> ${call.outcome.toUpperCase()} after ${call.durationMs} ms`);
    console.log(`  ${"".padEnd(17)} HTTP: ${describeHttp(call.http)}`);
    if (call.rawResponse) console.log(`  ${"".padEnd(17)} raw response: ${JSON.stringify(call.rawResponse)}`);
    if (call.error && !call.rawResponse) console.log(`  ${"".padEnd(17)} error: ${call.error.message}`);
  }
  const getStream = r.http.find((h) => h.method === "GET");
  console.log(`  optional GET      ${getStream ? describeHttp(getStream) : "not opened"}`);
  const closed = !init.ok ? "no session (initialize failed)" : r.close?.sessionTerminated ? "session terminated (DELETE ok)" : "session not confirmed terminated";
  console.log(`  close             ${r.close ? `${closed} in ${r.close.durationMs} ms` : "n/a"}`);
  console.log(`  tools/list sent   ${r.toolsListSent ? "YES (unexpected)" : "no"}`);
}

function summaryLine(r) {
  if (r.crashed) return `TEST ${r.test}  crashed (exit ${r.exitCode})`;
  if (!r.initialize.ok) return `TEST ${r.test}  initialize FAILED: ${r.initialize.error?.message}`;
  const calls = r.calls.map((c) => (c.sent ? `${c.tool}: ${c.outcome.toUpperCase()} (${c.durationMs} ms)` : `${c.tool}: not sent`)).join(", ");
  return `TEST ${r.test}  init OK (${r.initialize.durationMs} ms, session ${r.initialize.sessionIdPrefix ?? "?"})  ${calls}`;
}

function describeHttp(h) {
  if (!h) return "no matching HTTP request recorded";
  if (h.note) return `${h.status} (${h.note})`;
  if (h.status !== null) return `${h.status} ${h.contentType ?? ""} headers after ${h.headersAtMs - h.sentAtMs} ms`.replace(/\s+/g, " ");
  return `no response headers (${h.error ?? "still pending at close"})`;
}

function readVersion(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8")).version;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Child: one test, one fresh MCP session, result as JSON on stdout.

async function childMain(id) {
  const spec = TESTS[id];
  if (!spec) throw new Error(`unknown test ${id}`);
  const { PharosMcp, McpRecorder } = await import(pathToFileURL(clientModule).href);

  // Same clock as McpRecorder: both start here, so recorder atMs and HTTP times line up.
  const t0 = performance.now();
  const recorder = new McpRecorder();
  const at = () => Math.round(performance.now() - t0);
  const log = (line) => process.stderr.write(`  [${id} +${String(at()).padStart(6)} ms] ${line}\n`);
  const http = [];
  const trace = [];
  const result = { test: id, title: spec.title, endpoint: opts.endpoint, timeoutMs, startedAt: new Date().toISOString(), initialize: null, calls: [], close: null, toolsListSent: false, http, trace, messages: recorder.messages };

  // Last resort if something never settles: report what we have instead of hanging the phone session.
  const budget = timeoutMs * (spec.calls.length + 1) + 30_000;
  setTimeout(() => {
    result.watchdog = `test still running after ${budget} ms; stopped by the diagnostic`;
    finish(result);
  }, budget).unref();

  // Passive HTTP log around the global fetch the SDK transport uses. Requests and responses pass
  // through unchanged; only TEST D answers the optional GET stream itself, with 405 (the SDK's
  // documented "server offers no GET stream" case).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const entry = {
      seq: http.length + 1,
      method: String(init.method ?? "GET").toUpperCase(),
      jsonrpc: summarizeBody(init.body),
      sessionIdPrefix: headers.get("mcp-session-id")?.slice(0, 8) ?? null,
      protocolVersionHeader: headers.get("mcp-protocol-version"),
      sentAtMs: at(),
      status: null,
      contentType: null,
      headersAtMs: null,
      error: null,
    };
    http.push(entry);
    const label = `HTTP ${entry.method}${entry.jsonrpc ? ` ${entry.jsonrpc}` : ""}`;
    if (spec.noGetStream && entry.method === "GET") {
      Object.assign(entry, { status: 405, headersAtMs: at(), note: "not sent: optional GET stream suppressed by TEST D" });
      log(`${label}: suppressed (TEST D)`);
      return new Response(null, { status: 405 });
    }
    log(`${label} sent`);
    try {
      const response = await realFetch(input, init);
      Object.assign(entry, { status: response.status, contentType: response.headers.get("content-type"), headersAtMs: at() });
      log(`${label} -> ${response.status} ${entry.contentType ?? ""} (headers after ${entry.headersAtMs - entry.sentAtMs} ms)`);
      return response;
    } catch (error) {
      Object.assign(entry, { error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`, failedAtMs: at() });
      log(`${label} -> no response headers: ${entry.error} (after ${entry.failedAtMs - entry.sentAtMs} ms)`);
      throw error;
    }
  };

  const mcp = new PharosMcp(new URL(opts.endpoint), {
    timeoutMs,
    recorder,
    trace: (line) => trace.push({ atMs: at(), line }),
  });

  log(`initialize (timeout ${timeoutMs} ms)`);
  const initStart = at();
  try {
    await mcp.connect();
    const request = recorder.messages.find((m) => m.direction === "client->server" && m.message.method === "initialize");
    result.initialize = {
      ok: true,
      durationMs: at() - initStart,
      server: recorder.server ?? null,
      protocolVersion: recorder.protocolVersion ?? null,
      sessionIdPrefix: recorder.sessionIdPrefix ?? null,
      rawResponse: request ? responseTo(recorder, request.message.id)?.message ?? null : null,
    };
    log(`initialize OK: ${result.initialize.server?.name} ${result.initialize.server?.version}, protocol ${result.initialize.protocolVersion}, session ${result.initialize.sessionIdPrefix}...`);
  } catch (error) {
    result.initialize = { ok: false, durationMs: at() - initStart, error: describeError(error) };
    log(`initialize FAILED: ${result.initialize.error.message}`);
  }

  if (result.initialize.ok) {
    for (const tool of spec.calls) {
      const previous = result.calls.at(-1);
      if (previous && !previous.responseReceived) {
        result.calls.push({ tool, sent: false, responseReceived: false, note: `not sent: ${previous.tool} got no response, and TEST ${id} waits for it first` });
        log(`${tool} not sent (${previous.tool} got no response)`);
        continue;
      }
      const before = recorder.messages.length;
      const started = at();
      log(`tools/call ${tool} (waiting up to ${timeoutMs} ms)`);
      let error = null;
      try {
        await mcp.call(tool, {});
      } catch (caught) {
        error = caught;
      }
      const finished = at();
      const request = recorder.messages.slice(before).find((m) => m.direction === "client->server" && m.message.method === "tools/call");
      const response = request ? responseTo(recorder, request.message.id) : undefined;
      const timedOut = !response && error?.kind === "MCP_CONNECTION" && /within \d+ ms/.test(error.message);
      const call = {
        tool,
        sent: Boolean(request),
        requestId: request?.message.id ?? null,
        request: request?.message ?? null,
        sentAtMs: request?.atMs ?? started,
        outcome: response ? (response.message.result?.isError ? "response (tool reported an error)" : "response") : timedOut ? "timeout" : "failed",
        responseReceived: Boolean(response),
        responseAtMs: response?.atMs ?? null,
        durationMs: (response ? response.atMs : finished) - (request?.atMs ?? started),
        rawResponse: response?.message ?? null,
        error: error ? describeError(error) : null,
        http: request ? http.find((h) => h.method === "POST" && h.jsonrpc === `tools/call#${request.message.id} ${tool}`) ?? null : null,
      };
      result.calls.push(call);
      log(`${tool}: ${call.outcome} after ${call.durationMs} ms`);
    }
  }

  log("closing session");
  const closeStart = at();
  await mcp.close();
  result.close = { durationMs: at() - closeStart, sessionTerminated: recorder.sessionTerminated };
  result.toolsListSent = recorder.messages.some((m) => m.direction === "client->server" && m.message.method === "tools/list");
  globalThis.fetch = realFetch;
  finish(result);
}

function responseTo(recorder, id) {
  return recorder.messages.find((m) => m.direction === "server->client" && m.message.id === id && ("result" in m.message || "error" in m.message));
}

function summarizeBody(body) {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((m) => {
        if (!m?.method) return m?.id !== undefined ? `response#${m.id}` : "?";
        const id = m.id !== undefined ? `#${m.id}` : "";
        if (m.method === "tools/call") return `tools/call${id} ${m.params?.name}`;
        if (m.method === "notifications/cancelled") return `notifications/cancelled (request ${m.params?.requestId})`;
        return `${m.method}${id}`;
      })
      .join(", ");
  } catch {
    return "(non-JSON body)";
  }
}

function describeError(error) {
  return {
    name: error?.name ?? "Error",
    kind: error?.kind ?? null,
    message: String(error?.message ?? error).slice(0, 500),
    hint: error?.hint ?? null,
  };
}

function finish(result) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}
