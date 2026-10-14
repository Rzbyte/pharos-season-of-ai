import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TRANSFER_TOPIC, WATCHED_TOKEN } from "../src/constants.js";
import { CliError, ToolCallError } from "../src/errors.js";
import { TransferMonitor, type MonitorOptions } from "../src/monitor.js";
import { ALICE, BOB, FakeCaller, hex, makeLog, serverFilter, TOPIC, transient, USDC, ZERO } from "./fixtures.js";

const noSleep = async () => undefined;
const monitorFor = (caller: FakeCaller, options: Partial<MonitorOptions> = {}) =>
  new TransferMonitor(caller, { token: WATCHED_TOKEN, topic: TRANSFER_TOPIC, sleep: noSleep, ...options });
const ranges = (caller: FakeCaller) => caller.getLogs.map((args) => `${BigInt(String(args.fromBlock))}..${BigInt(String(args.toBlock))}`);

describe("get_logs filter", () => {
  test("every call carries the exact contract, the exact topic0 and explicit hex bounds, never latest", async () => {
    const caller = new FakeCaller(5_000n);
    const monitor = monitorFor(caller, { lookback: 2_500n });
    await monitor.poll();
    caller.head = 5_003n;
    await monitor.poll();
    assert.equal(caller.getLogs.length, 4);
    for (const args of caller.getLogs) {
      assert.deepEqual(Object.keys(args).sort(), ["address", "fromBlock", "toBlock", "topics"]);
      assert.equal(args.address, USDC);
      assert.deepEqual(args.topics, [TOPIC]);
      assert.match(String(args.fromBlock), /^0x[0-9a-f]+$/);
      assert.match(String(args.toBlock), /^0x[0-9a-f]+$/);
      const span = BigInt(String(args.toBlock)) - BigInt(String(args.fromBlock)) + 1n;
      assert.ok(span >= 1n && span <= 1000n, `span ${span}`);
    }
    assert.ok(!JSON.stringify(caller.calls).includes("latest"));
  });
});

