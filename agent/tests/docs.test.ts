// Task 13, Docs MCP + Chain MCP Agent: a question answered by the Developer Docs MCP (a stand-in here, with
// made-up docs pages in the shape the live one answers), the contract addresses and functions it gives
// read through the official Chain MCP server on a fake chain, and the verdict: confirmed, a mismatch, no
// contract, another network, nothing to call, or a question the docs do not cover. Both transcripts
// replay as a proof. The Docs MCP client itself: event streams, JSON, errors and its budget.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { encodeAbiParameters, getAddress, toFunctionSelector } from "viem";
import { DOCS_MCP, DocsMcp } from "../src/core/docs-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { addressesIn, functionsIn, notCovered, splitAnswer } from "../src/docs/answer.js";
import { docsThenChain, parseQuestion, type DocsChainResult } from "../src/docs/run.js";
import { verifyDocsChainProof } from "../src/docs/verify.js";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { startFakeDocs, type FakeDocs } from "./fake-docs.js";
import { connectOfficial } from "./official-server.js";

const net = NETWORKS["pharos-mainnet"];
const [WPROS, USDC] = [net.tokens[0]!.address.toLowerCase(), net.tokens[1]!.address.toLowerCase()];
const ATLANTIC_USDC = "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8";
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
const CANONICAL = "https://docs.pharos.xyz/getting-started/canonical-contracts";
const NOW = new Date("2026-10-17T12:00:00.000Z");

/** Made-up docs, in the shape the Developer Docs MCP answers: a registry page with a table per network. */
const registry = ({ label = "USDC", at = USDC } = {}) => `# Token Registry

Tokens on Pharos.

## Pharos Mainnet

| Token | Address | Decimals |
| --- | --- | --- |
| WPROS | ${getAddress(WPROS)} | 18 |
| ${label} | ${getAddress(at)} | 6 |

## Atlantic Testnet

| Token | Address |
| --- | --- |
| USDC | ${ATLANTIC_USDC} |
`;
const sources = (...pages: [string, string][]) => `\n\n# Sources\n\n${pages.map(([title, url]) => `- [${title}](${url})`).join("\n")}`;
const ANSWERS: Record<string, string> = {
  "What is the USDC token address on Pharos Mainnet?": `The USDC token on Pharos Mainnet is listed in the [Token Registry](${REGISTRY}), with its address and decimals.${sources(["Token Registry", REGISTRY], ["Canonical Contracts", CANONICAL])}`,
  "What is the USDT token address on Pharos Mainnet?": `USDT is listed in the [Token Registry](${REGISTRY}).${sources(["Token Registry", REGISTRY])}`,
  "What is the USDC address on Atlantic Testnet?": `The [Token Registry](${REGISTRY}) lists USDC for each network.${sources(["Token Registry", REGISTRY])}`,
  "What does getBlockNumber() return on Multicall3?": `Multicall3 is deployed at \`${MULTICALL}\` on every Pharos network.\n\n\`function getBlockNumber() external view returns (uint256 blockNumber)\` returns the current block number.${sources(["Canonical Contracts", CANONICAL])}`,
  "Which address is USDC on Pharos Mainnet?": `USDC is at 0x1111111111111111111111111111111111111111 on Pharos Mainnet, per the [Token Registry](${REGISTRY}).${sources(["Token Registry", REGISTRY])}`,
  "Where is the Pharos bridge contract?": `See the [Bridge](https://docs.pharos.xyz/getting-started/bridge) page.${sources(["Bridge", "https://docs.pharos.xyz/getting-started/bridge"])}`,
  "Where is the Pharos faucet contract?": `The faucet contract is at 0x000000000000000000000000000000000000dEaD on Pharos Mainnet.${sources(["Faucet", "https://docs.pharos.xyz/getting-started/faucet"])}`,
  "How do I deploy a contract with Foundry?": `Use forge script with --broadcast.${sources(["Foundry", "https://docs.pharos.xyz/developer-guide/foundry"])}`,
  "How do I deploy an Anchor program to Solana?": `I cannot find information about deploying Anchor programs to Solana in the Pharos Developer Docs.${sources(["Rust", "https://docs.pharos.xyz/developer-guide/rust"])}`,
};

