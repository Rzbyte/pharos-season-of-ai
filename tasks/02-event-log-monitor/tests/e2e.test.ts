import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run, type Io } from "../src/run.js";
import { shortAddress } from "../src/transfer.js";
import { startFakePharosMcp, type FakeLogChain, type FakeServer } from "./fake-pharos-mcp.js";
import { getAddress } from "viem";
import { ALICE, BOB, makeLog, TOPIC, USDC, ZERO } from "./fixtures.js";

const ALLOWED = new Set(["get_chain_info", "get_block_number", "get_logs"]);
const HEAD = 20_248_479n;

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(server: FakeServer, args: string[], extra: Partial<Io> = {}): Promise<Outcome> {
  let stdout = "";
  let stderr = "";
  const code = await run([...args, "--endpoint", server.url], {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    env: {},
    isTTY: false,
    retryDelayMs: 1,
    sleep: async () => undefined,
    ...extra,
  });
  return { code, stdout, stderr };
}

async function withServer(chain: FakeLogChain, body: (server: FakeServer) => Promise<void>): Promise<void> {
  const server = await startFakePharosMcp(chain);
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

const getLogs = (server: FakeServer) => server.calls.filter((call) => call.tool === "get_logs").map((call) => call.args);
const span = (args: Record<string, unknown>) => `${BigInt(String(args.fromBlock))}..${BigInt(String(args.toBlock))}`;
const eventBlocks = (stdout: string) => [...stdout.matchAll(/^(?:Transfer|Mint|Burn)\s+.+$/gm)].length;
const txLines = (stdout: string) => [...stdout.matchAll(/^\s+Tx hash\s+(0x[0-9a-f]{64})$/gm)].map((match) => match[1]);

/** Every get_logs call: exact address + topic0, explicit hex range of at most 1,000 blocks. */
function assertFiltered(server: FakeServer): void {
  for (const args of getLogs(server)) {
    assert.equal(args.address, USDC);
    assert.deepEqual(args.topics, [TOPIC]);
    assert.match(String(args.fromBlock), /^0x[0-9a-f]+$/);
    assert.match(String(args.toBlock), /^0x[0-9a-f]+$/);
    const blocks = BigInt(String(args.toBlock)) - BigInt(String(args.fromBlock)) + 1n;
    assert.ok(blocks >= 1n && blocks <= 1000n);
  }
  for (const call of server.calls) assert.ok(ALLOWED.has(call.tool), `unexpected tool ${call.tool}`);
}

describe("finite mode", () => {
  test("scans the last 1,000 blocks in one get_logs call and prints decoded events", async () => {
    const logs = [makeLog({ block: HEAD - 10n, index: 1, amount: 125_500_000n }), makeLog({ block: HEAD - 5n, from: ZERO }), makeLog({ block: HEAD - 1_000n })];
    await withServer({ head: HEAD, logs }, async (server) => {
      const { code, stdout, stderr } = await runCli(server, []);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /Pharos Event \/ Log Monitor/);
      assert.match(stdout, /Watching\s+Circle USDC · Transfer/);
      assert.match(stdout, /Network\s+Pharos Mainnet \(chain ID 1672\)/);
      assert.match(stdout, new RegExp(`^Transfer\\s+125\\.5 USDC transferred from ${shortAddress(getAddress(ALICE))} to ${shortAddress(getAddress(BOB))}$`, "m"));
      assert.match(stdout, /Mint\s+125\.5 USDC minted to 0x/);
      assert.match(stdout, new RegExp(`From\\s+${getAddress(ALICE)}\n\\s+To\\s+${getAddress(BOB)}`));
      assert.match(stdout, /Amount\s+125\.5 USDC \(raw 125500000\)/);
      assert.match(stdout, new RegExp(`Block\\s+${HEAD - 10n} \\(log index 1\\)`));
      assert.equal(eventBlocks(stdout), 2, "the log 1,000 blocks back is outside the window");
      assert.match(stdout, /Finished\./);
      assert.match(stdout, new RegExp(`Checked blocks\\s+${HEAD - 999n}..${HEAD} \\(1000 blocks\\)`));
      assert.match(stdout, /MCP tool calls\s+3 \(get_chain_info 1, get_block_number 1, get_logs 1\)/);
      assert.deepEqual(getLogs(server).map(span), [`${HEAD - 999n}..${HEAD}`]);
      assertFiltered(server);
    });
  });

  test("an explicit range over 1,000 blocks is paged into contiguous ranges", async () => {
    const logs = [makeLog({ block: 1_000n }), makeLog({ block: 1_001n }), makeLog({ block: 3_499n })];
    await withServer({ head: 5_000n, logs }, async (server) => {
      const { code, stdout } = await runCli(server, ["--from-block", "1000", "--to-block", "0xdab"]);
      assert.equal(code, 0);
      assert.deepEqual(getLogs(server).map(span), ["1000..1999", "2000..2999", "3000..3499"]);
      assert.equal(eventBlocks(stdout), 3);
      assertFiltered(server);
    });
  });

  test("zero events is a normal, successful result", async () => {
    await withServer({ head: HEAD, logs: [] }, async (server) => {
      const { code, stdout } = await runCli(server, ["--blocks", "20"]);
      assert.equal(code, 0);
      assert.match(stdout, /No Transfer events in the checked blocks\./);
      assert.match(stdout, /Reported\s+0 events/);
    });
  });

  test("a --to-block ahead of the head is a usage error, before any get_logs", async () => {
    await withServer({ head: 100n, logs: [] }, async (server) => {
      const { code, stderr } = await runCli(server, ["--from-block", "50", "--to-block", "101"]);
      assert.equal(code, 2);
      assert.match(stderr, /ahead of the chain head \(100\)/);
      assert.equal(getLogs(server).length, 0);
    });
  });

  test("a range that keeps failing ends the scan with exit 5, after one retry of the same range", async () => {
    await withServer({ head: 100n, logs: [], getLogsFailures: 5 }, async (server) => {
      const { code, stderr, stdout } = await runCli(server, ["--blocks", "10"]);
      assert.equal(code, 5);
      assert.match(stderr, /get_logs failed: header not found/);
      assert.deepEqual(getLogs(server).map(span), ["91..100", "91..100"]);
      assert.deepEqual(getLogs(server)[0], getLogs(server)[1]);
      assert.match(stdout, /Stopped by an error\./);
      assert.match(stdout, /Checked blocks\s+none/);
    });
  });
});

