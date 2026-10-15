#!/usr/bin/env node
// npm run probe: a real, read-only look at how https://docs.pharos.xyz answers, before trusting the
// parser with it. It reads the sitemap, checks that the pages the README names are listed, and asks a
// few pages one question each, reporting what came back (status, content type, size, how it was read).
// Writes proof/probe.json. Plain HTTPS GET requests to the public docs site; no MCP.
import { writeFile } from "node:fs/promises";
import { DocsHttpProvider } from "./providers/docs-http.js";
import { judge } from "./source-gate.js";
import { GOAL } from "./search.js";

const EXPECTED = [
  "/getting-started/network/atlantic-testnet",
  "/getting-started/network/pacific-mainnet",
  "/getting-started/canonical-contracts",
  "/getting-started/token-registry",
  "/developer-guide/foundry",
  "/developer-guide/hardhat",
  "/api-and-sdk/json-rpc-methods",
  "/tooling-and-infrastructure/pharos-skill-engine-guide",
  "/tooling-and-infrastructure/rpc",
];
const ASKS = [
  ["/getting-started/network/atlantic-testnet", "What is the chain ID of the Atlantic testnet?"],
  ["/developer-guide/foundry", "How do I deploy a contract with Foundry?"],
  ["/developer-guide/hardhat", "How do I deploy an Anchor program to Solana?"],
] as const;

const provider = new DocsHttpProvider({ onRequest: (r) => process.stdout.write(`GET ${r.url} -> ${r.error ?? `${r.status} ${r.contentType ?? ""} ${r.bytes} B`} (${r.ms} ms)\n`) });
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
try {
  const pages = await provider.index();
  const paths = new Set(pages.map((page) => page.path));
  report.index = { pages: pages.length, sample: pages.slice(0, 8), expectedPresent: EXPECTED.filter((p) => paths.has(p)), expectedMissing: EXPECTED.filter((p) => !paths.has(p)) };
  process.stdout.write(`\nindex: ${pages.length} pages; expected pages missing: ${(report.index as { expectedMissing: string[] }).expectedMissing.join(", ") || "none"}\n`);
  const asks = [];
  for (const [path, question] of ASKS) {
    const page = pages.find((entry) => entry.path === path);
    if (!page) {
      asks.push({ path, question, error: "not in the index" });
      continue;
    }
    try {
      const response = await provider.ask(page, question, GOAL);
      const verdict = judge(response, question);
      asks.push({ path, question, kind: response.kind, via: response.via, chars: response.text.length, head: response.text.slice(0, 600), verdict: { ok: verdict.ok, reason: verdict.reason, answer: verdict.answer } });
      process.stdout.write(`\n${path}?ask="${question}"\n  read as: ${response.kind} via ${response.via}, ${response.text.length} chars\n  gate: ${verdict.ok ? "answer" : `no answer (${verdict.reason})`}\n  first lines:\n${response.text.slice(0, 400).split("\n").map((l) => `    | ${l}`).join("\n")}\n`);
    } catch (error) {
      asks.push({ path, question, error: error instanceof Error ? error.message : String(error) });
      process.stdout.write(`\n${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  report.asks = asks;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.stdout.write(`probe failed: ${report.error}\n`);
  process.exitCode = 1;
}
report.requests = provider.requests().map(({ body, ...rest }) => ({ ...rest, bodyChars: body?.length ?? null }));
await writeFile("proof/probe.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write("\nSaved proof/probe.json\n");
