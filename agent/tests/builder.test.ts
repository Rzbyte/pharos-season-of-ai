// Task 29, Doc-Grounded Builder Agent: a how-to question answered by the Developer Docs MCP (a stand-in
// here, with made-up pages in the shape the live one answers), the action it asks for read from its
// words, its pieces set beside the Skill Engine's, then prepared through the official Chain MCP server on
// a fake chain (Task 08's dry run), with the Skill Engine's cast commands; on Atlantic, with a key, sent.
// Both transcripts replay as a proof.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getAddress, toFunctionSelector } from "viem";
import { EXAMPLE, parseAction } from "../src/builder/action.js";
import { chainIdsIn, groundFunction, groundNetwork, groundToken, rpcUrlsIn } from "../src/builder/ground.js";
import { howTo, type HowToResult } from "../src/builder/run.js";
import { skillFee } from "../src/builder/skill.js";
import { verifyHowToProof } from "../src/builder/verify.js";
import { Chain } from "../src/core/chain.js";
import { ChainMcp } from "../src/core/chain-mcp.js";
import { DOCS_MCP, DocsMcp } from "../src/core/docs-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS, type Network } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { startFakeDocs, type FakeDocs } from "./fake-docs.js";
import { connectOfficial } from "./official-server.js";

const net = NETWORKS["pharos-mainnet"];
const atlanticNet = NETWORKS["atlantic-testnet"];
const [WPROS, USDC] = [net.tokens[0]!.address, net.tokens[1]!.address];
const lower = (address: string) => address.toLowerCase();
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
const NOW = new Date("2026-10-17T12:00:00.000Z");

/** Made-up docs in the shape the Developer Docs MCP answers: a registry page with a table per network. */
const registry = (usdc = USDC) => `# Token Registry

## Pharos Mainnet

| Token | Address | Decimals |
| --- | --- | --- |
| WPROS | ${getAddress(WPROS)} | 18 |
| USDC | ${getAddress(usdc)} | 6 |

## Atlantic Testnet

| Token | Address |
| --- | --- |
| USDC | ${atlanticNet.tokens[0]!.address} |
`;
const cites = (title: string, url: string) => `\n\n# Sources\n\n- [${title}](${url})`;
const SEND = `How do I send 25 USDC to ${RECIPIENT}?`;
const ANSWERS: Record<string, string> = {
  [SEND]: `To send USDC, call \`transfer(address,uint256)\` on the USDC contract listed in the [Token Registry](${REGISTRY}). Pharos Mainnet's chain ID is 1672 and its RPC is https://rpc.pharos.xyz.${cites("Token Registry", REGISTRY)}`,
  [`How do I send 5000000 USDC to ${RECIPIENT}?`]: `Call \`transfer(address,uint256)\` on USDC ([Token Registry](${REGISTRY})).${cites("Token Registry", REGISTRY)}`,
  "How do I wrap 0.5 PROS into WPROS?": `Send PROS to the WPROS contract's \`deposit()\` function. WPROS is in the [Token Registry](${REGISTRY}).${cites("Token Registry", REGISTRY)}`,
  "What is my USDC balance?": `Call balanceOf on the USDC contract; its address is in the [Token Registry](${REGISTRY}).${cites("Token Registry", REGISTRY)}`,
  "How do I deploy a contract with Foundry?": `Use forge script with --broadcast.${cites("Foundry", "https://docs.pharos.xyz/developer-guide/foundry")}`,
  "How do I bridge PROS to Solana?": `I cannot find information about bridging to Solana in the Pharos Developer Docs.${cites("Bridge", "https://docs.pharos.xyz/getting-started/bridge")}`,
  [`How do I send 1.5 USDC to ${RECIPIENT}?`]: `Call \`transfer(address,uint256)\` on USDC. The Atlantic Testnet's chain ID is 688689, its RPC https://atlantic.dplabs-internal.com.${cites("Atlantic Testnet", "https://docs.pharos.xyz/getting-started/network/atlantic-testnet")}`,
};

