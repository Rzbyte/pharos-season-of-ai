import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getAddress } from "viem";
import { MAX_BLOCK_RANGE, TRANSFER_TOPIC, WATCHED_TOKEN } from "../src/constants.js";
import { getLogsArgs, isRetryable, parseBlockNumber, planRanges } from "../src/monitor.js";
import { CliError, ToolCallError } from "../src/errors.js";
import { classify, decodeTransfer, logKey, shortAddress, summarize, ZERO_ADDRESS } from "../src/transfer.js";
import { ALICE, APPROVAL_TOPIC, BOB, makeLog, TOPIC, topicFor, USDC, word, ZERO } from "./fixtures.js";

const token = WATCHED_TOKEN;
const decoded = (log: Record<string, unknown>) => {
  const result = decodeTransfer(log, token);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return (result as Extract<typeof result, { ok: true }>).event;
};
const rejected = (log: unknown) => {
  const result = decodeTransfer(log as Record<string, unknown>, token);
  assert.equal(result.ok, false);
  return (result as Extract<typeof result, { ok: false }>).reason;
};

describe("constants", () => {
  test("watch the exact Circle USDC address and the Transfer topic0", () => {
    assert.equal(WATCHED_TOKEN.address, USDC);
    assert.equal(WATCHED_TOKEN.address, getAddress(USDC));
    assert.equal(WATCHED_TOKEN.decimals, 6);
    assert.equal(TRANSFER_TOPIC, TOPIC);
    assert.equal(MAX_BLOCK_RANGE, 1000n);
  });
});

