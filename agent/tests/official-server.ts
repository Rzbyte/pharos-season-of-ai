// The official Pharos Chain MCP server (vendor/pharos-mcp, unmodified) for tests, in-process over the MCP
// SDK's in-memory transport and pointed at a fake chain. The agent talks to the real server code; only
// the chain underneath is made up.
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Chain } from "../src/core/chain.js";
import { ChainMcp, Recorder } from "../src/core/chain-mcp.js";
import type { Network } from "../src/core/networks.js";
import type { FakeChain } from "./fake-chain.js";

interface OfficialServerModule {
  createPharosServer(config: Record<string, unknown>): { connect(transport: unknown): Promise<void>; close(): Promise<void> };
}
interface OfficialConfigModule {
  loadConfig(env: Record<string, string>): Record<string, unknown>;
}

/** Loaded by path at run time (the vendored server is compiled on its own, with its own settings). */
const vendored = (file: string) => import(new URL(`../vendor/pharos-mcp/src/${file}`, import.meta.url).href);

export async function connectOfficial(fake: FakeChain, net: Network, options: { broadcast?: boolean; budget?: number } = {}): Promise<{ chain: Chain; mcp: ChainMcp; recorder: Recorder; close(): Promise<void> }> {
  const { createPharosServer } = (await vendored("server.js")) as OfficialServerModule;
  const { loadConfig } = (await vendored("config.js")) as OfficialConfigModule;
  const config = loadConfig({ PHAROS_RPC_URL: fake.url, PHAROS_CHAIN_ID: String(net.chainId), PHAROS_NATIVE_SYMBOL: net.nativeSymbol, ENABLE_SEND_RAW_TRANSACTION: options.broadcast ? "true" : "false" });
  const server = createPharosServer(config);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const recorder = new Recorder();
  const mcp = await ChainMcp.connect({ kind: "transport", label: "the official pharos-mcp-server (in-process) on a fake chain", transport: clientSide }, { recorder, budget: options.budget ?? 60, timeoutMs: 10_000 });
  return {
    chain: new Chain(mcp, net),
    mcp,
    recorder,
    close: async () => {
      await mcp.close();
      await server.close().catch(() => undefined);
    },
  };
}