let fake: FakeChain;
let docs: FakeDocs;
before(async () => {
  fake = await startFakeChain(
    defaultState({
      native: { [lower(EXAMPLE.account)]: 2n * 10n ** 18n },
      // The wrapped token's payable deposit() takes the value and returns nothing, as WETH-style tokens do.
      answers: { [lower(WPROS)]: { [toFunctionSelector("deposit()")]: "0x" } },
      tokens: {
        [lower(USDC)]: { decimals: 6, symbol: "USDC", name: "USD Coin", balances: { [lower(EXAMPLE.account)]: 1_000_000_000n } },
        [lower(WPROS)]: { decimals: 18, symbol: "WPROS", name: "Wrapped PROS", balances: {} },
      },
    }),
  );
  docs = await startFakeDocs((question) => ANSWERS[question] ?? `Use forge.${cites("Foundry", "https://docs.pharos.xyz/developer-guide/foundry")}`, { [REGISTRY]: registry(), "https://docs.pharos.xyz/developer-guide/foundry": "# Foundry\n\nforge build.\n" });
});
after(async () => {
  await fake.close();
  await docs.close();
});

async function ask(question: string, inputs = {}): Promise<{ result: HowToResult; proof: ProofFile; chainCalls: string[] }> {
  const official = await connectOfficial(fake, net, { budget: 40 });
  const client = new DocsMcp(docs.url, { budget: 4, timeoutMs: 5000 });
  try {
    const result = await howTo(question, { docs: client, chain: official.chain, inputs, now: () => NOW });
    const proof = JSON.parse(JSON.stringify({ ...proofFile({ task: "29", capability: "how-to", about: "test", mcp: official.mcp, network: net, startedAt: new Date(), input: { question, inputs }, result }), docsMcp: { endpoint: DOCS_MCP, transcript: client.recorder.messages } })) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    (proof.result as HowToResult).docsMcp.where = DOCS_MCP;
    const chainCalls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string } }).params.name);
    return { result, proof, chainCalls };
  } finally {
    await official.close();
  }
}

describe("reading the action from the question", () => {
  const read = (question: string, inputs = {}, network: Network = net) => parseAction(question, inputs, network);

  test("a send, an approval, a wrap and a balance, each with what the question names, the example's for the rest", () => {
    const send = read(SEND).action!;
    assert.deepEqual([send.kind, send.token?.symbol, send.amount, send.counterparty, send.account], ["erc20-transfer", "USDC", { value: "25", from: "question" }, { value: RECIPIENT, from: "question" }, { value: EXAMPLE.account, from: "example" }]);
    const native = read("How do I send PROS?").action!;
    assert.deepEqual([native.kind, native.token, native.amount, native.counterparty], ["native-transfer", null, { value: "0.01", from: "example" }, { value: EXAMPLE.counterparty, from: "example" }]);
    const approve = read(`How do I approve ${OTHER} to spend unlimited USDC?`).action!;
    assert.deepEqual([approve.kind, approve.token?.symbol, approve.amount, approve.counterparty?.value], ["erc20-approve", "USDC", { value: "max", from: "question" }, OTHER]);
    const wrap = read("How do I wrap 0.5 PROS into WPROS?").action!;
    assert.deepEqual([wrap.kind, wrap.token?.symbol, wrap.amount, wrap.counterparty], ["wrap", "WPROS", { value: "0.5", from: "question" }, null]);
    const balance = read(`What is the USDC balance of ${OTHER}?`).action!;
    assert.deepEqual([balance.kind, balance.token?.symbol, balance.account, balance.amount], ["balance", "USDC", { value: OTHER, from: "question" }, null]);
    assert.deepEqual(read("How do I send USDC on chain 1672?").action!.amount, { value: "25", from: "example" }, "a chain ID is no amount");
    assert.deepEqual([read(`How much USDC does ${OTHER} hold?`).action!.kind, read("How much gas does a USDC transfer cost?").action!.kind], ["balance", "erc20-transfer"], "how much a wallet holds, or what a transfer costs");
  });

  test("the inputs over the question; a bad input refused; nothing to prepare said why", () => {
    const given = read(SEND, { from: OTHER, amount: "3.5" }).action!;
    assert.deepEqual([given.account, given.amount], [{ value: OTHER, from: "input" }, { value: "3.5", from: "input" }]);
    assert.throws(() => read(SEND, { from: "0x12" }), (e: unknown) => e instanceof AgentError && e.kind === "usage" && /from must be a 0x address/.test(e.message));
    assert.throws(() => read(SEND, { token: "PEPE" }), /token must be PROS or an official Pharos Mainnet token: WPROS, USDC, LINK, WETH/);
    assert.throws(() => read("How do I send 1.1234567 USDC?"), /amount/);
    assert.equal(read("How do I deploy a contract with Foundry?").reason, "The question asks for nothing this agent prepares: sending, approving, wrapping, or a balance.");
    assert.equal(read("How do I send 25 PEPE?").reason, "PEPE is not PROS or an official Pharos Mainnet token (WPROS, USDC, LINK, WETH), so nothing is prepared.");
    assert.equal(read("How do I approve PROS?").reason, "Only a token can be approved, not PROS.");
    assert.throws(() => read("How do I send 1 USDC?", {}, atlanticNet), /Name the sender: in the question, or as an input \(on Atlantic there is no example to fall back on\)/);
  });
});