describe("polling", () => {
  test("watch mode starts at the head: the first poll queries nothing, later polls only new blocks", async () => {
    const caller = new FakeCaller(100n, [makeLog({ block: 100n }), makeLog({ block: 101n })]);
    const monitor = monitorFor(caller);
    const first = await monitor.poll();
    assert.equal(first.head, 100n);
    assert.equal(first.ranges.length, 0);
    assert.equal(first.events.length, 0);
    assert.equal(monitor.cursor, 100n);

    caller.head = 101n;
    const second = await monitor.poll();
    assert.deepEqual(ranges(caller), ["101..101"]);
    assert.deepEqual(second.events.map((event) => event.blockNumber), [101n]);
    assert.equal(monitor.cursor, 101n);
  });

  test("a newly mined block appears on the next poll", async () => {
    const caller = new FakeCaller(200n, [makeLog({ block: 195n })]);
    const monitor = monitorFor(caller, { lookback: 10n });
    const first = await monitor.poll();
    assert.deepEqual(first.events.map((event) => event.blockNumber), [195n]);

    const quiet = await monitor.poll();
    assert.equal(quiet.ranges.length, 0, "no new block, no get_logs call");

    caller.logs.push(makeLog({ block: 203n, index: 2, from: ZERO }));
    caller.head = 205n;
    const next = await monitor.poll();
    assert.deepEqual(ranges(caller), ["191..200", "201..205"]);
    assert.equal(next.events.length, 1);
    assert.equal(next.events[0]!.kind, "Mint");
  });

  test("zero events: the cursor still advances and nothing is reported", async () => {
    const caller = new FakeCaller(1_000n);
    const monitor = monitorFor(caller, { lookback: 50n });
    const result = await monitor.poll();
    assert.equal(result.events.length, 0);
    assert.equal(result.ranges[0]!.ok, true);
    assert.equal(monitor.cursor, 1_000n);
    assert.equal(result.caughtUp, true);
  });

  test("a gap over 1,000 blocks is split into contiguous ranges", async () => {
    const caller = new FakeCaller(10_000n);
    const monitor = monitorFor(caller);
    await monitor.poll();
    caller.head = 12_345n;
    const result = await monitor.poll();
    assert.deepEqual(ranges(caller), ["10001..11000", "11001..12000", "12001..12345"]);
    assert.equal(result.cursorAfter, 12_345n);
  });

  test("a long outage is caught up over several polls, at most 10 ranges each", async () => {
    const caller = new FakeCaller(0n);
    const monitor = monitorFor(caller);
    await monitor.poll();
    caller.head = 25_000n;
    const first = await monitor.poll();
    assert.equal(first.ranges.length, 10);
    assert.equal(first.caughtUp, false);
    assert.equal(monitor.cursor, 10_000n);
    const second = await monitor.poll();
    assert.equal(second.ranges.length, 10);
    const third = await monitor.poll();
    assert.equal(third.ranges.length, 5);
    assert.equal(third.caughtUp, true);
    assert.equal(monitor.cursor, 25_000n);
  });

  test("finite mode: a caller-supplied head skips get_block_number and upTo caps the target", async () => {
    const caller = new FakeCaller(9_999n, [makeLog({ block: 50n }), makeLog({ block: 1_500n })]);
    const monitor = monitorFor(caller);
    monitor.cursor = 9n;
    const result = await monitor.poll({ head: 9_999n, upTo: 1_200n });
    assert.equal(caller.calls.filter((call) => call.name === "get_block_number").length, 0);
    assert.deepEqual(ranges(caller), ["10..1009", "1010..1200"]);
    assert.deepEqual(result.events.map((event) => event.blockNumber), [50n]);
    assert.equal(monitor.cursor, 1_200n);
  });

  test("a head behind the cursor (lagging node) queries nothing and keeps the cursor", async () => {
    const caller = new FakeCaller(500n);
    const monitor = monitorFor(caller);
    await monitor.poll();
    caller.head = 498n;
    const result = await monitor.poll();
    assert.equal(result.ranges.length, 0);
    assert.equal(monitor.cursor, 500n);
  });
});

