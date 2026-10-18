// The real pharos-agent binary, end to end: the guardian against the official Chain MCP server (its HTTP
// mode, and over stdio with --execute) on a fake chain, the proof it writes, and `verify` on that proof.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultState, startFakeChain, type FakeChain } from "./fake-chain.js";
import { startFakeDocs, type FakeDocs } from "./fake-docs.js";

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
    const proofPath = join(dir, "guardian", "proof", "proof.json");
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
    // Both in a folder that does not exist yet, as a task's proof/ folder on a fresh checkout.
    const store = join(dir, "trend", "proof", "watch-store.json");
    const proofs = [1, 2, 3].map((n) => join(dir, "trend", "proof", `watch-${n}.json`));
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

describe("pharos-agent alert", () => {
  // Its own chain with past USDC transfers, moved on between runs; and a webhook receiver that can refuse.
  const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";
  const OTHER = "0x1111111111111111111111111111111111111111";
  let chain: FakeChain;
  let hook: ReturnType<typeof createHttpServer>;
  let hookUrl: string;
  const posts: { text: string; alert: { id: string; kind: string } }[] = [];
  let refuse = (_alert: { kind: string }) => false;
  before(async () => {
    chain = await startFakeChain(defaultState({ tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: 80_000_000n } } }, transfers: [{ token: USDC, from: OTHER, to: RECIPIENT, amount: 600_000_000n, block: 4_999_990n }, { token: USDC, from: PAYER, to: OTHER, amount: 40_000_000n, block: 4_999_995n }] }));
    hook = createHttpServer((request: IncomingMessage, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const post = JSON.parse(body);
        posts.push(post);
        response.writeHead(refuse(post.alert) ? 503 : 204).end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
    hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;
  });
  after(async () => {
    await new Promise<void>((resolve) => hook.close(() => resolve()));
    await chain.close();
  });

  test("two runs, one store: each alert POSTed once, one the webhook refused retried next run; the proofs verify as one history", async () => {
    const store = join(dir, "alert-store.json");
    const proofs = [1, 2].map((n) => join(dir, `alert-${n}.json`));
    refuse = (alert) => alert.kind === "triggered";
    const first = await cli(["alert", "--store", store, "--rpc", chain.url, "--webhook", hookUrl, "--proof", proofs[0]!]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /\n {2}Scanned {5}blocks 4,999,001–5,000,000 \(1 get_logs call\)\n/);
    assert.match(first.stdout, /\n {2}A USDC transfer of 500 or more +1 new +\[get_logs\]\n/);
    assert.match(first.stdout, /\n {2}0x912c…f647 holds less than 100 USDC +HOLDS: 80 USDC +\[eth_call\]\n/);
    assert.match(first.stdout, /\n {2}Alerts {6}A USDC transfer of 500 or more: 600 USDC from 0x1111…1111 to 0xB274…9553 at block 4,999,990\n {14}TRIGGERED 0x912c…f647 holds less than 100 USDC: 80 USDC at block 5,000,000\n/);
    assert.match(first.stdout, /\n {2}Delivered {3}1 to the webhook; 1 kept to retry \(HTTP 503\)\n/);
    assert.deepEqual(posts.map((p) => p.text), ["USDC alerts: A USDC transfer of 500 or more: 600 USDC from 0x1111…1111 to 0xB274…9553 at block 4,999,990", "USDC alerts: 0x912c…f647 holds less than 100 USDC: 80 USDC at block 5,000,000"]);
    const kept = JSON.parse(await readFile(store, "utf8"));
    assert.deepEqual([kept.cursor, kept.states, kept.pending.map((a: { kind: string }) => a.kind)], ["5000000", { "holder-low": true, "usdc-paused": false, "gas-high": false }, ["triggered"]]);

    // Ten blocks on: a new large transfer, the balance back above 100, and the webhook taking everything.
    chain.state.head += 10n;
    chain.state.headTime += 10n;
    chain.state.transfers.push({ token: USDC, from: PAYER, to: OTHER, amount: 1_000_000_000n, block: 5_000_004n });
    chain.state.tokens[USDC]!.balances[PAYER] = 200_000_000n;
    refuse = () => false;
    posts.length = 0;
    const second = await cli(["alert", "--store", store, "--rpc", chain.url, "--webhook", hookUrl, "--proof", proofs[1]!]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /\n {2}Scanned {5}blocks 5,000,001–5,000,010 \(1 get_logs call\)\n/);
    assert.match(second.stdout, /\n {2}Alerts {6}A USDC transfer of 500 or more: 1,000 USDC from 0x912c…f647 to 0x1111…1111 at block 5,000,004\n {14}RESOLVED 0x912c…f647 holds less than 100 USDC: no longer holds: 200 USDC at block 5,000,010\n/);
    assert.match(second.stdout, /\n {2}Delivered {3}3 to the webhook\n/);
    assert.deepEqual(posts.map((p) => p.alert.kind), ["triggered", "transfer", "resolved"], "the kept alert first, then this run's");
    assert.deepEqual(JSON.parse(await readFile(store, "utf8")).pending, []);

    // A third run at the same block: nothing new, nothing POSTed.
    posts.length = 0;
    const third = await cli(["alert", "--store", store, "--rpc", chain.url, "--webhook", hookUrl]);
    assert.match(third.stdout, /\n {2}Scanned {5}no new blocks\n[\s\S]*\n {2}Alerts {6}none new\n/);
    assert.deepEqual(posts, []);

    const verified = await cli(["verify", ...proofs]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint", "  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /\n {2}PASS {2}delivery: 1 delivered \(webhook\), 1 kept to retry\n/);
    assert.match(verified.stdout, /\n {2}PASS {2}one history: 2 runs, each from the store the last one left; 4 alerts in all\n/);
    const reversed = await cli(["verify", proofs[1]!, proofs[0]!]);
    assert.match(reversed.stdout, /\n {2}FAIL {2}one history: run 2 did not start from the store run 1 left\n/);
  });

  test("refusals before anything runs: another bot's store, a webhook that is not http(s)", async () => {
    const store = join(dir, "other-alert-store.json");
    await writeFile(store, JSON.stringify({ schema: "pharos-agent/alert-store/1", bot: "pharos-mainnet:Someone else", cursor: null, states: {}, pending: [] }));
    const other = await cli(["alert", "--store", store, "--rpc", "http://127.0.0.1:9"]);
    assert.equal(other.code, 2);
    assert.match(other.stderr, /The store belongs to another bot \("pharos-mainnet:Someone else"\)/);
    const hookless = await cli(["alert", "--webhook", "ftp://hooks.example/x"]);
    assert.equal(hookless.code, 2);
    assert.match(hookless.stderr, /--webhook must be an http\(s\) URL/);
  });
});

