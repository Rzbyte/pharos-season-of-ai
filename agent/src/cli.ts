#!/usr/bin/env node
// pharos-agent: the Pharos Agent Lab's agent, one capability per task.
//
//   pharos-agent guardian [preset | config.json] [--block N] [--json] [--proof FILE] [--execute] [--verbose]
//   pharos-agent verify FILE
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatGwei } from "./core/amounts.js";
import { Chain } from "./core/chain.js";
import { AGENT, ChainMcp, type ChainMcpEndpoint } from "./core/chain-mcp.js";
import { AgentError, errorMessage } from "./core/errors.js";
import { signerFromEnv, type Signer } from "./core/execute.js";
import { network, type Network } from "./core/networks.js";
import { proofFile, type ProofFile } from "./core/proof.js";
import { parseGuardianConfig } from "./guardian/config.js";
import { GUARDIAN_PRESETS } from "./guardian/presets.js";
import { runGuardian, type GuardianRun } from "./guardian/run.js";
import { verifyGuardianProof } from "./guardian/verify.js";

const out = (text = "") => process.stdout.write(`${text}\n`);

const HELP = `pharos-agent ${AGENT.version}: the Pharos Agent Lab agent

  pharos-agent guardian [preset | config.json] [options]   Task 05, Threshold Guardian
      Reads every condition at one block through Pharos Chain MCP, decides, and prepares and
      simulates the action only when the rule holds. Default preset: payout (Pharos Mainnet).
      --block N        evaluate at block N instead of the latest
      --execute        Atlantic only: re-check at the newest block, then sign with PRIVATE_KEY and
                       broadcast through Chain MCP send_raw_transaction (the official server, run locally)
      --json           print the result as JSON
      --proof FILE     save the proof: input, result and every Chain MCP message
      --verbose        trace each Chain MCP call on stderr
      --chain-mcp URL  use this Chain MCP endpoint instead of the hosted one (recorded in the proof)
      --rpc URL        the RPC the locally run official server uses (Atlantic; recorded in the proof)

  pharos-agent verify FILE    check a proof offline by replaying its recorded responses

Mainnet runs use the hosted Chain MCP (https://mcp.pharos.xyz/mcp, read-only). Atlantic runs start
the official Pharos Chain MCP server (vendored, unmodified) locally over stdio.`;

interface Flags {
  positional: string[];
  help: boolean;
  json: boolean;
  execute: boolean;
  verbose: boolean;
  block?: bigint;
  proof?: string;
  chainMcp?: string;
  rpc?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positional: [], help: false, json: false, execute: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--execute") flags.execute = true;
    else if (arg === "--verbose") flags.verbose = true;
    else if (arg === "--block" || arg === "--proof" || arg === "--chain-mcp" || arg === "--rpc") {
      const value = argv[++i];
      if (!value) throw new AgentError("usage", `${arg} needs a value.`);
      if (arg === "--block") {
        if (!/^\d+$/.test(value)) throw new AgentError("usage", "--block must be a block number.");
        flags.block = BigInt(value);
      } else if (arg === "--proof") flags.proof = value;
      else {
        if (!/^https?:\/\/\S+$/.test(value)) throw new AgentError("usage", `${arg} must be an http(s) URL.`);
        if (arg === "--chain-mcp") flags.chainMcp = value;
        else flags.rpc = value;
      }
    } else if (arg.startsWith("--")) throw new AgentError("usage", `Unknown option ${arg}. See pharos-agent --help.`);
    else flags.positional.push(arg);
  }
  return flags;
}

/**
 * A guardian from a preset name or a file. "$SIGNER" in it stands for the address of PRIVATE_KEY (only the
 * address is derived here), so a preset can pay from, and check, the runner's own wallet.
 */
