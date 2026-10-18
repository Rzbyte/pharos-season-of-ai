// Task 18, Recurring Payment Agent: a schedule of repeating payments read (every line, or a refusal that
// says which part was not read), the calendar of their due days, and runs through the official Chain MCP
// server on a fake chain: what is owed since the start and not paid, taken within limits, prepared as
// Task 17's flow; on Atlantic, with a key and a store, sent and recorded as paid, never twice, across runs.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getAddress } from "viem";
import { EXAMPLE } from "../src/builder/action.js";
import { Chain } from "../src/core/chain.js";
import { ChainMcp } from "../src/core/chain-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { runRecurring, type RecurringOptions, type RecurringRun } from "../src/recurring/run.js";
import { dayOf, nextDue, occurrences, readSchedule } from "../src/recurring/schedule.js";
import { emptyRecurringStore, parseRecurringStore, type RecurringStore } from "../src/recurring/store.js";
import { recurringHistoryCheck, verifyRecurringProof } from "../src/recurring/verify.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const net = NETWORKS["pharos-mainnet"];
const atlantic = NETWORKS["atlantic-testnet"];
const USDC = getAddress(net.tokens[1]!.address);
const lower = (address: string) => address.toLowerCase();
const LANDLORD = EXAMPLE.counterparty;
const STAFF = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const NOW = new Date("2026-09-21T15:00:00.000Z");
// The fake chain's head is block 5,000,000 at 1,790,000,000 s: Monday 2026-09-21, UTC.
const SCHEDULE = `Rent: 25 USDC to ${LANDLORD}, monthly on the 1st
Payroll: 10 USDC to ${STAFF}, monthly on the 15th
Design tool: 2 USDC to ${LANDLORD}, weekly on Monday`;

