// Task 26, Audit-Log Agent: a period placed in blocks (the last hours, two times, two blocks), the address
// read at the block before it and at its end, its logs over every official token in two queries a page,
// and the report: transactions sent, flows and counterparties, approvals, wrapping, transfers of nothing,
// balances reconciled with the logs, a timeline, and plain sentences; a node without the older state; the
// input checks; proofs; pacing under the hosted endpoint's rate.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeAbiParameters, getAddress, maxUint256, type Hex } from "viem";
import { BlockClock, parsePeriod, type PeriodRequest } from "../src/audit/period.js";
import { APPROVAL_TOPIC, auditAddress, DEPOSIT_TOPIC, WITHDRAWAL_TOPIC, type AuditReport } from "../src/audit/report.js";
import { verifyAuditProof } from "../src/audit/verify.js";
import { AgentError } from "../src/core/errors.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { TRANSFER_TOPIC } from "../src/policy/check.js";
import { defaultState, startFakeChain, type FakeChain, type FakeToken, type FakeWorld } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const net = NETWORKS["pharos-mainnet"];
const [WPROS, USDC, LINK, WETH] = net.tokens.map((t) => t.address.toLowerCase());
const ME = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const TRADER = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const BUSY = "0x936564245B69f5a293b42cbd752E0eE3bb68b470";
const POISONER = "0x2222222222222222222222222222222222222222";
const ROUTER = "0xC0FFEE0000000000000000000000000000000001";
const lower = (a: string) => a.toLowerCase();
const word = (type: string, value: unknown): Hex => encodeAbiParameters([{ type }], [value]);
const HEAD = 5_000_000n;
/** The block before the last hour: the fake chain's blocks are one second apart. */
const BEFORE_HOUR = HEAD - 3600n;
const NOW = new Date("2026-10-17T12:00:00.000Z");

const tokens = (who: string, usdc: bigint, wpros: bigint, weth = 3n * 10n ** 18n): Record<string, FakeToken> => ({
  [WPROS!]: { decimals: 18, balances: { [lower(who)]: wpros } },
  [USDC!]: { decimals: 6, balances: { [lower(who)]: usdc } },
  [LINK!]: { decimals: 18, balances: {} },
  [WETH!]: { decimals: 18, balances: { [lower(who)]: weth } },
});
const world = (who: string, native: bigint, nonce: bigint, usdc: bigint, wpros: bigint): FakeWorld => ({ native: { [lower(who)]: native }, nonces: { [lower(who)]: nonce }, tokens: tokens(who, usdc, wpros) });

/** An active hour: USDC in from two addresses and out to one, an unlimited approval, a deposit into WPROS, a transfer of nothing. */
const active = () =>
  startFakeChain(
    defaultState({
      ...world(ME, 119n * 10n ** 16n, 1217n, 2_145_500_000n, 10n ** 18n),
      transfers: [
        { token: USDC!, from: TRADER, to: ME, amount: 1_000_000_000n, block: HEAD - 3000n },
        { token: USDC!, from: TRADER, to: ME, amount: 500_000_000n, block: HEAD - 2000n },
        { token: USDC!, from: BUSY, to: ME, amount: 845_500_000n, block: HEAD - 1500n },
        { token: USDC!, from: ME, to: BUSY, amount: 1_200_000_000n, block: HEAD - 500n },
        { token: USDC!, from: POISONER, to: ME, amount: 0n, block: HEAD - 400n },
        { token: USDC!, from: ME, to: TRADER, amount: 1n, block: HEAD - 5000n }, // before the hour
      ],
      logs: [
        { address: USDC!, topics: [APPROVAL_TOPIC, word("address", lower(ME)), word("address", lower(ROUTER))], data: word("uint256", maxUint256), block: HEAD - 100n },
        { address: WPROS!, topics: [DEPOSIT_TOPIC, word("address", lower(ME))], data: word("uint256", 10n ** 18n), block: HEAD - 50n },
      ],
      past: { [BEFORE_HOUR.toString()]: world(ME, 125n * 10n ** 16n, 1203n, 1_000_000_000n, 0n) },
    }),
  );

