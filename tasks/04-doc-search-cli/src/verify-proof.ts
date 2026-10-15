#!/usr/bin/env node
// npm run verify-proof: re-check the committed MCP proof files without any network request. Each result
// is recomputed from the raw responses saved in its transcript.
import { readFile } from "node:fs/promises";
import { PROOF_QUERIES, verifyMcpRun, type McpTranscript } from "./proof.js";

let failed = false;
try {
  for (const query of PROOF_QUERIES) {
    const transcript = JSON.parse(await readFile(`proof/query-${query.id}.json`, "utf8")) as McpTranscript;
    const output = await readFile(`sample-output/query-${query.id}.txt`, "utf8");
    process.stdout.write(`[${query.id}] ${query.question}\n`);
    for (const check of verifyMcpRun(transcript, output, query.expect)) {
      process.stdout.write(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
      if (!check.ok) failed = true;
    }
  }
} catch (error) {
  process.stderr.write(`Proof not verified: ${error instanceof Error ? error.message : String(error)}\nRun npm run proof where https://docs.pharos.xyz is reachable to capture it.\n`);
  failed = true;
}
if (failed) process.exitCode = 1;
else process.stdout.write("Proof verified.\n");