describe("pharos-agent whales", () => {
  // Its own chain: the four sample addresses with holdings, one USDC transfer of theirs in the lookback.
  const [BUSIEST, SENDER, TRADER, LARGEST] = ["0x912c9ade24d44d8922f0866d8dcb079f1363f647", "0x936564245b69f5a293b42cbd752e0ee3bb68b470", "0x1f3546a29eec2102c8d52e21a45114124014c85c", "0x0018b46177c611fc1efbca63c845c2a69045e28d"];
  const OTHER = "0x1111111111111111111111111111111111111111";
  let chain: FakeChain;
  before(async () => {
    chain = await startFakeChain(defaultState({ native: { [BUSIEST]: 500n * 10n ** 18n }, nonces: { [BUSIEST]: 7n }, code: { [TRADER]: "0x6080604052" }, tokens: { [USDC]: { decimals: 6, balances: { [BUSIEST]: 1_000_000_000n, [SENDER]: 50_000_000n, [LARGEST]: 1n } } }, transfers: [{ token: USDC, from: SENDER, to: OTHER, amount: 698_770_000n, block: 4_999_950n }, { token: USDC, from: OTHER, to: BUSIEST, amount: 20_000_000n, block: 4_999_960n }] }));
  });
  after(() => chain.close());

  test("two runs, one store: each address with its holdings, the significant moves, what changed; the proofs verify as one history", async () => {
    const store = join(dir, "whale-store.json");
    const proofs = [1, 2].map((n) => join(dir, `whales-${n}.json`));
    const first = await cli(["whales", "--store", store, "--rpc", chain.url, "--proof", proofs[0]!]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /\n {2}Scanned {5}blocks 4,999,001–5,000,000 \(2 get_logs calls\): 2 transfers by tracked addresses\n/);
    assert.match(first.stdout, /\n {2}Busiest in the sample \(0x912c9aDe24D44d8922f0866D8Dcb079f1363f647, no code\)\n {4}USDC {3}1,000 USDC, first seen · this run: 1 in \(20 USDC\), 0 out \(0 USDC\)\n {4}PROS {3}500 PROS, first seen\n {4}Nonce {2}7\n/);
    assert.match(first.stdout, /\n {2}Trades with the busiest \(0x1F3546a29EeC2102c8d52E21a45114124014c85C, has code\)\n/);
    assert.match(first.stdout, /\n {2}Significant Sent the most sent 698\.77 USDC to 0x1111…1111 at block 4,999,950\n/);
    // Ten blocks on: the busiest sent two transactions and 120 PROS left it.
    chain.state.head += 10n;
    chain.state.headTime += 10n;
    chain.state.native[BUSIEST] = 380n * 10n ** 18n;
    chain.state.nonces[BUSIEST] = 9n;
    const second = await cli(["whales", "--store", store, "--rpc", chain.url, "--proof", proofs[1]!]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /\n {4}USDC {3}1,000 USDC ±0 USDC since block 5,000,000\n {4}PROS {3}380 PROS −120 PROS since block 5,000,000\n {4}Nonce {2}9 · 2 transactions sent since block 5,000,000\n/);
    assert.match(second.stdout, /\n {2}Significant Busiest in the sample's PROS balance fell by 120 PROS since block 5,000,000, to 380 PROS\n/);
    const saved = JSON.parse(await readFile(store, "utf8"));
    assert.deepEqual([saved.cursor, saved.snapshots[BUSIEST].nonce], ["5000010", "9"]);
    const verified = await cli(["verify", ...proofs]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint", "  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /\n {2}PASS {2}scanned blocks: 2 get_logs calls within blocks 4,999,001–5,000,000\n/);
    assert.match(verified.stdout, /\n {2}PASS {2}one history: 2 runs, each from the store the last one left; 2 significant moves in all\n/);
  });

  test("refusals before anything runs: another watchlist's store, a token that is not official", async () => {
    const store = join(dir, "other-whale-store.json");
    await writeFile(store, JSON.stringify({ schema: "pharos-agent/whale-store/1", watchlist: "pharos-mainnet:Someone else", cursor: null, snapshots: {} }));
    const other = await cli(["whales", "--store", store, "--rpc", "http://127.0.0.1:9"]);
    assert.equal(other.code, 2);
    assert.match(other.stderr, /The store belongs to another watchlist \("pharos-mainnet:Someone else"\)/);
    const listFile = join(dir, "whales-unofficial.json");
    await writeFile(listFile, JSON.stringify({ name: "Mine", addresses: [BUSIEST], tokens: [{ token: OTHER, min: "1" }] }));
    const unofficial = await cli(["whales", listFile, "--rpc", "http://127.0.0.1:9"]);
    assert.equal(unofficial.code, 2);
    assert.match(unofficial.stderr, /is not on Pharos Mainnet's official token list/);
  });
});

describe("pharos-agent gas", () => {
  // Its own chain: five earlier base fees and the head's, the fee coming down between runs.
  const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";
  const GWEI = 10n ** 9n;
  let chain: FakeChain;
  before(async () => {
    chain = await startFakeChain(defaultState({ baseFee: GWEI, baseFees: { "4999000": GWEI, "4999200": 11n * GWEI / 10n, "4999400": 14n * GWEI / 10n, "4999600": 9n * GWEI / 10n, "4999800": 12n * GWEI / 10n, "5000000": 13n * GWEI / 10n }, priorityFee: GWEI / 10n, native: { [PAYER]: 10n ** 18n }, tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: 1_000_000_000n, [RECIPIENT]: 0n } } } }));
  });
  after(() => chain.close());

  test("two runs, one store: wait while the fee is high, then send when it reaches the target; the proofs verify as one history", async () => {
    const store = join(dir, "gas-store.json");
    const proofs = [1, 2].map((n) => join(dir, `gas-${n}.json`));
    const first = await cli(["gas", "--store", store, "--rpc", chain.url, "--proof", proofs[0]!]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /\n {2}Transaction {2}Send 25 USDC from 0x912c…f647 to 0xB274…9553 \(would succeed, 51,234 gas\)\n/);
    assert.match(first.stdout, /\n {2}Observed {5}block +4,999,000 +1 gwei +0% full {2}read now\n/);
    assert.match(first.stdout, /\n {15}block +5,000,000 +1\.3 gwei +0% full {2}now\n/);
    assert.match(first.stdout, /\n {2}Base fee {5}now 1\.3 gwei · lowest 0\.9 gwei · median 1\.1 gwei · highest 1\.4 gwei\n {2}Target {7}1 gwei: the 25th percentile of the last 12 observations\n {2}Decision {5}WAIT: The base fee, 1\.3 gwei, is above the target, 1 gwei/);
    assert.match(first.stdout, /\n {2}Settings {5}maxFeePerGas 1\.1 gwei · maxPriorityFeePerGas 0\.1 gwei\n {2}Cost {9}now 0\.00007172 PROS · at the target 0\.00005635 PROS · waiting saves 0\.00001537 PROS\n/);
    assert.match(first.stdout, /\n {2}Sent {9}Nothing was signed or sent: on Pharos Mainnet the optimizer only advises\.\n/);
    chain.state.head += 10n;
    chain.state.headTime += 10n;
    chain.state.baseFees!["5000010"] = 95n * GWEI / 100n;
    const second = await cli(["gas", "--store", store, "--rpc", chain.url, "--proof", proofs[1]!]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /\n {2}Decision {5}SEND NOW: The base fee, 0\.95 gwei, is at or below the target, 0\.95 gwei/);
    assert.match(second.stdout, /\n {2}Settings {5}maxFeePerGas 1\.05 gwei · maxPriorityFeePerGas 0\.1 gwei\n/);
    const saved = JSON.parse(await readFile(store, "utf8"));
    assert.deepEqual([saved.observations.length, saved.waitingSince], [7, null]);
    const verified = await cli(["verify", ...proofs]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint", "  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /\n {2}PASS {2}one history: 2 runs, each from the store the last one left: wait, send\n/);
  });

  test("refusals before anything runs: --execute on mainnet, an Atlantic preset without a key", async () => {
    const mainnet = await cli(["gas", "--execute", "--store", join(dir, "never.json"), "--rpc", "http://127.0.0.1:9"]);
    assert.equal(mainnet.code, 2);
    assert.match(mainnet.stderr, /--execute is limited to the Atlantic testnet/);
    const keyless = await cli(["gas", "atlantic-usdc", "--store", join(dir, "never.json")]);
    assert.equal(keyless.code, 2);
    assert.match(keyless.stderr, /"atlantic-usdc" sends from your own wallet \(\$SIGNER\), so it needs PRIVATE_KEY/);
  });
});

