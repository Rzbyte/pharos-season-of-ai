// The real pharos-agent binary, end to end: the guardian against the official Chain MCP server (its HTTP
// mode, and over stdio with --execute) on a fake chain, the proof it writes, and `verify` on that proof.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const PAYER = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";
// The well-known Hardhat/Anvil test key #1: public, only ever used here on a fake chain.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const KEY_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Only what the binary needs: no PRIVATE_KEY leaks in from the test runner's environment.
    execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
  });
}

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

let dir: string;
let fake: FakeChain;
let http: { close(cb: () => void): void; closeAllConnections?: () => void };
let mcpUrl: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pharos-agent-cli-"));
  fake = await startFakeChain(defaultState({ headTime: BigInt(Math.floor(Date.now() / 1000)), native: { [PAYER]: 10n ** 18n }, tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: 1_000_000_000n } } } }));
  const port = await freePort();
  const { loadConfig } = (await import(new URL("../vendor/pharos-mcp/src/config.js", import.meta.url).href)) as { loadConfig(env: Record<string, string>): unknown };
  const { startHttpServer } = (await import(new URL("../vendor/pharos-mcp/src/http.js", import.meta.url).href)) as { startHttpServer(config: unknown): Promise<typeof http> };
  http = await startHttpServer(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: String(port), PHAROS_RPC_URL: fake.url, PHAROS_CHAIN_ID: "1672" }));
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
});

after(async () => {
  http.closeAllConnections?.();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

describe("pharos-agent guardian", () => {
  test("the payout preset fires; the text output shows every condition, the decision and the simulated action", async () => {
    const { code, stdout, stderr } = await cli(["guardian", "payout", "--chain-mcp", mcpUrl]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^Pharos Threshold Guardian · USDC payout guardian\n/);
    assert.match(stdout, /\n  Network     Pharos Mainnet \(chain 1672\)\n/);
    assert.match(stdout, /\n  Chain MCP   http:\/\/127\.0\.0\.1:\d+\/mcp \(pharos-mcp-server 0\.1\.0\)\n/);
    assert.match(stdout, /\n  Rule        fire when all 6 conditions hold\n/);
    assert.equal((stdout.match(/^ {2}pass {2}/gm) ?? []).length, 6);
    assert.match(stdout, /pass {2}The payer holds at least the payout +1,000 USDC +>= 25 USDC +\[eth_call\]/);
    assert.match(stdout, /\n  Decision    FIRE: 6 of 6 conditions hold; the rule needs 6\.\n/);
    assert.match(stdout, /\n  Action      Transfer 25 USDC from 0x912c…f647 to 0xB274…9553\n {14}simulated at block 5,000,000: transfer returns true\n {14}gas 51,234 × 1\.2 gwei = 0\.00006148 PROS \(payer holds 1 PROS\)\n {14}not sent: the hosted Chain MCP is read-only; --execute runs on Atlantic\n/);
    assert.match(stdout, /Chain MCP calls\. Nothing was signed\.\n$/);
  });

  test("--json and --proof: the proof verifies by replay, failing only the hosted-endpoint check for a local server", async () => {
    const proofPath = join(dir, "proof.json");
    const { code, stdout, stderr } = await cli(["guardian", "payout", "--chain-mcp", mcpUrl, "--json", "--proof", proofPath]);
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).outcome, "fire");
    assert.match(stderr, /Proof saved to /);
    const proof = JSON.parse(await readFile(proofPath, "utf8"));
    assert.deepEqual([proof.format, proof.task, proof.capability, proof.chainMcp.kind, proof.chainMcp.endpoint], ["pharos-agent-proof/1", "05", "threshold-guardian", "hosted", mcpUrl]);
    const verified = await cli(["verify", proofPath]);
    assert.equal(verified.code, 1);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")), [`  FAIL  hosted endpoint: hosted ${mcpUrl}`]);
    assert.match(verified.stdout, /PASS {2}result recomputed from the recorded responses: \d+ calls replayed; decision, values and action identical/);
  });

  test("a guardian file that does not validate stops before any network call, with the reason", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify({ name: "x", network: "pharos-mainnet", fireWhen: "all", conditions: [], action: {} }));
    const { code, stderr } = await cli(["guardian", path, "--chain-mcp", "http://127.0.0.1:9/mcp"]);
    assert.equal(code, 2);
    assert.equal(stderr, "pharos-agent: conditions must list 1 to 8 conditions.\n");
  });

  test("--execute on Atlantic: the official server is started locally, the transfer is signed here and broadcast; its proof fully verifies", async () => {
    const atlantic = await startFakeChain(defaultState({ chainId: 688689, headTime: BigInt(Math.floor(Date.now() / 1000)), native: { [KEY_ADDRESS]: 10n ** 18n }, tokens: { "0xe0be08c77f415f577a1b3a9ad7a1df1479564ec8": { decimals: 6, balances: { [KEY_ADDRESS]: 3_000_000n } } } }));
    try {
      const proofPath = join(dir, "executed.json");
      const { code, stdout, stderr } = await cli(["guardian", "atlantic-payout", "--execute", "--rpc", atlantic.url, "--proof", proofPath], { PRIVATE_KEY: KEY });
      assert.equal(code, 0, stderr);
      assert.match(stdout, /\n  Re-check    block 5,000,000: 4 of 4 conditions hold; the rule needs 4\.\n  Sent        0x[0-9a-f]{64} \(nonce 0\)\n  Receipt     success in block 5,000,001, gas used 49,871 at 1 gwei\n/);
      assert.match(stdout, /Nothing was signed except the transaction above, locally\.\n$/);
      const proof = await readFile(proofPath, "utf8");
      assert.ok(!proof.toLowerCase().includes(KEY.slice(2)), "the key is not in the proof");
      const verified = await cli(["verify", proofPath]);
      assert.equal(verified.code, 0, verified.stdout);
      assert.match(verified.stdout, /PASS {2}signed transaction: chain 688689, signed by 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, exactly the prepared action/);
    } finally {
      await atlantic.close();
    }
  });

  test("--execute is refused on mainnet before anything runs", async () => {
    const { code, stderr } = await cli(["guardian", "payout", "--execute"], { PRIVATE_KEY: KEY });
    assert.equal(code, 2);
    assert.match(stderr, /--execute is limited to the Atlantic testnet/);
  });
});

