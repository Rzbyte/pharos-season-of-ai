import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TOOL_NAME, VERSION } from "./constants.js";
import type { McpRecorder, RecordedMessage } from "./mcp-client.js";

export const TRANSCRIPT_FORMAT = "pharos-mcp-transcript/1";

export type TranscriptOutcome = { ok: true; report: unknown } | { ok: false; error: { kind: string; message: string; hint: string | null } };

/** proof/mcp-transcript.json: the run's result first, then every JSON-RPC message verbatim. */
export interface Transcript {
  format: typeof TRANSCRIPT_FORMAT;
  about: string;
  tool: { name: string; version: string };
  runtime: { node: string; platform: string; arch: string };
  endpoint: string;
  startedAt: string;
  finishedAt: string;
  server: { name: string; version: string } | null;
  protocolVersion: string | null;
  session: { idPrefix: string | null; terminated: boolean };
  outcome: TranscriptOutcome;
  messageCount: number;
  messages: RecordedMessage[];
}

export function buildTranscript(recorder: McpRecorder, endpoint: string, outcome: TranscriptOutcome): Transcript {
  return {
    format: TRANSCRIPT_FORMAT,
    about:
      "Every JSON-RPC message exchanged with the MCP server during one run of this CLI, recorded verbatim and in order " +
      "(direction, milliseconds since start, message). HTTP headers are not recorded, so no bearer token can appear here.",
    tool: { name: TOOL_NAME, version: VERSION },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    endpoint,
    startedAt: recorder.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    server: recorder.server ?? null,
    protocolVersion: recorder.protocolVersion ?? null,
    session: { idPrefix: recorder.sessionIdPrefix ?? null, terminated: recorder.sessionTerminated },
    outcome,
    messageCount: recorder.messages.length,
    messages: recorder.messages,
  };
}

export async function writeTextFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`);
}
