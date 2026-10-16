// Proofs: a run's proof verifies by replay, and every kind of tampering is caught. Also the vendored
// official server: byte-identical to its upstream commit.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Chain } from "../src/core/chain.js";
import { ChainMcp, Recorder } from "../src/core/chain-mcp.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS, type Network } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { parseGuardianConfig } from "../src/guardian/config.js";
import { payoutGuardian } from "../src/guardian/presets.js";
import { runGuardian } from "../src/guardian/run.js";
import { verifyGuardianProof } from "../src/guardian/verify.js";
import { defaultState, startFakeChain } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const PAYER = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";
const presetJson = payoutGuardian() as unknown;
const NOW = new Date(Number(1_790_000_000n + 3n) * 1000);

/** A mainnet proof as the CLI writes it for the hosted endpoint (the run itself is in-process). */
async function mainnetProof(usdc = 1_000_000_000n): Promise<ProofFile> {
  const fake = await startFakeChain(defaultState({ native: { [PAYER]: 10n ** 18n }, tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: usdc } } } }));
  const official = await connectOfficial(fake, NETWORKS["pharos-mainnet"]);
  try {
    const result = await runGuardian(parseGuardianConfig(presetJson), { chain: official.chain, now: () => NOW });
    const proof = proofFile({ task: "05", capability: "threshold-guardian", about: "test", mcp: official.mcp, network: NETWORKS["pharos-mainnet"], startedAt: NOW, input: presetJson, result });
    return JSON.parse(JSON.stringify({ ...proof, chainMcp: { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP } })) as ProofFile;
  } finally {
    await official.close();
    await fake.close();
  }
}

const failing = async (proof: ProofFile) => (await verifyGuardianProof(proof)).filter((c) => !c.ok).map((c) => c.name);