describe("watch mode", () => {
  /** Mines one block per get_block_number call, each with one Transfer. */
  const miningChain = (): FakeLogChain => ({
    head: 1_000n,
    logs: [makeLog({ block: 998n })],
    beforeBlockNumber: (n, chain) => {
      if (n === 1) return;
      chain.head += 1n;
      chain.logs.push(makeLog({ block: chain.head, index: n }));
    },
  });

  test("reports only new events, each once, across polls; ranges are contiguous", async () => {
    await withServer(miningChain(), async (server) => {
      const { code, stdout, stderr } = await runCli(server, ["--watch", "--cycles", "4", "--lookback", "5"]);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /Started at head 1000\. Watching blocks from 996 on\./);
      // Lookback event at 998, then one per newly mined block 1001..1003.
      assert.equal(eventBlocks(stdout), 4);
      const txs = txLines(stdout);
      assert.equal(new Set(txs).size, txs.length, "no duplicate output");
      assert.deepEqual(getLogs(server).map(span), ["996..1000", "1001..1001", "1002..1002", "1003..1003"]);
      assert.match(stdout, /Stopped after 4 polls\./);
      assert.match(stdout, /MCP tool calls\s+9 \(get_chain_info 1, get_block_number 4, get_logs 4\)/);
      assertFiltered(server);
    });
  });

  test("without --lookback, only events mined after the start are reported", async () => {
    await withServer(miningChain(), async (server) => {
      const { stdout } = await runCli(server, ["--watch", "--cycles", "3"]);
      assert.equal(eventBlocks(stdout), 2);
      assert.doesNotMatch(stdout, new RegExp(`Block\\s+998 `));
      assert.deepEqual(getLogs(server).map(span), ["1001..1001", "1002..1002"]);
    });
  });

  test("a failed poll keeps the cursor; the next poll asks for the same range again", async () => {
    const chain = miningChain();
    chain.getLogsFailures = 2; // poll 2: both attempts fail
    await withServer(chain, async (server) => {
      const { code, stdout } = await runCli(server, ["--watch", "--cycles", "3"]);
      assert.equal(code, 0);
      assert.match(stdout, /! Poll 2 failed, the cursor stays at block 1000 and blocks 1001\.\.1001 are asked for again, unchanged, next poll: get_logs failed: header not found/);
      assert.deepEqual(getLogs(server).map(span), ["1001..1001", "1001..1001", "1001..1001", "1002..1002"]);
      assert.equal(eventBlocks(stdout), 2);
    });
  });

  test("a lost session is reopened on the next poll and no event is missed or repeated", async () => {
    const chain = miningChain();
    chain.dropSessionAfterToolCalls = 3; // get_chain_info, poll 1, poll 2's get_block_number; then gone
    await withServer(chain, async (server) => {
      const { code, stdout } = await runCli(server, ["--watch", "--cycles", "5"]);
      assert.equal(code, 0, stdout);
      assert.match(stdout, /no longer recognizes this session/);
      assert.equal(server.sessionsOpened(), 2);
      const txs = txLines(stdout);
      assert.equal(new Set(txs).size, txs.length);
      const ranges = getLogs(server).map(span);
      assert.equal(ranges.at(-1)?.endsWith(`..${chain.head}`), true);
      assert.equal(eventBlocks(stdout), Number(chain.head - 1_000n), "every mined block's event, once");
    });
  });

  test("a reported log that comes back removed is retracted, never re-reported as new", async () => {
    const tx = `0x${"ab".repeat(32)}`;
    const chain: FakeLogChain = {
      head: 100n,
      logs: [makeLog({ block: 99n, index: 3, tx })],
      beforeBlockNumber: (n, c) => {
        if (n === 2) {
          // A reorged log comes back with its original block, behind the cursor.
          c.head = 101n;
          c.onGetLogs = () => [makeLog({ block: 99n, index: 3, tx, removed: true })];
        }
      },
    };
    await withServer(chain, async (server) => {
      const { stdout } = await runCli(server, ["--watch", "--cycles", "2", "--lookback", "2"]);
      assert.equal(eventBlocks(stdout), 1);
      assert.match(stdout, new RegExp(`^Removed\\s+Log ${tx} \\(log index 3\\) at block 99 came back with removed: true`, "m"));
      assert.match(stdout, /Retracted\s+1/);
    });
  });

  test("Ctrl+C while waiting stops cleanly: summary printed, session closed, exit 0", async () => {
    const controller = new AbortController();
    let waits = 0;
    await withServer(miningChain(), async (server) => {
      const { code, stdout } = await runCli(server, ["--watch"], {
        signal: controller.signal,
        sleep: async () => {
          waits += 1;
          if (waits === 2) controller.abort();
        },
      });
      assert.equal(code, 0);
      assert.match(stdout, /Stopped \(Ctrl\+C\)\./);
      assert.equal(server.calls.filter((call) => call.tool === "get_block_number").length, 2);
      assert.ok(server.requests.includes("DELETE"), "MCP session terminated");
      assert.equal(server.openSessions(), 0);
    });
  });

  test("Ctrl+C during a poll lets that poll finish and print its events first", async () => {
    const controller = new AbortController();
    const chain = miningChain();
    const mine = chain.beforeBlockNumber!;
    chain.beforeBlockNumber = (n, c) => {
      mine(n, c);
      if (n === 2) controller.abort();
    };
    await withServer(chain, async (server) => {
      const { code, stdout } = await runCli(server, ["--watch"], { signal: controller.signal });
      assert.equal(code, 0);
      assert.equal(eventBlocks(stdout), 1, "the event found by the interrupted poll is still printed");
      assert.match(stdout, /Stopped \(Ctrl\+C\)\./);
      assert.equal(getLogs(server).length, 1);
    });
  });
});

