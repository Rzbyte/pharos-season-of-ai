#!/usr/bin/env node
// npm run probe: one look at the live Pharos Developer Docs MCP, to see what it returns before relying on
// it. Lists the tools (tools/list), asks one question (tools/call askQuestion), and writes every request,
// raw response and the parsed answer to proof/mcp-probe.json (creating proof/ if needed). JSON-RPC POST
// requests to https://docs.pharos.xyz/~gitbook/mcp; nothing else is contacted.
import { mkdir, writeFile } from "node:fs/promises";
import { MCP_ENDPOINT } from "./constants.js";
import { formatRequest } from "./formatter.js";
import { DeveloperDocsMcpProvider } from "./providers/developer-docs-mcp.js";
import type { DocsAnswer } from "./providers/provider.js";
import { MCP_GOAL } from "./search.js";

const QUESTION = "What is the Atlantic chain ID?";
const provider = new DeveloperDocsMcpProvider({ onRequest: (record) => process.stdout.write(`${formatRequest(record)}\n`) });
const startedAt = new Date().toISOString();
let answer: DocsAnswer | null = null;
let error: string | null = null;
try {
  const tools = await provider.tools();
  process.stdout.write(`tools: ${tools.map((tool) => tool.name).join(", ")}\n`);
  answer = await provider.answer(QUESTION, MCP_GOAL);
  process.stdout.write(`\n${answer.body}\n\nsources (${answer.sourceSection ? "Sources section" : "inline links"}):\n${answer.sources.map((source) => `  ${source.url}`).join("\n")}\n`);
} catch (failure) {
  error = failure instanceof Error ? failure.message : String(failure);
  process.stderr.write(`Probe failed: ${error}\n`);
  process.exitCode = 1;
}
await mkdir("proof", { recursive: true });
await writeFile(
  "proof/mcp-probe.json",
  `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), endpoint: MCP_ENDPOINT, question: QUESTION, tools: provider.verifiedTools() ?? null, requests: provider.requests(), answer, error }, null, 2)}\n`,
  "utf8",
);
