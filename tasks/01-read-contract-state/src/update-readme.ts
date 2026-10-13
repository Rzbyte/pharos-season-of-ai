#!/usr/bin/env node
// Last step of `npm run proof`: copy the live run's output into README.md.
// Refuses (exit 1, README untouched) unless the run succeeded against the hosted endpoint.
import { readFile, writeFile } from "node:fs/promises";
import { applyLiveRun, evidenceFromRun } from "./readme-proof.js";

const README = "README.md";
const TRANSCRIPT = "proof/mcp-transcript.json";
const OUTPUT = "sample-output/live-run.txt";

try {
  const [readme, transcriptText, output] = await Promise.all([
    readFile(README, "utf8"),
    readFile(TRANSCRIPT, "utf8"),
    readFile(OUTPUT, "utf8"),
  ]);
  const evidence = evidenceFromRun(JSON.parse(transcriptText) as unknown, output);
  await writeFile(README, applyLiveRun(readme, evidence, { transcript: TRANSCRIPT, output: OUTPUT }), "utf8");
  process.stderr.write(`README.md updated from the live run at block ${evidence.blockNumber} (${evidence.ethCalls} eth_call reads).\n`);
} catch (error) {
  process.stderr.write(`README.md not updated: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
