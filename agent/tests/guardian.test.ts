// Task 05, Threshold Guardian: the rules, the decision, and full runs against the official Chain MCP
// server (in-process, over stdio and over HTTP) on a fake chain. Nothing reaches the network.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { Chain } from "../src/core/chain.js";
import { ChainMcp, Recorder } from "../src/core/chain-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { NETWORKS, type Network } from "../src/core/networks.js";
import { parseGuardianConfig, type GuardianConfig } from "../src/guardian/config.js";
import { compare, decide, type ConditionOutcome } from "../src/guardian/evaluate.js";
import { payoutGuardian } from "../src/guardian/presets.js";
import { runGuardian } from "../src/guardian/run.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const PAYER = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";
const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";
const preset = payoutGuardian() as unknown;
const NOW = new Date(Number(1_790_000_000n + 3n) * 1000);

/** The fake chain the payout preset fires on: USDC live, the payer funded, a wallet recipient, cheap gas. */
function payoutChain(overrides: { usdc?: bigint; native?: bigint; paused?: boolean; chainId?: number } = {}) {
  return startFakeChain(
    defaultState({
      chainId: overrides.chainId ?? 1672,
      native: { [PAYER]: overrides.native ?? 10n ** 18n },
      tokens: { [USDC]: { decimals: 6, paused: overrides.paused ?? false, balances: { [PAYER]: overrides.usdc ?? 1_000_000_000n } } },
    }),
  );
}

async function run(fake: FakeChain, config: GuardianConfig, options: { block?: bigint } = {}) {
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    return { result: await runGuardian(config, { chain: official.chain, now: () => NOW, ...options }), messages: official.recorder.messages };
  } finally {
    await official.close();
  }
}

const calls = (messages: Recorder["messages"]) =>
  messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params);

const configWith = (edit: (config: Record<string, unknown> & { conditions: Record<string, unknown>[] }) => void) => {
  const copy = JSON.parse(JSON.stringify(preset)) as Record<string, unknown> & { conditions: Record<string, unknown>[] };
  edit(copy);
  return parseGuardianConfig(copy);
};

describe("guardian config", () => {
  test("the shipped payout preset is a valid guardian of six conditions and one USDC transfer", () => {
    const config = parseGuardianConfig(preset);
    assert.equal(config.network, "pharos-mainnet");
    assert.deepEqual(config.conditions.map((c) => c.id), ["usdc-live", "payer-funded", "payer-gas", "recipient-wallet", "gas-cap", "chain-fresh"]);
    assert.equal(config.action.type, "erc20-transfer");
  });

  test("rejects what it cannot evaluate safely, saying exactly what is wrong", () => {
    const cases: [string, (c: Record<string, unknown> & { conditions: Record<string, unknown>[] }) => void, RegExp][] = [
      ["unknown field", (c) => (c.extra = 1), /unknown field "extra"/],
      ["bad address", (c) => ((c.conditions[1]!.read as Record<string, unknown>).holder = "0x123"), /holder must be a 0x address/],
      ["duplicate id", (c) => (c.conditions[1]!.id = "usdc-live"), /share the id "usdc-live"/],
      ["ordering a yes/no", (c) => (c.conditions[0]!.op = "<"), /only be compared with == or !=/],
      ["a bool threshold as text", (c) => (c.conditions[0]!.value = "false"), /must be true or false/],
      ["an exponent", (c) => (c.conditions[1]!.value = "1e3"), /plain non-negative number/],
      ["a negative amount", (c) => ((c.action as Record<string, unknown>).amount = "-5"), /plain non-negative number/],
      ["unknown read", (c) => ((c.conditions[1]!.read as Record<string, unknown>).kind = "price-feed"), /read.kind must be one of/],
      ["too many conditions", (c) => (c.conditions = Array.from({ length: 9 }, (_, i) => ({ ...c.conditions[4]!, id: `g${i}` }))), /1 to 8 conditions/],
      ["rule beyond the conditions", (c) => (c.fireWhen = { atLeast: 7 }), /atLeast/],
      ["unknown network", (c) => (c.network = "sepolia"), /pharos-mainnet or atlantic-testnet/],
      ["call with the wrong arity", (c) => ((c.conditions[0]!.read as Record<string, unknown>).args = ["0x912c9aDe24D44d8922f0866D8Dcb079f1363f647"]), /takes 0/],
      ["unreadable signature", (c) => ((c.conditions[0]!.read as Record<string, unknown>).signature = "paused"), /call signature looks like/],
    ];
    for (const [name, edit, error] of cases) assert.throws(() => configWith(edit), (e: unknown) => e instanceof AgentError && e.kind === "usage" && error.test(e.message), name);
  });
});

