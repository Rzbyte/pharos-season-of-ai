// Task 28, Weekly Digest Agent: UTC periods (hours, days, weeks from Monday) placed in blocks; a token's
// every transfer (one query a page) or a wallet's transfers and approvals over every official token (two);
// each period's figures and sentences, compared with the one before, its busiest part named; a store so a
// schedule digests each period once, and the runs verify as one history; the block cap; the input checks.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeAbiParameters, getAddress, maxUint256, type Hex } from "viem";
import { APPROVAL_TOPIC } from "../src/audit/report.js";
import { partLabel, periodLabel, periodStart } from "../src/digest/calendar.js";
import { parseEvery, parseSubject } from "../src/digest/config.js";
import { runDigest, type DigestRun, type Subject } from "../src/digest/run.js";
import { digestKey, emptyDigestStore, parseDigestStore, type DigestStore } from "../src/digest/store.js";
import { digestHistoryCheck, verifyDigestProof } from "../src/digest/verify.js";
import { AgentError } from "../src/core/errors.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { TRANSFER_TOPIC } from "../src/policy/check.js";
import { defaultState, startFakeChain, type FakeChain, type FakeTransfer } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const net = NETWORKS["pharos-mainnet"];
const USDC = net.tokens.find((t) => t.symbol === "USDC")!;
const U = USDC.address.toLowerCase();
const ME = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const TRADER = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const BUSY = "0x936564245B69f5a293b42cbd752E0eE3bb68b470";
const POISONER = "0x2222222222222222222222222222222222222222";
const ROUTER = "0xC0FFEE0000000000000000000000000000000001";
const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (a: string) => a.toLowerCase();
const word = (type: string, value: unknown): Hex => encodeAbiParameters([{ type }], [value]);
const t = (from: string, to: string, usdc: number, block: number): FakeTransfer => ({ token: U, from: lower(from), to: lower(to), amount: BigInt(Math.round(usdc * 1e6)), block: BigInt(block) });
const NOW = new Date("2026-10-17T12:00:00.000Z");
// The fake chain's newest block, 5,000,000, is Monday 21 Sep 2026, 14:13:20 UTC; blocks are a second apart:
// 11:00 is block 4,988,400, 12:00 is 4,992,000, 13:00 is 4,995,600 and 14:00 is 4,999,200.
const HOURS: FakeTransfer[] = [
  t(TRADER, ME, 100, 4_988_500), t(BUSY, TRADER, 50, 4_989_000), // 11:00
  t(TRADER, BUSY, 10, 4_992_100), t(TRADER, BUSY, 20, 4_993_000), t(ME, TRADER, 5, 4_994_000), t(ZERO, TRADER, 1000, 4_994_500), // 12:00
  t(BUSY, ME, 7, 4_996_000), t(POISONER, ME, 0, 4_996_100), t(TRADER, ZERO, 3, 4_997_000), // 13:00
  t(ME, BUSY, 1, 4_999_500), // 14:00, so far
];

const chain = () =>
  startFakeChain(
    defaultState({
      native: { [lower(ME)]: 10n ** 18n },
      tokens: { [U]: { decimals: 6, balances: { [lower(ME)]: 1_300_000_000n, [lower(TRADER)]: 5_000_000_000n } } },
      transfers: structuredClone(HOURS),
      logs: [{ address: U, topics: [APPROVAL_TOPIC, word("address", lower(ME)), word("address", lower(ROUTER))], data: word("uint256", maxUint256), block: 4_993_500n }],
    }),
  );

