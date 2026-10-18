// Task 21, X402 Agent Buyer: an agent with a job (check a planned transfer before it is sent, and prepare
// it) and a budget, buying what it needs by x402 from Task 20's API (Task 25's risk check, Task 08's dry
// run), through the official x402 packages and the official Chain MCP server, on a fake chain. Prices
// asked for free, a plan within the budget, each authorization within what is left, the job finished from
// what was bought; a price changed after the 402 refused; and the proofs verifying, forged ones failing.
// x402 times an authorization by the clock, so each fake chain's head is now.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getAddress } from "viem";
import { API_VENDOR, buy, decide, runBuyer, type BuyerRun, type RunBuyerOptions } from "../src/buyer/run.js";
import { verifyBuyerProof } from "../src/buyer/verify.js";
import { Chain } from "../src/core/chain.js";
import { ChainMcp } from "../src/core/chain-mcp.js";
import { accountFromEnv, signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, recordedCalls, type ProofFile } from "../src/core/proof.js";
import { paidApi } from "../src/x402/api.js";
import { localFetch, serve } from "../src/x402/parties.js";
import { readAsset } from "../src/x402/pharos.js";
import { transferIntent } from "../src/x402/products.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const atlantic = NETWORKS["atlantic-testnet"];
const mainnet = NETWORKS["pharos-mainnet"];
const lower = (address: string) => address.toLowerCase();
// The well-known Hardhat/Anvil test keys #1 and #2: public, only ever used here on a fake chain.
const payer = accountFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
const facilitator = signerFromEnv({ PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" });
const TRADER = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const LOOKALIKE = getAddress(`0x1f35${"0".repeat(32)}c85c`);
const now = () => BigInt(Math.floor(Date.now() / 1000));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const failed = async (proof: ProofFile) => (await verifyBuyerProof(proof)).filter((c) => !c.ok).map((c) => c.name);
const job = (to: string, amount = "25") => ({ asset: "USDC", from: payer.address, to, amount });

/** The buyer's own USDC and PHRS, the facilitator's PHRS, and a history with the trader: its check looks fine. */
function chainFor(net: typeof atlantic): Promise<FakeChain> {
  const usdc = lower(net.tokens.find((t) => t.symbol === "USDC")!.address);
  const me = lower(payer.address);
  return startFakeChain(defaultState({ chainId: net.chainId, headTime: now(), native: { [lower(facilitator.address)]: 10n ** 18n, [me]: 10n ** 18n }, nonces: { [me]: 5n }, tokens: { [usdc]: { decimals: 6, name: "USD Coin", symbol: "USDC", eip3009: { version: "2" }, balances: { [me]: 30_000_000n } } }, transfers: [{ token: usdc, from: me, to: lower(TRADER), amount: 5_000_000n, block: 4_999_000n }, { token: usdc, from: lower(TRADER), to: me, amount: 4_000_000n, block: 4_999_500n }] }));
}

async function run(fake: FakeChain, net: typeof atlantic, options: Omit<RunBuyerOptions, "chain" | "job"> & { job: Record<string, string> }): Promise<{ result: BuyerRun; proof: ProofFile }> {
  const mcp = await ChainMcp.connect({ kind: "local", network: { ...net, rpcUrl: fake.url }, broadcast: net.id === "atlantic-testnet" }, { timeoutMs: 15_000, budget: 240 });
  try {
    const result = await runBuyer({ chain: new Chain(mcp, net), wait: { pollMs: 10 }, ...options, job: transferIntent(new URLSearchParams(options.job), net) });
    const proof = clone(proofFile({ task: "21", capability: "x402-buyer", about: "test", mcp, network: net, startedAt: new Date(), input: { job: options.job, budget: options.budget, ...(options.payTo ? { payTo: options.payTo } : {}) }, result }));
    return { result, proof };
  } finally {
    await mcp.close();
  }
}

describe("the API's products", () => {
  test("a planned transfer read from the query; refused, saying why, when it cannot be answered", () => {
    assert.deepEqual(transferIntent(new URLSearchParams({ asset: "USDC", from: payer.address, to: TRADER, amount: "25" }), atlantic), { kind: "erc20-transfer", token: getAddress(atlantic.tokens.find((t) => t.symbol === "USDC")!.address), from: payer.address, to: TRADER, amount: "25" });
    assert.equal(transferIntent(new URLSearchParams({ asset: "PHRS", from: payer.address, to: TRADER, amount: "0.5" }), atlantic).kind, "native-transfer");
    for (const [query, pattern] of [
      [{ asset: "DOGE", from: payer.address, to: TRADER, amount: "1" }, /asset must be PHRS or one of/],
      [{ from: "0x12", to: TRADER, amount: "1" }, /The sender \(from\) must be a 0x address/],
      [{ from: payer.address, to: TRADER, amount: "0" }, /more than zero/],
      [{ from: payer.address, to: TRADER, amount: "1.0000001" }, /more than 6 decimal places/],
    ] as const) assert.throws(() => transferIntent(new URLSearchParams(query), atlantic), pattern);
  });

  test("a request it cannot answer is a 400 before any 402; the free listing gives each product and price", async () => {
    const fake = await chainFor(atlantic);
    const official = await connectOfficial(fake, atlantic);
    try {
      const chain = official.chain;
      const read = await readAsset(chain, getAddress(atlantic.tokens.find((t) => t.symbol === "USDC")!.address), "latest");
      const api = await paidApi({ chain, asset: { ...read, decimals: 6 }, payTo: API_VENDOR, facilitator: null });
      const listing = (await (await api.handler(new Request(`${api.url}/`))).json()) as { products: { path: string; price: { shown: string } }[]; settles: boolean };
      assert.deepEqual([listing.products.map((p) => [p.path, p.price.shown]), listing.settles], [[["/data", "0.001 USDC"], ["/risk", "0.005 USDC"], ["/dryrun", "0.003 USDC"]], false]);
      const refused = await api.handler(new Request(`${api.url}/risk?asset=USDC&from=0x12&to=${TRADER}&amount=1`));
      assert.deepEqual([refused.status, ((await refused.json()) as { error: { message: string } }).error.message], [400, "The sender (from) must be a 0x address (40 hex characters)."]);
      const priced = await api.handler(new Request(`${api.url}/risk?asset=USDC&from=${payer.address}&to=${TRADER}&amount=1`));
      assert.equal(priced.status, 402);
      assert.deepEqual(api.facilitator.log.filter((l) => l.op !== "supported"), [], "asking a price calls no facilitator");
    } finally {
      await official.close();
      await fake.close();
    }
  });

  test("the outcome follows from what was bought", () => {
    const risk = (verdict: string) => ({ verdict, headline: "h", signals: [{ id: "x", severity: verdict === "looks-fine" ? "info" : "high", title: "t", detail: "the reason", tool: "eth_call" }] }) as never;
    const dry = (verdict: string) => ({ verdict, reason: verdict === "would-succeed" ? null : "it reverts", headline: "d", tx: { from: payer.address, to: TRADER, data: "0x", value: "0" }, gas: { expectedCost: "56350000000000", maxCost: "100000000000000" } }) as never;
    assert.deepEqual(decide(null, null, "over budget"), { verdict: "not-done", reason: "over budget", tx: null, gas: null });
    assert.deepEqual(decide(risk("do-not-send"), null, null), { verdict: "do-not-send", reason: "the reason", tx: null, gas: null });
    assert.deepEqual(decide(risk("check-first"), null, null), { verdict: "check-first", reason: "the reason", tx: null, gas: null });
    assert.deepEqual(decide(risk("looks-fine"), null, "the dry run was refused"), { verdict: "not-done", reason: "the dry run was refused", tx: null, gas: null });
    assert.deepEqual(decide(risk("looks-fine"), dry("would-revert"), null), { verdict: "would-fail", reason: "it reverts", tx: null, gas: null });
    assert.deepEqual(decide(risk("looks-fine"), dry("would-succeed"), null), { verdict: "ready", reason: null, tx: { from: payer.address, to: TRADER, data: "0x", value: "0" }, gas: { expectedCost: "56350000000000", maxCost: "100000000000000", shown: "0.00005635" } });
  });
});

describe("buying on Atlantic", () => {
  test("ready: the check and the dry run bought within the budget, each settled; the transfer ready to sign; the proof verifies, forged ones fail", async () => {
    const fake = await chainFor(atlantic);
    try {
      const usdc = lower(atlantic.tokens.find((t) => t.symbol === "USDC")!.address);
      const { result, proof } = await run(fake, atlantic, { payer, facilitator, budget: "0.01", job: job(TRADER) });
      assert.deepEqual([result.verdict, result.reason, result.payer.key, result.api.where, result.api.settles, result.api.facilitator], ["ready", null, "given", "in-process", true, facilitator.address]);
      assert.deepEqual(result.plan.map((p) => [p.product, p.status, p.price?.shown]), [["risk", "bought", "0.005 USDC"], ["dryrun", "bought", "0.003 USDC"]]);
      assert.deepEqual([result.ledger.committed.shown, result.ledger.settled.shown, result.ledger.remaining.shown], ["0.008 USDC", "0.008 USDC", "0.002 USDC"]);
      assert.equal(fake.state.tokens[usdc]!.balances[lower(API_VENDOR)], 8_000n, "the API was paid 0.008 USDC, settled on chain");
      assert.deepEqual([(result.purchases[0]!.data as { verdict: string }).verdict, (result.purchases[1]!.data as { verdict: string }).verdict], ["looks-fine", "would-succeed"]);
      assert.equal(result.tx?.to, getAddress(usdc), "the transaction to sign is the dry run's: a USDC transfer");
      assert.match(result.headline, /^Ready to sign: Send 25 USDC from 0x7099…79C8 to 0x1F35…c85C\. The check found nothing suspicious, and the dry run says it would succeed, for about [\d.]+ PHRS of gas\. Bought 2 answers; 0\.008 USDC signed for of the 0\.01 USDC budget\.$/);
      assert.deepEqual(result.steps.map((s) => s.source), ["the API · 402", "the client · /risk", "the client · /dryrun", "the verdict"]);
      assert.deepEqual(await failed(proof), []);
      const checks = await verifyBuyerProof(proof);
      assert.equal(checks.find((c) => c.name === "answers recomputed")!.detail, "risk and dryrun, each recomputed from its recorded calls");
      assert.match(checks.find((c) => c.name === "settlements")!.detail, /^risk: 0x[0-9a-f]{64}: transferWithAuthorization of exactly the signed authorization, sent by the facilitator 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; .*; dryrun: 0x[0-9a-f]{64}: /);
      // A verdict not what was bought says; an answer changed; a ledger that hides a purchase.
      const claimed = clone(proof);
      (claimed.result as BuyerRun).verdict = "do-not-send";
      assert.deepEqual(await failed(claimed), ["outcome recomputed"]);
      const changed = clone(proof);
      ((changed.result as BuyerRun).purchases[0]!.data as { verdict: string }).verdict = "do-not-send";
      assert.deepEqual(await failed(changed), ["answers recomputed", "outcome recomputed"]);
      const hidden = clone(proof);
      (hidden.result as BuyerRun).ledger.committed.amount = "5000";
      assert.deepEqual(await failed(hidden), ["within the budget"]);
    } finally {
      await fake.close();
    }
  });

  test("do not send: a lookalike of the trader; the dry run not bought, the rest of the budget kept; the proof verifies", async () => {
    const fake = await chainFor(atlantic);
    try {
      const { result, proof } = await run(fake, atlantic, { payer, facilitator, budget: "0.01", job: job(LOOKALIKE) });
      assert.deepEqual([result.verdict, result.purchases.length, result.ledger.remaining.shown, result.tx], ["do-not-send", 1, "0.005 USDC", null]);
      assert.deepEqual(result.plan.map((p) => [p.product, p.status, p.note]), [["risk", "bought", `bought for 0.005 USDC, settled in ${result.purchases[0]!.settlement!.transaction}`], ["dryrun", "not-needed", "not needed: the check says do not send"]]);
      assert.match(result.reason!, /starts and ends like 0x1F35…c85C, which the sender dealt with 2 times in the last 2,000 blocks, but it is a different address/);
      assert.deepEqual(await failed(proof), []);
    } finally {
      await fake.close();
    }
  });

  test("the budget: the dry run over what is left, the check over all of it; nothing signed past what is left; the proofs verify", async () => {
    const fake = await chainFor(atlantic);
    try {
      const short = await run(fake, atlantic, { payer, facilitator, budget: "0.006", job: job(TRADER) });
      assert.deepEqual([short.result.verdict, short.result.reason, short.result.purchases.length, short.result.ledger.committed.shown], ["not-done", "the dry run costs 0.003 USDC, more than the 0.001 USDC left of the budget", 1, "0.005 USDC"]);
      assert.deepEqual(short.result.plan.map((p) => p.status), ["bought", "over-budget"]);
      const none = await run(fake, atlantic, { payer, facilitator, budget: "0.001", job: job(TRADER) });
      assert.deepEqual([none.result.verdict, none.result.reason, none.result.purchases, none.result.ledger.committed.amount], ["not-done", "the risk check costs 0.005 USDC, more than the 0.001 USDC left of the budget", [], "0"]);
      assert.equal(none.result.headline, "Not done: Send 25 USDC from 0x7099…79C8 to 0x1F35…c85C: the risk check costs 0.005 USDC, more than the 0.001 USDC left of the budget. Nothing bought; 0 USDC signed for of the 0.001 USDC budget.");
      for (const { proof } of [short, none]) assert.deepEqual(await failed(proof), []);
      assert.equal(recordedCalls(none.proof.transcript).filter((c) => c.name === "send_raw_transaction").length, 0);
    } finally {
      await fake.close();
    }
  });

  test("a price changed after the 402: the buyer does not sign", async () => {
    const fake = await chainFor(atlantic);
    const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: fake.url }, broadcast: true }, { timeoutMs: 15_000, budget: 120 });
    try {
      const chain = new Chain(mcp, atlantic);
      const read = await readAsset(chain, getAddress(atlantic.tokens.find((t) => t.symbol === "USDC")!.address), "latest");
      const asset = { ...read, decimals: 6 };
      const cheap = await paidApi({ chain, asset, payTo: API_VENDOR, facilitator, wait: { pollMs: 10 } });
      const dear = await paidApi({ chain, asset, payTo: API_VENDOR, facilitator, prices: { risk: "0.006" }, wait: { pollMs: 10 } });
      // The first ask of a product (the price) reaches the cheap API; the purchase, the dear one.
      const asked = new Set<string>();
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input as never, init);
        const path = new URL(request.url).pathname;
        const first = !asked.has(path);
        asked.add(path);
        return (first ? cheap : dear).handler(request);
      };
      const result = await buy({ net: atlantic, fetcher, api: { url: cheap.url, where: "remote" }, job: transferIntent(new URLSearchParams(job(TRADER)), atlantic), budget: "0.01", asset: { address: asset.address, symbol: "USDC", decimals: 6 }, payer });
      assert.deepEqual([result.verdict, result.purchases[0]!.payment, result.ledger.committed.amount], ["not-done", null, "0"]);
      assert.equal(result.reason, "the risk check was not bought: the price changed to 0.006 USDC from the 0.005 USDC the 402 asked");
    } finally {
      await mcp.close();
      await fake.close();
    }
  });

  test("from an API elsewhere, over HTTP: the same job, bought and settled", async () => {
    const fake = await chainFor(atlantic);
    const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: fake.url }, broadcast: true }, { timeoutMs: 15_000, budget: 200 });
    try {
      const chain = new Chain(mcp, atlantic);
      const read = await readAsset(chain, getAddress(atlantic.tokens.find((t) => t.symbol === "USDC")!.address), "latest");
      const api = await paidApi({ chain, asset: { ...read, decimals: 6 }, payTo: API_VENDOR, facilitator, wait: { pollMs: 10 } });
      const server = await serve(api.handler);
      try {
        const result = await buy({ net: atlantic, fetcher: fetch, api: { url: server.url, where: "remote" }, job: transferIntent(new URLSearchParams(job(TRADER)), atlantic), budget: "0.01", asset: { address: read.address, symbol: "USDC", decimals: 6 }, payer });
        assert.deepEqual([result.verdict, result.api.where, result.api.url, result.purchases.map((p) => p.settlement?.success)], ["ready", "remote", server.url, [true, true]]);
      } finally {
        await server.close();
      }
    } finally {
      await mcp.close();
      await fake.close();
    }
  });
});