describe("deciding", () => {
  test("compares base-unit integers exactly, yes/no and addresses only for equality", () => {
    const n = (raw: bigint) => ({ type: "number" as const, raw, decimals: 6, unit: "USDC" });
    assert.equal(compare(n(25_000_000n), ">=", n(25_000_000n)), true);
    assert.equal(compare(n(24_999_999n), ">=", n(25_000_000n)), false);
    assert.equal(compare({ type: "bool", value: false }, "==", { type: "bool", value: false }), true);
    assert.equal(compare({ type: "address", value: "0xAbC0000000000000000000000000000000000001" }, "==", { type: "address", value: "0xabc0000000000000000000000000000000000001" }), true);
  });

  test("all, any and at-least rules; a value that could not be read never counts as passing", () => {
    const o = (id: string, passed: boolean | null): ConditionOutcome => ({ id, label: id, tool: "eth_call", op: "==", observed: null, threshold: "", passed, error: passed === null ? "x" : null });
    const set = [o("a", true), o("b", true), o("c", null)];
    assert.equal(decide("all", set).fire, false);
    assert.deepEqual(decide("all", set).unreadable, ["c"]);
    assert.equal(decide("any", set).fire, true);
    assert.equal(decide({ atLeast: 2 }, set).fire, true);
    assert.equal(decide({ atLeast: 3 }, set).fire, false);
    assert.equal(decide("any", [o("x", null)]).fire, false);
  });
});