describe("reading a schedule", () => {
  const read = (text: string) => readSchedule(text, net);
  const refuses = (text: string, pattern: RegExp) => assert.throws(() => read(text), (e: unknown) => e instanceof AgentError && e.kind === "usage" && pattern.test(e.message), `${text.slice(0, 50)} should refuse with ${pattern}`);

  test("each rule, amounts with commas, a start and an end; comments and blank lines passed over", () => {
    const items = read(`# the household
Rent: 1,500 USDC to ${LANDLORD}, monthly on the 1st

Payroll, Ana: 1,000.5 USDC to ${lower(STAFF)}, monthly on the last day, from Oct 1, 2026
Tool: 2 USDC to ${LANDLORD}, every Monday, until 2027-06-30
Gym: 0.01 PROS to ${STAFF}, every 2 weeks on fri, from 2026-10-02
Domain: 12 USDC to ${LANDLORD}, yearly on March 1
Insurance: 30 USDC to ${LANDLORD}, every 3 months on day 31, from 2026-01-31
Allowance: 1 USDC to ${STAFF}, daily
Water: 4 USDC to ${STAFF}, every 10 days, from 2026-09-03`);
    assert.deepEqual(items.map((i) => [i.id, i.amount, i.asset, i.every, i.from, i.until]), [
      ["rent", "1500", "USDC", "monthly on the 1st", null, null],
      ["payroll-ana", "1000.5", "USDC", "monthly on the last day", "2026-10-01", null],
      ["tool", "2", "USDC", "weekly on Monday", null, "2027-06-30"],
      ["gym", "0.01", "PROS", "every 2 weeks on Friday", "2026-10-02", null],
      ["domain", "12", "USDC", "yearly on March 1", null, null],
      ["insurance", "30", "USDC", "every 3 months on the 31st", "2026-01-31", null],
      ["allowance", "1", "USDC", "daily", null, null],
      ["water", "4", "USDC", "every 10 days", "2026-09-03", null],
    ]);
    assert.deepEqual([items[1]!.to, items[1]!.raw, items[3]!.token], [STAFF, 1_000_500_000n, null]);
  });

  test("refused, saying why: the line's shape, the amount, the asset, the address, the rule, the dates, the names", () => {
    refuses("Rent 25 USDC to 0x1111111111111111111111111111111111111111, monthly on the 1st", /starts with a name and a colon/);
    refuses(`Rent: 25 USDC ${LANDLORD}, monthly on the 1st`, /is not read as "<amount> <asset> to 0x…"/);
    refuses(`Rent: 25 PEPE to ${LANDLORD}, monthly on the 1st`, /"PEPE" is not PROS or an official Pharos Mainnet token/);
    refuses(`Rent: 0 USDC to ${LANDLORD}, monthly on the 1st`, /more than zero/);
    refuses(`Rent: 1.0000001 USDC to ${LANDLORD}, monthly on the 1st`, /more than 6 decimal places/);
    refuses(`Rent: 25 USDC to ${LANDLORD.slice(0, -1)}4, monthly on the 1st`, /fails its checksum/);
    refuses(`Rent: 25 USDC to ${USDC}, monthly on the 1st`, /a token contract cannot be paid/);
    refuses(`Rent: 25 USDC to ${LANDLORD}, sometimes`, /"sometimes" is not a rule the agent reads/);
    refuses(`Rent: 25 USDC to ${LANDLORD}`, /say how often/);
    refuses(`Rent: 25 USDC to ${LANDLORD}, monthly on the 1st, weekly on Monday`, /one rule a line/);
    refuses(`Rent: 25 USDC to ${LANDLORD}, every 2 weeks on Monday`, /counts from a start: add "from" a date/);
    refuses(`Rent: 25 USDC to ${LANDLORD}, monthly on the 32nd`, /not a rule the agent reads/);
    refuses(`Rent: 25 USDC to ${LANDLORD}, yearly on February 30`, /February has no 30th/);
    refuses(`Rent: 25 USDC to ${LANDLORD}, every 13 months on the 1st, from 2026-01-01`, /out of range/);
    refuses(`Rent: 25 USDC to ${LANDLORD}, monthly on the 1st, from 2026-10-01, until 2026-09-01`, /ends \(2026-09-01\) before it starts \(2026-10-01\)/);
    refuses(`Rent: 25 USDC to ${LANDLORD}, monthly on the 1st, from soon`, /"soon" is not a date the agent reads/);
    refuses(`Rent: 25 USDC to ${LANDLORD}, monthly on the 1st\nrent: 5 USDC to ${STAFF}, weekly on Monday`, /Two payments are named "rent"/);
    refuses(Array.from({ length: 21 }, (_, k) => `P${k}: 1 USDC to ${LANDLORD}, daily`).join("\n"), /at most 20 payments/);
    refuses("", /Write a schedule/);
  });

  test("the calendar: a day past a month's end falls on its last day; every N counts from the start; the next due day", () => {
    const [rent, payroll, tool, gym, domain, insurance, , water] = read(`Rent: 1 USDC to ${LANDLORD}, monthly on the 31st
Payroll: 1 USDC to ${LANDLORD}, monthly on the last day
Tool: 1 USDC to ${LANDLORD}, weekly on Monday, until 2026-09-28
Gym: 1 USDC to ${LANDLORD}, every 2 weeks on Friday, from 2026-10-01
Domain: 1 USDC to ${LANDLORD}, yearly on February 29
Insurance: 1 USDC to ${LANDLORD}, every 3 months on the 31st, from 2026-01-31
Allowance: 1 USDC to ${LANDLORD}, daily
Water: 1 USDC to ${LANDLORD}, every 10 days, from 2026-09-03`);
    assert.deepEqual(occurrences(rent!, "2027-01-01", "2027-05-31"), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
    assert.deepEqual(occurrences(payroll!, "2028-01-15", "2028-03-15"), ["2028-01-31", "2028-02-29"]);
    assert.deepEqual(occurrences(tool!, "2026-09-01", "2026-10-31"), ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
    assert.deepEqual(occurrences(gym!, "2026-09-01", "2026-11-10"), ["2026-10-02", "2026-10-16", "2026-10-30"]);
    assert.deepEqual(occurrences(domain!, "2027-01-01", "2028-12-31"), ["2027-02-28", "2028-02-29"]);
    assert.deepEqual(occurrences(insurance!, "2026-01-01", "2026-12-31"), ["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31"]);
    assert.deepEqual(occurrences(water!, "2026-09-01", "2026-10-05"), ["2026-09-03", "2026-09-13", "2026-09-23", "2026-10-03"]);
    assert.deepEqual([nextDue(rent!, "2026-09-21"), nextDue(tool!, "2026-09-21"), nextDue(tool!, "2026-09-28"), nextDue(domain!, "2026-09-21")], ["2026-09-30", "2026-09-28", null, "2027-02-28"]);
    assert.equal(dayOf("1970-01-02"), 1);
  });

  test("a store: its shape checked, and that it belongs to this network and payer", () => {
    const store = emptyRecurringStore("pharos-mainnet", EXAMPLE.account, "2026-09-01");
    assert.deepEqual(parseRecurringStore(JSON.parse(JSON.stringify(store)), "pharos-mainnet", EXAMPLE.account), store);
    assert.throws(() => parseRecurringStore({ ...store, schema: "x" }, "pharos-mainnet"), /not a recurring payment store/);
    assert.throws(() => parseRecurringStore(store, "atlantic-testnet"), /is for pharos-mainnet, not atlantic-testnet/);
    assert.throws(() => parseRecurringStore(store, "pharos-mainnet", STAFF), /belongs to the payer/);
    const twice = { ...store, paid: [{ id: "rent@2026-09-01", tx: `0x${"a".repeat(64)}`, block: "1", status: "success" }, { id: "rent@2026-09-01", tx: `0x${"b".repeat(64)}`, block: "2", status: "success" }] };
    assert.throws(() => parseRecurringStore(twice, "pharos-mainnet"), /records rent@2026-09-01 as paid twice/);
    assert.throws(() => parseRecurringStore({ ...store, paid: [{ id: "rent@2026-09-01", tx: `0x${"a".repeat(64)}`, block: "1", status: "pending" }] }, "pharos-mainnet"), /malformed/);
  });
});

describe("a run on Pharos Mainnet", () => {
  let fake: FakeChain;
  before(async () => {
    fake = await startFakeChain(defaultState({ native: { [lower(EXAMPLE.account)]: 10n ** 18n }, nonces: { [lower(EXAMPLE.account)]: 41n }, tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(EXAMPLE.account)]: 100_000_000n } } } }));
  });
  after(() => fake.close());

  async function run(schedule: string, options: Omit<RecurringOptions, "chain"> = {}): Promise<{ result: RecurringRun; proof: ProofFile }> {
    const official = await connectOfficial(fake, net, { budget: 80 });
    try {
      const result = await runRecurring(schedule, { chain: official.chain, now: () => NOW, ...options });
      const input = { schedule, store: options.store ?? null, keep: options.keep, from: options.from, since: options.since, sinceDefault: options.sinceDefault, maxPerItem: options.maxPerItem, maxPayments: options.maxPayments };
      const proof = JSON.parse(JSON.stringify(proofFile({ task: "18", capability: "recurring-payments", about: "test", mcp: official.mcp, network: net, startedAt: new Date(), input, result }))) as ProofFile;
      proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
      return { result, proof };
    } finally {
      await official.close();
    }
  }

  test("this month so far: everything owed since the 1st, oldest first, prepared as one flow; the proof verifies", async () => {
    const { result, proof } = await run(SCHEDULE, { sinceDefault: "month" });
    assert.deepEqual([result.today, result.since, result.sinceFrom, result.verdict, result.payer], ["2026-09-21", "2026-09-01", "month", "ready", { address: EXAMPLE.account, from: "example" }]);
    assert.deepEqual(result.owed.map((o) => [o.id, o.late]), [["rent@2026-09-01", 20], ["design-tool@2026-09-07", 14], ["design-tool@2026-09-14", 7], ["payroll@2026-09-15", 6], ["design-tool@2026-09-21", 0]]);
    assert.deepEqual([result.due, result.later, result.nonce], [result.owed.map((o) => o.id), 0, 41]);
    assert.deepEqual(result.payments.map((p) => [p.to.name, p.amount, p.memo, p.tx?.nonce]), [["Rent", "25", "Rent, due 2026-09-01", 41], ["Design tool", "2", "Design tool, due 2026-09-07", 42], ["Design tool", "2", "Design tool, due 2026-09-14", 43], ["Payroll", "10", "Payroll, due 2026-09-15", 44], ["Design tool", "2", "Design tool, due 2026-09-21", 45]]);
    assert.deepEqual(result.items.map((i) => [i.id, i.owed, i.next]), [["rent", 1, "2026-10-01"], ["payroll", 1, "2026-10-15"], ["design-tool", 3, "2026-09-28"]]);
    assert.deepEqual([result.totals.map((t) => [t.asset, t.shown, t.covered]), result.paid, result.store], [[["USDC", "41 USDC", true], ["PROS", "0 PROS", true]], [], null]);
    assert.match(result.headline, /^The 5 payments due by 2026-09-21, 41 USDC in all, ready to sign: each dry-runs at block 5,000,000, for about [\d.]+ PROS in gas together\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.equal(result.steps[1]!.text, "At block 5,000,000's day, 2026-09-21, counting from 2026-09-01 (the first of this month; nothing is kept between runs here): 5 owed, Rent of 2026-09-01, Design tool of 2026-09-07, Design tool of 2026-09-14, Payroll of 2026-09-15, Design tool of 2026-09-21.");
    assert.deepEqual((await verifyRecurringProof(proof)).filter((c) => !c.ok), []);
  });

  test("nothing due today; the limits a run takes, the rest left for the next; more than the payer holds", async () => {
    const quiet = (await run(`Rent: 25 USDC to ${LANDLORD}, monthly on the 1st`)).result;
    assert.deepEqual([quiet.verdict, quiet.since, quiet.sinceFrom, quiet.payments, quiet.nonce], ["nothing-due", "2026-09-21", "today", [], null]);
    assert.equal(quiet.headline, "Nothing is due at 2026-09-21: every payment since 2026-09-21 is paid or not yet due. Next: Rent on 2026-10-01.");
    const capped = (await run(SCHEDULE, { since: "2026-08-01", maxPerItem: 2, maxPayments: 4 })).result;
    assert.deepEqual([capped.sinceFrom, capped.owed.length, capped.due, capped.later], ["input", 12, ["rent@2026-08-01", "design-tool@2026-08-03", "design-tool@2026-08-10", "payroll@2026-08-15"], 8]);
    assert.match(capped.headline, / 8 more wait for the next run\.$/);
    fake.state.tokens[lower(USDC)]!.balances[lower(EXAMPLE.account)] = 30_000_000n;
    try {
      const short = (await run(SCHEDULE, { sinceDefault: "month" })).result;
      assert.deepEqual([short.verdict, short.payments.every((p) => p.dryRun.verdict === "would-succeed")], ["short", true]);
      assert.match(short.headline, /^The 5 payments due need 41 USDC, but 0x912c…f647 holds 30 USDC\. Nothing was sent/);
    } finally {
      fake.state.tokens[lower(USDC)]!.balances[lower(EXAMPLE.account)] = 100_000_000n;
    }
  });

  test("with a store on mainnet: prepared, not sent, so still owed next run; the runs form one history", async () => {
    const first = await run(SCHEDULE, { keep: true, since: "2026-09-14" });
    assert.deepEqual([first.result.verdict, first.result.due, first.result.store?.since, first.result.store?.lastRun, first.result.store?.paid], ["ready", ["design-tool@2026-09-14", "payroll@2026-09-15", "design-tool@2026-09-21"], "2026-09-14", { block: "5000000", day: "2026-09-21" }, []]);
    const second = await run(SCHEDULE, { keep: true, store: first.result.store });
    assert.deepEqual([second.result.sinceFrom, second.result.due], ["store", first.result.due]);
    assert.ok(second.result.steps.some((s) => s.source === "the store" && /Nothing recorded as paid: nothing was sent, so they stay owed for the next run\./.test(s.text)));
    for (const proof of [first.proof, second.proof]) assert.deepEqual((await verifyRecurringProof(proof)).filter((c) => !c.ok), []);
    assert.deepEqual(recurringHistoryCheck([first.proof, second.proof]), { name: "one history", ok: true, detail: "2 runs, each from the store the last one left; 0 payments recorded, each once" });
    assert.equal(recurringHistoryCheck([second.proof, first.proof]).ok, false, "out of order is not one history");
    await assert.rejects(run(SCHEDULE, { keep: true, store: first.result.store, since: "2026-09-01" }), /a store's start is not moved/);
    await assert.rejects(run(SCHEDULE, { keep: true, store: first.result.store, from: STAFF }), /belongs to the payer/);
  });

  test("a changed recorded answer fails the proof", async () => {
    const { proof } = await run(SCHEDULE, { sinceDefault: "month" });
    const forged = JSON.parse(JSON.stringify(proof)) as ProofFile;
    const nonceReply = forged.transcript.find((m) => m.direction === "server->client" && JSON.stringify(m.message).includes('\\"nonce\\"'));
    assert.ok(nonceReply, "the nonce answer is in the transcript");
    const content = (nonceReply.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
    content.text = content.text.replace("41", "7");
    assert.deepEqual((await verifyRecurringProof(forged)).filter((c) => !c.ok).map((c) => c.name), ["run recomputed from the recorded responses"]);
  });
});

describe("paying on Atlantic", () => {
  // The well-known Hardhat/Anvil test key #1: public, only ever used here on a fake chain.
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
  const TUSDC = getAddress(atlantic.tokens[0]!.address);
  const schedule = `Rent: 1 USDC to ${LANDLORD}, monthly on the 1st\nTool: 0.5 USDC to ${STAFF}, weekly on Monday`;

  test("with a key and a store: sent in order, recorded as paid, never paid twice; a pending one waits for its receipt; the proofs verify as one history", async () => {
    const chainFake = await startFakeChain(defaultState({ chainId: 688689, native: { [lower(signer.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: { decimals: 6, balances: { [lower(signer.address)]: 10_000_000n } } } }));
    const run = async (store: RecurringStore | null, since?: string) => {
      const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: chainFake.url }, broadcast: true }, { timeoutMs: 15_000, budget: 200 });
      try {
        const result = await runRecurring(schedule, { chain: new Chain(mcp, atlantic), store, keep: true, since, from: signer.address, signer, wait: { pollMs: 10 }, now: () => NOW });
        return { result, proof: JSON.parse(JSON.stringify(proofFile({ task: "18", capability: "recurring-payments", about: "test", mcp, network: atlantic, startedAt: new Date(), input: { schedule, store, keep: true, since, from: signer.address }, result }))) as ProofFile };
      } finally {
        await mcp.close();
      }
    };
    try {
      const unkept = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: chainFake.url }, broadcast: false }, { timeoutMs: 15_000 });
      try {
        await assert.rejects(runRecurring(schedule, { chain: new Chain(unkept, atlantic), from: signer.address, signer }), /Sending needs a store/);
      } finally {
        await unkept.close();
      }
      const first = await run(null, "2026-09-01");
      assert.deepEqual([first.result.verdict, first.result.due, first.result.paid.map((p) => [p.id, p.status])], ["sent", ["rent@2026-09-01", "tool@2026-09-07", "tool@2026-09-14", "tool@2026-09-21"], [["rent@2026-09-01", "success"], ["tool@2026-09-07", "success"], ["tool@2026-09-14", "success"], ["tool@2026-09-21", "success"]]]);
      assert.deepEqual([chainFake.state.tokens[lower(TUSDC)]!.balances[lower(LANDLORD)], chainFake.state.tokens[lower(TUSDC)]!.balances[lower(STAFF)]], [1_000_000n, 1_500_000n]);
      assert.equal(first.result.headline, "The 4 payments due, 2.5 USDC in all, sent and checked against their receipts, and recorded as paid.");
      // The same day again, from the store: nothing owed, nothing sent.
      const second = await run(first.result.store);
      assert.deepEqual([second.result.verdict, second.result.owed, second.result.store?.paid.length], ["nothing-due", [], 4]);
      // A payment recorded as pending: while its receipt is unknown it is not paid again; once it is, it is paid.
      const pendingStore: RecurringStore = { ...second.result.store!, paid: second.result.store!.paid.map((p, k) => (k === 3 ? { ...p, block: null, status: "pending" as const } : p)) };
      const kept = chainFake.receipts.get(lower(pendingStore.paid[3]!.tx));
      chainFake.receipts.delete(lower(pendingStore.paid[3]!.tx));
      const waiting = await run(pendingStore);
      assert.deepEqual([waiting.result.verdict, waiting.result.store?.paid[3]?.status], ["nothing-due", "pending"]);
      assert.match(waiting.result.steps.find((s) => s.source === "Chain MCP · get_transaction_receipt")!.text, /tool@2026-09-21 still not in a block: not paid again while it may land/);
      chainFake.receipts.set(lower(pendingStore.paid[3]!.tx), kept!);
      const landed = await run(waiting.result.store);
      assert.deepEqual([landed.result.store?.paid[3]?.status, landed.result.store?.paid[3]?.block], ["success", second.result.store!.paid[3]!.block]);
      const proofs = [first.proof, second.proof, waiting.proof, landed.proof];
      for (const proof of proofs) assert.deepEqual((await verifyRecurringProof(proof)).filter((c) => !c.ok), []);
      assert.equal((await verifyRecurringProof(first.proof)).find((c) => c.name === "signed transactions")!.detail, "4 on chain 688689, each signed by its sender, each exactly the prepared payment, in order");
      assert.deepEqual(recurringHistoryCheck([first.proof, second.proof]), { name: "one history", ok: true, detail: "2 runs, each from the store the last one left; 4 payments recorded, each once" });
    } finally {
      await chainFake.close();
    }
  });
});