describe("cursor and retries", () => {
  test("a failed range does not advance the cursor, and the retry repeats the exact same range", async () => {
    const caller = new FakeCaller(1_000n, [makeLog({ block: 1_005n })]);
    const monitor = monitorFor(caller);
    await monitor.poll();
    caller.head = 1_010n;
    caller.onGetLogs = () => {
      throw transient();
    };
    const failed = await monitor.poll();
    assert.ok(failed.error instanceof ToolCallError);
    assert.equal(failed.ranges[0]!.attempts, 2);
    assert.equal(monitor.cursor, 1_000n, "cursor unchanged");
    assert.equal(failed.events.length, 0);
    assert.deepEqual(caller.getLogs[0], caller.getLogs[1], "in-poll retry: same arguments");

    caller.onGetLogs = undefined;
    caller.head = 1_020n;
    const recovered = await monitor.poll();
    // The failed range first, unchanged; only then the blocks mined since.
    assert.deepEqual(ranges(caller), ["1001..1010", "1001..1010", "1001..1010", "1011..1020"]);
    assert.deepEqual(caller.getLogs[2], caller.getLogs[0]);
    assert.equal(recovered.events.length, 1);
    assert.equal(monitor.cursor, 1_020n);
  });

  test("while the head is below a failed range's end, nothing is queried; then that range comes first", async () => {
    const caller = new FakeCaller(1_000n);
    const monitor = monitorFor(caller);
    await monitor.poll();
    caller.head = 1_010n;
    caller.onGetLogs = () => {
      throw transient();
    };
    await monitor.poll();
    caller.onGetLogs = undefined;
    caller.head = 1_005n; // a lagging node answers next
    const lagging = await monitor.poll();
    assert.equal(lagging.ranges.length, 0);
    assert.equal(monitor.cursor, 1_000n);
    caller.head = 1_012n;
    await monitor.poll();
    assert.deepEqual(ranges(caller).slice(2), ["1001..1010", "1011..1012"]);
    assert.equal(monitor.cursor, 1_012n);
  });

  test("a transient failure is retried once with identical arguments and then succeeds", async () => {
    const caller = new FakeCaller(300n, [makeLog({ block: 250n })]);
    caller.onGetLogs = (_args, call) => {
      if (call === 1) throw transient();
      return undefined;
    };
    let slept = 0;
    const monitor = monitorFor(caller, { lookback: 100n, retryDelayMs: 7, sleep: async (ms) => void (slept += ms) });
    const result = await monitor.poll();
    assert.equal(result.error, undefined);
    assert.equal(result.ranges[0]!.attempts, 2);
    assert.deepEqual(caller.getLogs[0], caller.getLogs[1]);
    assert.equal(slept, 7);
    assert.equal(result.events.length, 1);
    assert.equal(monitor.cursor, 300n);
  });

  test("when the second of three ranges fails, the first range commits and the cursor stops at its end", async () => {
    const caller = new FakeCaller(0n, [makeLog({ block: 500n }), makeLog({ block: 1_500n }), makeLog({ block: 2_500n })]);
    const monitor = monitorFor(caller);
    await monitor.poll();
    caller.head = 3_000n;
    caller.onGetLogs = (args) => {
      if (args.fromBlock === hex(1_001n)) throw transient();
      return undefined;
    };
    const result = await monitor.poll();
    assert.deepEqual(result.events.map((event) => event.blockNumber), [500n]);
    assert.equal(monitor.cursor, 1_000n);
    assert.deepEqual(result.ranges.map((range) => range.ok), [true, false]);

    caller.onGetLogs = undefined;
    const next = await monitor.poll();
    assert.deepEqual(next.ranges.map((range) => `${range.from}..${range.to}`), ["1001..2000", "2001..3000"]);
    assert.deepEqual(next.events.map((event) => event.blockNumber), [1_500n, 2_500n]);
  });

  test("rejected arguments and lost connections are not retried in the poll", async () => {
    for (const error of [new ToolCallError("get_logs", "Input validation error", -32602), new CliError("MCP_CONNECTION", "closed")]) {
      const caller = new FakeCaller(10n);
      const monitor = monitorFor(caller, { lookback: 5n });
      caller.onGetLogs = () => {
        throw error;
      };
      const result = await monitor.poll();
      assert.equal(result.ranges[0]!.attempts, 1);
      assert.equal(result.error, error);
      assert.equal(monitor.cursor, 5n);
    }
  });

  test("a get_block_number failure leaves the cursor and queries no logs", async () => {
    const caller = new FakeCaller(10n);
    const monitor = monitorFor(caller);
    await monitor.poll();
    caller.onBlockNumber = () => {
      throw new CliError("MCP_CONNECTION", "gone");
    };
    const result = await monitor.poll();
    assert.equal(result.error?.kind, "MCP_CONNECTION");
    assert.equal(result.head, undefined);
    assert.equal(caller.getLogs.length, 0);
    assert.equal(monitor.cursor, 10n);
  });

  test("a non-array get_logs payload is a failure, retried once, and the cursor stays", async () => {
    const caller = new FakeCaller(10n);
    caller.onGetLogs = () => ({ error: "weird" });
    const monitor = monitorFor(caller, { lookback: 5n });
    const result = await monitor.poll();
    assert.ok(result.error instanceof ToolCallError);
    assert.equal(result.ranges[0]!.attempts, 2);
    assert.equal(monitor.cursor, 5n);
  });
});

