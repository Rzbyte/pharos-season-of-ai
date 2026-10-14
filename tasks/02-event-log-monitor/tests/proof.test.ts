import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { HOSTED_ENDPOINT } from "../src/constants.js";
import { applyProof, MARKERS, printedEvents, verifyProof, type ProofResult } from "../src/proof.js";
import { run } from "../src/run.js";
import { startFakePharosMcp, type FakeLogChain } from "./fake-pharos-mcp.js";
import { makeLog, ZERO } from "./fixtures.js";

// A proof-shaped run against the in-process fake. Its endpoint is rewritten to the hosted URL only so
// the verifier's other checks can be exercised; nothing here is, or is used as, live proof.
type Json = Record<string, any>;
interface Run {
  transcript: Json;
  report: Json;
  output: string;
}

let dir: string;
let baseline: Run;

async function proofRun(chain: FakeLogChain, args: string[]): Promise<Run> {
  const server = await startFakePharosMcp(chain);
  const files = { transcript: join(dir, `t${Math.random()}.json`), report: join(dir, `r${Math.random()}.json`), output: join(dir, `o${Math.random()}.txt`) };
  try {
    const code = await run([...args, "--endpoint", server.url, "--transcript", files.transcript, "--report", files.report, "--save-output", files.output], {
      stdout: () => undefined,
      stderr: () => undefined,
      env: {},
      isTTY: false,
      retryDelayMs: 1,
      sleep: async () => undefined,
    });
    assert.equal(code, 0);
  } finally {
    await server.close();
  }
  const transcript = JSON.parse(await readFile(files.transcript, "utf8")) as Json;
  const report = JSON.parse(await readFile(files.report, "utf8")) as Json;
  transcript.endpoint = HOSTED_ENDPOINT;
  report.endpoint = HOSTED_ENDPOINT;
  return { transcript, report, output: await readFile(files.output, "utf8") };
}

