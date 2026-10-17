// Task 08, Dry-Run Executor: intents, predictions, costs and verdicts against the official Chain MCP
// server on a fake chain, a submission on Atlantic compared with its receipt, and proofs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Chain } from "../src/core/chain.js";
import { ChainMcp, Recorder } from "../src/core/chain-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS, type Network } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { parseDryRun, type Intent } from "../src/dryrun/intent.js";
import { runDryRun } from "../src/dryrun/run.js";
import { verifyDryRunProof } from "../src/dryrun/verify.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const ROUTER = "0x1111111111111111111111111111111111111111";
const lower = (a: string) => a.toLowerCase();

const mainnetChain = (overrides: { usdc?: bigint; native?: bigint; paused?: boolean; code?: Record<string, `0x${string}`> } = {}) =>
  startFakeChain(defaultState({ native: { [lower(PAYER)]: overrides.native ?? 10n ** 18n, [lower(RECIPIENT)]: 5n * 10n ** 17n }, code: overrides.code ?? {}, tokens: { [lower(USDC)]: { decimals: 6, paused: overrides.paused ?? false, balances: { [lower(PAYER)]: overrides.usdc ?? 1_000_000_000n, [lower(RECIPIENT)]: 600_000_000n } } } }));

const intent = (fields: Record<string, unknown>, network = "pharos-mainnet"): Intent => parseDryRun({ network, intent: fields }).intent;
const transfer = (amount = "25", extra: Record<string, unknown> = {}) => intent({ kind: "erc20-transfer", token: USDC, from: PAYER, to: RECIPIENT, amount, ...extra });

async function dry(fake: FakeChain, request: Intent, block?: bigint) {
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    return { run: await runDryRun(request, { chain: official.chain, block }), official };
  } finally {
    await official.close();
  }
}

const tools = (messages: Recorder["messages"]) =>
  messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);

describe("dry-run intents", () => {
  test("each kind is checked before anything touches the chain", () => {
    assert.equal(transfer().kind, "erc20-transfer");
    assert.equal(intent({ kind: "erc20-approve", token: USDC, from: PAYER, spender: ROUTER, amount: "max" }).kind, "erc20-approve");
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ kind: "swap" }, /kind must be one of/],
      [{ kind: "erc20-transfer", token: USDC, from: "0x12", to: RECIPIENT, amount: "1" }, /from must be a 0x address/],
      [{ kind: "erc20-transfer", token: USDC, from: PAYER, to: RECIPIENT, amount: "-1" }, /plain non-negative number/],
      [{ kind: "native-transfer", from: PAYER, to: RECIPIENT, amount: "0.0000000000000000001" }, /more than 18 decimal places/],
      [{ kind: "call", from: PAYER, to: USDC, signature: "transfer(address,uint256)", args: [RECIPIENT], value: "0" }, /takes 2/],
      [{ kind: "call", from: PAYER, to: USDC, signature: "transfer(address,uint256)", args: [RECIPIENT, "1"], value: "1" }, /not payable/],
      [{ kind: "call", from: PAYER, to: USDC, signature: "transfer", args: [] }, /A function looks like/],
    ];
    for (const [fields, error] of cases) assert.throws(() => intent(fields), (e: unknown) => e instanceof AgentError && e.kind === "usage" && error.test(e.message), JSON.stringify(fields));
  });
});