describe("decodeTransfer", () => {
  test("decodes from, to, amount, tx hash, block and log index from a live-shaped log", () => {
    const log = makeLog({ block: 20_248_479n, index: 7, amount: 125_500_000n });
    const event = decoded(log);
    assert.equal(event.from, getAddress(ALICE));
    assert.equal(event.to, getAddress(BOB));
    assert.equal(event.amountRaw, 125_500_000n);
    assert.equal(event.amount, "125.5");
    assert.equal(event.symbol, "USDC");
    assert.equal(event.transactionHash, log.transactionHash);
    assert.equal(event.blockNumber, 20_248_479n);
    assert.equal(event.logIndex, 7);
    assert.equal(event.key, `${log.transactionHash}:7`);
    assert.equal(event.kind, "Transfer");
    assert.equal(event.summary, `125.5 USDC transferred from ${shortAddress(getAddress(ALICE))} to ${shortAddress(getAddress(BOB))}`);
  });

  test("decoded fields match the raw topics and data exactly", () => {
    const log = makeLog({ block: 5n, from: BOB, to: ALICE, amount: 2n ** 255n + 1n });
    const event = decoded(log);
    const topics = log.topics as string[];
    assert.equal(event.from.toLowerCase(), `0x${topics[1]!.slice(26)}`);
    assert.equal(event.to.toLowerCase(), `0x${topics[2]!.slice(26)}`);
    assert.equal(event.amountRaw, BigInt(log.data as string));
  });

  test("formats amounts with 6 decimals, exactly and without rounding", () => {
    const amount = (raw: bigint) => decoded(makeLog({ block: 1n, amount: raw })).amount;
    assert.equal(amount(0n), "0");
    assert.equal(amount(1n), "0.000001");
    assert.equal(amount(1_000_000n), "1");
    assert.equal(amount(125_500_000n), "125.5");
    assert.equal(amount(1_234_567_890_123n), "1,234,567.890123");
    assert.equal(amount(2n ** 256n - 1n).replace(/,/g, "").length, 79);
  });

  test("accepts uppercase hex and a log without removed", () => {
    const log = makeLog({ block: 10n });
    log.transactionHash = String(log.transactionHash).toUpperCase().replace("0X", "0x");
    log.data = String(log.data).toUpperCase().replace("0X", "0x");
    delete log.removed;
    const event = decoded(log);
    assert.equal(event.transactionHash, String(log.transactionHash).toLowerCase());
  });

  test("rejects a log of another contract", () => {
    assert.match(rejected(makeLog({ block: 1n, address: "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0" })), /not the watched contract/);
  });

  test("rejects a log with another topic0 (Approval)", () => {
    const log = makeLog({ block: 1n });
    (log.topics as string[])[0] = APPROVAL_TOPIC;
    assert.match(rejected(log), /topic0/);
  });

  test("rejects malformed topics", () => {
    const withTopics = (topics: unknown) => ({ ...makeLog({ block: 1n }), topics });
    assert.match(rejected(withTopics([TOPIC, topicFor(ALICE)])), /expected 3 topics/);
    // ERC-721 Transfer: tokenId indexed as a fourth topic, empty data.
    assert.match(rejected({ ...withTopics([TOPIC, topicFor(ALICE), topicFor(BOB), word(1n)]), data: "0x" }), /expected 3 topics/);
    assert.match(rejected(withTopics("0xdd")), /not an array/);
    assert.match(rejected(withTopics([TOPIC, `0x${"1".repeat(64)}`, topicFor(BOB)])), /topic1/);
    assert.match(rejected(withTopics([TOPIC, topicFor(ALICE), topicFor(BOB).slice(0, 60)])), /topic2/);
    assert.match(rejected(withTopics([TOPIC, 12, topicFor(BOB)])), /topic1/);
  });

  test("rejects malformed data", () => {
    const withData = (data: unknown) => ({ ...makeLog({ block: 1n }), data });
    assert.match(rejected(withData("0x")), /data/);
    assert.match(rejected(withData(`${word(1n)}00`)), /data/);
    assert.match(rejected(withData(`${word(1n)}${word(2n).slice(2)}`)), /data/);
    assert.match(rejected(withData(word(1n).slice(0, 64))), /data/);
    assert.match(rejected(withData(`0x${"zz".repeat(32)}`)), /data/);
    assert.match(rejected(withData(5)), /data/);
  });

  test("rejects a missing tx hash, block or log index", () => {
    assert.match(rejected({ ...makeLog({ block: 1n }), transactionHash: "0x1234" }), /transactionHash/);
    assert.match(rejected({ ...makeLog({ block: 1n }), blockNumber: null }), /blockNumber/);
    assert.match(rejected({ ...makeLog({ block: 1n }), blockNumber: 12 }), /blockNumber/);
    assert.match(rejected({ ...makeLog({ block: 1n }), logIndex: undefined }), /logIndex/);
    assert.match(rejected({ ...makeLog({ block: 1n }), logIndex: "7" }), /logIndex/);
    assert.match(rejected(null), /not an object/);
    assert.match(rejected([]), /not an object/);
  });
});

describe("classification", () => {
  test("from the zero address is a Mint", () => {
    const event = decoded(makeLog({ block: 1n, from: ZERO, to: BOB }));
    assert.equal(event.kind, "Mint");
    assert.equal(event.summary, `125.5 USDC minted to ${shortAddress(getAddress(BOB))}`);
  });

  test("to the zero address is a Burn", () => {
    const event = decoded(makeLog({ block: 1n, from: ALICE, to: ZERO }));
    assert.equal(event.kind, "Burn");
    assert.equal(event.summary, `125.5 USDC burned from ${shortAddress(getAddress(ALICE))}`);
  });

  test("anything else is a Transfer, and Mint wins when both are zero", () => {
    assert.equal(classify(getAddress(ALICE), getAddress(BOB)), "Transfer");
    assert.equal(classify(ZERO_ADDRESS, ZERO_ADDRESS), "Mint");
  });

  test("summaries follow the three fixed sentences", () => {
    const a = getAddress("0x1234567890123456789012345678901234567890");
    const b = getAddress("0x0987654321098765432109876543210987654321");
    assert.equal(shortAddress(a), "0x1234…7890");
    assert.equal(summarize("Transfer", "125.5 USDC", a, b), "125.5 USDC transferred from 0x1234…7890 to 0x0987…4321");
    assert.equal(summarize("Mint", "125.5 USDC", ZERO_ADDRESS, b), "125.5 USDC minted to 0x0987…4321");
    assert.equal(summarize("Burn", "125.5 USDC", a, ZERO_ADDRESS), "125.5 USDC burned from 0x1234…7890");
  });
});