const clone = (value: Run): Run => structuredClone(value);
const verify = (value: Run) => verifyProof(value.transcript, value.report, value.output);
const failed = (result: ProofResult) => result.checks.filter((check) => !check.ok).map((check) => check.name);
/** The tools/call request messages for one tool, in order. */
const requests = (value: Run, tool: string) => value.transcript.messages.map((entry: Json) => entry.message).filter((m: Json) => m.method === "tools/call" && m.params.name === tool);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "elm-proof-"));
  const chain: FakeLogChain = {
    head: 20_248_479n,
    logs: [makeLog({ block: 20_248_400n, index: 2 }), makeLog({ block: 20_248_470n, from: ZERO })],
    beforeBlockNumber: (n, c) => {
      if (n === 1) return;
      c.head += 3n;
      c.logs.push(makeLog({ block: c.head - 1n, index: n }));
    },
  };
  baseline = await proofRun(chain, ["--watch", "--lookback", "100", "--cycles", "3"]);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("verifyProof", () => {
  test("a clean watch run verifies, every check passing", () => {
    const result = verify(baseline);
    assert.deepEqual(failed(result), []);
    assert.equal(result.ok, true);
    assert.equal(result.evidence?.events, 4);
    assert.equal(result.evidence?.eventsAfterStart, 2);
    assert.equal(result.evidence?.getLogsCalls, 3);
    assert.equal(result.evidence?.chainId, 1672);
  });

  test("a run with a failed range that was repeated still verifies", async () => {
    const value = await proofRun({ head: 500n, logs: [makeLog({ block: 450n })], getLogsFailures: 1 }, ["--blocks", "100"]);
    assert.deepEqual(failed(verify(value)), []);
    assert.equal(requests(value, "get_logs").length, 2);
  });

  test("refuses a run against another endpoint", () => {
    const value = clone(baseline);
    value.transcript.endpoint = "http://127.0.0.1:1234/mcp";
    assert.deepEqual(failed(verify(value)), ["hosted endpoint"]);
  });

  test("refuses another chain ID", () => {
    const value = clone(baseline);
    const id = requests(value, "get_chain_info")[0].id;
    const response = value.transcript.messages.find((entry: Json) => entry.message.id === id && entry.direction === "server->client").message;
    response.result.content[0].text = response.result.content[0].text.replace('"chainId": 1672', '"chainId": 1');
    assert.ok(failed(verify(value)).includes("chain ID 1672"));
  });

  test("refuses a get_logs call without the exact address or topic", () => {
    const wrongAddress = clone(baseline);
    requests(wrongAddress, "get_logs")[0].params.arguments.address = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
    assert.ok(failed(verify(wrongAddress)).includes("exact address and Transfer topic filter"));

    const noTopic = clone(baseline);
    delete requests(noTopic, "get_logs")[1].params.arguments.topics;
    assert.ok(failed(verify(noTopic)).includes("exact address and Transfer topic filter"));
  });

  test("refuses latest, over-1,000-block, overlapping or gapped ranges", () => {
    const latest = clone(baseline);
    requests(latest, "get_logs")[1].params.arguments.toBlock = "latest";
    assert.ok(failed(verify(latest)).includes("explicit ranges of at most 1,000 blocks, contiguous"));

    const wide = clone(baseline);
    requests(wide, "get_logs")[0].params.arguments.fromBlock = `0x${(20_248_479n - 1_000n).toString(16)}`;
    assert.ok(failed(verify(wide)).includes("explicit ranges of at most 1,000 blocks, contiguous"));

    const gap = clone(baseline);
    const second = requests(gap, "get_logs")[1].params.arguments;
    second.fromBlock = `0x${(BigInt(second.fromBlock) + 1n).toString(16)}`;
    assert.ok(failed(verify(gap)).includes("explicit ranges of at most 1,000 blocks, contiguous"));
  });

  test("refuses a tool outside the three the monitor uses", () => {
    const value = clone(baseline);
    requests(value, "get_logs")[0].params.name = "eth_call";
    assert.ok(failed(verify(value)).includes("only Chain MCP tool calls"));
  });

  test("refuses a decoded value that does not match the raw log", () => {
    for (const mutate of [
      (event: Json) => (event.from = event.to),
      (event: Json) => (event.amount.raw = "1"),
      (event: Json) => (event.blockNumber = "1"),
      (event: Json) => (event.type = "Burn"),
    ]) {
      const value = clone(baseline);
      mutate(value.report.events[0]);
      value.transcript.outcome.report.events = value.report.events;
      assert.ok(failed(verify(value)).includes("decoded fields match raw topics and data"));
    }
  });

  test("refuses duplicate events, in the report or in the printed output", () => {
    const report = clone(baseline);
    report.report.events.push(report.report.events[0]);
    report.transcript.outcome.report.events = report.report.events;
    assert.ok(failed(verify(report)).includes("dedup by transactionHash + logIndex, nothing missed"));

    const output = clone(baseline);
    const block = /^Transfer .+\n(?:  .+\n){5}/m.exec(output.output)![0];
    output.output = output.output.replace(block, `${block}\n${block}`);
    assert.ok(failed(verify(output)).includes("no duplicate event output"));
  });

  test("refuses a run that left a returned Transfer log unreported", () => {
    const value = clone(baseline);
    value.report.events.shift();
    value.transcript.outcome.report.events = value.report.events;
    assert.ok(failed(verify(value)).includes("dedup by transactionHash + logIndex, nothing missed"));
  });

  test("refuses a run without any event", async () => {
    const value = await proofRun({ head: 500n, logs: [] }, ["--blocks", "10"]);
    assert.ok(failed(verify(value)).includes("caught at least one real Transfer event"));
  });

  test("printedEvents reads tx hash and log index pairs from the text output", () => {
    const pairs = printedEvents(baseline.output);
    assert.equal(pairs.length, 4);
    assert.ok(pairs.every((pair) => /^0x[0-9a-f]{64}$/.test(pair.tx)));
  });
});

describe("applyProof", () => {
  const readme = [
    "# Task 02",
    "- [ ] Demonstrates catching at least one live event <!-- req-4 -->",
    MARKERS.statusStart,
    "_pending_",
    MARKERS.statusEnd,
    MARKERS.outputStart,
    "_pending_",
    MARKERS.outputEnd,
  ].join("\n");
  const links = { transcript: "proof/mcp-transcript.json", report: "proof/report.json", output: "sample-output/live-run.txt" };

  test("fills the marked sections and ticks requirement 4", () => {
    const result = verify(baseline);
    const next = applyProof(readme, result, baseline.output, links);
    assert.match(next, /- \[x\] Demonstrates catching/);
    assert.match(next, /\*\*Live proof:\*\* captured .+ against `https:\/\/mcp\.pharos\.xyz\/mcp`/);
    assert.match(next, /\*\*4 Transfer events\*\* \(2 mined after the monitor started\)/);
    assert.ok(next.includes(baseline.output.trim()));
    assert.doesNotMatch(next, /_pending_/);
  });

  test("the real README has every marker and starts with requirement 4 open", async () => {
    const real = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    assert.match(real, /- \[ \] \*\*Demonstrates catching at least one live event\.\*\* <!-- req-4 -->/);
    const next = applyProof(real, verify(baseline), baseline.output, links);
    assert.match(next, /- \[x\] \*\*Demonstrates catching at least one live event\.\*\*/);
    assert.doesNotMatch(next, /Live proof:\*\* pending/);
  });

  test("refuses to write an unverified proof", () => {
    const value = clone(baseline);
    value.transcript.endpoint = "http://localhost/mcp";
    assert.throws(() => applyProof(readme, verify(value), value.output, links), /did not verify/);
  });
});