/** The recorded response (as JSON text inside the tool result) of the n-th tools/call matching `match`. */
function editResponse(proof: ProofFile, match: (params: { name: string; arguments: Record<string, unknown> }) => boolean, edit: (payload: Record<string, unknown>) => void) {
  const request = proof.transcript.find((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call" && match((m.message as unknown as { params: { name: string; arguments: Record<string, unknown> } }).params));
  assert.ok(request, "request to tamper with");
  const id = (request.message as { id: number }).id;
  const response = proof.transcript.find((m) => m.direction === "server->client" && "id" in m.message && m.message.id === id)!;
  const content = (response.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
  const payload = JSON.parse(content.text) as Record<string, unknown>;
  edit(payload);
  content.text = JSON.stringify(payload);
}

describe("guardian proofs", () => {
  test("a fire run verifies: official server, hosted endpoint, chain first, one block, result recomputed by replay", async () => {
    const proof = await mainnetProof();
    const checks = await verifyGuardianProof(proof);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.deepEqual(checks.map((c) => c.name), ["proof format", "network", "official Chain MCP server", "hosted endpoint", "every request answered", "chain checked first", "no key material", "guardian input", "one pinned block", "result recomputed from the recorded responses"]);
    assert.match(checks.at(-1)!.detail, /^\d+ calls replayed; decision, values and action identical$/);
  });

  test("a hold run verifies too", async () => {
    const proof = await mainnetProof(1_000_000n);
    assert.equal((proof.result as { outcome: string }).outcome, "hold");
    assert.deepEqual(await failing(proof), []);
  });

  test("tampering is caught: a changed answer, a changed decision, an unpinned read, another server, a lost response", async () => {
    const answer = await mainnetProof();
    editResponse(answer, (p) => p.name === "get_balance", (payload) => (payload.balanceWei = "0"));
    assert.deepEqual(await failing(answer), ["result recomputed from the recorded responses"]);

    const decision = await mainnetProof();
    (decision.result as { decision: { fire: boolean } }).decision.fire = false;
    assert.deepEqual(await failing(decision), ["result recomputed from the recorded responses"]);

    const unpinned = await mainnetProof();
    const request = unpinned.transcript.find((m) => "method" in m.message && m.message.method === "tools/call" && (m.message as unknown as { params: { name: string } }).params.name === "get_code")!;
    (request.message as unknown as { params: { arguments: { block: string } } }).params.arguments.block = "latest";
    assert.deepEqual(await failing(unpinned), ["one pinned block", "result recomputed from the recorded responses"]);

    const server = await mainnetProof();
    const init = server.transcript.find((m) => "result" in m.message && (m.message as { result?: { serverInfo?: unknown } }).result?.serverInfo)!;
    (init.message as unknown as { result: { serverInfo: { name: string } } }).result.serverInfo.name = "some-other-server";
    assert.deepEqual(await failing(server), ["official Chain MCP server"]);

    const lost = await mainnetProof();
    lost.transcript = lost.transcript.filter((m) => !(m.direction === "server->client" && "id" in m.message && m.message.id === 5));
    assert.ok((await failing(lost)).includes("every request answered"));

    const endpoint = await mainnetProof();
    endpoint.chainMcp.endpoint = "https://example.invalid/mcp";
    assert.deepEqual(await failing(endpoint), ["hosted endpoint"]);
  });

  test("an executed Atlantic run verifies, including the signed transaction; a swapped transaction does not", async () => {
    // The well-known Hardhat/Anvil test key #1: public, only ever used here on a fake chain.
    const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
    const token = NETWORKS["atlantic-testnet"].tokens[0]!.address.toLowerCase();
    const fake = await startFakeChain(defaultState({ chainId: 688689, native: { [signer.address.toLowerCase()]: 10n ** 18n }, tokens: { [token]: { decimals: 6, balances: { [signer.address.toLowerCase()]: 5_000_000n } } } }));
    const net: Network = { ...NETWORKS["atlantic-testnet"], rpcUrl: fake.url };
    const input = { name: "Atlantic payout", network: "atlantic-testnet", fireWhen: "all", conditions: [{ id: "payer-funded", label: "The payer holds the payout", read: { kind: "erc20-balance", token, holder: signer.address }, op: ">=", value: "1" }], action: { type: "erc20-transfer", token, from: signer.address, to: signer.address, amount: "1" } };
    const recorder = new Recorder();
    const mcp = await ChainMcp.connect({ kind: "local", network: net, broadcast: true }, { recorder, timeoutMs: 15_000 });
    let proof: ProofFile;
    try {
      const result = await runGuardian(parseGuardianConfig(input), { chain: new Chain(mcp, net), signer, wait: { pollMs: 10 } });
      assert.equal(result.outcome, "executed");
      proof = JSON.parse(JSON.stringify(proofFile({ task: "05", capability: "threshold-guardian", about: "test", mcp, network: NETWORKS["atlantic-testnet"], startedAt: NOW, input, result }))) as ProofFile;
    } finally {
      await mcp.close();
      await fake.close();
    }
    const checks = await verifyGuardianProof(proof);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.ok(checks.some((c) => c.name === "official server run locally" && c.ok));
    assert.match(checks.find((c) => c.name === "signed transaction")!.detail, /^chain 688689, signed by 0x[0-9a-fA-F]{40}, exactly the prepared action$/);
    // The result claims a different payee than the transaction pays: caught.
    (proof.result as { action: { tx: { data: string } } }).action.tx.data = "0xa9059cbb" + "00".repeat(64);
    assert.ok((await failing(proof)).includes("signed transaction"));
  });
});

describe("the vendored official Chain MCP server", () => {
  test("every file is byte-identical to PharosNetwork/pharos-mcp at 9a3750c (git blob hashes)", () => {
    const upstream: Record<string, string> = {
      "config.ts": "42f6b189b136fc3ba2e05d30a19f83a2a95aa330",
      "http.ts": "b5816d5c7f490116562430903e1ed28e9abcaa6f",
      "index.ts": "fc44ad578cb9ddc332509f83954a0f7bb6f61b28",
      "rpc.ts": "e8bafe6a99bf936f9bc8d71131f24acad4759487",
      "server.ts": "8728636fde9c7a37e3e928d53bb713d147b309f0",
      "validation.ts": "70ed5973e09a7695e565ed6f88282ebac2329e79",
    };
    const dir = fileURLToPath(new URL("../../vendor/pharos-mcp/src/", import.meta.url));
    // A git blob hash: sha1 of "blob <size>\0" followed by the bytes.
    const blob = (bytes: Buffer) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
    for (const [file, hash] of Object.entries(upstream)) assert.equal(blob(readFileSync(`${dir}${file}`)), hash, file);
  });
});