describe("dedup", () => {
  test("the same log returned twice in one response is reported once", async () => {
    const log = makeLog({ block: 7n, index: 1 });
    const caller = new FakeCaller(10n);
    caller.onGetLogs = () => [log, structuredClone(log)];
    const result = await monitorFor(caller, { lookback: 5n }).poll();
    assert.equal(result.events.length, 1);
    assert.equal(result.skipped.duplicate, 1);
  });

  test("the same event across multiple polls is reported once (re-included in a later block)", async () => {
    const tx = `0x${"ab".repeat(32)}`;
    const caller = new FakeCaller(100n, [makeLog({ block: 95n, index: 2, tx })]);
    const monitor = monitorFor(caller, { lookback: 10n });
    assert.equal((await monitor.poll()).events.length, 1);
    // Same transactionHash + logIndex, now in block 103 (as after a reorg that re-mined the tx).
    caller.logs.push(makeLog({ block: 103n, index: 2, tx }));
    caller.head = 105n;
    const second = await monitor.poll();
    assert.equal(second.events.length, 0);
    assert.equal(second.skipped.duplicate, 1);
    assert.equal(monitor.totals.reported, 1);
  });

  test("same transaction, different logIndex: two events", async () => {
    const tx = `0x${"cd".repeat(32)}`;
    const caller = new FakeCaller(10n, [makeLog({ block: 8n, index: 0, tx }), makeLog({ block: 8n, index: 1, tx, to: ZERO })]);
    const result = await monitorFor(caller, { lookback: 5n }).poll();
    assert.deepEqual(result.events.map((event) => event.kind), ["Transfer", "Burn"]);
  });

  test("a server that ignores the range cannot cause duplicates: out-of-range logs wait for their own range", async () => {
    const logs = [makeLog({ block: 3n }), makeLog({ block: 8n }), makeLog({ block: 12n })];
    const caller = new FakeCaller(10n, logs);
    caller.onGetLogs = () => logs;
    const monitor = monitorFor(caller, { lookback: 10n });
    const first = await monitor.poll();
    assert.deepEqual(first.events.map((event) => event.blockNumber), [3n, 8n]);
    assert.equal(first.skipped.outsideRange, 1);
    caller.head = 20n;
    const second = await monitor.poll();
    assert.deepEqual(second.events.map((event) => event.blockNumber), [12n]);
    assert.equal(second.skipped.outsideRange, 2);
    assert.equal(monitor.totals.reported, 3);
  });

  test("a server that ignores the filter cannot inject other contracts or events", async () => {
    const other = makeLog({ block: 5n, address: "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0" });
    const approval = makeLog({ block: 6n });
    (approval.topics as string[])[0] = "0x8c5be1e5ebec7d5bd14f71427e1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
    const caller = new FakeCaller(10n);
    caller.onGetLogs = () => [other, approval, makeLog({ block: 7n })];
    const result = await monitorFor(caller, { lookback: 10n }).poll();
    assert.deepEqual(result.events.map((event) => event.blockNumber), [7n]);
    assert.equal(result.skipped.wrongFilter, 2);
  });

  test("events come out in block, then logIndex order", async () => {
    const caller = new FakeCaller(10n);
    caller.onGetLogs = () => [makeLog({ block: 9n, index: 0 }), makeLog({ block: 8n, index: 5 }), makeLog({ block: 8n, index: 2 })];
    const result = await monitorFor(caller, { lookback: 10n }).poll();
    assert.deepEqual(result.events.map((event) => `${event.blockNumber}:${event.logIndex}`), ["8:2", "8:5", "9:0"]);
  });

  test("dedup memory is bounded, oldest keys evicted first", async () => {
    const caller = new FakeCaller(10n, [1n, 2n, 3n, 4n].map((block) => makeLog({ block })));
    const monitor = monitorFor(caller, { lookback: 10n, seenCapacity: 2 });
    await monitor.poll();
    assert.equal(monitor.seenCount, 2);
  });
});