let fake: FakeChain;
let docs: FakeDocs;
before(async () => {
  fake = await startFakeChain(
    defaultState({
      code: { [MULTICALL.toLowerCase()]: "0x6080604052" },
      answers: { [MULTICALL.toLowerCase()]: { [toFunctionSelector("getBlockNumber()")]: encodeAbiParameters([{ type: "uint256" }], [5_000_000n]) } },
      tokens: {
        [USDC]: { decimals: 6, symbol: "USDC", name: "USD Coin", balances: { "0x912c9ade24d44d8922f0866d8dcb079f1363f647": 6_300_000_000n } },
        [WPROS]: { decimals: 18, symbol: "WPROS", name: "Wrapped PROS", balances: {} },
      },
    }),
  );
  docs = await startFakeDocs((question) => ANSWERS[question] ?? `Use forge.${sources(["Foundry", "https://docs.pharos.xyz/developer-guide/foundry"])}`, { [REGISTRY]: registry(), [CANONICAL]: `# Canonical Contracts\n\n| Contract | Address |\n| --- | --- |\n| Multicall3 | ${MULTICALL} |\n`, "https://docs.pharos.xyz/developer-guide/foundry": "# Foundry\n\nInstall Foundry, then forge build.\n", "https://docs.pharos.xyz/getting-started/faucet": "# Faucet\n\nClaim testnet tokens from the faucet.\n" });
});
after(async () => {
  await fake.close();
  await docs.close();
});

async function ask(question: string): Promise<{ result: DocsChainResult; proof: ProofFile; chainCalls: string[] }> {
  const official = await connectOfficial(fake, net, { budget: 40 });
  const client = new DocsMcp(docs.url, { budget: 4, timeoutMs: 5000 });
  try {
    const result = await docsThenChain(question, { docs: client, chain: official.chain, now: () => NOW });
    const proof = JSON.parse(JSON.stringify({ ...proofFile({ task: "13", capability: "docs-chain", about: "test", mcp: official.mcp, network: net, startedAt: new Date(), input: { question }, result }), docsMcp: { endpoint: DOCS_MCP, transcript: client.recorder.messages } })) as ProofFile;
    proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
    // The replay checks the docs answers against the endpoint the result names: here, the official one.
    (proof.result as DocsChainResult).docsMcp.where = DOCS_MCP;
    const chainCalls = official.recorder.messages.filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call").map((m) => (m.message as unknown as { params: { name: string } }).params.name);
    return { result, proof, chainCalls };
  } finally {
    await official.close();
  }
}

describe("reading the docs", () => {
  test("an answer split from its sources; the docs saying they do not cover a question; addresses and functions found", () => {
    const { body, sources: cited } = splitAnswer(ANSWERS["What is the USDC token address on Pharos Mainnet?"]!);
    assert.equal(body, `The USDC token on Pharos Mainnet is listed in the [Token Registry](${REGISTRY}), with its address and decimals.`);
    assert.deepEqual(cited, [{ title: "Token Registry", url: REGISTRY }, { title: "Canonical Contracts", url: CANONICAL }]);
    assert.equal(notCovered(splitAnswer(ANSWERS["How do I deploy an Anchor program to Solana?"]!).body), true);
    assert.equal(notCovered("No. Pharos does not support Solana programs."), false, "a factual negative stays an answer");
    assert.deepEqual(addressesIn(registry(), REGISTRY).map((a) => [a.label, a.network]), [["WPROS · 18", "pharos-mainnet"], ["USDC · 6", "pharos-mainnet"], ["USDC", "atlantic-testnet"]]);
    assert.deepEqual(addressesIn(`Multicall3 is deployed at \`${MULTICALL}\` on every Pharos network.`, "the answer").map((a) => [a.address, a.label, a.network]), [[MULTICALL, "Multicall3 is deployed at … on every Pharos network", null]]);
    assert.deepEqual(functionsIn("`function getBlockNumber() external view returns (uint256 blockNumber)` returns the current block number.\nAlso: decimals() → uint8", "x").map((f) => [f.name, f.returns]), [["getBlockNumber", "uint256"], ["decimals", "uint8"]]);
    assert.throws(() => parseQuestion("  "), /Ask a question about a Pharos contract/);
    assert.throws(() => parseQuestion("x".repeat(301)), /at most 300 characters/);
  });
});

