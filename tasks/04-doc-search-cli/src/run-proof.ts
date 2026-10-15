#!/usr/bin/env node
// npm run proof: run the three README examples through the real CLI against the Pharos Developer Docs MCP
// (https://docs.pharos.xyz/~gitbook/mcp), save each run's full JSON-RPC transcript (requests, raw event
// streams, the askQuestion answer, the result) and printed output, verify them, and only then write the
// README's example and proof sections. Nothing is written to the README from a failed or unverified run.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { MCP_ENDPOINT } from "./constants.js";
import { formatJson } from "./formatter.js";
import { applyProof, PROOF_QUERIES, verifyMcpRun, type Example, type McpTranscript } from "./proof.js";
import { run } from "./run.js";

// Fresh checkouts have neither directory; the transcripts and outputs below are written into them.
await mkdir("proof", { recursive: true });
await mkdir("sample-output", { recursive: true });

const examples: Example[] = [];
let json = "";
let failed = false;
let tools: string[] = [];
const summary: string[] = [];

for (const query of PROOF_QUERIES) {
  const transcriptFile = `proof/query-${query.id}.json`;
  const outputFile = `sample-output/query-${query.id}.txt`;
  let output = "";
  // --no-cache: every run lists the tools live, so each transcript shows the tool discovery too.
  const code = await run([query.question, "--no-cache", "--transcript", transcriptFile], {
    stdout: (text) => void (output += text),
    stderr: (text) => void (output += text),
    env: { ...process.env, PHAROS_DOCS_MCP_URL: "" },
  });
  await writeFile(outputFile, output, "utf8");
  let transcript: McpTranscript;
  try {
    transcript = JSON.parse(await readFile(transcriptFile, "utf8")) as McpTranscript;
  } catch {
    process.stdout.write(`\n[${query.id}] ${query.label}: pharos-docs "${query.question}" -> exit ${code}, no transcript written\n`);
    failed = true;
    continue;
  }
  if (query.id === "a") {
    json = formatJson(transcript.result);
    await writeFile("sample-output/query-a.json", json, "utf8");
    tools = (transcript.tools ?? []).map((tool) => tool.name);
  }
  const checks = verifyMcpRun(transcript, output, query.expect);
  process.stdout.write(`\n[${query.id}] ${query.label}: pharos-docs "${query.question}" -> exit ${code}\n`);
  for (const check of checks) process.stdout.write(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  if (checks.some((check) => !check.ok)) failed = true;
  examples.push({ id: query.id, label: query.label, question: query.question, output });
  const { result } = transcript;
  summary.push(
    `- **${query.label}** ("${query.question}"): ${result.status}${result.reason ? ` (${result.reason})` : ""}, ` +
      `${transcript.requests.length} JSON-RPC requests (${transcript.requests.map((r) => (r.rpc?.method === "tools/call" ? `tools/call ${String(r.rpc.params?.name)}` : r.rpc?.method)).join(", ")}), ` +
      `${result.status === "answered" ? `${result.sources.length} ${result.sources.length === 1 ? "source" : "sources"}` : `${result.suggestions.length} nearby ${result.suggestions.length === 1 ? "page" : "pages"}`}, ` +
      `${checks.filter((c) => c.ok).length}/${checks.length} checks passed. Transcript: [${transcriptFile}](${transcriptFile}).`,
  );
}

if (failed) {
  process.stderr.write("\nProof NOT verified; README.md left unchanged. The transcripts and outputs above show why.\n");
  process.exitCode = 1;
} else {
  const when = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const readme = await readFile("README.md", "utf8");
  const status = [
    `**Live proof:** captured ${when} against the Pharos Developer Docs MCP (\`${MCP_ENDPOINT}\`) by \`npm run proof\`, and verified from the saved JSON-RPC requests and raw responses (\`npm run verify-proof\`). Tools listed by the server: ${tools.map((name) => `\`${name}\``).join(", ")}.`,
    "",
    ...summary,
  ];
  await writeFile("README.md", applyProof(readme, examples, json, status), "utf8");
  process.stdout.write("\nProof verified; README.md examples and proof section updated.\n");
}
