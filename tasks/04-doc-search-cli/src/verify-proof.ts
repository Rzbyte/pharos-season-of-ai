#!/usr/bin/env node
// npm run verify-proof: re-check the committed proof files without any network request.
import { readFile } from "node:fs/promises";
import { PROOF_QUERIES, verifyRun, type Transcript } from "./proof.js";

let failed = false;
try {
  for (const query of PROOF_QUERIES) {
    const transcript = JSON.parse(await readFile(`proof/query-${query.id}.json`, "utf8")) as Transcript;
    const output = await readFile(`sample-output/query-${query.id}.txt`, "utf8");
    process.stdout.write(`[${query.id}] ${query.question}\n`);
    for (const check of verifyRun(transcript, output, query.expect)) {
      process.stdout.write(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
      if (!check.ok) failed = true;
    }
  }
} catch (error) {
  process.stderr.write(`Proof not verified: ${error instanceof Error ? error.message : String(error)}\n`);
  failed = true;
}
if (failed) process.exitCode = 1;
else process.stdout.write("Proof verified.\n");