describe("a dry run through the official Chain MCP server", () => {
  test("would succeed: the state it changes, read at one block, simulated there, priced, and the outcome predicted", async () => {
    const fake = await mainnetChain();
    try {
      const { run, official } = await dry(fake, transfer());
      assert.equal(run.verdict, "would-succeed");
      assert.equal(run.returns, "true");
      assert.equal(run.summary, "Send 25 USDC from 0x912c…f647 to 0xB274…9553");
      assert.deepEqual(run.outcome.map((l) => [l.role, l.asset, l.shown.before, l.shown.after, l.shown.change]), [
        ["sender", "USDC", "1,000 USDC", "975 USDC", "−25 USDC"],
        ["recipient", "USDC", "600 USDC", "625 USDC", "+25 USDC"],
        ["sender", "PROS", "1 PROS", "about 0.99994364 PROS", "−0.00005635 PROS"],
      ]);
      assert.deepEqual(run.gas, { gas: "51234", gasLimit: "61480", baseFee: "1000000000", priorityFee: "100000000", gasPrice: "1200000000", expectedFeePerGas: "1100000000", maxFeePerGas: "2100000000", expectedCost: String(51_234n * 1_100_000_000n), maxCost: String(61_480n * 2_100_000_000n) });
      assert.equal(run.funds.shown.needs, "0.0001291 PROS");
      assert.deepEqual(run.warnings, []);
      assert.equal(run.headline, "Would succeed: Send 25 USDC from 0x912c…f647 to 0xB274…9553, for about 0.00005635 PROS in gas.");
      // Every state read and the simulation name the pinned block; the chain is checked first.
      const calls = tools(official.recorder.messages);
      assert.equal(calls[0]!.name, "get_chain_info");
      const pinned = `0x${BigInt(run.block.number).toString(16)}`;
      for (const call of calls.filter((c) => ["eth_call", "get_balance", "get_code"].includes(c.name))) assert.equal(call.arguments.block, pinned, JSON.stringify(call));
      assert.deepEqual(calls.map((c) => c.name).slice(-4), ["eth_call", "estimate_gas", "get_block", "get_gas_price"], "simulate, then price");
    } finally {
      await fake.close();
    }
  });

  test("would revert: the reason, nothing predicted, and no gas estimated for it", async () => {
    const fake = await mainnetChain({ usdc: 10_000_000n });
    try {
      const { run, official } = await dry(fake, transfer());
      assert.equal(run.verdict, "would-revert");
      assert.equal(run.reason, "It reverts: ERC20: transfer amount exceeds balance.");
      assert.ok(run.outcome.every((l) => l.after === null));
      assert.equal(run.gas, null);
      assert.ok(!tools(official.recorder.messages).some((c) => c.name === "estimate_gas"));
    } finally {
      await fake.close();
    }
    const paused = await mainnetChain({ paused: true });
    try {
      assert.equal((await dry(paused, transfer())).run.reason, "It reverts: Pausable: paused.");
    } finally {
      await paused.close();
    }
  });

  test("cannot pay: it would succeed, but the sender cannot cover the value and the maximum fee", async () => {
    const fake = await mainnetChain({ native: 10n ** 12n });
    try {
      const { run } = await dry(fake, transfer());
      assert.equal(run.verdict, "cannot-pay");
      assert.equal(run.reason, "The sender holds 0.000001 PROS but needs up to 0.0001291 PROS: the value plus the maximum fee.");
      assert.ok(run.outcome.every((l) => l.after === null));
    } finally {
      await fake.close();
    }
  });

  test("warnings: a contract recipient, a self-transfer, an unlimited approval to an address with no code", async () => {
    const fake = await mainnetChain({ code: { [lower(RECIPIENT)]: "0x6080" } });
    try {
      assert.deepEqual((await dry(fake, transfer())).run.warnings.map((w) => w.code), ["recipient-contract"]);
      const self = (await dry(fake, transfer("25", { to: PAYER }))).run;
      assert.deepEqual(self.warnings.map((w) => w.code), ["self-transfer"]);
      assert.deepEqual(self.outcome[0]!.shown, { before: "1,000 USDC", after: "1,000 USDC", change: "no change" });
      const approval = (await dry(fake, intent({ kind: "erc20-approve", token: USDC, from: PAYER, spender: ROUTER, amount: "max" }))).run;
      assert.deepEqual(approval.warnings.map((w) => w.code), ["unlimited-approval", "spender-not-contract"]);
      assert.equal(approval.outcome[0]!.role, "allowance");
      assert.equal(approval.outcome[0]!.shown.before, "0 USDC");
      assert.equal(approval.outcome[0]!.after, (2n ** 256n - 1n).toString());
      assert.equal(approval.summary, "Approve 0x1111…1111 to spend unlimited USDC of 0x912c…f647");
    } finally {
      await fake.close();
    }
  });

  test("a native transfer and a raw call: the native balances; a decoded return; a call to an address with no contract", async () => {
    const fake = await mainnetChain();
    try {
      const native = (await dry(fake, intent({ kind: "native-transfer", from: PAYER, to: RECIPIENT, amount: "0.25" }))).run;
      assert.equal(native.verdict, "would-succeed");
      assert.deepEqual(native.outcome.map((l) => [l.role, l.shown.before, l.shown.after]), [
        ["recipient", "0.5 PROS", "0.75 PROS"],
        ["sender", "1 PROS", "about 0.7499769 PROS"],
      ]);
      const call = (await dry(fake, intent({ kind: "call", from: PAYER, to: USDC, signature: "transfer(address,uint256) returns (bool)", args: [RECIPIENT, "1000000"], value: "0" }))).run;
      assert.deepEqual([call.verdict, call.returns], ["would-succeed", "true"]);
      const nothing = (await dry(fake, intent({ kind: "call", from: PAYER, to: ROUTER, signature: "deposit(uint256)", args: ["5"], value: "0" }))).run;
      assert.deepEqual(nothing.warnings.map((w) => w.code), ["no-contract"]);
    } finally {
      await fake.close();
    }
  });

  test("an address that is not a token is a usage error, before anything is simulated", async () => {
    const fake = await mainnetChain();
    try {
      await assert.rejects(dry(fake, transfer("1", { token: ROUTER })), (e: unknown) => e instanceof AgentError && e.kind === "usage" && /no contract at/.test(e.message));
    } finally {
      await fake.close();
    }
  });
});