describe("a live-shaped run through the official Chain MCP server", () => {
  test("fire: every condition holds at one pinned block, so the transfer is prepared and simulated at that block", async () => {
    const fake = await payoutChain();
    try {
      const { result, messages } = await run(fake, parseGuardianConfig(preset));
      assert.equal(result.outcome, "fire");
      assert.equal(result.decision.passed, 6);
      assert.deepEqual(result.conditions.map((c) => [c.id, c.passed, c.observed]), [
        ["usdc-live", true, "paused() = false"],
        ["payer-funded", true, "1,000 USDC"],
        ["payer-gas", true, "1 PROS"],
        ["recipient-wallet", true, "no contract code"],
        ["gas-cap", true, "1.2 gwei"],
        ["chain-fresh", true, "3 s"],
      ]);
      assert.equal(result.action?.status, "ready");
      assert.equal(result.action?.simulation.ok, true);
      assert.equal(result.action?.gas, "51234");
      assert.equal(result.action?.cost?.wei, String(51_234n * 1_200_000_000n));
      assert.equal(result.action!.summary, "Transfer 25 USDC from 0x912c…f647 to 0xB274…9553");
      // The chain check comes first; every state read and the simulation name the pinned block.
      const sent = calls(messages);
      assert.equal(sent[0]!.name, "get_chain_info");
      const pinned = `0x${BigInt(result.block.number).toString(16)}`;
      for (const call of sent.filter((c) => ["eth_call", "get_balance", "get_code", "get_transaction_count"].includes(c.name))) assert.equal(call.arguments.block, pinned, JSON.stringify(call));
      assert.equal(result.chainMcp.server, "pharos-mcp-server 0.1.0");
      assert.equal(result.toolCalls, sent.length);
    } finally {
      await fake.close();
    }
  });

  test("hold: one condition fails, so nothing is prepared or simulated", async () => {
    const fake = await payoutChain({ usdc: 10_000_000n });
    try {
      const { result, messages } = await run(fake, parseGuardianConfig(preset));
      assert.equal(result.outcome, "hold");
      assert.deepEqual(result.decision.failed, ["payer-funded"]);
      assert.equal(result.action, null);
      assert.ok(!calls(messages).some((c) => String((c.arguments.transaction as { data?: string } | undefined)?.data ?? "").startsWith("0xa9059cbb")), "no transfer was simulated");
      assert.ok(!calls(messages).some((c) => c.name === "estimate_gas"));
      assert.match(result.headline, /^Hold at block 5,000,000: 5 of 6 conditions hold; the rule needs 6\. 1 short\.$/);
    } finally {
      await fake.close();
    }
  });

  test("blocked: the conditions hold but the transfer reverts in simulation, so it does not fire", async () => {
    const fake = await payoutChain({ paused: true });
    try {
      const config = configWith((c) => (c.conditions = c.conditions.filter((cond) => cond.id !== "usdc-live")));
      const { result } = await run(fake, config);
      assert.equal(result.outcome, "blocked");
      assert.equal(result.decision.fire, true);
      assert.equal(result.action?.status, "blocked");
      assert.equal(result.action?.reason, "The action reverts in simulation: Pausable: paused.");
    } finally {
      await fake.close();
    }
  });

  test("blocked: every condition holds, but USDC refuses this recipient (blacklisted), which only the simulation sees", async () => {
    const fake = await payoutChain();
    try {
      fake.state.tokens[USDC]!.blacklist = [RECIPIENT];
      const { result } = await run(fake, parseGuardianConfig(preset));
      assert.equal(result.outcome, "blocked");
      assert.equal(result.decision.passed, 6);
      assert.equal(result.action?.reason, "The action reverts in simulation: Blacklistable: account is blacklisted.");
      assert.equal(result.action?.gas, null, "no gas is estimated for a transfer that reverts");
    } finally {
      await fake.close();
    }
  });

  test("blocked: the payer cannot pay for gas", async () => {
    const fake = await payoutChain({ native: 0n });
    try {
      const config = configWith((c) => (c.conditions = c.conditions.filter((cond) => cond.id !== "payer-gas")));
      const { result } = await run(fake, config);
      assert.equal(result.outcome, "blocked");
      assert.match(result.action!.reason!, /^The payer holds 0 PROS but needs 0\.00006148 PROS for the action and its gas\.$/);
    } finally {
      await fake.close();
    }
  });

  test("a value that cannot be read (a call to an address with no contract) holds, fail-closed", async () => {
    const fake = await payoutChain();
    try {
      const config = configWith((c) => ((c.conditions[0]!.read as Record<string, unknown>).to = RECIPIENT));
      const { result } = await run(fake, config);
      assert.equal(result.outcome, "hold");
      assert.deepEqual(result.decision.unreadable, ["usdc-live"]);
      assert.match(result.conditions[0]!.error!, /^unreadable answer/);
    } finally {
      await fake.close();
    }
  });

  test("a server on another chain stops the run before any value is read", async () => {
    const fake = await payoutChain({ chainId: 1 });
    try {
      const official = await connectOfficial(fake, { ...NETWORKS["pharos-mainnet"], chainId: 1 });
      try {
        await assert.rejects(runGuardian(parseGuardianConfig(preset), { chain: new Chain(official.mcp, NETWORKS["pharos-mainnet"]), now: () => NOW }), (e: unknown) => e instanceof AgentError && e.kind === "wrong_chain");
        assert.deepEqual(calls(official.recorder.messages).map((c) => c.name), ["get_chain_info"]);
      } finally {
        await official.close();
      }
    } finally {
      await fake.close();
    }
  });

  test("an explicit block pins every read to it", async () => {
    const fake = await payoutChain();
    try {
      const { result, messages } = await run(fake, parseGuardianConfig(preset), { block: 4_999_990n });
      assert.equal(result.block.number, "4999990");
      assert.equal(result.conditions.find((c) => c.id === "chain-fresh")!.observed, "13 s");
      for (const call of calls(messages).filter((c) => c.name === "eth_call" || c.name === "get_balance" || c.name === "get_code")) assert.equal(call.arguments.block, "0x4c4b36");
    } finally {
      await fake.close();
    }
  });

  test("at least 5 of 6: one failing condition still fires", async () => {
    const fake = await payoutChain();
    try {
      fake.state.gasPrice = 50_000_000_000n;
      const { result } = await run(fake, configWith((c) => (c.fireWhen = { atLeast: 5 })));
      assert.equal(result.outcome, "fire");
      assert.deepEqual(result.decision.failed, ["gas-cap"]);
      assert.equal(result.rule, "at least 5 of 6");
    } finally {
      await fake.close();
    }
  });

  test("the hosted path: Streamable HTTP to the official server's own HTTP mode", async () => {
    const fake = await payoutChain();
    const port = await freePort();
    const { loadConfig } = (await import(new URL("../vendor/pharos-mcp/src/config.js", import.meta.url).href)) as { loadConfig(env: Record<string, string>): unknown };
    const { startHttpServer } = (await import(new URL("../vendor/pharos-mcp/src/http.js", import.meta.url).href)) as { startHttpServer(config: unknown): Promise<{ close(cb: () => void): void; closeAllConnections?: () => void }> };
    const server = await startHttpServer(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: String(port), PHAROS_RPC_URL: fake.url, PHAROS_CHAIN_ID: "1672" }));
    try {
      const mcp = await ChainMcp.connect({ kind: "hosted", url: `http://127.0.0.1:${port}/mcp` }, { timeoutMs: 10_000 });
      try {
        const result = await runGuardian(parseGuardianConfig(preset), { chain: new Chain(mcp, NETWORKS["pharos-mainnet"]), now: () => NOW });
        assert.equal(result.outcome, "fire");
        assert.equal(result.chainMcp.server, "pharos-mcp-server 0.1.0");
        assert.equal(result.chainMcp.where, `http://127.0.0.1:${port}/mcp`);
      } finally {
        await mcp.close();
      }
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fake.close();
    }
  });
});