describe("pharos-agent explain", () => {
  // Its own chain, with one failed transaction on it: 100 USDC sent by a holder of 50.
  const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";
  const HASH = `0x${"a1".repeat(32)}`;
  let chain: FakeChain;
  before(async () => {
    chain = await startFakeChain(defaultState({ native: { [PAYER]: 10n ** 18n }, tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: 50_000_000n } } } }));
    const data = `0xa9059cbb${RECIPIENT.slice(2).padStart(64, "0")}${(100_000_000).toString(16).padStart(64, "0")}`;
    chain.transactions.set(HASH, { hash: HASH, from: PAYER, to: USDC, input: data, value: "0x0", gas: "0x186a0", nonce: "0x7", blockNumber: "0x4c4b40", type: "0x2" });
    chain.receipts.set(HASH, { transactionHash: HASH as `0x${string}`, blockNumber: "0x4c4b40", status: "0x0", gasUsed: "0x7918", effectiveGasPrice: "0x3b9aca00", from: PAYER as `0x${string}`, to: USDC as `0x${string}`, logs: [], cumulativeGasUsed: "0x7918", type: "0x2" });
  });
  after(() => chain.close());

  test("a failed transaction by its hash: the cause, every finding with its source, the fix; the proof verifies", async () => {
    const proof = join(dir, "explain.json");
    const run = await cli(["explain", HASH, "--rpc", chain.url, "--proof", proof]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Transaction {2}Transfer 100 USDC to 0xB274…9553 \(from 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647\)\n {2}Block {8}5,000,000 · .*\n {2}Status {7}FAILED\n/);
    assert.match(run.stdout, /\n {2}! Replayed before its block {2}reverts at block 4,999,999: Error {3}\[eth_call\]\n/);
    assert.match(run.stdout, /\n {2}! Sender's balance {11}0x912c…f647 held 50 USDC, and it sends 100 USDC {3}\[eth_call\]\n/);
    assert.match(run.stdout, /\n {2}Why {10}It stopped with the message "ERC20: transfer amount exceeds balance"\. The sender did not hold enough\.\n {2}Error {8}Error \(message: ERC20: transfer amount exceeds balance\)\n {2}Fix {10}Send no more than the sender holds, or fund it first\.\n/);
    const verified = await cli(["verify", proof]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /\n {2}PASS {2}one pinned block: every state read before execution is at block 4999999\n/);
  });

  test("a transaction described: why it would fail if sent now; a malformed hash is refused before anything runs", async () => {
    const run = await cli(["explain", "--amount", "5000", "--rpc", chain.url]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Asked {8}a transaction described, not sent\n/);
    assert.match(run.stdout, /\n {2}Status {7}WOULD FAIL\n/);
    const bad = await cli(["explain", "0x12", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /A transaction hash is 0x and 64 hex characters/);
  });
});

describe("pharos-agent risk", () => {
  // Its own chain: the example sender trades with one address; a made-up lookalike copies its ends.
  const TRADER = "0x1f3546a29eec2102c8d52e21a45114124014c85c";
  const LOOKALIKE = `0x1f35${"0".repeat(32)}c85c`;
  let chain: FakeChain;
  before(async () => {
    chain = await startFakeChain(defaultState({ native: { [PAYER]: 10n ** 18n, [TRADER]: 10n ** 17n }, nonces: { [TRADER]: 3n }, tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: 1_000_000_000n } } }, transfers: [{ token: USDC, from: PAYER, to: TRADER, amount: 58_410_000n, block: 4_999_900n }, { token: USDC, from: TRADER, to: PAYER, amount: 58_400_000n, block: 4_999_950n }] }));
  });
  after(() => chain.close());

  test("a lookalike recipient: every signal with its source, high risk; the proof verifies", async () => {
    const proof = join(dir, "risk.json");
    const run = await cli(["risk", "--to", LOOKALIKE, "--rpc", chain.url, "--proof", proof]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Counterparty {2}0x1f3500000000000000000000000000000000c85c \(the recipient\): no code, nonce 0, 0 PROS\n {2}History {7}blocks 4,998,001–5,000,000, USDC: 2 transfers by either, 0 between them, 0 of nothing\n/);
    assert.match(run.stdout, /\n {2}HIGH {4}Looks like an address the sender uses: 0x1f35…c85c starts and ends like 0x1F35…c85C, which the sender dealt with 2 times/);
    assert.match(run.stdout, /\n {2}MEDIUM {2}Never used: /);
    assert.match(run.stdout, /\n {2}Risk {10}HIGH: do not send\n/);
    const verified = await cli(["verify", proof]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /\n {2}PASS {2}scanned blocks: 4 get_logs calls within blocks 4,998,001–5,000,000\n/);
  });

  test("--blocks is bounded, before anything runs", async () => {
    const bad = await cli(["risk", "--blocks", "20000", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--blocks must be a whole number from 1 to 10,000/);
  });
});


describe("pharos-agent audit", () => {
  // Its own chain: in the last hour the example address received 500 USDC from a trader and sent 200 back.
  const TRADER = "0x1f3546a29eec2102c8d52e21a45114124014c85c";
  const world = (native: bigint, nonce: bigint, usdc: bigint) => ({ native: { [PAYER]: native }, nonces: { [PAYER]: nonce }, tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: usdc } } } });
  let chain: FakeChain;
  before(async () => {
    chain = await startFakeChain(
      defaultState({
        ...world(10n ** 18n, 12n, 1_300_000_000n),
        transfers: [{ token: USDC, from: TRADER, to: PAYER, amount: 500_000_000n, block: 4_998_000n }, { token: USDC, from: PAYER, to: TRADER, amount: 200_000_000n, block: 4_999_000n }],
        past: { "4996400": world(11n * 10n ** 17n, 10n, 1_000_000_000n) },
      }),
    );
  });
  after(() => chain.close());

  test("the last hour, in sentences and a timeline; the proof verifies", async () => {
    const proof = join(dir, "audit.json");
    const run = await cli(["audit", "--rpc", chain.url, "--proof", proof]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Address {7}0x912c9aDe24D44d8922f0866D8Dcb079f1363f647 \(a wallet\)\n {2}Period {8}in the last hour: blocks 4,996,401–5,000,000, 2026-09-21T13:13:21\.000Z to 2026-09-21T14:13:20\.000Z\n/);
    assert.match(run.stdout, /\n {2}It sent 2 transactions \(its nonce went from 10 to 12\)\.\n {2}It received 500 USDC in 1 transfer from 0x1F35…c85C and sent 200 USDC in 1 transfer to 0x1F35…c85C\.\n/);
    assert.match(run.stdout, /\n {2}Its USDC went from 1,000 to 1,300, all of it in the logs above\.\n/);
    assert.match(run.stdout, /\n {7}4,999,000 {2}~13:56:40 {2}Sent 200 USDC to 0x1F35…c85C {2}0x[0-9a-f]{64}\n/);
    assert.match(run.stdout, /\n {2}\d+ Chain MCP calls, 8 of them get_logs\. Nothing was signed or sent\.\n/);
    const verified = await cli(["verify", proof]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /\n {2}PASS {2}pinned blocks: every state read is at block 5000000 or 4996400\n/);
    assert.match(verified.stdout, /\n {2}PASS {2}scanned blocks: 8 get_logs calls within blocks 4,996,401–5,000,000\n/);
  });

  test("an address, and one period, checked before anything runs", async () => {
    const bad = await cli(["audit", "0x12", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /The address must be a 0x address of 40 hex characters/);
    const both = await cli(["audit", "--hours", "2", "--since", "2026-10-17T09:00Z", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /Give the period one way/);
  });
});