describe("removed logs", () => {
  test("a removed log never seen before is not reported, only counted", async () => {
    const caller = new FakeCaller(10n, [makeLog({ block: 5n, removed: true }), makeLog({ block: 6n })]);
    const result = await monitorFor(caller, { lookback: 10n }).poll();
    assert.deepEqual(result.events.map((event) => event.blockNumber), [6n]);
    assert.equal(result.skipped.removed, 1);
    assert.equal(result.retractions.length, 0);
  });

  test("a removed log that was reported earlier is retracted, and its key forgotten", async () => {
    const tx = `0x${"ee".repeat(32)}`;
    const caller = new FakeCaller(10n, [makeLog({ block: 8n, index: 4, tx })]);
    const monitor = monitorFor(caller, { lookback: 5n });
    assert.equal((await monitor.poll()).events.length, 1);

    caller.head = 12n;
    caller.onGetLogs = () => [makeLog({ block: 11n, index: 4, tx, removed: true })];
    const result = await monitor.poll();
    assert.equal(result.events.length, 0);
    assert.deepEqual(result.retractions, [{ key: `${tx}:4`, transactionHash: tx, logIndex: 4, blockNumber: 11n }]);
    assert.equal(monitor.totals.retracted, 1);

    // Re-included later: reported again, since the retraction withdrew the first report.
    caller.head = 14n;
    caller.onGetLogs = () => [makeLog({ block: 13n, index: 4, tx })];
    assert.equal((await monitor.poll()).events.length, 1);
  });

  test("a reorged log keeps its original block, behind the cursor, and is still retracted", async () => {
    const tx = `0x${"ef".repeat(32)}`;
    const reported = makeLog({ block: 8n, index: 1, tx });
    const caller = new FakeCaller(10n, [reported]);
    const monitor = monitorFor(caller, { lookback: 5n });
    assert.equal((await monitor.poll()).events.length, 1);
    caller.head = 12n;
    caller.onGetLogs = () => [{ ...reported, removed: true }];
    const result = await monitor.poll();
    assert.deepEqual(result.retractions.map((entry) => [entry.key, entry.blockNumber]), [[`${tx}:1`, 8n]]);
    assert.equal(result.skipped.outsideRange, 0);
  });

  test("a removed log outside the range and never reported is only counted as outside the range", async () => {
    const caller = new FakeCaller(10n);
    caller.onGetLogs = () => [makeLog({ block: 2n, removed: true })];
    const result = await monitorFor(caller, { lookback: 5n }).poll();
    assert.equal(result.skipped.outsideRange, 1);
    assert.equal(result.skipped.removed, 0);
    assert.deepEqual(result.removedKeys, []);
  });

  test("removed must be a boolean when present", async () => {
    const caller = new FakeCaller(10n, [{ ...makeLog({ block: 5n }), removed: "false" }]);
    const result = await monitorFor(caller, { lookback: 10n }).poll();
    assert.equal(result.events.length, 0);
    assert.equal(result.malformed[0]?.reason, "removed is not a boolean");
  });
});

describe("malformed logs", () => {
  test("are skipped with a reason, do not stop the range, and the cursor still advances", async () => {
    const bad = { ...makeLog({ block: 4n }), data: "0x" };
    const caller = new FakeCaller(10n, [bad, makeLog({ block: 5n, from: ALICE, to: BOB })]);
    const monitor = monitorFor(caller, { lookback: 10n });
    const result = await monitor.poll();
    assert.equal(result.events.length, 1);
    assert.equal(result.malformed.length, 1);
    assert.match(result.malformed[0]!.reason, /data/);
    assert.equal(result.malformed[0]!.blockNumber, "4");
    assert.equal(monitor.cursor, 10n);
  });

  test("non-object entries and logs without a block are malformed", async () => {
    const caller = new FakeCaller(10n);
    caller.onGetLogs = () => [null, 5, { ...makeLog({ block: 5n }), blockNumber: null }];
    const result = await monitorFor(caller, { lookback: 10n }).poll();
    assert.equal(result.skipped.malformed, 3);
  });
});

describe("serverFilter (the fake itself)", () => {
  test("rejects ranges over 1,000 blocks like the real server", () => {
    assert.throws(() => serverFilter([], { fromBlock: "0x0", toBlock: hex(1_000n) }), /Block range too large/);
    assert.deepEqual(serverFilter([], { fromBlock: "0x0", toBlock: hex(999n), address: USDC, topics: [TOPIC] }), []);
  });
});
