import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ASK_TOOL, MCP_ENDPOINT, MCP_TIMEOUT_MS, TOOLS_TTL_MS } from "../constants.js";
import { answerAndSources } from "../text.js";
import type { RequestRecord } from "../types.js";
import type { FetchLike } from "./http.js";
import { isRecord, McpHttpClient } from "./mcp-http.js";
import { ProviderError, type DocsAnswer, type DocsAnswerProvider } from "./provider.js";

/** One tool as tools/list describes it. */
export interface McpTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
}

export interface DeveloperDocsMcpOptions {
  /** Always https://docs.pharos.xyz/~gitbook/mcp except in tests, which point it at a local fake server. */
  endpoint?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  /** A tool list verified earlier (the CLI's disk cache, the web endpoint's memory): tools/list is then not called. */
  tools?: McpTool[];
  onRequest?: (record: RequestRecord) => void;
}

/**
 * The Pharos Developer Docs MCP, the canonical provider of pharos-docs.
 *
 *   tools/list                      once (or a recent verified list): askQuestion must be offered,
 *                                   taking a string "question" (and, optionally, "goal")
 *   tools/call askQuestion          { question, goal }: the answer, then a "# Sources" list of
 *                                   docs.pharos.xyz pages
 *
 * Every call is a JSON-RPC 2.0 POST to the MCP endpoint (McpHttpClient). Nothing here falls back to any
 * other transport: if the MCP cannot answer, the search reports an error.
 */
export class DeveloperDocsMcpProvider implements DocsAnswerProvider {
  readonly name = "developer-docs-mcp";
  readonly transport = "docs-mcp";
  readonly endpoint: string;
  private readonly client: McpHttpClient;
  private inventory: McpTool[] | undefined;
  private readonly preloaded: boolean;

  constructor(options: DeveloperDocsMcpOptions = {}) {
    this.endpoint = options.endpoint ?? MCP_ENDPOINT;
    this.client = new McpHttpClient(this.endpoint, { timeoutMs: options.timeoutMs ?? MCP_TIMEOUT_MS, fetch: options.fetch, onRequest: options.onRequest });
    this.inventory = options.tools;
    this.preloaded = options.tools !== undefined;
  }

  requests(): RequestRecord[] {
    return this.client.requests();
  }

  /** Whether this run used a verified tool list from a cache instead of calling tools/list. */
  get toolsFromCache(): boolean {
    return this.preloaded && !this.client.requests().some((record) => record.purpose === "tools/list");
  }

  /** The server's tools (tools/list), once per provider. */
  async tools(): Promise<McpTool[]> {
    if (!this.inventory) this.inventory = parseToolList(await this.client.call("tools/list"));
    return this.inventory;
  }

  /** The tool list, if it was read or given; undefined before. */
  verifiedTools(): McpTool[] | undefined {
    return this.inventory;
  }

  async answer(question: string, goal: string): Promise<DocsAnswer> {
    const { goal: takesGoal } = askTool(await this.tools());
    const result = await this.client.call("tools/call", { name: ASK_TOOL, arguments: takesGoal ? { question, goal } : { question } });
    const text = toolText(result);
    return { tool: ASK_TOOL, text, ...answerAndSources(text) };
  }
}

/** A tools/list result as tools. Anything without a tools array, or with no named tool, is malformed. */
export function parseToolList(result: unknown): McpTool[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) throw new ProviderError("malformed_response", "The Developer Docs MCP tool list (tools/list) has no tools array.");
  const tools = result.tools
    .filter(isRecord)
    .filter((tool) => typeof tool.name === "string" && tool.name.trim() !== "")
    .map((tool) => ({ name: tool.name as string, description: typeof tool.description === "string" ? tool.description : null, inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : null }));
  if (tools.length === 0) throw new ProviderError("malformed_response", "The Developer Docs MCP tool list (tools/list) has no tools.");
  return tools;
}

/**
 * askQuestion, checked against what pharos-docs sends: a string "question" it must accept, a string
 * "goal" it may accept, and nothing else it requires.
 */
export function askTool(tools: McpTool[]): { tool: McpTool; goal: boolean } {
  const tool = tools.find((entry) => entry.name === ASK_TOOL);
  if (!tool) throw new ProviderError("upstream_error", `The Developer Docs MCP does not offer ${ASK_TOOL} (it lists: ${tools.map((entry) => entry.name).join(", ")}).`);
  const properties = isRecord(tool.inputSchema?.properties) ? tool.inputSchema.properties : {};
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required.filter((name): name is string => typeof name === "string") : [];
  const typeOf = (name: string) => (isRecord(properties[name]) ? properties[name].type : undefined);
  if (!("question" in properties) || (typeOf("question") !== undefined && typeOf("question") !== "string")) {
    throw new ProviderError("upstream_error", `The Developer Docs MCP's ${ASK_TOOL} no longer takes a string "question".`);
  }
  const unknown = required.filter((name) => name !== "question" && name !== "goal");
  if (unknown.length > 0) throw new ProviderError("upstream_error", `The Developer Docs MCP's ${ASK_TOOL} now requires ${unknown.join(", ")}, which pharos-docs does not send.`);
  return { tool, goal: "goal" in properties && (typeOf("goal") === undefined || typeOf("goal") === "string") };
}

/** The text of a tools/call result: its text content, in order. A tool error (isError) is an upstream error carrying its text. */
export function toolText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) throw new ProviderError("malformed_response", `The ${ASK_TOOL} result has no content array.`);
  const text = result.content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n\n")
    .trim();
  if (result.isError === true) throw new ProviderError("upstream_error", `The Developer Docs MCP could not answer (${ASK_TOOL} reported an error): ${text.slice(0, 300) || "no detail"}`);
  if (!text) throw new ProviderError("malformed_response", `The ${ASK_TOOL} result has no text content.`);
  return text;
}

// ---------------------------------------------------------------------------
// The CLI's disk cache of a verified tool list, so a second question does not re-list the tools.

interface ToolsCacheFile {
  format: "pharos-docs-mcp-tools/1";
  endpoint: string;
  savedAt: number;
  tools: McpTool[];
}

export async function readToolsCache(file: string, endpoint: string, now = Date.now(), ttlMs = TOOLS_TTL_MS): Promise<McpTool[] | null> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as ToolsCacheFile;
    if (data.format !== "pharos-docs-mcp-tools/1" || data.endpoint !== endpoint || typeof data.savedAt !== "number" || now - data.savedAt > ttlMs || data.savedAt > now) return null;
    // A cache file is not trusted more than the network: it must still hold a usable askQuestion.
    const tools = parseToolList({ tools: data.tools });
    askTool(tools);
    return tools;
  } catch {
    return null;
  }
}

export async function writeToolsCache(file: string, endpoint: string, tools: McpTool[], now = Date.now()): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const data: ToolsCacheFile = { format: "pharos-docs-mcp-tools/1", endpoint, savedAt: now, tools };
    await writeFile(file, JSON.stringify(data), "utf8");
  } catch {
    // A cache that cannot be written is only slower, never wrong.
  }
}