describe("the docs beside the Skill Engine", () => {
  test("chain IDs and RPC URLs found; the network, a token's address and a function compared", () => {
    assert.deepEqual(chainIdsIn("Atlantic Testnet’s chain ID is **688689**. | Chain ID | 1672 |"), [688689, 1672]);
    assert.deepEqual(rpcUrlsIn("Use `https://atlantic.dplabs-internal.com` or https://rpc.pharos.xyz/. See https://docs.pharos.xyz/x."), ["https://atlantic.dplabs-internal.com", "https://rpc.pharos.xyz"]);
    const said = [{ where: "the answer", text: "The chain ID is 1672; RPC https://rpc.pharos.xyz." }];
    assert.deepEqual(groundNetwork(net, said).map((g) => [g.id, g.agrees]), [["chain-id", true], ["rpc", true]]);
    assert.deepEqual(groundNetwork(net, [{ where: "the answer", text: "Its chain ID is 50002." }]).map((g) => [g.id, g.docs, g.agrees]), [["chain-id", "50002", false], ["rpc", null, null]]);
    assert.deepEqual(groundNetwork(net, [{ where: "the answer", text: "Atlantic's chain ID is 688689." }])[0]!.agrees, null, "another Pharos network's ID is no contradiction");
    const usdc = net.tokens[1]!;
    assert.deepEqual([groundToken(net, usdc, [{ where: REGISTRY, text: registry() }]).agrees, groundToken(net, usdc, [{ where: REGISTRY, text: registry(OTHER) }]).docs, groundToken(net, usdc, [{ where: "the answer", text: "No addresses." }]).agrees], [true, OTHER, null]);
    assert.deepEqual([groundFunction("transfer(address,uint256)", "the ERC-20 standard", said).agrees, groundFunction("transfer(address,uint256)", "x", [{ where: "the answer", text: "Call `transfer` on it." }]).agrees], [null, true]);
    assert.deepEqual(skillFee(51_234n, 1_200_000_000n, net), { gas: "51234", gasLimit: "61481", gasPrice: "1200000000", cost: "73777200000000", costShown: "0.00007377 PROS" });
  });
});

