#!/usr/bin/env node
// Checks the proof run's files from the raw MCP messages; with --update-readme, also writes the
// verified result into README.md. Exit 1 (README untouched) when any check fails.
import { readFile, writeFile } from "node:fs/promises";
import { applyProof, verifyProof } from "./proof.js";

const README = "README.md";
const TRANSCRIPT = "proof/mcp-transcript.json";
const REPORT = "proof/report.json";
const OUTPUT = "sample-output/live-run.txt";

try {
  const [transcriptText, reportText, output] = await Promise.all([readFile(TRANSCRIPT, "utf8"), readFile(REPORT, "utf8"), readFile(OUTPUT, "utf8")]);
  const result = verifyProof(JSON.parse(transcriptText) as unknown, JSON.parse(reportText) as unknown, output);
  for (const check of result.checks) process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  if (!result.ok) {
    process.stderr.write("Proof NOT verified.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`Proof verified: ${result.evidence?.events} Transfer events from ${TRANSCRIPT}.\n`);
    if (process.argv.includes("--update-readme")) {
      const readme = await readFile(README, "utf8");
      await writeFile(README, applyProof(readme, result, output, { transcript: TRANSCRIPT, report: REPORT, output: OUTPUT }), "utf8");
      process.stderr.write("README.md updated from the verified proof run.\n");
    }
  }
} catch (error) {
  process.stderr.write(`Proof not verified: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