async function digest(fake: FakeChain, subject: Subject, every: "hour" | "day" | "week", options: { store?: DigestStore; periods?: number; soFar?: boolean; maxBlocks?: number } = {}): Promise<{ run: DigestRun; proof: ProofFile; calls: { name: string; arguments: Record<string, unknown> }[] }> {
  const official = await connectOfficial(fake, net, { budget: 2000 });
  try {
    const name = subject.kind === "token" ? subject.token.symbol.toLowerCase() : lower(subject.address);
    const store = options.store ?? emptyDigestStore(digestKey(net.id, name, every));
    const run = await runDigest(subject, every, store, { chain: official.chain, periods: options.periods, soFar: options.soFar, maxBlocks: options.maxBlocks, now: () => NOW });
    const proof = JSON.parse(JSON.stringify(proofFile({ task: "28", capability: "digest", about: "test", mcp: official.mcp, network: net, startedAt: new Date(), input: { subject: name, every, periods: options.periods, soFar: options.soFar, maxBlocks: options.maxBlocks, store }, result: run }))) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    const calls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);
    return { run, proof, calls };
  } finally {
    await official.close();
  }
}

const TOKEN: Subject = { kind: "token", token: USDC };
const WALLET: Subject = { kind: "wallet", address: getAddress(lower(ME)) };

describe("the calendar", () => {
  test("UTC hours, days, and weeks from Monday; their labels", () => {
    const at = (iso: string) => BigInt(Date.parse(iso) / 1000);
    const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString();
    assert.equal(iso(periodStart(at("2026-09-21T14:13:20Z"), "hour")), "2026-09-21T14:00:00.000Z");
    assert.equal(iso(periodStart(at("2026-09-21T14:13:20Z"), "day")), "2026-09-21T00:00:00.000Z");
    // 21 September 2026 is a Monday, and 27 September a Sunday.
    assert.equal(iso(periodStart(at("2026-09-21T14:13:20Z"), "week")), "2026-09-21T00:00:00.000Z");
    assert.equal(iso(periodStart(at("2026-09-27T23:59:59Z"), "week")), "2026-09-21T00:00:00.000Z");
    assert.equal(iso(periodStart(at("2026-09-28T00:00:00Z"), "week")), "2026-09-28T00:00:00.000Z");
    assert.deepEqual([periodLabel(at("2026-09-21T00:00Z"), "week"), periodLabel(at("2026-09-20T00:00Z"), "day"), periodLabel(at("2026-09-21T13:00Z"), "hour")], ["the week of Monday 21 Sep 2026", "Sunday 20 Sep 2026", "21 Sep 2026, 13:00 to 14:00 UTC"]);
    assert.deepEqual([partLabel(at("2026-09-22T00:00Z"), "day"), partLabel(at("2026-09-22T13:00Z"), "hour")], ["Tuesday", "13:00 UTC"]);
  });
});

