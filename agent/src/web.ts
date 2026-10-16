// The agent over HTTP: one serverless function (GET /api/agent?task=NN&...) for every task the agent
// powers, so the site stays one project within Vercel's function limits. Each task validates its own
// parameters strictly; nothing here signs or holds a key, and the only Chain MCP endpoint is the hosted
// one (tests pass a local one).
import { isAddress } from "viem";
import { parseAmount, parseGasPrice } from "./core/amounts.js";
import { Chain } from "./core/chain.js";
import { ChainMcp, Recorder, type RecordedMessage } from "./core/chain-mcp.js";
import { AgentError, errorMessage } from "./core/errors.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "./core/networks.js";
import { parseGuardianConfig } from "./guardian/config.js";
import { PAYOUT_DEFAULTS, payoutGuardian } from "./guardian/presets.js";
import { runGuardian } from "./guardian/run.js";

export interface WebOptions {
  /** The Chain MCP endpoint; only tests change it. */
  chainMcpUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export interface WebResponse {
  status: number;
  body: unknown;
  /** Seconds a successful answer may be shared at the edge. */
  maxAge: number;
}

/** One line per Chain MCP call, for the page's proof panel: the tool, its arguments, and whether it answered. */
export interface CallLine {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export function callLines(messages: readonly RecordedMessage[]): CallLine[] {
  const failed = new Set<unknown>();
  for (const { direction, message } of messages) {
    if (direction === "server->client" && "id" in message && ("error" in message || (message as { result?: { isError?: boolean } }).result?.isError === true)) failed.add(message.id);
  }
  return messages
    .filter((m) => m.direction === "client->server" && "method" in m.message && m.message.method === "tools/call")
    .map((m) => {
      const { params, id } = m.message as unknown as { id: unknown; params: { name: string; arguments?: Record<string, unknown> } };
      return { tool: params.name, args: params.arguments ?? {}, ok: !failed.has(id) };
    });
}

const usage = (message: string): WebResponse => ({ status: 400, body: { error: { kind: "usage", message } }, maxAge: 0 });

/** Task 05: the mainnet payout guardian with the page's four inputs. */
async function guardian(params: URLSearchParams, options: WebOptions): Promise<WebResponse> {
  const read = (key: keyof typeof PAYOUT_DEFAULTS) => (params.get(key) ?? PAYOUT_DEFAULTS[key]).trim();
  const inputs = { payer: read("payer"), recipient: read("recipient"), amount: read("amount"), maxGasGwei: read("maxGasGwei") };
  if (!isAddress(inputs.payer, { strict: false })) return usage("The payer must be a 0x address (40 hex characters).");
  if (!isAddress(inputs.recipient, { strict: false })) return usage("The recipient must be a 0x address (40 hex characters).");
  if (inputs.payer.toLowerCase() === inputs.recipient.toLowerCase()) return usage("The payer and the recipient must be different addresses.");
  let amount: bigint;
  let gas: bigint;
  try {
    amount = parseAmount(inputs.amount, 6, "The amount");
    gas = parseGasPrice(`${inputs.maxGasGwei} gwei`);
  } catch (error) {
    return usage(errorMessage(error));
  }
  if (amount <= 0n || amount > 10_000_000_000_000n) return usage("The amount must be more than 0 and at most 10,000,000 USDC.");
  if (gas <= 0n || gas > 10_000_000_000_000n) return usage("The gas cap must be more than 0 and at most 10,000 gwei.");

  const config = parseGuardianConfig(payoutGuardian(inputs));
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "hosted", url: options.chainMcpUrl ?? HOSTED_CHAIN_MCP }, { recorder, budget: 30, timeoutMs: options.timeoutMs ?? 20_000 });
  try {
    const result = await runGuardian(config, { chain: new Chain(mcp, NETWORKS["pharos-mainnet"]), now: options.now });
    return { status: 200, body: { result, inputs, calls: callLines(recorder.messages) }, maxAge: 15 };
  } finally {
    await mcp.close();
  }
}

export async function handle(url: URL, options: WebOptions = {}): Promise<WebResponse> {
  try {
    switch (url.searchParams.get("task")) {
      case "05":
        return await guardian(url.searchParams, options);
      default:
        return usage("Unknown task. Use ?task=05.");
    }
  } catch (error) {
    if (error instanceof AgentError) {
      const status = error.kind === "usage" ? 400 : error.kind === "mcp_connection" || error.kind === "mcp_tool" || error.kind === "wrong_chain" || error.kind === "budget" ? 502 : 500;
      return { status, body: { error: { kind: error.kind, message: error.message, hint: error.hint ?? null } }, maxAge: 0 };
    }
    return { status: 500, body: { error: { kind: "unexpected", message: errorMessage(error) } }, maxAge: 0 };
  }
}
