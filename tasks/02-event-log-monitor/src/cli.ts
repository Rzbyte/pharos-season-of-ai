#!/usr/bin/env node
import { run } from "./run.js";

// First Ctrl+C: finish the current poll, print the summary, close the MCP session, exit.
// Second Ctrl+C: quit at once.
const controller = new AbortController();
const stop = (signal: NodeJS.Signals) => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
  if (signal === "SIGINT") process.stderr.write("\nStopping after the current poll (Ctrl+C again to quit now)...\n");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
  signal: controller.signal,
});
process.off("SIGINT", stop);
process.off("SIGTERM", stop);
