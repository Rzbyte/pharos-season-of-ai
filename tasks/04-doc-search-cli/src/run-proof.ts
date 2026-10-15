#!/usr/bin/env node
// npm run proof: run the three README examples through the real CLI against https://docs.pharos.xyz,
// save each run's full request transcript and printed output, verify them, and only then write the
// README's example and proof sections. Nothing is written to the README from a failed or unverified run.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { formatJson } from "./formatter.js";
import { applyProof, PROOF_QUERIES, verifyRun, type Example, type Transcript } from "./proof.js";
import { run } from "./run.js";

// Fresh checkouts have neither directory; the transcripts and outputs below are written into them.
await mkdir("proof", { recursive: true });
await mkdir("sample-output", { recursive: true });

const examples: Example[] = [];
let json = "";
let failed = false;
const summary: string[] = [];

for (const query of PROOF_QUERIES) {
  const transcriptFile = `proof/query-${query.id}.json`;
  const outputFile = `sample-output/query-${query.id}.txt`;
  let output = "";
  const code = await run([query.question, "--no-cache", "--transcript", transcriptFile], {
    stdout: (text) => void (output += text),
    stderr: (text) => void (output += text),
    env: { ...process.env, PHAROS_DOCS_FETCH_ORIGIN: "" },
  });
  await writeFile(outputFile, output, "utf8");
  const transcript = JSON.parse(await readFile(transcriptFile, "utf8")) as Transcript;
  if (query.id === "a") {
    json = formatJson(transcript.result);
    await writeFile("sample-output/query-a.json", json, "utf8");
  }
  const checks = verifyRun(transcript, output, query.expect);
  process.stdout.write(`\n[${query.id}] ${query.label}: pharos-docs "${query.question}" -> exit ${code}\n`);
  for (const check of checks) process.stdout.write(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  if (checks.some((check) => !check.ok)) failed = true;
  examples.push({ id: query.id, label: query.label, question: query.question, output });
  summary.push(
    `- **${query.label}** ("${query.question}"): ${transcript.result.status}${transcript.result.reason ? ` (${transcript.result.reason})` : ""}, ` +
      `${transcript.requests.length} HTTPS requests to docs.pharos.xyz, ${checks.filter((c) => c.ok).length}/${checks.length} checks passed. Transcript: [${transcriptFile}](${transcriptFile}).`,
  );
}

if (failed) {
  process.stderr.write("\nProof NOT verified; README.md left unchanged. The transcripts and outputs above show why.\n");
  process.exitCode = 1;
} else {
  const when = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const readme = await readFile("README.md", "utf8");
  const status = [`**Live proof:** captured ${when} against \`https://docs.pharos.xyz\` by \`npm run proof\`, and verified from the saved requests and response bodies (\`npm run verify-proof\`).`, "", ...summary];
  await writeFile("README.md", applyProof(readme, examples, json, status), "utf8");
  process.stdout.write("\nProof verified; README.md examples and proof section updated.\n");
}