async function audit(fake: FakeChain, period: PeriodRequest, options: { address?: string; maxBlocks?: number } = {}): Promise<{ report: AuditReport; proof: ProofFile; calls: { name: string; arguments: Record<string, unknown> }[] }> {
  const official = await connectOfficial(fake, net, { budget: 200 });
  try {
    const address = getAddress(options.address ?? ME);
    const report = await auditAddress(address, period, { chain: official.chain, maxBlocks: options.maxBlocks, now: () => NOW });
    const proof = JSON.parse(JSON.stringify(proofFile({ task: "26", capability: "audit-log", about: "test", mcp: official.mcp, network: net, startedAt: new Date(), input: { address, period, maxBlocks: options.maxBlocks }, result: report }))) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    const calls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);
    return { report, proof, calls };
  } finally {
    await official.close();
  }
}

const LAST_HOUR: PeriodRequest = { kind: "hours", hours: 1 };

describe("an activity report for an address over a period", () => {
  test("an active hour: flows and counterparties, an approval, wrapping and a transfer of nothing, reconciled, in sentences", async () => {
    const fake = await active();
    try {
      const { report, proof, calls } = await audit(fake, LAST_HOUR);
      assert.equal(report.headline, "0x912c…f647 in the last hour: 14 transactions sent, 4 token transfers, 1 approval and 1 transfer of nothing.");
      assert.deepEqual(report.summary, [
        "Activity of 0x912c…f647 in the last hour: blocks 4,996,401 to 5,000,000 (21 Sep 2026, 13:13:21 to 14:13:20 UTC).",
        "It sent 14 transactions (its nonce went from 1,203 to 1,217).",
        "It received 2,345.5 USDC in 3 transfers (2 from 0x1F35…c85C) and sent 1,200 USDC in 1 transfer to 0x9365…b470.",
        "Its WPROS grew by 1 in 1 deposit (wrapping).",
        "It approved 0xC0FF…0001 to spend unlimited USDC.",
        "It had 1 transfer of nothing, with 0x2222…2222: that is how address poisoning plants lookalike addresses in a wallet's history, so never copy an address from them.",
        "Its PROS went from 1.25 to 1.19 (−0.06): gas, and any PROS it sent or received, which leave no logs.",
        "Its USDC went from 1,000 to 2,145.5, all of it in the logs above.",
        "Its WPROS went from 0 to 1, all of it in the logs above.",
        "It held 3 WETH throughout.",
      ]);
      const usdc = report.tokens.find((t) => t.symbol === "USDC")!;
      assert.deepEqual([usdc.in, usdc.out, usdc.unexplained, usdc.zeroValue], [{ count: 3, raw: "2345500000", shown: "2,345.5" }, { count: 1, raw: "1200000000", shown: "1,200" }, "0", 1]);
      assert.deepEqual(usdc.counterparties, [{ address: TRADER, in: 2, out: 0 }, { address: BUSY, in: 1, out: 1 }]);
      assert.deepEqual(report.approvals.map((a) => [a.spender, a.shown, a.symbol]), [[getAddress(ROUTER), "unlimited", "USDC"]]);
      assert.deepEqual([report.sent, report.quiet, report.opening?.block, report.closing.block], [14, false, "4996400", "5000000"]);
      assert.deepEqual(report.events.map((e) => [e.block, e.approxTime.slice(11, 19), e.text]), [
        ["4999950", "14:12:30", "Wrapped 1 WPROS (a deposit)"],
        ["4999900", "14:11:40", "Approved 0xC0FF…0001 to spend unlimited USDC"],
        ["4999600", "14:06:40", "Received 0 USDC from 0x2222…2222 (a transfer of nothing)"],
        ["4999500", "14:05:00", "Sent 1,200 USDC to 0x9365…b470"],
        ["4998500", "13:48:20", "Received 845.5 USDC from 0x9365…b470"],
        ["4998000", "13:40:00", "Received 500 USDC from 0x1F35…c85C"],
        ["4997000", "13:23:20", "Received 1,000 USDC from 0x1F35…c85C"],
      ]);
      // Two queries a page over every official token at once: from it (four events), then to it.
      const me = word("address", lower(ME));
      const logs = calls.filter((c) => c.name === "get_logs");
      assert.equal(logs.length, 8, "3,600 blocks: four pages of two queries");
      assert.deepEqual(logs[0]!.arguments.address, net.tokens.map((t) => getAddress(t.address)));
      assert.deepEqual(logs.slice(0, 2).map((c) => c.arguments.topics), [[[TRANSFER_TOPIC, APPROVAL_TOPIC, DEPOSIT_TOPIC, WITHDRAWAL_TOPIC], me], [TRANSFER_TOPIC, null, me]]);
      assert.equal(calls.filter((c) => c.name === "get_block").length, 5, "the newest block, then four reads place the hour's start");
      assert.deepEqual((await verifyAuditProof(proof)).filter((c) => !c.ok), []);
    } finally {
      await fake.close();
    }
  });

  test("a quiet hour: nothing happened, and the report and its headline say so", async () => {
    const fake = await startFakeChain(defaultState({ ...world(ME, 10n ** 18n, 50n, 0n, 0n), past: { [BEFORE_HOUR.toString()]: world(ME, 10n ** 18n, 50n, 0n, 0n) } }));
    try {
      const { report } = await audit(fake, LAST_HOUR);
      assert.equal(report.headline, "0x912c…f647 in the last hour: nothing happened.");
      assert.deepEqual(report.summary.slice(1), ["Nothing happened: no transaction sent, no token moved, no approval given.", "Its PROS stayed at 1.", "It held 3 WETH throughout."]);
      assert.deepEqual([report.quiet, report.events, report.sent], [true, [], 0]);
    } finally {
      await fake.close();
    }
  });

  test("two times or two blocks: the same blocks; back-to-back periods share none; a few block reads place a time", async () => {
    const fake = await active();
    try {
      const at = (n: bigint) => new Date(Number(1_790_000_000n - (HEAD - n)) * 1000).toISOString();
      const first = await audit(fake, parsePeriod({ since: at(HEAD - 2000n), until: at(HEAD - 1000n) }));
      assert.deepEqual([first.report.period.from.number, first.report.period.to.number, first.report.period.description], ["4998001", "4999000", "from 21 Sep 2026, 13:40 to 13:56:40 UTC"]);
      assert.equal(first.calls.filter((c) => c.name === "get_block").length, 6, "the newest block, then four reads for the start and one for the end");
      const next = await audit(fake, parsePeriod({ since: at(HEAD - 1000n), until: at(HEAD) }));
      assert.deepEqual([next.report.period.from.number, next.report.period.to.number], ["4999001", "5000000"]);
      const blocks = await audit(fake, parsePeriod({ fromBlock: "4998001", toBlock: "4999000" }));
      assert.deepEqual([blocks.report.period.from.number, blocks.report.period.to.number, blocks.report.period.description], ["4998001", "4999000", "in blocks 4,998,001 to 4,999,000"]);
      assert.equal(blocks.report.summary[0], "Activity of 0x912c…f647 in blocks 4,998,001 to 4,999,000 (21 Sep 2026, 13:40:01 to 13:56:40 UTC).");
      assert.deepEqual(blocks.report.events.map((e) => e.text), ["Received 845.5 USDC from 0x9365…b470"], "the 500 USDC of block 4,998,000 is the period before");
      // A block period is cacheable once it has ended; it never reads past the newest block.
      await assert.rejects(audit(fake, parsePeriod({ fromBlock: "4999000", toBlock: "5000001" })), /Block 5,000,001 is not mined yet: the newest is 5,000,000\./);
      await assert.rejects(audit(fake, parsePeriod({ since: at(HEAD + 10n) })), /No block has been mined since 21 Sep 2026, 14:13:30 UTC: the newest is from 14:13:20\./);
    } finally {
      await fake.close();
    }
  });

  test("placing a time on an irregular chain: two blocks a second with shared timestamps, then seven seconds a block", async () => {
    const KINK = 4_990_000n;
    const timeOf = (n: bigint) => (n < KINK ? 1_780_000_000n + n / 2n : 1_780_000_000n + KINK / 2n + (n - KINK) * 7n);
    const fake = await startFakeChain(defaultState({ timeOf }));
    try {
      // The first block after a time, the slow way: every block's time is known here (none after: HEAD + 1).
      const expected = (target: bigint) => {
        let [lo, hi] = [-1n, HEAD + 1n];
        while (hi - lo > 1n) {
          const mid = (lo + hi) / 2n;
          if (timeOf(mid) > target) hi = mid;
          else lo = mid;
        }
        return hi;
      };
      const head = timeOf(HEAD);
      for (const back of [0n, 1n, 6n, 7n, 3600n, 70_000n, 70_001n, 100_000n, 86_400n * 7n, 2_000_000n]) {
        const official = await connectOfficial(fake, net, { budget: 80 });
        try {
          const clock = new BlockClock(official.chain, await official.chain.block(HEAD));
          assert.equal(await clock.firstAfter(head - back), expected(head - back), `${back} s before the newest block`);
          assert.ok(official.mcp.toolCalls <= 50, `${back} s: ${official.mcp.toolCalls} calls`);
        } finally {
          await official.close();
        }
      }
    } finally {
      await fake.close();
    }
  });

  test("a period longer than a report reads is trimmed to its newest blocks, and says so", async () => {
    const fake = await active();
    try {
      const { report, proof } = await audit(fake, LAST_HOUR, { maxBlocks: 2000 });
      assert.deepEqual([report.period.from.number, report.period.blocks, report.period.trimmed, report.scanned.pages], ["4998001", 2000, { from: "4996401", blocks: "3600" }, 4]);
      assert.equal(report.summary[1], "Only the newest 2,000 of the period's 3,600 blocks were read; a longer period needs the CLI, or several reports.");
      assert.deepEqual((await verifyAuditProof(proof)).filter((c) => !c.ok), [], "the cap is in the proof's input, so the replay trims the same");
    } finally {
      await fake.close();
    }
  });

  test("a node without the older state: the opening is unknown and said so; the rest of the report stands", async () => {
    const fake = await active();
    try {
      fake.onRequest = (method, params) => {
        if (method === "eth_getBalance" && params[1] === `0x${BEFORE_HOUR.toString(16)}`) fake.state.failures.eth_getBalance = { code: -32000, message: "missing trie node 0xabc (path ) state 0xdef is not available" };
        else delete fake.state.failures.eth_getBalance;
      };
      const { report, proof } = await audit(fake, LAST_HOUR);
      assert.deepEqual([report.opening, report.sent, report.native.change], [null, null, null]);
      assert.match(report.openingError!, /^the node did not serve the state at block 4,996,400: .*missing trie node/);
      assert.ok(report.summary.includes("It holds 1.19 PROS at the end."));
      assert.ok(report.summary.includes("At the end it holds 2,145.5 USDC, 1 WPROS and 3 WETH."));
      assert.match(report.summary.at(-1)!, /^Its balances and nonce before the period are unknown: the node did not serve the state at block 4,996,400: /);
      assert.equal(report.summary[1], "It received 2,345.5 USDC in 3 transfers (2 from 0x1F35…c85C) and sent 1,200 USDC in 1 transfer to 0x9365…b470.");
      assert.equal(report.headline, "0x912c…f647 in the last hour: 4 token transfers, 1 approval and 1 transfer of nothing.");
      assert.deepEqual((await verifyAuditProof(proof)).filter((c) => !c.ok), [], "the refusal replays too");
    } finally {
      await fake.close();
    }
  });

  test("a contract: a transfer to itself, a withdrawal, a revoked approval, a balance the logs do not explain, the timeline capped", async () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ token: USDC!, from: TRADER, to: ROUTER, amount: 1_000_000n, block: HEAD - 3000n + BigInt(i) }));
    const fake = await startFakeChain(
      defaultState({
        code: { [lower(ROUTER)]: "0x6080604052" },
        ...world(ROUTER, 0n, 1n, 60_000_000n, 0n),
        transfers: [...many, { token: USDC!, from: ROUTER, to: ROUTER, amount: 5_000_000n, block: HEAD - 10n }],
        logs: [
          { address: WPROS!, topics: [WITHDRAWAL_TOPIC, word("address", lower(ROUTER))], data: word("uint256", 2n * 10n ** 18n), block: HEAD - 20n },
          { address: USDC!, topics: [APPROVAL_TOPIC, word("address", lower(ROUTER)), word("address", lower(BUSY))], data: word("uint256", 0n), block: HEAD - 5n },
        ],
        // 55 USDC came in, but the balance grew by 60: 5 without a log.
        past: { [BEFORE_HOUR.toString()]: { ...world(ROUTER, 0n, 1n, 0n, 2n * 10n ** 18n) } },
      }),
    );
    try {
      const { report } = await audit(fake, LAST_HOUR, { address: ROUTER });
      assert.deepEqual([report.account.code, report.sent, report.events.length, report.truncated], ["contract", 0, 50, 8]);
      assert.deepEqual(report.summary.slice(1, 6), [
        "It is a contract: it sends no transactions of its own.",
        "It received 55 USDC in 55 transfers (all from 0x1F35…c85C) and moved USDC to itself once.",
        "Its WPROS shrank by 2 in 1 withdrawal (wrapping).",
        "It revoked 0x9365…b470's USDC approval.",
        "Its PROS stayed at 0.",
      ]);
      assert.ok(report.summary.includes("Its USDC went from 0 to 60: the logs account for +55, and +5 changed without one."));
      assert.ok(report.summary.includes("Its WPROS went from 2 to 0, all of it in the logs above."));
      assert.deepEqual(report.events.slice(0, 3).map((e) => e.text), ["Revoked 0x9365…b470's USDC approval", "Sent 5 USDC to itself", "Unwrapped 2 WPROS (a withdrawal)"]);
    } finally {
      await fake.close();
    }
  });

  test("the period's input is checked like any untrusted input", () => {
    const fails = (input: Parameters<typeof parsePeriod>[0], pattern: RegExp) => assert.throws(() => parsePeriod(input), (e: unknown) => e instanceof AgentError && e.kind === "usage" && pattern.test(e.message), JSON.stringify(input));
    assert.deepEqual(parsePeriod({}), { kind: "hours", hours: 1 });
    assert.deepEqual(parsePeriod({ hours: "24" }), { kind: "hours", hours: 24 });
    for (const hours of ["0", "169", "1.5", "-1", "x"]) fails({ hours }, /hours must be a whole number from 1 to 168/);
    fails({ hours: "2", since: "2026-10-17T09:00Z" }, /Give the period one way/);
    assert.deepEqual(parsePeriod({ since: "2026-10-17T09:00" }), { kind: "time", since: "2026-10-17T09:00:00.000Z", until: null }, "UTC when no zone is given");
    assert.deepEqual(parsePeriod({ since: "2026-10-17T09:00+07:00", until: "2026-10-18" }).kind, "time");
    assert.equal((parsePeriod({ since: "2026-10-17T09:00+07:00" }) as { since: string }).since, "2026-10-17T02:00:00.000Z");
    assert.equal((parsePeriod({ since: "2026-10-17" }) as { since: string }).since, "2026-10-17T00:00:00.000Z");
    fails({ since: "yesterday" }, /since must be a date and time, like 2026-10-17T09:00Z/);
    fails({ since: "2026-02-30T00:00Z" }, /since is not a real date and time/);
    fails({ since: "2026-10-17T24:00Z" }, /since is not a real date and time/);
    fails({ since: "2026-10-17T10:00Z", until: "2026-10-17T09:00Z" }, /until must be after since/);
    fails({ until: "2026-10-17T09:00Z" }, /needs its start/);
    fails({ fromBlock: "10" }, /needs both its first and its last block/);
    fails({ fromBlock: "20", toBlock: "10" }, /first block must not be after the last/);
    fails({ fromBlock: "1e3", toBlock: "2000" }, /Blocks must be whole numbers/);
  });

  test("a changed answer fails the replay; long runs are paced under the endpoint's rate", async () => {
    const fake = await active();
    try {
      const { proof } = await audit(fake, LAST_HOUR);
      // The 1,000 USDC transfer from the trader, made 2,000 in the recorded get_logs answer.
      const logIds = new Set(proof.transcript.filter((m) => m.direction === "client->server" && JSON.stringify(m.message).includes('"name":"get_logs"')).map((m) => (m.message as { id: number }).id));
      const answer = proof.transcript.find((m) => m.direction === "server->client" && "id" in m.message && logIds.has(m.message.id as number) && JSON.stringify(m.message).includes("3b9aca00"))!;
      const content = (answer.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
      content.text = content.text.replace("3b9aca00", "77359400");
      assert.deepEqual((await verifyAuditProof(proof)).filter((c) => !c.ok).map((c) => c.name), ["report recomputed from the recorded responses"]);

      const official = await connectOfficial(fake, net, { pace: { calls: 3, windowMs: 400 } });
      try {
        const started = performance.now();
        for (let i = 0; i < 6; i += 1) await official.chain.blockNumber();
        assert.ok(performance.now() - started >= 400, "six calls at three per 400 ms wait for the window");
      } finally {
        await official.close();
      }
    } finally {
      await fake.close();
    }
  });
});
