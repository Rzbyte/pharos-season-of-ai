// Task 20, X402 Paywalled API: x402 on Pharos through the official x402 packages and the official Chain
// MCP server, on a fake chain. The asset read (its EIP-712 domain, EIP-3009 or not); the paid endpoint's
// 402 terms; the client's EIP-3009 authorization, within its cap; the facilitator's verify (simulated on
// chain) and settle (transferWithAuthorization sent); the data released only once settled. Each refusal
// says why, an authorization is never settled twice, the parts work over HTTP as the Pharos skill sets
// them up, and the proofs verify offline, a forged one failing.
// x402 times an authorization by the clock, so each fake chain's head is now.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Chain } from "../src/core/chain.js";
import { ChainMcp } from "../src/core/chain-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, recordedCalls, type ProofFile } from "../src/core/proof.js";
import { facilitatorRoutes, LocalFacilitatorClient, localFetch, paidEndpoint, payingFetch, pharosFacilitator, serve } from "../src/x402/parties.js";
import { readAsset, x402Network, type X402Asset } from "../src/x402/pharos.js";
import { reasonWords, runX402, type X402Options, type X402Run } from "../src/x402/run.js";
import { verifyX402Proof } from "../src/x402/verify.js";
import { defaultState, startFakeChain, type FakeChain, type FakeToken } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const net = NETWORKS["pharos-mainnet"];
const atlantic = NETWORKS["atlantic-testnet"];
const USDC = getAddress(net.tokens.find((t) => t.symbol === "USDC")!.address);
const TUSDC = getAddress(atlantic.tokens.find((t) => t.symbol === "USDC")!.address);
const lower = (address: string) => address.toLowerCase();
// The well-known Hardhat/Anvil test keys #1 and #2: public, only ever used here on a fake chain.
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const facilitatorKey = signerFromEnv({ PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" });
const PAY_TO = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const PLAIN = "0x00000000000000000000000000000000000c0de1";
const now = () => BigInt(Math.floor(Date.now() / 1000));
const usdc = (balances: Record<string, bigint> = {}): FakeToken => ({ decimals: 6, name: "USD Coin", symbol: "USDC", eip3009: { version: "2" }, balances });
const failedChecks = async (proof: ProofFile) => (await verifyX402Proof(proof)).filter((c) => !c.ok).map((c) => c.name);
const sends = (proof: ProofFile) => recordedCalls(proof.transcript).filter((c) => c.name === "send_raw_transaction").length;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("the asset, read through Chain MCP", () => {
  let fake: FakeChain;
  before(async () => {
    fake = await startFakeChain(defaultState({ headTime: now(), tokens: { [lower(USDC)]: usdc(), [PLAIN]: { decimals: 18, name: "Plain", symbol: "PLN", balances: {} } } }));
  });
  after(() => fake.close());

  test("its EIP-712 name and version and its decimals, and whether it answers EIP-3009; a token without it, or no token at all", async () => {
    const official = await connectOfficial(fake, net);
    try {
      assert.deepEqual(await readAsset(official.chain, USDC, "latest"), { address: USDC, symbol: "USDC", name: "USD Coin", version: "2", decimals: 6, eip3009: true });
      assert.deepEqual(await readAsset(official.chain, PLAIN, "latest"), { address: PLAIN, symbol: "PLN", name: "Plain", version: null, decimals: 18, eip3009: false });
      const nothing = "0x0000000000000000000000000000000000000bad";
      assert.deepEqual(await readAsset(official.chain, nothing, "latest"), { address: nothing, symbol: null, name: null, version: null, decimals: null, eip3009: false });
    } finally {
      await official.close();
    }
  });

  test("the x402 network of each Pharos network, and the facilitator's reasons in words", () => {
    assert.deepEqual([x402Network(net), x402Network(atlantic)], ["eip155:1672", "eip155:688689"]);
    assert.equal(reasonWords("invalid_exact_evm_insufficient_balance"), "the payer does not hold the amount");
    assert.equal(reasonWords("invalid_exact_evm_nonce_already_used"), "this authorization was used already");
    assert.equal(reasonWords("some_new_reason"), "some new reason");
    assert.equal(reasonWords(undefined), null);
  });
});

describe("a run on Pharos Mainnet: the facilitator only verifies", () => {
  let fake: FakeChain;
  before(async () => {
    fake = await startFakeChain(defaultState({ headTime: now(), tokens: { [lower(USDC)]: usdc({ [lower(payer.address)]: 5_000_000n }), [PLAIN]: { decimals: 6, name: "Plain", symbol: "PLN", balances: {} } } }));
  });
  after(() => fake.close());

  async function run(options: Omit<X402Options, "chain" | "payTo"> & { payTo?: X402Options["payTo"] }): Promise<{ result: X402Run; proof: ProofFile }> {
    const official = await connectOfficial(fake, net, { budget: 80 });
    try {
      const result = await runX402({ chain: official.chain, payTo: PAY_TO, ...options });
      const input = { payTo: options.payTo ?? PAY_TO, price: options.price, cap: options.cap, asset: options.asset };
      const proof = clone(proofFile({ task: "20", capability: "x402-payment", about: "test", mcp: official.mcp, network: net, startedAt: new Date(), input, result }));
      proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
      return { result, proof };
    } finally {
      await official.close();
    }
  }

  test("402 with its terms, an authorization signed by a key made for the run, refused for want of funds; the data stays locked, nothing is sent; the proof verifies", async () => {
    const { result, proof } = await run({ price: "0.001" });
    assert.deepEqual([result.verdict, result.reason, result.payer.key, result.facilitator, result.response.status, result.data, result.settle, result.settlement], ["refused", "the payer does not hold the amount", "new", { address: null, settles: false }, 402, null, null, null]);
    const accepted = result.required!.accepts[0]!;
    assert.deepEqual({ ...accepted, maxTimeoutSeconds: typeof accepted.maxTimeoutSeconds }, { scheme: "exact", network: "eip155:1672", asset: USDC, amount: "1000", payTo: PAY_TO, maxTimeoutSeconds: "number", extra: { name: "USD Coin", version: "2" } });
    const auth = (result.payment!.payload as { authorization: { from: string; to: string; value: string } }).authorization;
    assert.deepEqual([auth.from, auth.to, auth.value], [result.payer.address, PAY_TO, "1000"]);
    assert.notEqual(lower(result.payer.address), lower(payer.address));
    assert.deepEqual([result.verify?.isValid, result.verify?.invalidReason], [false, "invalid_exact_evm_insufficient_balance"]);
    assert.deepEqual(result.steps.map((s) => s.source), ["Chain MCP · eth_call", "the paid endpoint", "the client", "the facilitator · verify", "the verdict"]);
    assert.match(result.headline, /^The endpoint asked 0\.001 USDC; a key made for this run, holding nothing \(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}\), signed for it, and the facilitator refused it on Pharos Mainnet: the payer does not hold the amount\. The data stayed locked\.$/);
    assert.deepEqual([result.endpoint.price, result.cap, result.permit2], [{ amount: "1000", shown: "0.001 USDC" }, { amount: "1000", shown: "0.001 USDC" }, null]);
    assert.equal(sends(proof), 0);
    assert.deepEqual(await failedChecks(proof), []);
    const checks = await verifyX402Proof(proof);
    assert.match(checks.find((c) => c.name === "facilitator's check")!.detail, /^the simulation reverts, and the payer's recorded balance \(0 base units\) is under 1000: refused$/);
    assert.equal(checks.find((c) => c.name === "nothing sent")!.detail, "a facilitator without a key: no transaction sent");
    assert.doesNotMatch(JSON.stringify(proof), /private[_ ]?key/i);
  });

  test("forged proofs fail: data released for a refused payment, an authorization for more, a balance changed", async () => {
    const { proof } = await run({ price: "0.001" });
    const released = clone(proof);
    (released.result as X402Run).data = { block: { number: "1" } };
    assert.deepEqual(await failedChecks(released), ["data only when paid"]);
    const more = clone(proof);
    ((more.result as X402Run).payment!.payload as { authorization: { value: string } }).authorization.value = "999999";
    assert.deepEqual(await failedChecks(more), ["signed authorization"]);
    // Not a number at all: a failed check, never a crash of the verifier.
    const garbled = clone(proof);
    ((garbled.result as X402Run).payment!.payload as { authorization: { value: string } }).authorization.value = "lots";
    assert.ok((await failedChecks(garbled)).includes("signed authorization"));
    // The payer's balance, as the chain answered the facilitator, made a million USDC.
    const richer = clone(proof);
    const balanceOf = encodeFunctionData({ abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [(proof.result as X402Run).payer.address] });
    const request = richer.transcript.find((m) => m.direction === "client->server" && JSON.stringify(m.message).includes(balanceOf));
    const reply = richer.transcript.find((m) => m.direction === "server->client" && (m.message as { id?: unknown }).id === (request?.message as { id?: unknown } | undefined)?.id && "result" in m.message);
    const content = (reply!.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
    content.text = content.text.replace(/0x0{64}/, `0x${(10n ** 12n).toString(16).padStart(64, "0")}`);
    assert.deepEqual(await failedChecks(richer), ["facilitator's check"]);
  });

  test("the client's cap below the price: nothing signed; a token without EIP-3009: nothing to sign, and Permit2's contracts looked for", async () => {
    const capped = await run({ price: "0.01", cap: "0.001" });
    assert.deepEqual([capped.result.verdict, capped.result.reason, capped.result.payment, capped.result.verify], ["not-paid", "the endpoint asks 0.01 USDC, more than the client's cap of 0.001 USDC a request", null, null]);
    assert.equal(capped.result.headline, "Nothing was paid: the endpoint asks 0.01 USDC, more than the client's cap of 0.001 USDC a request. The data stayed locked.");
    assert.deepEqual(await failedChecks(capped.proof), []);
    const plain = await run({ price: "0.001", asset: PLAIN });
    assert.deepEqual([plain.result.verdict, plain.result.asset.eip3009, plain.result.reason], ["not-paid", false, "the asset answers no EIP-712 version(), so there is no domain for an authorization to sign"]);
    assert.deepEqual(plain.result.permit2, { permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3", permit2Code: false, proxy: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001", proxyCode: false });
    assert.match(plain.result.steps[1]!.text, /^x402's other way to settle, Permit2, needs Permit2 \(0x0000…8BA3\) and x402's proxy \(0x4020…0001\) deployed: Permit2 has no code on Pharos Mainnet, the proxy has none\./);
    assert.deepEqual(await failedChecks(plain.proof), []);
  });

  test("refused: a facilitator key off Atlantic, a zero price, a price finer than the asset, an address that is no token", async () => {
    const official = await connectOfficial(fake, net);
    try {
      await assert.rejects(runX402({ chain: official.chain, payTo: PAY_TO, price: "0.001", payer, facilitator: facilitatorKey }), /Settling is limited to the Atlantic testnet/);
      await assert.rejects(runX402({ chain: official.chain, payTo: PAY_TO, price: "0" }), /more than zero/);
      await assert.rejects(runX402({ chain: official.chain, payTo: PAY_TO, price: "0.0000001" }), /decimal places/);
      await assert.rejects(runX402({ chain: official.chain, payTo: PAY_TO, price: "0.001", asset: "0x0000000000000000000000000000000000000bad" }), /0x0000000000000000000000000000000000000bad answers no decimals\(\): it is not a token an endpoint can price in/i);
    } finally {
      await official.close();
    }
  });
});

describe("a paid request on Atlantic", () => {
  let fake: FakeChain;
  const balances = () => fake.state.tokens[lower(TUSDC)]!.balances;
  before(async () => {
    fake = await startFakeChain(defaultState({ chainId: 688689, headTime: now(), native: { [lower(facilitatorKey.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: usdc({ [lower(payer.address)]: 5_000_000n, [lower("0x1F3546a29EeC2102c8d52E21a45114124014c85C")]: 10n }) } }));
  });
  after(() => fake.close());

  async function run(options: Partial<X402Options> & { price: string }): Promise<{ result: X402Run; proof: ProofFile }> {
    const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: fake.url }, broadcast: true }, { timeoutMs: 15_000, budget: 120 });
    try {
      const result = await runX402({ chain: new Chain(mcp, atlantic), payTo: PAY_TO, payer, facilitator: facilitatorKey, wait: { pollMs: 10 }, ...options });
      const input = { payTo: options.payTo ?? PAY_TO, price: options.price, cap: options.cap, asset: options.asset };
      return { result, proof: clone(proofFile({ task: "20", capability: "x402-payment", about: "test", mcp, network: atlantic, startedAt: new Date(), input, result })) };
    } finally {
      await mcp.close();
    }
  }

  test("paid, settled by transferWithAuthorization through Chain MCP, and the data released; the proof verifies, a forged settlement fails", async () => {
    const before = { payer: balances()[lower(payer.address)]!, payTo: balances()[lower(PAY_TO)] ?? 0n };
    const { result, proof } = await run({ price: "0.001", cap: "0.01" });
    assert.deepEqual([result.verdict, result.reason, result.payer, result.facilitator], ["paid", null, { address: payer.address, key: "given" }, { address: facilitatorKey.address, settles: true }]);
    assert.deepEqual([balances()[lower(payer.address)], balances()[lower(PAY_TO)]], [before.payer - 1000n, before.payTo + 1000n]);
    assert.deepEqual([result.verify?.isValid, result.settle?.success, result.settle?.network, result.response.status], [true, true, "eip155:688689", 200]);
    assert.deepEqual(result.settlement, { tx: result.settle!.transaction, block: "5000001", status: "success", transfer: { from: payer.address, to: PAY_TO, value: "1000" } });
    assert.equal(fake.receipts.get(lower(result.settle!.transaction))?.status, "0x1");
    assert.equal((result.response.paymentResponse as { transaction: string }).transaction, result.settle!.transaction);
    assert.deepEqual(result.data, { network: "eip155:688689", chainId: 688689, block: { number: "5000000", timestamp: new Date(Number(fake.state.headTime - 1n) * 1000).toISOString(), baseFeePerGas: "1000000000" }, gasPrice: "1200000000", source: "Pharos Chain MCP" });
    assert.deepEqual(result.steps.map((s) => s.source), ["Chain MCP · eth_call", "the paid endpoint", "the client", "the facilitator · verify", "the facilitator · settle", "the client", "the verdict"]);
    assert.equal(result.headline, `Paid and served: 0.001 USDC from 0x7099…79C8 to 0xB274…9553, settled in ${result.settle!.transaction}, and the data released for it.`);
    assert.equal(sends(proof), 1);
    assert.deepEqual(await failedChecks(proof), []);
    const checks = await verifyX402Proof(proof);
    assert.equal(checks.find((c) => c.name === "settlement")!.detail, `${result.settle!.transaction}: transferWithAuthorization of exactly the signed authorization, sent by the facilitator ${facilitatorKey.address}; its receipt a success, holding the Transfer of 1000 base units to ${PAY_TO}`);
    assert.equal(checks.find((c) => c.name === "data from Chain MCP")!.detail, "block 5000000 and the gas price, each a recorded answer");
    const forged = clone(proof);
    (forged.result as X402Run).settle!.transaction = `0x${"ab".repeat(32)}`;
    assert.deepEqual(await failedChecks(forged), ["settlement", "data only when paid"]);
    const other = clone(proof);
    (other.result as X402Run).payTo = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
    assert.ok((await failedChecks(other)).includes("terms as asked"));
  });

  test("the same authorization twice: refused the second time, nothing moved", async () => {
    const { result } = await run({ price: "0.002" });
    assert.equal(result.verdict, "paid");
    const moved = balances()[lower(PAY_TO)];
    const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: fake.url }, broadcast: true }, { timeoutMs: 15_000, budget: 60 });
    try {
      const chain = new Chain(mcp, atlantic);
      const asset: X402Asset = await readAsset(chain, TUSDC, "latest");
      const facilitator = new LocalFacilitatorClient(pharosFacilitator(chain, facilitatorKey, { wait: { pollMs: 10 } }));
      const handler = await paidEndpoint({ chain, asset, payTo: PAY_TO, routes: [{ path: "/data", amount: "2000", description: "test", data: async () => ({ ok: true }) }], facilitator });
      const again = await handler(new Request("https://x402.local/data", { headers: { "payment-signature": encodePaymentSignatureHeader(result.payment as PaymentPayload) } }));
      assert.equal(again.status, 402);
      assert.deepEqual(facilitator.log.filter((l) => l.op !== "supported").map((l) => [l.op, (l.response as { invalidReason?: string }).invalidReason]), [["verify", "invalid_exact_evm_nonce_already_used"]]);
      assert.equal(balances()[lower(PAY_TO)], moved);
    } finally {
      await mcp.close();
    }
  });

  test("a payer short of the price: refused at verify, so a facilitator with a key sends nothing", async () => {
    const poor = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
    const { result, proof } = await run({ price: "0.001", payer: poor });
    assert.deepEqual([result.verdict, result.reason, result.settle, sends(proof)], ["refused", "the payer does not hold the amount", null, 0]);
    assert.equal((await verifyX402Proof(proof)).find((c) => c.name === "nothing sent")?.detail, "refused before settling: no transaction sent");
    assert.equal(result.headline, "The endpoint asked 0.001 USDC; 0x90F7…b906 signed for it, and the facilitator refused it on Atlantic Testnet: the payer does not hold the amount. The data stayed locked.");
    assert.deepEqual(await failedChecks(proof), []);
  });

  test("Chain MCP failing is an error, never a verdict: mid-verify it is thrown, not called a refusal; after a settlement is signed, its hash is named", async () => {
    // The facilitator's simulation fails upstream (not a revert): x402 would take it for a failed check.
    fake.onRequest = (method, params) => {
      if (method === "eth_call" && String((params[0] as { data?: string } | undefined)?.data).startsWith("0xe3ee160e")) fake.state.failures.eth_call = { code: -32000, message: "upstream unavailable" };
    };
    try {
      await assert.rejects(run({ price: "0.001" }), (error: unknown) => error instanceof AgentError && error.kind === "mcp_tool" && /upstream unavailable/.test(error.message));
    } finally {
      fake.onRequest = undefined;
      delete fake.state.failures.eth_call;
    }
    // The receipt cannot be read once the settlement is sent: the run says which transaction, so it is not paid again.
    const before = balances()[lower(PAY_TO)] ?? 0n;
    fake.state.failures.eth_getTransactionReceipt = { code: -32000, message: "upstream unavailable" };
    try {
      await assert.rejects(run({ price: "0.004" }), (error: unknown) => error instanceof AgentError && error.kind === "execution" && /^The settlement 0x[0-9a-f]{64} was signed and may have been sent, then: .*upstream unavailable/.test(error.message) && error.hint === "Check its receipt before paying again.");
    } finally {
      delete fake.state.failures.eth_getTransactionReceipt;
    }
    assert.equal(balances()[lower(PAY_TO)], before + 4000n, "it was in fact sent: the error names it rather than calling it unpaid");
  });

  test("over HTTP, as the Pharos skill sets it up: the endpoint asks x402's HTTP facilitator client, the facilitator answers /supported, /verify and /settle, the client pays with fetch", async () => {
    const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: fake.url }, broadcast: true }, { timeoutMs: 15_000, budget: 80 });
    const chain = new Chain(mcp, atlantic);
    const log: Parameters<typeof facilitatorRoutes>[1] = [];
    const facilitatorServer = await serve(facilitatorRoutes(pharosFacilitator(chain, facilitatorKey, { wait: { pollMs: 10 } }), log));
    try {
      const supported = (await (await fetch(`${facilitatorServer.url}/supported`)).json()) as { kinds: { scheme: string; network: string }[]; signers: Record<string, string[]> };
      assert.deepEqual(supported.kinds.map((k) => [k.scheme, k.network]), [["exact", "eip155:688689"]]);
      assert.deepEqual(Object.values(supported.signers).flat(), [facilitatorKey.address]);
      const asset = await readAsset(chain, TUSDC, "latest");
      const endpoint = await serve(await paidEndpoint({ chain, asset, payTo: PAY_TO, routes: [{ path: "/data", amount: "1500", description: "test", data: async () => ({ block: (await chain.blockNumber()).toString() }) }], facilitator: new HTTPFacilitatorClient({ url: facilitatorServer.url }), free: { "/": async () => ({ paid: ["/data"] }) } }));
      try {
        assert.equal((await fetch(`${endpoint.url}/data`)).status, 402);
        assert.deepEqual(await (await fetch(`${endpoint.url}/`)).json(), { paid: ["/data"] });
        assert.equal((await fetch(`${endpoint.url}/nothing`)).status, 404);
        const before = balances()[lower(PAY_TO)] ?? 0n;
        const paid = await payingFetch(payer, atlantic, TUSDC, "1500")(`${endpoint.url}/data`);
        assert.equal(paid.status, 200);
        assert.match(JSON.stringify(await paid.json()), /^\{"block":"\d+"\}$/);
        assert.ok(paid.headers.get("payment-response"));
        assert.equal(balances()[lower(PAY_TO)], before + 1500n);
        assert.deepEqual(log.map((l) => l.op).filter((op) => op !== "supported"), ["verify", "settle"]);
        const bad = await fetch(`${facilitatorServer.url}/verify`, { method: "POST", body: "{}" });
        assert.equal(bad.status, 400);
      } finally {
        await endpoint.close();
      }
    } finally {
      await facilitatorServer.close();
      await mcp.close();
    }
  });
});

test("the paying client, offered one asset only: a payment asked in another is not made", async () => {
  const fake = await startFakeChain(defaultState({ chainId: 688689, headTime: now(), tokens: { [lower(TUSDC)]: usdc({ [lower(payer.address)]: 5_000_000n }) } }));
  const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: fake.url }, broadcast: false }, { timeoutMs: 15_000 });
  try {
    const chain = new Chain(mcp, atlantic);
    const asset = await readAsset(chain, TUSDC, "latest");
    const facilitator = new LocalFacilitatorClient(pharosFacilitator(chain, null));
    const handler = await paidEndpoint({ chain, asset, payTo: PAY_TO, routes: [{ path: "/data", amount: "1000", description: "test", data: async () => ({}) }], facilitator });
    await assert.rejects(payingFetch(payer, atlantic, PLAIN, "1000", localFetch(handler))("https://x402.local/data"), /spendControls|allowedAssets|rejected/i);
    assert.deepEqual(facilitator.log.filter((l) => l.op !== "supported"), []);
  } finally {
    await mcp.close();
    await fake.close();
  }
});