describe("pharos-agent dryrun", () => {
  test("the default dry run: a USDC transfer on mainnet, its verdict, outcome, gas and funds", async () => {
    const { code, stdout, stderr } = await cli(["dryrun", "--chain-mcp", mcpUrl]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^Pharos Dry-Run Executor · Send 25 USDC from 0x912c…f647 to 0xB274…9553\n/);
    assert.match(stdout, /\n  Verdict     WOULD SUCCEED: returns true\n/);
    assert.ok(stdout.includes("\n  Outcome     Sender USDC     1,000 USDC → 975 USDC (−25 USDC)\n              Recipient USDC  0 USDC → 25 USDC (+25 USDC)\n              Sender PROS     1 PROS → about 0.99994364 PROS (−0.00005635 PROS)\n"), stdout);
    assert.ok(stdout.includes("\n  Gas         51,234 (limit 61,480) at about 1.1 gwei: about 0.00005635 PROS, at most 0.0001291 PROS\n  Funds       the sender holds 1 PROS; it needs up to 0.0001291 PROS\n"), stdout);
    assert.match(stdout, /\n  Submitted   no: the hosted Chain MCP is read-only; --submit runs on Atlantic\n/);
    assert.match(stdout, /Chain MCP calls\. Nothing was signed or sent\.\n$/);
  });

  test("--proof: the dry-run proof verifies by replay (only the endpoint differs from the hosted one)", async () => {
    const proofPath = join(dir, "dryrun.json");
    const { code, stdout, stderr } = await cli(["dryrun", "erc20-approve", "--spender", "0x1111111111111111111111111111111111111111", "--amount", "max", "--chain-mcp", mcpUrl, "--json", "--proof", proofPath]);
    assert.equal(code, 0, stderr);
    const run = JSON.parse(stdout);
    assert.deepEqual([run.verdict, run.warnings.map((w: { code: string }) => w.code)], ["would-succeed", ["unlimited-approval", "spender-not-contract"]]);
    const verified = await cli(["verify", proofPath]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")), [`  FAIL  hosted endpoint: hosted ${mcpUrl}`]);
    assert.match(verified.stdout, /PASS {2}result recomputed from the recorded responses: \d+ calls replayed; prediction, cost and verdict identical/);
  });

  test("--submit on Atlantic: sent, then every predicted change matched against the receipt; the proof verifies", async () => {
    const token = "0xe0be08c77f415f577a1b3a9ad7a1df1479564ec8";
    const atlantic = await startFakeChain(defaultState({ chainId: 688689, native: { [KEY_ADDRESS]: 10n ** 18n }, tokens: { [token]: { decimals: 6, balances: { [KEY_ADDRESS]: 3_000_000n } } } }));
    try {
      const proofPath = join(dir, "submitted.json");
      const { code, stdout, stderr } = await cli(["dryrun", "--network", "atlantic-testnet", "--to", "0xB2749BD12f19C24a2244176658F3dF3e48e79553", "--amount", "1", "--submit", "--rpc", atlantic.url, "--proof", proofPath], { PRIVATE_KEY: KEY });
      assert.equal(code, 0, stderr);
      assert.match(stdout, /\n  Submitted   0x[0-9a-f]{64} \(nonce 0\): success in block 5,000,001\n/);
      assert.equal((stdout.match(/^ {4}match {2}/gm) ?? []).length, 6);
      assert.match(stdout, /\n  Prediction  matched the receipt in every line\n/);
      const verified = await cli(["verify", proofPath]);
      assert.equal(verified.code, 0, verified.stdout);
    } finally {
      await atlantic.close();
    }
  });

  test("refusals before anything runs: --submit on mainnet, a token that is not official", async () => {
    const mainnet = await cli(["dryrun", "--submit"], { PRIVATE_KEY: KEY });
    assert.equal(mainnet.code, 2);
    assert.match(mainnet.stderr, /--submit is limited to the Atlantic testnet/);
    const token = await cli(["dryrun", "--token", "DOGE", "--chain-mcp", "http://127.0.0.1:9/mcp"]);
    assert.equal(token.code, 2);
    assert.match(token.stderr, /DOGE is not an official Pharos Mainnet token\. Use one of WPROS, USDC, LINK, WETH, or a token address\./);
  });
});


describe("pharos-agent gate", () => {
  // A chain at a fixed time (Monday 14:13 UTC, inside the treasury's hours), so the result does not
  // depend on when the tests run; reached with --rpc through the official server run over stdio.
  const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";
  let chain: FakeChain;
  before(async () => {
    chain = await startFakeChain(defaultState({ headTime: 1_790_000_000n, native: { [PAYER]: 10n ** 18n }, tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: 1_000_000_000n } } }, transfers: [{ token: USDC, from: PAYER, to: RECIPIENT, amount: 1_200_000_000n, block: 4_999_900n }] }));
  });
  after(() => chain.close());

  test("the treasury policy: every rule with its value and source, then the decision; nothing is signed", async () => {
    const { code, stdout, stderr } = await cli(["gate", "--rpc", chain.url]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^Pharos Policy Gatekeeper · Treasury payouts\n/);
    assert.match(stdout, /\n {2}Request {5}Send 25 USDC from 0x912c…f647 to 0xB274…9553\n/);
    assert.equal((stdout.match(/^ {2}pass {2}/gm) ?? []).length, 7);
    assert.match(stdout, /\n {2}pass {2}At most 5,000 USDC sent in 1,000 blocks +1,225 USDC +≤ 5,000 USDC +\[get_logs\]\n +1,200 USDC sent in 1 transfer over blocks 4,999,001–5,000,000 \(17 min\), plus 25 USDC now\.\n/);
    assert.match(stdout, /\n {2}pass {2}Between 06:00 and 22:00 UTC, every day +Mon 14:13 UTC +every day, 06:00–22:00 +\[get_block\]\n/);
    assert.match(stdout, /\n {2}Decision {4}ALLOWED: 7 of 7 rules hold\n/);
    assert.match(stdout, /\n {2}Dry run {5}would succeed; gas 51,234 \(limit 61,480\), about 0\.00005635 PROS\n/);
    assert.match(stdout, /Chain MCP calls\. Nothing was signed or sent\.\n$/);
  });

  test("denied: exit code 9, every failing rule listed; the proof verifies by replay", async () => {
    const proofPath = join(dir, "gate.json");
    const { code, stdout, stderr } = await cli(["gate", "treasury", "--to", "0x1111111111111111111111111111111111111111", "--amount", "150", "--rpc", chain.url, "--proof", proofPath]);
    assert.equal(code, 9, stderr);
    assert.match(stdout, /\n {2}FAIL {2}The recipient is one of 3 allowed addresses +0x1111…1111 +3 allowed +\[request\]\n +The recipient is not on the list\.\n/);
    assert.match(stdout, /\n {2}Decision {4}DENIED: 5 of 7 rules hold; failing: counterparties, per-action\n/);
    assert.match(stdout, /\n {2}Sent {8}no: denied\n/);
    const verified = await cli(["verify", proofPath]);
    // Run through a local server with --rpc, so only the hosted-endpoint check differs from a hosted run.
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /PASS {2}spend window: 1 get_logs page, 1,000 blocks ending at block 5,000,000/);
    assert.match(verified.stdout, /PASS {2}result recomputed from the recorded responses: \d+ calls replayed; every rule and the decision identical/);
  });

  test("--execute on Atlantic: allowed, sent through the official server, the receipt matched; the proof fully verifies", async () => {
    const token = "0xe0be08c77f415f577a1b3a9ad7a1df1479564ec8";
    const atlantic = await startFakeChain(defaultState({ chainId: 688689, native: { [KEY_ADDRESS]: 10n ** 18n }, tokens: { [token]: { decimals: 6, balances: { [KEY_ADDRESS]: 3_000_000n } } } }));
    try {
      const proofPath = join(dir, "gate-executed.json");
      const { code, stdout, stderr } = await cli(["gate", "atlantic-treasury", "--execute", "--rpc", atlantic.url, "--proof", proofPath], { PRIVATE_KEY: KEY });
      assert.equal(code, 0, stderr);
      assert.match(stdout, /\n {2}Request {5}Send 1 USDC from 0x7099…79C8 to 0xB274…9553\n/);
      assert.match(stdout, /\n {2}Decision {4}ALLOWED: 7 of 7 rules hold\n/);
      assert.match(stdout, /\n {2}Sent {8}0x[0-9a-f]{64} \(nonce 0\): success in block 5,000,001\n/);
      assert.ok(!/^ {4}DIFF/m.test(stdout), stdout);
      const verified = await cli(["verify", proofPath]);
      assert.equal(verified.code, 0, verified.stdout);
      assert.match(verified.stdout, /PASS {2}signed transaction: chain 688689, signed by 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, exactly the prepared gated transaction/);
    } finally {
      await atlantic.close();
    }
  });

  test("refusals before anything runs: --execute on mainnet, a missing policy, a preset that needs a key", async () => {
    const mainnet = await cli(["gate", "--execute"], { PRIVATE_KEY: KEY });
    assert.equal(mainnet.code, 2);
    assert.match(mainnet.stderr, /--execute is limited to the Atlantic testnet/);
    const missing = await cli(["gate", "no-such-policy.json"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /No policy preset or file "no-such-policy\.json"\./);
    const keyless = await cli(["gate", "atlantic-treasury"]);
    assert.equal(keyless.code, 2);
    assert.match(keyless.stderr, /"atlantic-treasury" uses your own wallet \(\$SIGNER\), so it needs PRIVATE_KEY/);
  });
});