describe("executing on Atlantic: the official server over stdio, broadcasting a transaction signed here", () => {
  // Well-known Hardhat/Anvil test keys (#1, and #5 below): public, only ever used here on a fake chain.
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const signer = signerFromEnv({ PRIVATE_KEY: KEY });
  const TUSDC = NETWORKS["atlantic-testnet"].tokens[0]!.address.toLowerCase();
  const atlanticConfig = (amount = "40") =>
    parseGuardianConfig({
      name: "Atlantic payout",
      network: "atlantic-testnet",
      fireWhen: "all",
      conditions: [
        { id: "usdc-live", label: "USDC is not paused", read: { kind: "call", to: TUSDC, signature: "paused() returns (bool)" }, op: "==", value: false },
        { id: "payer-funded", label: "The payer holds the payout", read: { kind: "erc20-balance", token: TUSDC, holder: signer.address }, op: ">=", value: amount },
      ],
      action: { type: "erc20-transfer", token: TUSDC, from: signer.address, to: RECIPIENT, amount },
    });
  const atlanticChain = async () => {
    const fake = await startFakeChain(defaultState({ chainId: 688689, native: { [signer.address.toLowerCase()]: 10n ** 18n }, tokens: { [TUSDC]: { decimals: 6, balances: { [signer.address.toLowerCase()]: 100_000_000n } } } }));
    const net: Network = { ...NETWORKS["atlantic-testnet"], rpcUrl: fake.url };
    const recorder = new Recorder();
    const mcp = await ChainMcp.connect({ kind: "local", network: net, broadcast: true }, { recorder, timeoutMs: 15_000 });
    return { fake, chain: new Chain(mcp, net), mcp, recorder };
  };

  test("the conditions are re-read at the newest block, then the transfer is signed here, broadcast through Chain MCP and confirmed", async () => {
    const { fake, chain, mcp, recorder } = await atlanticChain();
    try {
      const result = await runGuardian(atlanticConfig(), { chain, signer, now: () => NOW, wait: { pollMs: 10 } });
      assert.equal(result.outcome, "executed");
      assert.equal(result.execution?.status, "success");
      assert.equal(result.execution?.recheck.decision.fire, true);
      assert.equal(fake.state.tokens[TUSDC]!.balances[RECIPIENT], 40_000_000n);
      assert.equal(result.chainMcp.server, "pharos-mcp-server 0.1.0");
      const broadcast = calls(recorder.messages).find((c) => c.name === "send_raw_transaction");
      assert.ok(broadcast, "the transaction went through Chain MCP send_raw_transaction");
      // The key is never in the result or the transcript; the signed transaction is, and it recovers to the payer.
      const everything = JSON.stringify({ result, messages: recorder.messages });
      assert.ok(!everything.toLowerCase().includes(KEY.slice(2).toLowerCase()));
      assert.equal(privateKeyToAccount(KEY).address, signer.address);
    } finally {
      await mcp.close();
      await fake.close();
    }
  });

  test("conditions that stop holding between the decision and the send abort it: nothing is signed", async () => {
    const { fake, chain, mcp, recorder } = await atlanticChain();
    try {
      // The token is paused once the action has been simulated and estimated (the payer's balance is the
      // last read before execution), so only the re-check can see it.
      fake.onRequest = (method) => {
        if (method === "eth_getBalance") fake.state.tokens[TUSDC]!.paused = true;
      };
      const result = await runGuardian(atlanticConfig(), { chain, signer, now: () => NOW, wait: { pollMs: 10 } });
      assert.equal(result.outcome, "aborted");
      assert.equal(result.execution?.sent, false);
      assert.deepEqual(result.execution?.recheck.decision.failed, ["usdc-live"]);
      assert.ok(!calls(recorder.messages).some((c) => c.name === "send_raw_transaction"));
    } finally {
      await mcp.close();
      await fake.close();
    }
  });

  test("refuses to execute on mainnet, or with a key that is not the payer's", async () => {
    const fake = await payoutChain();
    try {
      const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
      try {
        await assert.rejects(runGuardian(parseGuardianConfig(preset), { chain: official.chain, signer, now: () => NOW }), /limited to the Atlantic testnet/);
      } finally {
        await official.close();
      }
    } finally {
      await fake.close();
    }
    const { fake: fake2, chain, mcp } = await atlanticChain();
    try {
      const other = signerFromEnv({ PRIVATE_KEY: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" });
      await assert.rejects(runGuardian(atlanticConfig(), { chain, signer: other, now: () => NOW }), /is not the action's payer/);
    } finally {
      await mcp.close();
      await fake2.close();
    }
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