describe("the docs, then the chain", () => {
  test("a token the docs list on a page: its row found, then the chain agrees; every step with its source; the proof verifies", async () => {
    const { result, proof, chainCalls } = await ask("What is the USDC token address on Pharos Mainnet?");
    assert.deepEqual([result.docs.status, result.docs.pages, result.verdict], ["answered", [REGISTRY], "confirmed"]);
    assert.deepEqual(result.readings.map((r) => [r.address, r.label, r.network, r.code, r.token?.symbol, r.agrees, r.skillEngine, r.skillEngineAgrees]), [[getAddress(USDC), "USDC · 6", "pharos-mainnet", "contract", "USDC", true, "USDC", true]]);
    assert.equal(result.headline, 'The docs give 0xC879…1815 as "USDC · 6", and Pharos Mainnet agrees: a contract whose symbol() is USDC, with 6 decimals and 6,300 USDC in supply.');
    assert.deepEqual(result.steps.map((s) => s.source), ["Developer Docs MCP · askQuestion", "Developer Docs MCP · getPage /getting-started/token-registry", "docs page /getting-started/token-registry", "Chain MCP · get_code", "Chain MCP · eth_call", "Chain MCP · eth_call", "Chain MCP · eth_call", "Chain MCP · eth_call", "the verdict"]);
    assert.deepEqual(docs.requests.slice(-2).map((r) => r.name), ["askQuestion", "getPage"]);
    assert.deepEqual(chainCalls, ["get_chain_info", "get_block_number", "get_block", "get_code", "eth_call", "eth_call", "eth_call", "eth_call"]);
    assert.deepEqual((await verifyDocsChainProof(proof)).filter((c) => !c.ok), []);
  });

  test("an address and a function in the answer: the address found on the page it cites, the function the docs describe, called", async () => {
    const { result } = await ask("What does getBlockNumber() return on Multicall3?");
    assert.deepEqual([result.verdict, result.docs.pages, result.functions.map((f) => `${f.name}() ${f.returns}`)], ["confirmed", [CANONICAL], ["getBlockNumber() uint256"]]);
    assert.deepEqual(result.readings.map((r) => [r.address, r.label, r.where, r.onPage]), [[MULTICALL, "Multicall3", CANONICAL, CANONICAL]]);
    assert.deepEqual(result.readings[0]!.calls.map((c) => [c.name, c.from, c.ok, c.value]), [["getBlockNumber", "docs", true, "5000000"], ["symbol", "erc20", false, null]]);
    assert.equal(result.headline, 'The docs give 0xcA11…CA11 as "Multicall3", and on Pharos Mainnet it is a contract: getBlockNumber() returns 5000000.');
  });

  test("the answer is synthesized: an address it alone gives is not called where the page it cites gives another", async () => {
    const { result } = await ask("Which address is USDC on Pharos Mainnet?");
    assert.deepEqual([result.verdict, result.readings.map((r) => [r.address, r.label])], ["confirmed", [[getAddress(USDC), "USDC · 6"]]]);
    assert.equal(result.steps.find((s) => s.text.startsWith("The docs' answer also gives"))?.text, 'The docs\' answer also gives 0x1111111111111111111111111111111111111111 ("USDC is at … on Pharos Mainnet, per the Token Registry"), but none of the pages read has it, so it is not called.');
    const unread = (await ask("Where is the Pharos bridge contract?")).result;
    assert.deepEqual([unread.verdict, unread.docs.pages, unread.steps[1]], ["nothing-to-call", [], { source: "Developer Docs MCP · getPage /getting-started/bridge", text: 'Could not read "Bridge": The Developer Docs MCP could not answer getPage: No page at https://docs.pharos.xyz/getting-started/bridge.' }]);
  });

  test("the chain contradicts the docs, or the Skill Engine; no contract where the docs say; another network; nothing to call; not covered", async () => {
    // A docs error: USDC listed at WPROS's address. The same address under two names is kept twice.
    docs.pages[REGISTRY] = registry({ at: WPROS });
    try {
      const mismatch = (await ask("What is the USDC token address on Pharos Mainnet?")).result;
      assert.deepEqual([mismatch.verdict, mismatch.readings.map((r) => [r.address, r.agrees, r.skillEngineAgrees])], ["mismatch", [[getAddress(WPROS), false, true]]]);
      assert.equal(mismatch.headline, 'The docs give 0x52C4…F0B0 as "USDC · 6", but on Pharos Mainnet it calls itself WPROS, and the Skill Engine lists it as WPROS too.');
    } finally {
      docs.pages[REGISTRY] = registry();
    }
    // The docs and the chain agree on a name the Skill Engine's token list does not give that address.
    docs.pages[REGISTRY] = registry({ label: "USDT" });
    fake.state.tokens[USDC]!.symbol = "USDT";
    try {
      const listed = (await ask("What is the USDT token address on Pharos Mainnet?")).result;
      assert.deepEqual([listed.verdict, listed.readings.map((r) => [r.agrees, r.skillEngine, r.skillEngineAgrees])], ["mismatch", [[true, "USDC", false]]]);
      assert.equal(listed.headline, 'The docs give 0xC879…1815 as "USDT · 6" and on Pharos Mainnet it calls itself USDT, but the Skill Engine lists it as USDC.');
    } finally {
      docs.pages[REGISTRY] = registry();
      fake.state.tokens[USDC]!.symbol = "USDC";
    }
    const none = (await ask("Where is the Pharos faucet contract?")).result;
    assert.deepEqual([none.verdict, none.readings[0]!.onPage, none.headline], ["no-contract", null, 'The docs\' answer gives 0x0000…dEaD as "The faucet contract is at … on Pharos Mainnet" (on none of the pages it cites), but there is no contract at that address on Pharos Mainnet.']);
    const atlantic = (await ask("What is the USDC address on Atlantic Testnet?")).result;
    assert.deepEqual([atlantic.verdict, atlantic.readings.map((r) => [r.address, r.read])], ["other-network", [[ATLANTIC_USDC, false]]]);
    assert.equal(atlantic.headline, 'The docs place 0xE0BE…4ec8 ("USDC") on Atlantic Testnet; this run reads Pharos Mainnet.');
    const nothing = (await ask("How do I deploy a contract with Foundry?")).result;
    assert.deepEqual([nothing.verdict, nothing.docs.pages, nothing.headline], ["nothing-to-call", ["https://docs.pharos.xyz/developer-guide/foundry"], "The docs answered, but gave no contract address to call."]);
    const before = docs.requests.length;
    const { result: uncovered, chainCalls } = await ask("How do I deploy an Anchor program to Solana?");
    assert.deepEqual([uncovered.verdict, uncovered.docs.status, uncovered.docs.answer, docs.requests.length - before, chainCalls], ["no-answer", "no_answer", null, 1, ["get_chain_info", "get_block_number", "get_block"]]);
  });

  test("a changed docs answer, or an endpoint that is not the official one, fails the proof", async () => {
    const { proof } = await ask("What is the USDC token address on Pharos Mainnet?");
    const forged = JSON.parse(JSON.stringify(proof)) as ProofFile;
    const page = forged.docsMcp!.transcript.find((m) => m.direction === "server->client" && JSON.stringify(m.message).includes("Token Registry\\n"))!;
    const content = (page.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
    content.text = content.text.replace(`| USDC | ${getAddress(USDC)} | 6 |`, `| USDC | ${getAddress(WPROS)} | 6 |`);
    assert.deepEqual((await verifyDocsChainProof(forged)).filter((c) => !c.ok).map((c) => c.name), ["answer recomputed from the recorded responses"]);
    const elsewhere = JSON.parse(JSON.stringify(proof)) as ProofFile;
    elsewhere.docsMcp!.endpoint = "https://docs.example.com/mcp";
    assert.deepEqual((await verifyDocsChainProof(elsewhere)).filter((c) => !c.ok).map((c) => c.name), ["Developer Docs MCP", "answer recomputed from the recorded responses"]);
  });
});

describe("the Developer Docs MCP client", () => {
  test("an event stream or plain JSON; a tool error, an HTTP error and the budget each said plainly", async () => {
    const client = new DocsMcp(docs.url, { budget: 3, timeoutMs: 5000 });
    assert.match(await client.call("getPage", { url: REGISTRY }), /^# Token Registry/);
    docs.json = true;
    try {
      assert.match(await client.call("getPage", { url: REGISTRY }), /^# Token Registry/);
    } finally {
      docs.json = false;
    }
    await assert.rejects(client.call("getPage", { url: "https://docs.pharos.xyz/nowhere" }), (e: unknown) => e instanceof AgentError && e.kind === "mcp_tool" && /could not answer getPage: No page at/.test(e.message));
    await assert.rejects(client.call("getPage", { url: REGISTRY }), (e: unknown) => e instanceof AgentError && e.kind === "budget");
    docs.status = 503;
    try {
      await assert.rejects(new DocsMcp(docs.url).call("askQuestion", { question: "x", goal: "y" }), (e: unknown) => e instanceof AgentError && e.kind === "mcp_connection" && /answered HTTP 503/.test(e.message));
    } finally {
      docs.status = undefined;
    }
    assert.deepEqual(client.recorder.messages.map((m) => m.direction), ["client->server", "server->client", "client->server", "server->client", "client->server", "server->client"]);
  });
});