async function loadGuardian(source: string | undefined, signer: () => Signer) {
  const name = source ?? "payout";
  let text: string;
  const preset = GUARDIAN_PRESETS[name];
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No guardian preset or file "${name}".`, "Presets: payout (mainnet), atlantic-payout (testnet, pays from PRIVATE_KEY's address). Or pass a path to a guardian JSON file.");
    }
  }
  if (text.includes("$SIGNER")) {
    if (!process.env.PRIVATE_KEY) throw new AgentError("usage", `"${name}" pays from your own wallet ($SIGNER), so it needs PRIVATE_KEY (an Atlantic testnet key) for the address.`, "export PRIVATE_KEY=0x... (never commit it)");
    text = text.replaceAll("$SIGNER", signer().address);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  return { config: parseGuardianConfig(json), input: json };
}

function endpointFor(net: Network, flags: Flags): ChainMcpEndpoint {
  const local = (broadcast: boolean): ChainMcpEndpoint => ({ kind: "local", network: flags.rpc ? { ...net, rpcUrl: flags.rpc } : net, broadcast });
  if (flags.execute) {
    if (net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (network: atlantic-testnet).");
    if (flags.chainMcp) throw new AgentError("usage", "--execute broadcasts through the official server run locally; --chain-mcp does not apply.");
    return local(true);
  }
  if (flags.chainMcp) return { kind: "hosted", url: flags.chainMcp };
  return net.hostedChainMcp && !flags.rpc ? { kind: "hosted", url: net.hostedChainMcp } : local(false);
}

function printGuardian(run: GuardianRun): void {
  const mark = (passed: boolean | null) => (passed === true ? "pass" : passed === false ? "FAIL" : "n/a ");
  out(`Pharos Threshold Guardian · ${run.guardian}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${BigInt(run.block.number).toLocaleString("en-US")} · ${run.block.timestamp}`);
  out(`  Rule        fire when ${run.rule} conditions hold`);
  out();
  const width = Math.max(...run.conditions.map((c) => c.label.length));
  for (const c of run.conditions) {
    const seen = c.observed ?? `unreadable (${c.error})`;
    out(`  ${mark(c.passed)}  ${c.label.padEnd(width)}  ${seen.padEnd(16)}  ${c.op} ${c.threshold}   [${c.tool}]`);
  }
  out();
  out(`  Decision    ${run.decision.fire ? "FIRE" : "HOLD"}: ${run.decision.summary}`);
  const a = run.action;
  if (!a) {
    out("  Action      not fired");
  } else {
    out(`  Action      ${a.summary}`);
    if (a.simulation.ok) {
      out(`              simulated at block ${BigInt(a.simulation.block).toLocaleString("en-US")}: ${a.type === "erc20-transfer" ? "transfer returns true" : "succeeds"}`);
      out(`              gas ${BigInt(a.gas!).toLocaleString("en-US")} × ${formatGwei(BigInt(a.gasPrice!))} = ${a.cost!.display} (payer holds ${a.payerBalance!.display})`);
    }
    if (a.status === "blocked") out(`              BLOCKED: ${a.reason}`);
    else if (!run.execution) out(`              not sent${run.network.chainId === 1672 ? ": the hosted Chain MCP is read-only; --execute runs on Atlantic" : ""}`);
  }
  const e = run.execution;
  if (e) {
    out(`  Re-check    block ${BigInt(e.recheck.block).toLocaleString("en-US")}: ${e.recheck.decision.summary}`);
    if (e.sent) {
      out(`  Sent        ${e.txHash} (nonce ${e.nonce})`);
      out(`  Receipt     ${e.status}${e.blockNumber ? ` in block ${BigInt(e.blockNumber).toLocaleString("en-US")}` : ""}${e.gasUsed ? `, gas used ${BigInt(e.gasUsed).toLocaleString("en-US")}` : ""}${e.effectiveGasPrice ? ` at ${formatGwei(BigInt(e.effectiveGasPrice))}` : ""}`);
    } else out(`  Not sent    ${e.reason}`);
  }
  out();
  out(`  ${run.toolCalls} Chain MCP calls. Nothing was signed${run.execution?.sent ? " except the transaction above, locally" : ""}.`);
}

async function guardian(flags: Flags): Promise<number> {
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  const { config, input } = await loadGuardian(flags.positional[1], keySigner);
  const net = network(config.network);
  const signer = flags.execute ? keySigner() : undefined;
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const run = await runGuardian(config, { chain: new Chain(mcp, net), block: flags.block, signer });
    if (flags.proof) {
      const proof = proofFile({ task: "05", capability: "threshold-guardian", about: "One Threshold Guardian run: the guardian (input), its result, and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input, result: run });
      await writeFile(flags.proof, `${JSON.stringify(proof, null, 2)}\n`);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printGuardian(run);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.outcome === "hold" || run.outcome === "fire" || run.outcome === "executed" ? 0 : 8;
  } finally {
    await mcp.close();
  }
}

async function verify(flags: Flags): Promise<number> {
  const path = flags.positional[1];
  if (!path) throw new AgentError("usage", "verify needs a proof file.");
  const proof = JSON.parse(await readFile(path, "utf8")) as ProofFile;
  if (proof.capability !== "threshold-guardian") throw new AgentError("usage", `No verifier for "${proof.capability}".`);
  const checks = await verifyGuardianProof(proof);
  for (const check of checks) out(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  out(failed ? `\n${failed} check(s) failed.` : `\nProof verified: ${checks.length} checks.`);
  return failed ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const command = flags.positional[0];
  if (!command || command === "help" || flags.help) {
    out(HELP);
    return command || flags.help ? 0 : 2;
  }
  if (command === "guardian") return guardian(flags);
  if (command === "verify") return verify(flags);
  throw new AgentError("usage", `Unknown command "${command}". See pharos-agent --help.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      const known = error instanceof AgentError;
      process.stderr.write(`pharos-agent: ${known ? error.message : errorMessage(error)}\n${known && error.hint ? `  ${error.hint}\n` : ""}`);
      process.exitCode = known ? error.exitCode : 1;
    },
  );
}

