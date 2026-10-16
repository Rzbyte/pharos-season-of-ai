#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { createPharosServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.transport === "http") {
    await startHttpServer(config);
    console.error(`Pharos MCP HTTP server listening at http://${config.host}:${config.port}/mcp`);
    console.error(`Health check: http://${config.host}:${config.port}/health`);
    return;
  }

  const server = createPharosServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Pharos MCP stdio server connected to ${config.rpcUrl}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