describe("dedup key", () => {
  test("is transactionHash + logIndex, case-insensitive on the hash", () => {
    const log = makeLog({ block: 9n, index: 3 });
    assert.equal(logKey(log), `${log.transactionHash}:3`);
    assert.equal(logKey({ ...log, transactionHash: String(log.transactionHash).toUpperCase().replace("0X", "0x") }), `${log.transactionHash}:3`);
    assert.notEqual(logKey(makeLog({ block: 9n, index: 4, tx: log.transactionHash as string })), logKey(log));
    assert.equal(logKey({ ...log, logIndex: null }), undefined);
  });
});

describe("planRanges", () => {
  test("splits a gap into contiguous ranges of at most 1,000 blocks", () => {
    assert.deepEqual(planRanges(1n, 2500n), [
      { from: 1n, to: 1000n },
      { from: 1001n, to: 2000n },
      { from: 2001n, to: 2500n },
    ]);
    assert.deepEqual(planRanges(5n, 5n), [{ from: 5n, to: 5n }]);
    assert.deepEqual(planRanges(10n, 1009n), [{ from: 10n, to: 1009n }]);
    assert.deepEqual(planRanges(10n, 1010n), [
      { from: 10n, to: 1009n },
      { from: 1010n, to: 1010n },
    ]);
    assert.deepEqual(planRanges(6n, 5n), []);
  });

  test("respects a limit on the number of ranges", () => {
    assert.deepEqual(planRanges(0n, 99_999n, 1000n, 3), [
      { from: 0n, to: 999n },
      { from: 1000n, to: 1999n },
      { from: 2000n, to: 2999n },
    ]);
  });

  test("every planned range is non-empty, at most 1,000 blocks, and they tile the gap", () => {
    for (const [from, to] of [[0n, 0n], [7n, 12_345n], [20_247_480n, 20_248_479n], [1n, 3000n]] as const) {
      const ranges = planRanges(from, to);
      let next = from;
      for (const range of ranges) {
        assert.equal(range.from, next);
        assert.ok(range.to >= range.from && range.to - range.from + 1n <= 1000n);
        next = range.to + 1n;
      }
      assert.equal(next, to + 1n);
    }
  });
});

describe("get_logs arguments", () => {
  test("always the exact address, the exact topic0 and explicit hex bounds", () => {
    assert.deepEqual(getLogsArgs(token, TRANSFER_TOPIC, { from: 20_247_480n, to: 20_248_479n }), {
      address: USDC,
      topics: [TOPIC],
      fromBlock: "0x134f3b8",
      toBlock: "0x134f79f",
    });
  });
});

describe("helpers", () => {
  test("parseBlockNumber reads the get_block_number payload", () => {
    assert.equal(parseBlockNumber({ blockNumber: "20248479", blockNumberHex: "0x134f79f" }), 20_248_479n);
    assert.equal(parseBlockNumber({ blockNumberHex: "0x134f79f" }), 20_248_479n);
    assert.throws(() => parseBlockNumber({ blockNumber: "latest" }), CliError);
  });

  test("only transient tool errors are retried", () => {
    assert.equal(isRetryable(new ToolCallError("get_logs", "header not found", -32000)), true);
    assert.equal(isRetryable(new ToolCallError("get_logs", "Input validation error", -32602)), false);
    assert.equal(isRetryable(new ToolCallError("get_logs", "Block range too large: 1001 blocks requested")), false);
    assert.equal(isRetryable(new CliError("MCP_CONNECTION", "gone")), false);
    assert.equal(isRetryable(new Error("boom")), false);
  });
});