describe("submitting on Atlantic, then comparing the prediction with the receipt", () => {
  // The well-known Hardhat/Anvil test key #1: public, only ever used here on a fake chain.
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
  const TUSDC = NETWORKS["atlantic-testnet"].tokens[0]!.address;
  const atlantic = async () => {
    const fake = await startFakeChain(defaultState({ chainId: 688689, native: { [lower(signer.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: { decimals: 6, balances: { [lower(signer.address)]: 5_000_000n, [lower(RECIPIENT)]: 1_000_000n } } } }));
    const net: Network = { ...NETWORKS["atlantic-testnet"], rpcUrl: fake.url };
    const recorder = new Recorder();
    const mcp = await ChainMcp.connect({ kind: "local", network: net, broadcast: true }, { recorder, timeoutMs: 15_000 });
    return { fake, mcp, recorder, chain: new Chain(mcp, net) };
  };

  test("a token transfer: sent through Chain MCP, then every predicted change matches the receipt's block", async () => {
    const { fake, mcp, chain } = await atlantic();
    try {
      const run = await runDryRun(intent({ kind: "erc20-transfer", token: TUSDC, from: signer.address, to: RECIPIENT, amount: "1.5" }, "atlantic-testnet"), { chain, signer, wait: { pollMs: 10 } });
      assert.equal(run.verdict, "would-succeed");
      const s = run.submission!;
      assert.equal(s.status, "success");
      assert.deepEqual(s.comparisons.map((c) => [c.what, c.match]), [["Status", true], ["Sender USDC", true], ["Recipient USDC", true], ["Sender PHRS", true], ["Gas used", true], ["Fee per gas", true]]);
      assert.deepEqual(s.comparisons.slice(1, 3).map((c) => [c.predicted, c.actual]), [["−1.5 USDC", "−1.5 USDC"], ["+1.5 USDC", "+1.5 USDC"]]);
      assert.equal(s.matched, true);
      assert.equal(fake.state.tokens[lower(TUSDC)]!.balances[lower(RECIPIENT)], 2_500_000n);
    } finally {
      await mcp.close();
      await fake.close();
    }
  });

  test("an approval: the allowance after the receipt is exactly the approved amount", async () => {
    const { fake, mcp, chain } = await atlantic();
    try {
      const run = await runDryRun(intent({ kind: "erc20-approve", token: TUSDC, from: signer.address, spender: ROUTER, amount: "3" }, "atlantic-testnet"), { chain, signer, wait: { pollMs: 10 } });
      assert.deepEqual(run.submission!.comparisons.slice(0, 2).map((c) => [c.what, c.actual, c.match]), [["Status", "success", true], ["Allowance USDC", "3 USDC", true]]);
      assert.equal(run.submission!.matched, true);
    } finally {
      await mcp.close();
      await fake.close();
    }
  });

  test("submitting is refused on mainnet, and with a key that is not the sender's", async () => {
    const fake = await mainnetChain();
    try {
      const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
      try {
        await assert.rejects(runDryRun(transfer(), { chain: official.chain, signer }), /limited to the Atlantic testnet/);
      } finally {
        await official.close();
      }
    } finally {
      await fake.close();
    }
    const { fake: fake2, mcp, chain } = await atlantic();
    try {
      await assert.rejects(runDryRun(intent({ kind: "erc20-transfer", token: TUSDC, from: RECIPIENT, to: signer.address, amount: "1" }, "atlantic-testnet"), { chain, signer }), /is not the sender/);
    } finally {
      await mcp.close();
      await fake2.close();
    }
  });
});

describe("dry-run proofs", () => {
  const failing = async (proof: ProofFile) => (await verifyDryRunProof(proof)).filter((c) => !c.ok).map((c) => c.name);

  test("a mainnet dry run verifies by replay; a changed answer does not", async () => {
    const fake = await mainnetChain();
    try {
      const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
      let proof: ProofFile;
      try {
        const request = { network: "pharos-mainnet" as const, intent: transfer() };
        const run = await runDryRun(request.intent, { chain: official.chain });
        proof = JSON.parse(JSON.stringify(proofFile({ task: "08", capability: "dry-run-executor", about: "test", mcp: official.mcp, network: NETWORKS["pharos-mainnet"], startedAt: new Date(), input: request, result: run }))) as ProofFile;
        proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
      } finally {
        await official.close();
      }
      const checks = await verifyDryRunProof(proof);
      assert.deepEqual(checks.filter((c) => !c.ok), []);
      assert.match(checks.find((c) => c.name === "result recomputed from the recorded responses")!.detail, /calls replayed; prediction, cost and verdict identical$/);
      // The recipient's balance, as recorded, is changed: the replayed prediction no longer matches.
      const data = `0x70a08231${"0".repeat(24)}${RECIPIENT.slice(2).toLowerCase()}`;
      const request = proof.transcript.find((m) => m.direction === "client->server" && JSON.stringify(m.message).includes(data))!;
      const id = (request.message as { id: number }).id;
      const response = proof.transcript.find((m) => m.direction === "server->client" && "id" in m.message && m.message.id === id)!;
      const content = (response.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
      assert.match(content.text, /23c34600/, "the recipient's 600 USDC answer");
      content.text = content.text.replace("23c34600", "23c34601");
      assert.deepEqual(await failing(proof), ["result recomputed from the recorded responses"]);
    } finally {
      await fake.close();
    }
  });

  test("a submitted Atlantic run verifies, including the transaction it signed", async () => {
    const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
    const TUSDC = NETWORKS["atlantic-testnet"].tokens[0]!.address;
    const fake = await startFakeChain(defaultState({ chainId: 688689, native: { [lower(signer.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: { decimals: 6, balances: { [lower(signer.address)]: 5_000_000n } } } }));
    const net: Network = { ...NETWORKS["atlantic-testnet"], rpcUrl: fake.url };
    const mcp = await ChainMcp.connect({ kind: "local", network: net, broadcast: true }, { timeoutMs: 15_000 });
    let proof: ProofFile;
    try {
      const request = { network: "atlantic-testnet" as const, intent: intent({ kind: "erc20-transfer", token: TUSDC, from: signer.address, to: RECIPIENT, amount: "1" }, "atlantic-testnet") };
      const run = await runDryRun(request.intent, { chain: new Chain(mcp, net), signer, wait: { pollMs: 10 } });
      assert.equal(run.submission?.matched, true);
      proof = JSON.parse(JSON.stringify(proofFile({ task: "08", capability: "dry-run-executor", about: "test", mcp, network: NETWORKS["atlantic-testnet"], startedAt: new Date(), input: request, result: run }))) as ProofFile;
    } finally {
      await mcp.close();
      await fake.close();
    }
    const checks = await verifyDryRunProof(proof);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.match(checks.find((c) => c.name === "signed transaction")!.detail, /^chain 688689, signed by 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, exactly the prepared dry-run transaction$/);
  });
});