describe("pharos-agent digest", () => {
  // Its own chain: USDC moving over the last hours, a block a second; the newest is Monday 21 Sep 2026, 14:13:20 UTC.
  const TRADER = "0x1f3546a29eec2102c8d52e21a45114124014c85c";
  const BUSY = "0x936564245b69f5a293b42cbd752e0ee3bb68b470";
  let chain: FakeChain;
  before(async () => {
    chain = await startFakeChain(
      defaultState({
        tokens: { [USDC]: { decimals: 6, balances: { [PAYER]: 1_300_000_000n, [TRADER]: 5_000_000_000n } } },
        transfers: [{ token: USDC, from: TRADER, to: BUSY, amount: 10_000_000n, block: 4_992_100n }, { token: USDC, from: TRADER, to: BUSY, amount: 20_000_000n, block: 4_993_000n }, { token: USDC, from: BUSY, to: PAYER, amount: 7_000_000n, block: 4_996_000n }],
      }),
    );
  });
  after(() => chain.close());

  test("USDC hour by hour, with the hour so far; the proof verifies", async () => {
    const proof = join(dir, "digest.json");
    const run = await cli(["digest", "usdc", "--every", "hour", "--periods", "2", "--so-far", "--rpc", chain.url, "--proof", proof]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Subject {7}USDC \(0xC879C018dB60520F4355C26eD1a6D572cdAC1815\), the token, every hour\n/);
    assert.match(run.stdout, /\n {2}21 Sep 2026, 12:00 to 13:00 UTC \(blocks 4,992,000–4,995,599\)\n {4}USDC, 21 Sep 2026, 12:00 to 13:00 UTC: 2 transfers moved 30 USDC between 1 sender and 1 recipient\.\n/);
    assert.match(run.stdout, /\n {4}Against the hour before: 50% fewer transfers and 77% less volume\.\n/);
    assert.match(run.stdout, /\n {2}21 Sep 2026, 14:00 to 15:00 UTC, so far \(blocks 4,999,200–5,000,000\)\n {4}USDC, 21 Sep 2026, 14:00 to 15:00 UTC, so far: no USDC moved between holders\.\n/);
    assert.match(run.stdout, /\n {2}Now: a total supply of 6,300 USDC\.\n/);
    const verified = await cli(["verify", proof]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
  });

  test("on a schedule, with a store: each hour digested once, the proofs one history; --periods with a store is refused", async () => {
    const store = join(dir, "digest-store.json");
    const [first, second] = [join(dir, "digest-1.json"), join(dir, "digest-2.json")];
    const one = await cli(["digest", "usdc", "--every", "hour", "--store", store, "--rpc", chain.url, "--proof", first]);
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /\n {2}Store: .*digest-store\.json \(the last digest ended at 2026-09-21T14:00:00\.000Z\)\.\n/);
    const two = await cli(["digest", "usdc", "--every", "hour", "--store", store, "--rpc", chain.url, "--proof", second]);
    assert.match(two.stdout, /\n {2}USDC: no hour has ended since the last digest; the next ends at 2026-09-21T15:00:00\.000Z\.\n/);
    const verified = await cli(["verify", first, second]);
    assert.match(verified.stdout, /\n {2}PASS {2}one history: 2 runs, each from the store the last one left; 1 period digested, each once\n/);
    const both = await cli(["digest", "--store", store, "--periods", "2", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /--periods is for a run without a store/);
  });
});

describe("pharos-agent ask", () => {
  // Made-up docs in the shape the Developer Docs MCP answers: the answer names a page that lists USDC.
  const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
  let docs: FakeDocs;
  before(async () => {
    fake.state.tokens[USDC]!.symbol = "USDC";
    docs = await startFakeDocs(() => `USDC is listed in the [Token Registry](${REGISTRY}).\n\n# Sources\n\n- [Token Registry](${REGISTRY})`, { [REGISTRY]: "# Token Registry\n\n## Pharos Mainnet\n\n| Token | Address |\n| --- | --- |\n| USDC | 0xC879C018dB60520F4355C26eD1a6D572cdAC1815 |\n" });
  });
  after(async () => {
    delete fake.state.tokens[USDC]!.symbol;
    await docs.close();
  });

  test("a question in words, answered from the docs, then checked on chain; the proof verifies but for its two endpoints", async () => {
    const proof = join(dir, "ask.json");
    const run = await cli(["ask", "What", "is", "the", "USDC", "token", "address", "on", "Pharos", "Mainnet?", "--rpc", fake.url, "--docs-mcp", docs.url, "--proof", proof]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Question {5}What is the USDC token address on Pharos Mainnet\?\n {2}Docs MCP {5}http:\/\/127\.0\.0\.1:\d+\/~gitbook\/mcp\n/);
    assert.match(run.stdout, /\n {2}The docs say:\n {4}USDC is listed in the Token Registry\.\n {2}Sources: https:\/\/docs\.pharos\.xyz\/getting-started\/token-registry\n/);
    assert.match(run.stdout, /\n {3}3\. The docs give 0xC879C018dB60520F4355C26eD1a6D572cdAC1815 as "USDC" on Pharos Mainnet\. {3}\[docs page \/getting-started\/token-registry\]\n/);
    assert.match(run.stdout, /\n {2}Verdict {6}CONFIRMED: The docs give 0xC879…1815 as "USDC", and Pharos Mainnet agrees: a contract whose symbol\(\) is USDC, with 6 decimals and 1,000 USDC in supply\.\n {2}2 Developer Docs MCP and 8 Chain MCP calls\. Nothing was signed or sent\.\n/);
    const verified = await cli(["verify", proof]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint", "  FAIL  Developer Docs MCP"]);
    assert.match(verified.stdout, /\n {2}PASS {2}answer recomputed from the recorded responses: 2 docs and 8 chain calls replayed; the answer, every reading and the verdict identical\n/);
  });

  test("no question, or one too long, is refused before anything runs", async () => {
    const none = await cli(["ask", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /Ask a question about a Pharos contract/);
    const long = await cli(["ask", "x".repeat(301), "--rpc", "http://127.0.0.1:9"]);
    assert.equal(long.code, 2);
    assert.match(long.stderr, /at most 300 characters/);
  });
});

describe("pharos-agent howto", () => {
  // Made-up docs in the shape the Developer Docs MCP answers: how to send a token, and a registry page.
  const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
  const RECIPIENT = "0x1111111111111111111111111111111111111111";
  let docs: FakeDocs;
  before(async () => {
    docs = await startFakeDocs(() => `Call \`transfer(address,uint256)\` on USDC, listed in the [Token Registry](${REGISTRY}). Pharos Mainnet's chain ID is 1672.\n\n# Sources\n\n- [Token Registry](${REGISTRY})`, { [REGISTRY]: "# Token Registry\n\n## Pharos Mainnet\n\n| Token | Address |\n| --- | --- |\n| USDC | 0xC879C018dB60520F4355C26eD1a6D572cdAC1815 |\n" });
  });
  after(() => docs.close());

  test("a how-to in words: the docs, the pieces beside the Skill Engine, the dry run, its cast commands; the proof verifies but for its two endpoints", async () => {
    const proof = join(dir, "howto.json");
    const run = await cli(["howto", "How", "do", "I", "send", "25", "USDC", "to", RECIPIENT, "--rpc", fake.url, "--docs-mcp", docs.url, "--proof", proof]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Question {5}How do I send 25 USDC to 0x1111111111111111111111111111111111111111\n/);
    assert.match(run.stdout, /\n {3}2\. It asks to send 25 USDC from 0x912c…f647 to 0x1111…1111 on Pharos Mainnet\. The recipient and the amount are the question's; the sender is the example's\. {3}\[the question\]\n/);
    assert.match(run.stdout, /\n {2}With the Skill Engine \(https:\/\/github\.com\/PharosNetwork\/pharos-skill-engine, a873387\), not run here:\n {4}cast estimate 0xC879C018dB60520F4355C26eD1a6D572cdAC1815 "transfer\(address,uint256\)" 0x1111111111111111111111111111111111111111 25000000 --from 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647 --rpc-url https:\/\/rpc\.pharos\.xyz\n {4}cast send .+ --private-key \$PRIVATE_KEY --rpc-url https:\/\/rpc\.pharos\.xyz\n/);
    assert.match(run.stdout, /\n {2}Verdict {6}READY: Send 25 USDC from 0x912c…f647 to 0x1111…1111: ready\. The dry run at block 5,000,000 succeeds, for about [\d.]+ PROS in gas\. Nothing was sent: the hosted Chain MCP is read-only\.\n {2}2 Developer Docs MCP and \d+ Chain MCP calls\. Nothing was signed or sent\.\n/);
    const verified = await cli(["verify", proof]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint", "  FAIL  Developer Docs MCP"]);
    assert.match(verified.stdout, /\n {2}PASS {2}no key material: /);
  });

  test("a bad value, or --execute on mainnet, is refused before anything runs", async () => {
    const bad = await cli(["howto", "How do I send USDC?", "--from", "0x12", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /from must be a 0x address/);
    const mainnet = await cli(["howto", "How do I send USDC?", "--execute", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(mainnet.code, 2);
    assert.match(mainnet.stderr, /--execute is limited to the Atlantic testnet/);
  });
});

describe("pharos-agent pay", () => {
  test("a request in words with an address book: each payment, the totals, the commands; the proof verifies but for its endpoint", async () => {
    const book = join(dir, "contacts.txt");
    await writeFile(book, "alice = 0x1111111111111111111111111111111111111111\nbob = 0x2222222222222222222222222222222222222222\n");
    const proof = join(dir, "pay.json");
    const run = await cli(["pay", "Pay", "alice", "25", "USDC", "and", "bob", "0.5", "USDC", "for", "lunch", "--contacts", book, "--rpc", fake.url, "--proof", proof]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Sender {7}0x912c9aDe24D44d8922f0866D8Dcb079f1363f647 \(the example's\), next nonce \d+\n/);
    assert.match(run.stdout, /\n {3}1\. 25 USDC to alice \(0x1111111111111111111111111111111111111111\)\n {6}would succeed, [\d,]+ gas, nonce \d+\n {6}cast send 0xC879C018dB60520F4355C26eD1a6D572cdAC1815 "transfer\(address,uint256\)" 0x1111111111111111111111111111111111111111 25000000 --private-key \$PRIVATE_KEY --rpc-url https:\/\/rpc\.pharos\.xyz\n/);
    assert.match(run.stdout, /\n {3}2\. 0\.5 USDC to bob \(0x2222222222222222222222222222222222222222\), for lunch\n/);
    assert.match(run.stdout, /\n {2}Verdict {6}READY: The 2 payments, 25\.5 USDC in all, ready: each dry-runs at block 5,000,000/);
    const verified = await cli(["verify", proof]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
  });

  test("a request not read whole, or --execute on mainnet, is refused before anything runs", async () => {
    const unknown = await cli(["pay", "Pay carol 5 USDC", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Who is "carol"\? Name an address \(0x…\), or a name in the address book \(none given\)\./);
    const mainnet = await cli(["pay", "Send 1 USDC to 0x1111111111111111111111111111111111111111", "--execute", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(mainnet.code, 2);
    assert.match(mainnet.stderr, /--execute is limited to the Atlantic testnet/);
  });
});

describe("pharos-agent invoice", () => {
  const STUDIO = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
  const INVOICE = `Invoice: INV-7\nFrom: Example Studio\nDesign work 15.00 USDC\nHosting 5.00 USDC\nTotal: 20 USDC\nPay to: ${STUDIO}\nThank you!\n`;

  test("an invoice file and your payees: the checks, the payment and its link; the proof verifies but for its endpoint", async () => {
    const file = join(dir, "invoice.txt");
    const book = join(dir, "payees.txt");
    await writeFile(file, INVOICE);
    await writeFile(book, `Example Studio = ${STUDIO}\n`);
    const proof = join(dir, "invoice", "proof", "invoice.json");
    const run = await cli(["invoice", file, "--payees", book, "--rpc", fake.url, "--proof", proof]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Invoice {6}INV-7 from Example Studio\n {2}Amount due {3}20 USDC\n {2}Pay to {7}0xB2749BD12f19C24a2244176658F3dF3e48e79553 \(Example Studio in your payees\)\n/);
    assert.match(run.stdout, /\n {2}Checks {7}ok {4}The figures add up: The 2 lines add up to the total, 20 USDC\.\n/);
    assert.match(run.stdout, /\n {2}Link {9}ethereum:0xC879C018dB60520F4355C26eD1a6D572cdAC1815@1672\/transfer\?address=0xB2749BD12f19C24a2244176658F3dF3e48e79553&uint256=20000000\n/);
    assert.match(run.stdout, /\n {2}Not read {5}Thank you!\n {2}Verdict {6}READY: Invoice INV-7 from Example Studio: 20 USDC to 0xB274…9553, ready to sign\./);
    const verified = await cli(["verify", proof]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
  });

  test("a new payee is held: exit 9; a payment link as the argument; an invoice that does not add up is refused before anything runs", async () => {
    const held = await cli(["invoice", `ethereum:${STUDIO}@1672?value=1e16`, "--rpc", fake.url]);
    assert.equal(held.code, 9, held.stderr);
    assert.match(held.stdout, /\n {2}Verdict {6}CHECK FIRST: Check first: a new payee\. The invoice asks for 0\.01 PROS to 0xB2749BD12f19C24a2244176658F3dF3e48e79553\./);
    const file = join(dir, "wrong.txt");
    await writeFile(file, INVOICE.replace("Total: 20 USDC", "Total: 25 USDC"));
    const wrong = await cli(["invoice", file, "--rpc", "http://127.0.0.1:9"]);
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /The 2 lines add up to 20 USDC, but the total says 25 USDC\./);
    const missing = await cli(["invoice", join(dir, "nowhere.txt"), "--rpc", "http://127.0.0.1:9"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /The invoice .*nowhere\.txt cannot be read/);
    const mainnet = await cli(["invoice", `ethereum:${STUDIO}@1672?value=1e16`, "--execute", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(mainnet.code, 2);
    assert.match(mainnet.stderr, /--execute is limited to the Atlantic testnet/);
  });
});

describe("pharos-agent recurring", () => {
  const SCHEDULE = "Rent: 25 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, monthly on the 1st\nTool: 2 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, weekly on Monday\n";

  test("a schedule with a store, run twice: what is owed, prepared; the store kept; the two proofs verify as one history", async () => {
    const file = join(dir, "schedule.txt");
    await writeFile(file, SCHEDULE);
    const store = join(dir, "recurring", "proof", "store.json");
    const proofs = [1, 2].map((k) => join(dir, "recurring", "proof", `run-${k}.json`));
    const first = await cli(["recurring", file, "--store", store, "--since", "2026-09-01", "--rpc", fake.url, "--proof", proofs[0]!]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /\n {2}Counting {5}from 2026-09-01 \(given\)\n/);
    assert.match(first.stdout, /\n {2}Owed {9}\d+, oldest first; this run takes \d+\n {4}1\. Rent, due 2026-09-01 \(\d+ days late\): 25 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553\n/);
    assert.match(first.stdout, /\n {2}Store {8}.*store\.json: 0 recorded as paid\n/);
    const kept = JSON.parse(await readFile(store, "utf8"));
    assert.deepEqual([kept.schema, kept.since, kept.paid], ["pharos-agent/recurring-store/1", "2026-09-01", []]);
    const second = await cli(["recurring", file, "--store", store, "--rpc", fake.url, "--proof", proofs[1]!]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /\n {2}Counting {5}from 2026-09-01 \(the store's start\)\n/);
    const verified = await cli(["verify", ...proofs]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint", "  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /PASS {2}one history: 2 runs, each from the store the last one left; 0 payments recorded, each once/);
  });

  test("a line not read, --execute without a store or on mainnet, a bad day: refused before anything runs", async () => {
    const file = join(dir, "bad-schedule.txt");
    await writeFile(file, "Rent: 25 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, now and then\n");
    const bad = await cli(["recurring", file, "--rpc", "http://127.0.0.1:9"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /"now and then" is not a rule the agent reads/);
    const unkept = await cli(["recurring", file, "--network", "atlantic-testnet", "--execute", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(unkept.code, 2);
    assert.match(unkept.stderr, /--execute needs --store FILE/);
    const mainnet = await cli(["recurring", file, "--store", join(dir, "s.json"), "--execute", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(mainnet.code, 2);
    assert.match(mainnet.stderr, /--execute is limited to the Atlantic testnet/);
    const day = await cli(["recurring", file, "--since", "1 Sept", "--rpc", "http://127.0.0.1:9"]);
    assert.equal(day.code, 2);
    assert.match(day.stderr, /--since must be a day as YYYY-MM-DD/);
  });
});

describe("pharos-agent x402", () => {
  // For these, the chain's USDC is an EIP-3009 token, as Circle's is.
  before(() => {
    Object.assign(fake.state.tokens[USDC]!, { name: "USD Coin", symbol: "USDC", eip3009: { version: "2" } });
  });
  after(() => {
    for (const key of ["name", "symbol", "eip3009"] as const) delete fake.state.tokens[USDC]![key];
  });
  // The well-known Hardhat/Anvil test key #2, as the facilitator's: public, only ever used here on a fake chain.
  const FACILITATOR_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
  const FACILITATOR = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
  const TUSDC = "0xe0be08c77f415f577a1b3a9ad7a1df1479564ec8";
  const RECIPIENT = "0xb2749bd12f19c24a2244176658f3df3e48e79553";
  const atlanticChain = () => startFakeChain(defaultState({ chainId: 688689, headTime: BigInt(Math.floor(Date.now() / 1000)), native: { [FACILITATOR]: 10n ** 18n }, tokens: { [TUSDC]: { decimals: 6, name: "USD Coin", symbol: "USDC", eip3009: { version: "2" }, balances: { [KEY_ADDRESS]: 3_000_000n } } } }));

  test("on mainnet: the 402 terms, a key made for the run signs, the facilitator refuses it; exit 9; the proof verifies but for its endpoint", async () => {
    const proofPath = join(dir, "x402", "mainnet.json");
    const run = await cli(["x402", "--rpc", fake.url, "--proof", proofPath]);
    assert.equal(run.code, 9, run.stderr);
    assert.match(run.stdout, /\n {2}Asset {8}USD Coin \(USDC\) at 0xC879C018dB60520F4355C26eD1a6D572cdAC1815, version 2, 6 decimals: EIP-3009\n {2}Endpoint {5}GET \/data, 0\.001 USDC a request, paid to 0xB2749BD12f19C24a2244176658F3dF3e48e79553\n {2}Client {7}a key made for this run, holding nothing: 0x[0-9a-fA-F]{40}; pays at most 0\.001 USDC a request\n {2}Facilitator {2}verifies only: it holds no key, so nothing can be sent\n/);
    assert.match(run.stdout, /\n {4}4\. the facilitator · verify: Refused: the payer does not hold the amount \(invalid_exact_evm_insufficient_balance\)\.\n/);
    assert.match(run.stdout, /\n {2}Verdict {6}REFUSED: The endpoint asked 0\.001 USDC; a key made for this run, holding nothing \(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}\), signed for it, and the facilitator refused it on Pharos Mainnet: the payer does not hold the amount\. The data stayed locked\.\n {2}\d+ Chain MCP calls\. No transaction was sent\.\n$/);
    const verified = await cli(["verify", proofPath]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /PASS {2}nothing sent: a facilitator without a key: no transaction sent/);
  });

  test("--execute on Atlantic: paid with PRIVATE_KEY, settled with FACILITATOR_PRIVATE_KEY through the official server run locally, the data received; the proof fully verifies", async () => {
    const atlantic = await atlanticChain();
    try {
      const proofPath = join(dir, "x402", "atlantic.json");
      const run = await cli(["x402", "--network", "atlantic-testnet", "--execute", "--price", "0.25", "--cap", "1", "--rpc", atlantic.url, "--proof", proofPath], { PRIVATE_KEY: KEY, FACILITATOR_PRIVATE_KEY: FACILITATOR_KEY });
      assert.equal(run.code, 0, run.stderr + run.stdout);
      assert.match(run.stdout, /\n {2}Client {7}PRIVATE_KEY's address, 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; pays at most 1 USDC a request\n {2}Facilitator {2}settles with 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC\n/);
      assert.match(run.stdout, /\n {2}Data {9}\{"network":"eip155:688689","chainId":688689,"block":\{"number":"5000000",/);
      assert.match(run.stdout, /\n {2}Verdict {6}PAID: Paid and served: 0\.25 USDC from 0x7099…79C8 to 0xB274…9553, settled in 0x[0-9a-f]{64}, and the data released for it\.\n {2}\d+ Chain MCP calls\. One transaction sent, by the facilitator: 0x[0-9a-f]{64}\.\n$/);
      assert.deepEqual([atlantic.state.tokens[TUSDC]!.balances[KEY_ADDRESS], atlantic.state.tokens[TUSDC]!.balances[RECIPIENT]], [2_750_000n, 250_000n]);
      const proof = await readFile(proofPath, "utf8");
      for (const key of [KEY, FACILITATOR_KEY]) assert.ok(!proof.toLowerCase().includes(key.slice(2)), "no key is in the proof");
      const verified = await cli(["verify", proofPath]);
      assert.equal(verified.code, 0, verified.stdout);
      assert.match(verified.stdout, /PASS {2}settlement: 0x[0-9a-f]{64}: transferWithAuthorization of exactly the signed authorization, sent by the facilitator 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; its receipt a success, holding the Transfer of 250000 base units to 0xB2749BD12f19C24a2244176658F3dF3e48e79553/);
    } finally {
      await atlantic.close();
    }
  });

  test("serve and pay on Atlantic: a real HTTP API, 402 then paid with x402 pay, settled by the built-in facilitator; stopped cleanly", async () => {
    const atlantic = await atlanticChain();
    const child = spawn(process.execPath, [CLI, "x402", "serve", "--network", "atlantic-testnet", "--execute", "--price", "0.5", "--port", "0", "--rpc", atlantic.url], { env: { PATH: process.env.PATH ?? "", FACILITATOR_PRIVATE_KEY: FACILITATOR_KEY } });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no URL in time: ${stdout} ${stderr}`)), 30_000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          // The banner's last line: everything before it is in.
          const found = /Serving {6}(http:\/\/127\.0\.0\.1:\d+)[^]*Stop it {6}Ctrl-C\n/.exec(stdout);
          if (found) {
            clearTimeout(timer);
            resolve(found[1]!);
          }
        });
        void exited.then((code) => reject(new Error(`exited ${code}: ${stderr}`)));
      });
      assert.match(stdout, /\n {2}Facilitator {2}http:\/\/127\.0\.0\.1:\d+\/facilitator \(POST \/verify, POST \/settle, GET \/supported\), settles with 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC\n/);
      const terms = (await (await fetch(`${url}/`)).json()) as { x402: string; paid: { path: string; amount: string; asset: string; payTo: string }[]; facilitator: string; settles: boolean };
      assert.deepEqual([terms.x402, terms.paid[0]!.path, terms.paid[0]!.amount, terms.paid[0]!.payTo, terms.facilitator, terms.settles], ["eip155:688689", "/data", "500000", "0xB2749BD12f19C24a2244176658F3dF3e48e79553", `${url}/facilitator`, true]);
      assert.equal((await fetch(`${url}/data`)).status, 402);
      const supported = (await (await fetch(`${url}/facilitator/supported`)).json()) as { kinds: { network: string }[] };
      assert.deepEqual(supported.kinds.map((k) => k.network), ["eip155:688689"]);
      const capped = await cli(["x402", "pay", `${url}/data`, "--network", "atlantic-testnet"], { PRIVATE_KEY: KEY });
      assert.equal(capped.code, 9);
      assert.match(capped.stdout, /\n {2}Not paid {5}.*maxAmountPerPayment/);
      const paid = await cli(["x402", "pay", `${url}/data`, "--network", "atlantic-testnet", "--cap", "1"], { PRIVATE_KEY: KEY });
      assert.equal(paid.code, 0, paid.stdout + paid.stderr);
      assert.match(paid.stdout, /\n {2}402 asked {4}500000 base units of 0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8 to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, on eip155:688689, by the exact scheme\n {2}Signed {7}an EIP-3009 authorization: 500000 base units to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, valid until \S+\n {2}Settled {6}0x[0-9a-f]{64} on eip155:688689\n {2}Answer {7}200: \{"network":"eip155:688689"/);
      assert.equal(atlantic.state.tokens[TUSDC]!.balances[RECIPIENT], 500_000n);
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
      assert.match(stderr, /Stopped: 1 paid request served, each settled, \d+ Chain MCP calls\./);
    } finally {
      child.kill("SIGKILL");
      await atlantic.close();
    }
  });

  test("refused before anything runs: --execute or pay off Atlantic, a bad recipient, price, token or subcommand", async () => {
    for (const [args, pattern, env] of [
      [["x402", "--execute"], /--execute is limited to the Atlantic testnet/, { PRIVATE_KEY: KEY }],
      [["x402", "pay", "http://127.0.0.1:9/data"], /limited to the Atlantic testnet/, { PRIVATE_KEY: KEY }],
      [["x402", "pay", "nowhere", "--network", "atlantic-testnet"], /x402 pay needs one http\(s\) URL/, { PRIVATE_KEY: KEY }],
      [["x402", "pay", "http://127.0.0.1:9/data", "--network", "atlantic-testnet"], /Executing needs PRIVATE_KEY/, {}],
      [["x402", "--to", "0x12"], /--to must be a 0x address/, {}],
      [["x402", "--to", USDC], /--to is the asset's own contract/, {}],
      [["x402", "--price", "abc"], /--price must be a number of the asset/, {}],
      [["x402", "--token", "PEPE"], /"PEPE" is not an official Pharos Mainnet token/, {}],
      [["x402", "mint"], /x402 takes run \(the default\), serve, or pay URL/, {}],
      [["x402", "serve", "--cap", "1"], /--cap is the paying client's/, {}],
      [["x402", "serve", "--port", "http"], /--port must be a port number/, {}],
      [["x402", "serve", "--network", "atlantic-testnet", "--execute", "--facilitator", "http://127.0.0.1:9"], /--execute settles with the built-in facilitator/, { PRIVATE_KEY: KEY }],
    ] as const) {
      const run = await cli([...args, "--rpc", "http://127.0.0.1:9"], env);
      assert.equal(run.code, 2, `${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, pattern, args.join(" "));
    }
  });
});

describe("pharos-agent buy", () => {
  // For these, the chain's USDC is an EIP-3009 token, as Circle's is.
  before(() => {
    Object.assign(fake.state.tokens[USDC]!, { name: "USD Coin", symbol: "USDC", eip3009: { version: "2" } });
  });
  after(() => {
    for (const key of ["name", "symbol", "eip3009"] as const) delete fake.state.tokens[USDC]![key];
  });
  // The well-known Hardhat/Anvil test key #2, as the API's facilitator's: public, only ever used here on a fake chain.
  const FACILITATOR_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
  const FACILITATOR = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
  const TUSDC = "0xe0be08c77f415f577a1b3a9ad7a1df1479564ec8";
  const TRADER = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
  // The buyer's USDC and PHRS, the facilitator's PHRS, and a history with the trader: its check looks fine.
  const atlanticChain = () => startFakeChain(defaultState({ chainId: 688689, headTime: BigInt(Math.floor(Date.now() / 1000)), native: { [FACILITATOR]: 10n ** 18n, [KEY_ADDRESS]: 10n ** 18n }, tokens: { [TUSDC]: { decimals: 6, name: "USD Coin", symbol: "USDC", eip3009: { version: "2" }, balances: { [KEY_ADDRESS]: 30_000_000n } } }, transfers: [{ token: TUSDC, from: KEY_ADDRESS, to: TRADER.toLowerCase(), amount: 5_000_000n, block: 4_999_000n }] }));

  test("on mainnet: the prices asked, the plan, the first purchase refused on chain; exit 9; the proof verifies but for its endpoint", async () => {
    const proofPath = join(dir, "buyer", "mainnet.json");
    const run = await cli(["buy", "--rpc", fake.url, "--proof", proofPath]);
    assert.equal(run.code, 9, run.stderr);
    assert.match(run.stdout, /\n {2}Job {10}Send 25 USDC from 0x912c…f647 to 0xB274…9553\n {2}Budget {7}0\.01 USDC, paid by a key made for this run, holding nothing: 0x[0-9a-fA-F]{40}\n {2}API {10}in this process \(its facilitator verifies only\), paid to 0x1F3546a29EeC2102c8d52E21a45114124014c85C\n/);
    assert.match(run.stdout, /\n {2}Plan\n {4}1\. \/risk {4}0\.005 USDC {3}refused: the payer does not hold the amount\n {4}2\. \/dryrun {2}0\.003 USDC {3}not bought: the API refused the payment for the risk check: the payer does not hold the amount\n/);
    assert.match(run.stdout, /\n {2}Verdict {6}NOT DONE: Not done: Send 25 USDC from 0x912c…f647 to 0xB274…9553: the API refused the payment for the risk check: the payer does not hold the amount\. Nothing bought; 0\.005 USDC signed for of the 0\.01 USDC budget, 0 USDC settled\.\n/);
    const verified = await cli(["verify", proofPath]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /PASS {2}nothing sent: the API's facilitator holds no key: no transaction sent/);
  });

  test("--execute on Atlantic: the check and the dry run bought and settled, the transfer ready to sign; the proof fully verifies", async () => {
    const atlantic = await atlanticChain();
    try {
      const proofPath = join(dir, "buyer", "atlantic.json");
      const run = await cli(["buy", "--network", "atlantic-testnet", "--execute", "--to", TRADER, "--rpc", atlantic.url, "--proof", proofPath], { PRIVATE_KEY: KEY, FACILITATOR_PRIVATE_KEY: FACILITATOR_KEY });
      assert.equal(run.code, 0, run.stderr + run.stdout);
      assert.match(run.stdout, /\n {2}API {10}in this process \(its facilitator settles with 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC\), paid to 0x1F3546a29EeC2102c8d52E21a45114124014c85C\n/);
      assert.match(run.stdout, /\n {2}Ledger {7}0\.008 USDC signed for, 0\.008 USDC settled, 0\.002 USDC left\n {2}To sign {6}\{"from":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","to":"0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8","data":"0xa9059cbb/);
      assert.match(run.stdout, /\n {2}Verdict {6}READY: Ready to sign: Send 25 USDC from 0x7099…79C8 to 0x1F35…c85C\./);
      assert.equal(atlantic.state.tokens[TUSDC]!.balances[TRADER.toLowerCase()], 8_000n, "the API (paid to the sample address) received 0.008 USDC");
      const proof = await readFile(proofPath, "utf8");
      for (const key of [KEY, FACILITATOR_KEY]) assert.ok(!proof.toLowerCase().includes(key.slice(2)), "no key is in the proof");
      const verified = await cli(["verify", proofPath]);
      assert.equal(verified.code, 0, verified.stdout);
      assert.match(verified.stdout, /PASS {2}answers recomputed: risk and dryrun, each recomputed from its recorded calls/);
    } finally {
      await atlantic.close();
    }
  });

  test("--api: bought from x402 serve over HTTP, settled by its facilitator; ready", async () => {
    const atlantic = await atlanticChain();
    const child = spawn(process.execPath, [CLI, "x402", "serve", "--network", "atlantic-testnet", "--execute", "--port", "0", "--rpc", atlantic.url], { env: { PATH: process.env.PATH ?? "", FACILITATOR_PRIVATE_KEY: FACILITATOR_KEY } });
    let stdout = "";
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no URL in time: ${stdout}`)), 30_000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          const found = /Serving {6}(http:\/\/127\.0\.0\.1:\d+)[^]*Stop it {6}Ctrl-C\n/.exec(stdout);
          if (found) {
            clearTimeout(timer);
            resolve(found[1]!);
          }
        });
        void exited.then((code) => reject(new Error(`exited ${code}`)));
      });
      assert.match(stdout, /\n {15}GET http:\/\/127\.0\.0\.1:\d+\/risk\?asset=…&from=…&to=…&amount=…, 0\.005 USDC a request\n/);
      const run = await cli(["buy", "--network", "atlantic-testnet", "--execute", "--to", TRADER, "--api", url], { PRIVATE_KEY: KEY });
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.match(run.stdout, new RegExp(`\\n {2}API {10}${url.replace(/[.]/g, "\\.")}\\n`));
      assert.match(run.stdout, /\n {2}Verdict {6}READY: /);
      assert.match(run.stdout, /\n {2}Settled: 0x[0-9a-f]{64}, 0x[0-9a-f]{64}\.\n$/);
    } finally {
      child.kill("SIGTERM");
      await exited;
      await atlantic.close();
    }
  });

  test("refused before anything runs: --execute off Atlantic, a proof of an API elsewhere, a vendor for one, a bad budget or recipient", async () => {
    for (const [args, pattern, env] of [
      [["buy", "--execute"], /--execute is limited to the Atlantic testnet/, { PRIVATE_KEY: KEY }],
      [["buy", "--api", "http://127.0.0.1:9", "--proof", join(dir, "nope.json")], /A proof records the API's Chain MCP calls/, {}],
      [["buy", "--api", "http://127.0.0.1:9", "--vendor", TRADER], /--vendor is for the API in this process/, {}],
      [["buy", "--api", "ftp://x"], /--api must be an http\(s\) URL/, {}],
      [["buy", "--budget", "lots"], /--budget must be a number of USDC/, {}],
      [["buy", "--to", "0x12"], /The recipient \(to\) must be a 0x address/, {}],
      [["buy", "--token", "DOGE"], /asset must be PROS or one of/, {}],
    ] as const) {
      const run = await cli([...args, "--rpc", "http://127.0.0.1:9"], env);
      assert.equal(run.code, 2, `${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, pattern, args.join(" "));
    }
  });
});

describe("pharos-agent batch", () => {
  const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
  const STAFF = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
  const SPENDER = "0x3333333333333333333333333333333333333333";

  test("the example on mainnet: merged, independent, one nonce sequence, the savings counted; the proof verifies but for its endpoint", async () => {
    const proofPath = join(dir, "batch", "mainnet.json");
    const run = await cli(["batch", "--rpc", fake.url, "--proof", proofPath]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\n {2}Sender {7}0x912c9aDe24D44d8922f0866D8Dcb079f1363f647 \(the example's\), next nonce \d+\n {2}Batch {8}4 actions; merged: lines 1, 3 into transaction 1\n/);
    assert.match(run.stdout, /\n {3}1\. Send 30 USDC to 0xB274…9553 \(lines 1, 3\), rent; utilities\n {6}in the plan: would succeed, [\d,]+ gas, nonce \d+\n/);
    assert.match(run.stdout, /\n {2}Independent {2}ok {3}One sender: Every action is signed by 0x912c…f647/);
    assert.match(run.stdout, /\n {15}ok {3}USDC: The 2 sends take 40 USDC in all; 0x912c…f647 holds 1,000 USDC, enough in any order\.\n/);
    assert.match(run.stdout, /\n {2}Savings {6}21 Chain MCP calls for the plan; its dry runs one by one ask 36\. 3 transactions for 4 lines\.\n/);
    assert.match(run.stdout, /\n {2}Verdict {6}READY: Ready: 4 actions in 3 transactions \(lines 1 and 3 merged\), independent/);
    assert.match(run.stdout, /\n {2}To sign {6}\[\{"chainId":1672,"nonce":\d+,"to":"0xC879C018dB60520F4355C26eD1a6D572cdAC1815"/);
    const verified = await cli(["verify", proofPath]);
    assert.deepEqual(verified.stdout.split("\n").filter((line) => line.startsWith("  FAIL")).map((line) => line.split(":")[0]), ["  FAIL  hosted endpoint"]);
    assert.match(verified.stdout, /PASS {2}calls counted: 21 calls before any send/);
  });

  test("a batch from a file or standard input; not a batch: exit 9; refused before anything runs", async () => {
    const file = join(dir, "batch.txt");
    await writeFile(file, `approve 100 USDC for ${SPENDER}\nrevoke USDC for ${SPENDER}\n`);
    const twice = await cli(["batch", file, "--rpc", fake.url]);
    assert.equal(twice.code, 9, twice.stderr);
    assert.match(twice.stdout, /\n {2}Verdict {6}NOT A BATCH: Not a batch: lines 1 and 2 both set 0x3333…3333's USDC allowance/);
    const piped = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, "batch", "-", "--no-merge", "--rpc", fake.url], { env: { PATH: process.env.PATH ?? "" } });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.once("exit", (code) => resolve({ code, stdout }));
      child.stdin.end(`send 1 USDC to ${RECIPIENT}\nsend 2 USDC to ${RECIPIENT}\n`);
    });
    assert.equal(piped.code, 0, piped.stdout);
    assert.match(piped.stdout, /\n {2}Batch {8}2 actions \(--no-merge\)\n/);
    for (const [args, pattern, env] of [
      [["batch", file, "--execute"], /--execute is limited to the Atlantic testnet/, { PRIVATE_KEY: KEY }],
      [["batch", "--network", "atlantic-testnet"], /On Atlantic, give the batch/, {}],
      [["batch", join(dir, "nowhere.txt")], /The batch .*nowhere\.txt cannot be read/, {}],
      [["batch", "--from", "0x12"], /--from must be a 0x address/, {}],
      [["batch", file, "extra"], /batch takes one batch/, {}],
    ] as const) {
      const run = await cli([...args, "--rpc", "http://127.0.0.1:9"], env);
      assert.equal(run.code, 2, `${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, pattern, args.join(" "));
    }
    const unread = join(dir, "unread.txt");
    await writeFile(unread, "send 1 USDC\n");
    const refused = await cli(["batch", unread, "--rpc", "http://127.0.0.1:9"]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /Line 1 cannot be read: "send 1 USDC"/);
  });

  test("--execute on Atlantic: sent back to back, every value compared; the proof fully verifies", async () => {
    const TUSDC = "0xe0be08c77f415f577a1b3a9ad7a1df1479564ec8";
    const atlantic = await startFakeChain(defaultState({ chainId: 688689, mineOnPoll: true, native: { [KEY_ADDRESS]: 10n ** 18n }, tokens: { [TUSDC]: { decimals: 6, balances: { [KEY_ADDRESS]: 5_000_000n } } } }));
    try {
      const file = join(dir, "atlantic-batch.txt");
      await writeFile(file, `send 1 USDC to ${RECIPIENT} # rent\nsend 0.5 USDC to ${STAFF}\nsend 0.001 PHRS to ${STAFF}\n`);
      const proofPath = join(dir, "batch", "atlantic.json");
      const run = await cli(["batch", file, "--network", "atlantic-testnet", "--execute", "--rpc", atlantic.url, "--proof", proofPath], { PRIVATE_KEY: KEY });
      assert.equal(run.code, 0, run.stderr + run.stdout);
      assert.match(run.stdout, /\n {2}Sent {9}3 back to back from nonce 0, in blocks 5,000,001 to 5,000,001 \(1\); \d+ Chain MCP calls\n/);
      assert.match(run.stdout, /\n {15}ok {3}Sender USDC: predicted −1\.5 USDC, actual −1\.5 USDC\n/);
      assert.match(run.stdout, /\n {2}Verdict {6}SENT: Sent: 3 transactions back to back, nonces 0 to 2, all in block 5,000,001/);
      const proof = await readFile(proofPath, "utf8");
      assert.ok(!proof.toLowerCase().includes(KEY.slice(2)), "no key is in the proof");
      const verified = await cli(["verify", proofPath]);
      assert.equal(verified.code, 0, verified.stdout);
      assert.match(verified.stdout, /PASS {2}sent back to back: 3 sent, with no receipt asked between two sends/);
    } finally {
      await atlantic.close();
    }
  });
});