describe("JSON, report and transcript", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "elm-e2e-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("--json prints one object per line: start, events, report", async () => {
    await withServer({ head: 50n, logs: [makeLog({ block: 45n, to: ZERO, amount: 1n })] }, async (server) => {
      const { code, stdout } = await runCli(server, ["--json", "--blocks", "10"]);
      assert.equal(code, 0);
      const lines = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      assert.deepEqual(lines.map((line) => line.type), ["start", "event", "report"]);
      const event = lines[1]!.event;
      assert.equal(event.type, "Burn");
      assert.equal(event.amount.raw, "1");
      assert.equal(event.amount.formatted, "0.000001");
      assert.equal(event.to, ZERO);
      assert.equal(event.blockNumber, "45");
      assert.match(event.key, /^0x[0-9a-f]{64}:0$/);
      const report = lines[2]!.report;
      assert.equal(report.ok, true);
      assert.equal(report.dedupKey, "transactionHash:logIndex");
      assert.equal(report.filter.contract, USDC);
      assert.equal(report.filter.topic0, TOPIC);
      assert.deepEqual(report.scanned, { fromBlock: "41", toBlock: "50" });
    });
  });

  test("--transcript, --report and --save-output write matching files", async () => {
    const files = { transcript: join(dir, "t.json"), report: join(dir, "r.json"), output: join(dir, "o.txt") };
    await withServer({ head: 50n, logs: [makeLog({ block: 49n })] }, async (server) => {
      const { code, stdout } = await runCli(server, ["--blocks", "5", "--transcript", files.transcript, "--report", files.report, "--save-output", files.output]);
      assert.equal(code, 0);
      const transcript = JSON.parse(await readFile(files.transcript, "utf8"));
      const report = JSON.parse(await readFile(files.report, "utf8"));
      assert.equal(transcript.format, "pharos-mcp-transcript/1");
      assert.equal(transcript.tool.name, "event-log-monitor");
      assert.deepEqual(transcript.outcome.report.events, report.events);
      assert.equal(report.events.length, 1);
      assert.equal(await readFile(files.output, "utf8"), stdout);
      const tools = transcript.messages.map((m: any) => m.message.params?.name).filter(Boolean);
      assert.deepEqual([...new Set(tools)].sort(), ["get_block_number", "get_chain_info", "get_logs"]);
    });
  });
});