describe("the docs, then the action prepared", () => {
  test("a USDC transfer: the docs' answer and registry page beside the Skill Engine, dry-run, its cast commands; the proof verifies", async () => {
    const { result, proof, chainCalls } = await ask(SEND);
    assert.deepEqual([result.verdict, result.docs.pages, result.action?.summary], ["ready", [REGISTRY], `Send 25 USDC from 0x912c…f647 to 0x1111…1111`]);
    assert.deepEqual(result.grounding.map((g) => [g.id, g.uses, g.docsWhere, g.agrees]), [["chain-id", "1672", "the answer", true], ["rpc", "https://rpc.pharos.xyz", "the answer", true], ["token", getAddress(USDC), REGISTRY, true], ["function", "transfer(address,uint256)", "the answer", true]]);
    assert.equal(result.prepared?.verdict, "would-succeed");
    assert.deepEqual(result.skillEngine?.commands.map((c) => [c.label, c.command, c.reference]), [
      ["Estimate its gas", `cast estimate ${getAddress(USDC)} "transfer(address,uint256)" ${RECIPIENT} 25000000 --from ${EXAMPLE.account} --rpc-url https://rpc.pharos.xyz`, "references/transaction.md#estimate-gas-consumption"],
      ["Send it", `cast send ${getAddress(USDC)} "transfer(address,uint256)" ${RECIPIENT} 25000000 --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`, "references/transaction.md#contract-write-call"],
      ["The gas price", "cast gas-price --rpc-url https://rpc.pharos.xyz", "references/transaction.md#query-gas-price"],
    ]);
    assert.deepEqual([result.skillEngine?.network.name, result.skillEngine?.fee?.gasLimit], ["mainnet", "61481"]);
    assert.match(result.headline, /^Send 25 USDC from 0x912c…f647 to 0x1111…1111: ready\. The dry run at block 5,000,000 succeeds, for about [\d.]+ PROS in gas\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.deepEqual(result.steps.map((s) => s.source), ["Developer Docs MCP · askQuestion", "the question", "Developer Docs MCP · getPage /getting-started/token-registry", "Skill Engine networks.json · the docs' answer", "Skill Engine networks.json · the docs' answer", "Skill Engine tokens.json · docs page /getting-started/token-registry", "the ERC-20 standard · the docs' answer", "Chain MCP · eth_call · estimate_gas", "Skill Engine · references/transaction.md", "the verdict"]);
    assert.equal(result.steps[1]!.text, "It asks to send 25 USDC from 0x912c…f647 to 0x1111…1111 on Pharos Mainnet. The recipient and the amount are the question's; the sender is the example's.");
    assert.ok(!chainCalls.includes("send_raw_transaction"));
    assert.deepEqual((await verifyHowToProof(proof)).filter((c) => !c.ok), []);
  });

  test("a wrap, through the wrapped token's deposit(); a balance, read and not sent", async () => {
    const wrap = (await ask("How do I wrap 0.5 PROS into WPROS?")).result;
    assert.deepEqual([wrap.verdict, wrap.prepared?.tx.to, wrap.prepared?.tx.value, wrap.prepared?.tx.data], ["ready", getAddress(WPROS), "500000000000000000", toFunctionSelector("deposit()")]);
    assert.equal(wrap.skillEngine?.commands[1]!.command, `cast send ${getAddress(WPROS)} "deposit()" --value 0.5ether --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`);
    assert.deepEqual(wrap.grounding.find((g) => g.id === "function"), { id: "function", label: "Function", uses: "deposit()", usesFrom: "the Skill Engine's call with value", docs: "deposit(…)", docsWhere: "the answer", agrees: true });
    const balance = (await ask("What is my USDC balance?")).result;
    assert.deepEqual([balance.verdict, balance.read?.shown, balance.prepared, balance.headline], ["read", "1,000 USDC", null, "0x912c…f647 holds 1,000 USDC on Pharos Mainnet at block 5,000,000."]);
    assert.equal(balance.skillEngine?.commands.map((c) => c.command).join("\n"), `cast call ${getAddress(USDC)} "balanceOf(address)(uint256)" ${EXAMPLE.account} --rpc-url https://rpc.pharos.xyz`);
  });

  test("the docs and the Skill Engine disagree; a transfer that would fail; a question it prepares nothing for; one the docs do not cover", async () => {
    docs.pages[REGISTRY] = registry(OTHER);
    try {
      const differ = (await ask(SEND)).result;
      assert.deepEqual([differ.verdict, differ.grounding.find((g) => g.id === "token")?.docs], ["ready", OTHER], "the Skill Engine's address is the one prepared");
      assert.match(differ.headline, / The docs give another USDC address than the Skill Engine: check before sending\.$/);
    } finally {
      docs.pages[REGISTRY] = registry();
    }
    const big = (await ask(`How do I send 5000000 USDC to ${RECIPIENT}?`)).result;
    assert.equal(big.verdict, "would-fail");
    assert.match(big.headline, /^Send 5000000 USDC from 0x912c…f647 to 0x1111…1111 would not go through: it reverts: .+ Nothing was sent: the hosted Chain MCP is read-only\.$/);
    const deploy = (await ask("How do I deploy a contract with Foundry?")).result;
    assert.deepEqual([deploy.verdict, deploy.action, deploy.headline], ["not-prepared", null, "The docs answered. The question asks for nothing this agent prepares: sending, approving, wrapping, or a balance."]);
    const before = docs.requests.length;
    const { result: uncovered, chainCalls } = await ask("How do I bridge PROS to Solana?");
    assert.deepEqual([uncovered.verdict, uncovered.docs.status, docs.requests.length - before, chainCalls], ["no-answer", "no_answer", 1, ["get_chain_info", "get_block_number", "get_block"]]);
  });

  test("a bad input is refused before any call; a changed docs answer fails the proof", async () => {
    const before = [docs.requests.length, fake.requests.length];
    const official = await connectOfficial(fake, net);
    try {
      await assert.rejects(howTo(SEND, { docs: new DocsMcp(docs.url), chain: official.chain, inputs: { amount: "-1" } }), /amount/);
    } finally {
      await official.close();
    }
    assert.deepEqual([docs.requests.length, fake.requests.length], before, "nothing asked of the docs or the chain");
    const { proof } = await ask(SEND);
    const forged = JSON.parse(JSON.stringify(proof)) as ProofFile;
    const reply = forged.docsMcp!.transcript.find((m) => m.direction === "server->client" && JSON.stringify(m.message).includes("chain ID is 1672"))!;
    const content = (reply.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
    content.text = content.text.replace("chain ID is 1672", "chain ID is 50002");
    assert.deepEqual((await verifyHowToProof(forged)).filter((c) => !c.ok).map((c) => c.name), ["answer recomputed from the recorded responses"]);
  });
});

describe("performing it on Atlantic", () => {
  // The well-known Hardhat/Anvil test key #1: public, only ever used here on a fake chain.
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
  const TUSDC = atlanticNet.tokens[0]!.address;

  test("with a key, the prepared transfer is signed here and sent through Chain MCP, the receipt checked; the proof verifies", async () => {
    const chainFake = await startFakeChain(defaultState({ chainId: 688689, native: { [lower(signer.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: { decimals: 6, symbol: "USDC", balances: { [lower(signer.address)]: 5_000_000n } } } }));
    const local: Network = { ...atlanticNet, rpcUrl: chainFake.url };
    const mcp = await ChainMcp.connect({ kind: "local", network: local, broadcast: true }, { timeoutMs: 15_000 });
    const client = new DocsMcp(docs.url, { budget: 4, timeoutMs: 5000 });
    const question = `How do I send 1.5 USDC to ${RECIPIENT}?`;
    const inputs = { from: signer.address };
    let proof: ProofFile;
    try {
      // The server reads the fake chain; the agent's network is the Skill Engine's, whose RPC the commands name.
      const result = await howTo(question, { docs: client, chain: new Chain(mcp, atlanticNet), inputs, signer, wait: { pollMs: 10 }, now: () => NOW });
      assert.deepEqual([result.verdict, result.prepared?.submission?.status, result.prepared?.submission?.matched], ["sent", "success", true]);
      assert.deepEqual(result.grounding.slice(0, 2).map((g) => [g.uses, g.agrees]), [["688689", true], ["https://atlantic.dplabs-internal.com", true]]);
      assert.equal(chainFake.state.tokens[lower(TUSDC)]!.balances[lower(RECIPIENT)], 1_500_000n);
      assert.match(result.headline, /^Send 1\.5 USDC from 0x7099…79C8 to 0x1111…1111: sent, 0x[0-9a-f]{8}…, success\./);
      proof = JSON.parse(JSON.stringify({ ...proofFile({ task: "29", capability: "how-to", about: "test", mcp, network: atlanticNet, startedAt: new Date(), input: { question, inputs }, result }), docsMcp: { endpoint: DOCS_MCP, transcript: client.recorder.messages } })) as ProofFile;
      (proof.result as HowToResult).docsMcp.where = DOCS_MCP;
    } finally {
      await mcp.close();
      await chainFake.close();
    }
    const checks = await verifyHowToProof(proof);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.match(checks.find((c) => c.name === "signed transaction")!.detail, /^chain 688689, signed by 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, exactly the prepared dry-run transaction$/);
  });

  test("sending is refused on mainnet", async () => {
    const official = await connectOfficial(fake, net);
    try {
      await assert.rejects(howTo(SEND, { docs: new DocsMcp(docs.url), chain: official.chain, inputs: { from: signer.address }, signer }), /limited to the Atlantic testnet/);
    } finally {
      await official.close();
    }
  });
});