describe("on Pharos Mainnet: nothing settles", () => {
  test("the prices asked, the plan within the budget, the first purchase signed with a key made for the run and refused on chain; the job not done; the proof verifies", async () => {
    const fake = await chainFor(mainnet);
    const official = await connectOfficial(fake, mainnet, { budget: 60 });
    try {
      const jobAsked = { asset: "USDC", from: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", to: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "25" };
      const result = await runBuyer({ chain: official.chain, job: transferIntent(new URLSearchParams(jobAsked), mainnet), budget: "0.01" });
      assert.deepEqual([result.verdict, result.payer.key, result.api.settles, result.api.facilitator], ["not-done", "new", false, null]);
      assert.equal(result.reason, "the API refused the payment for the risk check: the payer does not hold the amount");
      assert.deepEqual(result.plan.map((p) => [p.product, p.status, p.price?.shown]), [["risk", "refused", "0.005 USDC"], ["dryrun", "over-budget", "0.003 USDC"]]);
      assert.deepEqual([result.ledger.committed.shown, result.ledger.settled.shown], ["0.005 USDC", "0 USDC"], "the signed authorization counts against the budget, though it never settled");
      const proof = clone(proofFile({ task: "21", capability: "x402-buyer", about: "test", mcp: official.mcp, network: mainnet, startedAt: new Date(), input: { job: jobAsked, budget: "0.01" }, result }));
      proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
      assert.deepEqual(await failed(proof), []);
      assert.equal((await verifyBuyerProof(proof)).find((c) => c.name === "nothing sent")!.detail, "the API's facilitator holds no key: no transaction sent");
      await assert.rejects(runBuyer({ chain: official.chain, job: transferIntent(new URLSearchParams(jobAsked), mainnet), budget: "0.01", payer }), /Paying is limited to the Atlantic testnet/);
    } finally {
      await official.close();
      await fake.close();
    }
  });
});