describe("failures and usage", () => {
  test("an endpoint on another chain is refused before any log query (exit 6)", async () => {
    await withServer({ head: 10n, logs: [], chainId: 1 }, async (server) => {
      const { code, stderr } = await runCli(server, ["--watch", "--cycles", "1"]);
      assert.equal(code, 6);
      assert.match(stderr, /chain ID 1, not Pharos Mainnet \(1672\)/);
      assert.equal(getLogs(server).length, 0);
    });
  });

  test("a server without get_logs fails with exit 4", async () => {
    await withServer({ head: 10n, logs: [], tools: ["get_chain_info", "get_block_number"] }, async (server) => {
      const { code, stderr } = await runCli(server, ["--watch", "--cycles", "3", "--lookback", "3"]);
      assert.equal(code, 4);
      assert.match(stderr, /does not expose: get_logs/);
    });
  });

  test("usage errors exit 2", async () => {
    await withServer({ head: 10n, logs: [] }, async (server) => {
      for (const args of [["--watch", "--blocks", "5"], ["--interval", "5"], ["--watch", "--interval", "0"], ["--watch", "--lookback", "-1"], ["--to-block", "5"], ["--blocks", "5", "--from-block", "1"], ["--nope"], ["extra"]]) {
        const { code } = await runCli(server, args);
        assert.equal(code, 2, args.join(" "));
      }
      assert.equal(server.calls.length, 0);
    });
  });
});

describe("no direct RPC", () => {
  const srcDir = fileURLToPath(new URL("../../src/", import.meta.url));

  test("the source never speaks JSON-RPC or calls fetch outside the MCP transport", async () => {
    for (const file of (await readdir(srcDir)).filter((name) => name.endsWith(".ts"))) {
      const text = await readFile(join(srcDir, file), "utf8");
      assert.doesNotMatch(text, /["'`]eth_[A-Za-z]+["'`]|["']jsonrpc["']|viem\/chains|createPublicClient|http\(\s*["']/, file);
      if (file !== "mcp-client.ts") assert.doesNotMatch(text, /\bfetch\(/, file);
    }
  });

  test("the monitor refuses any MCP tool outside get_chain_info, get_block_number, get_logs", async () => {
    const text = await readFile(join(srcDir, "run.ts"), "utf8");
    assert.match(text, /Refusing to call MCP tool/);
    const constants = await readFile(join(srcDir, "constants.ts"), "utf8");
    assert.match(constants, /TOOLS = \["get_chain_info", "get_block_number", "get_logs"\] as const/);
  });
});

describe("real process", () => {
  test("Ctrl+C (SIGINT) on the CLI finishes the poll, prints the summary and exits 0", async () => {
    const chain: FakeLogChain = {
      head: 500n,
      logs: [],
      beforeBlockNumber: (n, c) => {
        c.head += 1n;
        c.logs.push(makeLog({ block: c.head, index: n }));
      },
    };
    await withServer(chain, async (server) => {
      const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
      const child = spawn(process.execPath, [cli, "--watch", "--interval", "1", "--endpoint", server.url, "--no-color"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk) => void (stderr += chunk));
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      await new Promise<void>((resolve) =>
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (/^Transfer\s/m.test(stdout)) resolve();
        }),
      );
      child.kill("SIGINT");
      const code = await exited;
      assert.equal(code, 0, stderr);
      assert.match(stderr, /Stopping after the current poll/);
      assert.match(stdout, /Stopped \(Ctrl\+C\)\./);
      assert.equal(server.openSessions(), 0);
    });
  });
});