describe("a periodic digest", () => {
  test("a token, hour by hour: transfers, volume, the largest, who sent and received most, mints and burns, each against the hour before", async () => {
    const fake = await chain();
    try {
      const { run, proof, calls } = await digest(fake, TOKEN, "hour", { periods: 3, soFar: true });
      assert.deepEqual(run.digests.map((d) => [d.label, d.blocks, d.sentences]), [
        ["21 Sep 2026, 11:00 to 12:00 UTC", { from: "4988400", to: "4991999" }, [
          "USDC, 21 Sep 2026, 11:00 to 12:00 UTC: 2 transfers moved 150 USDC between 2 senders and 2 recipients.",
          "The largest was 100 USDC, from 0x1F35…c85C to 0x912c…f647.",
          "0x1F35…c85C sent the most: 100 USDC in 1 transfer.",
          "0x912c…f647 received the most: 100 USDC in 1 transfer.",
        ]],
        ["21 Sep 2026, 12:00 to 13:00 UTC", { from: "4992000", to: "4995599" }, [
          "USDC, 21 Sep 2026, 12:00 to 13:00 UTC: 3 transfers moved 35 USDC between 2 senders and 2 recipients.",
          "Against the hour before: 50% more transfers and 77% less volume.",
          "The largest was 20 USDC, from 0x1F35…c85C to 0x9365…b470.",
          "0x1F35…c85C sent the most: 30 USDC in 2 transfers.",
          "0x9365…b470 received the most: 30 USDC in 2 transfers.",
          "1,000 USDC were minted.",
        ]],
        ["21 Sep 2026, 13:00 to 14:00 UTC", { from: "4995600", to: "4999199" }, [
          "USDC, 21 Sep 2026, 13:00 to 14:00 UTC: 1 transfer moved 7 USDC between 1 sender and 1 recipient.",
          "Against the hour before: 67% fewer transfers and 80% less volume.",
          "The largest was 7 USDC, from 0x9365…b470 to 0x912c…f647.",
          "3 USDC were burned.",
          "1 transfer of nothing: the trace address poisoning leaves.",
        ]],
      ]);
      // The hour still open is summed up, and not compared: part of an hour against a whole one says nothing.
      assert.deepEqual([run.current?.label, run.current?.complete, run.current?.change, run.current?.sentences[0]], ["21 Sep 2026, 14:00 to 15:00 UTC", false, null, "USDC, 21 Sep 2026, 14:00 to 15:00 UTC, so far: 1 transfer moved 1 USDC between 1 sender and 1 recipient."]);
      assert.equal(run.headline, "USDC, 21 Sep 2026, 13:00 to 14:00 UTC: 1 transfer moved 7 USDC between 1 sender and 1 recipient.");
      assert.deepEqual([run.now.supplyShown, run.scanned, run.cut, run.behind], ["6,300", { from: "4988400", to: "5000000", pages: 13 }, 0, 0]);
      // A token's every transfer: one query a page, the token's address and the Transfer topic.
      const logs = calls.filter((c) => c.name === "get_logs");
      assert.deepEqual([logs.length, logs[0]!.arguments.address, logs[0]!.arguments.topics], [13, getAddress(U), [TRANSFER_TOPIC]]);
      assert.deepEqual((await verifyDigestProof(proof)).filter((c) => !c.ok), []);
    } finally {
      await fake.close();
    }
  });

  test("a wallet, hour by hour: its transfers and approvals over every official token, its holdings now", async () => {
    const fake = await chain();
    try {
      const { run, proof, calls } = await digest(fake, WALLET, "hour", { periods: 3 });
      assert.deepEqual(run.digests.map((d) => d.sentences), [
        ["0x912c…f647, 21 Sep 2026, 11:00 to 12:00 UTC: 1 token transfer.", "It received 100 USDC in 1 transfer."],
        ["0x912c…f647, 21 Sep 2026, 12:00 to 13:00 UTC: 1 token transfer and 1 approval.", "Against the hour before: as many transfers.", "It sent 5 USDC in 1 transfer.", "It approved 0xC0FF…0001 to spend unlimited USDC."],
        ["0x912c…f647, 21 Sep 2026, 13:00 to 14:00 UTC: 1 token transfer.", "Against the hour before: as many transfers.", "It received 7 USDC in 1 transfer.", "1 transfer of nothing: the trace address poisoning leaves; never copy an address from them."],
      ]);
      assert.equal(run.current, null, "the hour so far only when asked");
      assert.deepEqual(run.now.holdings.map((h) => `${h.shown} ${h.symbol}`), ["1 PROS", "1,300 USDC"]);
      const me = word("address", lower(ME));
      const logs = calls.filter((c) => c.name === "get_logs");
      assert.deepEqual(logs.slice(0, 2).map((c) => [c.arguments.address, c.arguments.topics]), [[net.tokens.map((t) => getAddress(t.address)), [[TRANSFER_TOPIC, APPROVAL_TOPIC], me]], [net.tokens.map((t) => getAddress(t.address)), [TRANSFER_TOPIC, null, me]]]);
      assert.deepEqual((await verifyDigestProof(proof)).filter((c) => !c.ok), []);
    } finally {
      await fake.close();
    }
  });

  test("a week, day by day on a chain of one block a minute: the busiest day; a day, hour by hour: the busiest hour", async () => {
    // Monday 14 Sep 2026 00:00 UTC is block 0; the newest block is Monday 21 Sep, 14:13.
    const MONDAY = 1_789_344_000n;
    const fake = await startFakeChain(defaultState({ head: 10_933n, timeOf: (n) => MONDAY + n * 60n, tokens: { [U]: { decimals: 6, balances: {} } } }));
    try {
      const day = (d: number, hour: number) => d * 1440 + hour * 60 + 5;
      fake.state.transfers = [t(TRADER, BUSY, 1, day(0, 9)), t(TRADER, BUSY, 1, day(1, 9)), t(TRADER, BUSY, 1, day(1, 10)), t(TRADER, BUSY, 1, day(1, 10) + 1), t(BUSY, TRADER, 2, day(4, 18))];
      const week = await digest(fake, TOKEN, "week");
      assert.equal(week.run.digests[0]!.label, "the week of Monday 14 Sep 2026");
      assert.deepEqual(week.run.digests[0]!.parts.map((p) => `${p.label} ${p.transfers}`), ["Monday 1", "Tuesday 3", "Wednesday 0", "Thursday 0", "Friday 1", "Saturday 0", "Sunday 0"]);
      assert.ok(week.run.digests[0]!.sentences.includes("The busiest day was Tuesday, with 3 transfers."));
      const tuesday = await digest(fake, TOKEN, "day", { periods: 7 });
      const busiest = tuesday.run.digests.find((d) => d.label === "Tuesday 15 Sep 2026")!;
      assert.ok(busiest.sentences.includes("The busiest hour was 10:00 UTC, with 2 transfers."));
      assert.deepEqual((await verifyDigestProof(week.proof)).filter((c) => !c.ok), []);
    } finally {
      await fake.close();
    }
  });

  test("on a schedule: each run digests the hours ended since the last, once; the runs verify as one history", async () => {
    const fake = await chain();
    try {
      const first = await digest(fake, TOKEN, "hour", { store: emptyDigestStore(digestKey(net.id, "usdc", "hour")) });
      assert.deepEqual([first.run.digests.map((d) => d.label), first.run.store.digested], [["21 Sep 2026, 13:00 to 14:00 UTC"], "2026-09-21T14:00:00.000Z"]);
      // Nothing has ended since: the run says when the next hour ends, and leaves the store as it was.
      const idle = await digest(fake, TOKEN, "hour", { store: first.run.store });
      assert.deepEqual([idle.run.digests, idle.run.headline, idle.run.store], [[], "USDC: no hour has ended since the last digest; the next ends at 2026-09-21T15:00:00.000Z.", first.run.store]);
      // Two hours on, the next run digests both, each once, the first compared with the store's last.
      fake.state.head += 7200n;
      fake.state.headTime += 7200n;
      fake.state.transfers.push(t(TRADER, BUSY, 4, 5_001_000), t(TRADER, BUSY, 4, 5_002_000));
      const later = await digest(fake, TOKEN, "hour", { store: idle.run.store });
      assert.deepEqual(later.run.digests.map((d) => [d.label, d.sentences.slice(0, 2)]), [
        ["21 Sep 2026, 14:00 to 15:00 UTC", ["USDC, 21 Sep 2026, 14:00 to 15:00 UTC: 3 transfers moved 9 USDC between 2 senders and 1 recipient.", "Against the hour before: 200% more transfers and 29% more volume."]],
        ["21 Sep 2026, 15:00 to 16:00 UTC", ["USDC, 21 Sep 2026, 15:00 to 16:00 UTC: no USDC moved between holders.", "Against the hour before: 100% fewer transfers and 100% less volume."]],
      ]);
      assert.deepEqual([later.run.store.digested, later.run.store.digests.length], ["2026-09-21T16:00:00.000Z", 3]);
      const proofs = [first.proof, idle.proof, later.proof];
      for (const proof of proofs) assert.deepEqual((await verifyDigestProof(proof)).filter((c) => !c.ok), []);
      assert.deepEqual(digestHistoryCheck(proofs), { name: "one history", ok: true, detail: "3 runs, each from the store the last one left; 3 periods digested, each once" });
      assert.equal(digestHistoryCheck([later.proof, first.proof]).ok, false, "runs out of order break the history");
    } finally {
      await fake.close();
    }
  });

  test("the blocks one run reads: without a store the oldest periods asked are cut; with one, the newest wait for the next run", async () => {
    const fake = await chain();
    try {
      const cut = (await digest(fake, TOKEN, "hour", { periods: 3, soFar: true, maxBlocks: 5000 })).run;
      assert.deepEqual([cut.digests.map((d) => d.label), cut.cut, cut.current?.complete], [["21 Sep 2026, 13:00 to 14:00 UTC"], 2, false]);
      const store: DigestStore = { ...emptyDigestStore(digestKey(net.id, "usdc", "hour")), digested: "2026-09-21T11:00:00.000Z" };
      const behind = (await digest(fake, TOKEN, "hour", { store, maxBlocks: 9000 })).run;
      assert.deepEqual([behind.digests.map((d) => d.label), behind.behind, behind.store.digested], [["21 Sep 2026, 11:00 to 12:00 UTC", "21 Sep 2026, 12:00 to 13:00 UTC"], 1, "2026-09-21T13:00:00.000Z"]);
      await assert.rejects(digest(fake, TOKEN, "day", { maxBlocks: 9000 }), (e: unknown) => e instanceof AgentError && /One day is 86,400 blocks, more than the 9,000 one run reads; digest by a shorter period\./.test(e.message));
    } finally {
      await fake.close();
    }
  });

  test("the input is checked: the subject, the cadence, the store; a changed answer fails the replay", async () => {
    assert.deepEqual(parseSubject("usdc", net), TOKEN);
    assert.deepEqual(parseSubject(USDC.address.toUpperCase().replace("0X", "0x"), net), TOKEN, "a token's own address is the token");
    assert.deepEqual(parseSubject(lower(ME), net), WALLET);
    assert.throws(() => parseSubject("pepe", net), /A digest is of an official token \(WPROS, USDC, LINK, WETH\) or of a 0x address/);
    assert.equal(parseEvery("Week"), "week");
    assert.throws(() => parseEvery("month"), /A digest comes every hour, day or week/);
    const key = digestKey(net.id, "usdc", "hour");
    assert.throws(() => parseDigestStore({ ...emptyDigestStore(digestKey(net.id, "usdc", "day")) }, key), /The store belongs to another digest \(pharos-mainnet:usdc:day\), not pharos-mainnet:usdc:hour/);
    assert.throws(() => parseDigestStore({ ...emptyDigestStore(key), digested: "yesterday" }, key), /last digested time is not a time/);
    const fake = await chain();
    try {
      await assert.rejects(digest(fake, TOKEN, "hour", { periods: 11 }), /periods must be a whole number from 1 to 10/);
      // An official token with no contract at the newest block is a broken chain, not a zero supply.
      const WPROS = net.tokens.find((t) => t.symbol === "WPROS")!;
      await assert.rejects(digest(fake, { kind: "token", token: WPROS }, "hour"), (e: unknown) => e instanceof AgentError && /The WPROS contract answered nothing at block 5,000,000: it has no code there\./.test(e.message));
      const { proof } = await digest(fake, TOKEN, "hour", { periods: 1 });
      const logIds = new Set(proof.transcript.filter((m) => m.direction === "client->server" && JSON.stringify(m.message).includes('"name":"get_logs"')).map((m) => (m.message as { id: number }).id));
      const answer = proof.transcript.find((m) => m.direction === "server->client" && "id" in m.message && logIds.has(m.message.id as number) && JSON.stringify(m.message).includes("6acfc0"))!;
      const content = (answer.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
      content.text = content.text.replace("6acfc0", "6acfc1");
      assert.deepEqual((await verifyDigestProof(proof)).filter((c) => !c.ok).map((c) => c.name), ["digests recomputed from the recorded responses"]);
    } finally {
      await fake.close();
    }
  });
});