describe("pharos-agent watch", () => {
  // Its own chain, changed between runs the way time changes the real one; reached with --rpc.
  const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";
  let chain: FakeChain;
  before(async () => {
    chain = await startFakeChain(defaultState({ native: { [PAYER]: 10n ** 18n, [RECIPIENT]: 10n ** 18n }, tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: 1_000_000_000n, [RECIPIENT]: 600_000_000n } } } }));
  });
  after(() => chain.close());
  const step = (usdc: bigint) => {
    chain.state.head += 10n;
    chain.state.headTime += 10n;
    chain.state.tokens[USDC]!.balances[PAYER] = usdc;
  };

  test("three runs, one store file: the observations persist, the trend fires on the third, and the proofs verify as one history", async () => {
    const store = join(dir, "watch-store.json");
    const proofs = [1, 2, 3].map((n) => join(dir, `watch-${n}.json`));
    const first = await cli(["watch", "--store", store, "--rpc", chain.url, "--proof", proofs[0]!]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /\n {2}Store {7}.*watch-store\.json: 1 observation\n/);
    assert.match(first.stdout, /\n {2}Trend {7}Fell across the last 3 observations: 1 of 3 observations so far \(not yet\)\n/);
    assert.match(first.stdout, /\n {2}Outcome {5}WATCHING\n/);
    step(990_000_000n);
    const second = await cli(["watch", "--store", store, "--rpc", chain.url, "--proof", proofs[1]!]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /: 2 observations\n/);
    step(975_500_000n);
    const third = await cli(["watch", "--store", store, "--rpc", chain.url, "--proof", proofs[2]!]);
    assert.equal(third.code, 0, third.stderr);
    assert.match(third.stdout, /\n {2}Counted {5}block +5,000,000 +\d\d:\d\d:\d\d +1,000 USDC\n +block +5,000,010 +\d\d:\d\d:\d\d +990 USDC {2}−10 USDC\n +block +5,000,020 +\d\d:\d\d:\d\d +975\.5 USDC {2}−14\.5 USDC\n/);
    assert.match(third.stdout, /\n {2}Trend {7}Fell across the last 3 observations: 2 of 2 steps down \(holds\)\n/);
    assert.match(third.stdout, /\n {2}Action {6}Would succeed: Send 100 USDC from 0xB274…9553 to 0x912c…f647, for about 0\.00005635 PROS in gas\.\n/);
    assert.match(third.stdout, /\n {2}Outcome {5}FIRED: the next trend counts only observations after this block\n/);
    const saved = JSON.parse(await readFile(store, "utf8"));
    assert.deepEqual([saved.observations.length, saved.actedAt], [3, "5000020"]);
    // Too soon after the last: the store is left as it was.
    const soon = await cli(["watch", "--store", store, "--rpc", chain.url]);
    assert.match(soon.stdout, /\n {2}Skipped {5}The last observation is 0 blocks old|\n {2}Skipped {5}Block 5,000,020 is not after the last observation/);
    assert.deepEqual(JSON.parse(await readFile(store, "utf8")), saved);
    // Each proof alone, and the three as one history (only the hosted-endpoint check differs, with --rpc).
    const verified = await cli(["verify", ...proofs]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint", "  FAIL  hosted endpoint", "  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /\n {2}PASS {2}one history: 3 runs, each from the store the last one left; 3 observations kept\n/);
    const shuffled = await cli(["verify", proofs[0]!, proofs[2]!]);
    assert.match(shuffled.stdout, /\n {2}FAIL {2}one history: run 2 did not start from the store run 1 left\n/);
  });

  test("a store of another watcher's value is refused, and nothing runs", async () => {
    const store = join(dir, "other-store.json");
    await writeFile(store, JSON.stringify({ schema: "pharos-agent/trend-store/1", observing: "something else", observations: [], actedAt: null }));
    const refused = await cli(["watch", "--store", store, "--rpc", "http://127.0.0.1:9"]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /The store holds observations of something else/);
  });
});
