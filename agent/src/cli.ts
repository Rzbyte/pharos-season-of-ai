#!/usr/bin/env node
// pharos-agent: the Pharos Agent Lab's agent, one capability per task.
//
//   pharos-agent guardian [preset | config.json] [--block N] [--json] [--proof FILE] [--execute] [--verbose]
//   pharos-agent dryrun [kind] [--token --from --to --amount ...] [--submit]
//   pharos-agent gate [policy] [kind] [--token --from --to --amount ...] [--execute]
//   pharos-agent verify FILE
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatAmount, formatGwei } from "./core/amounts.js";
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
import { parseDryRun } from "./dryrun/intent.js";
import { runDryRun, type DryRun } from "./dryrun/run.js";
import { verifyDryRunProof } from "./dryrun/verify.js";
import { EXAMPLE_PAYER, EXAMPLE_RECIPIENT } from "./guardian/presets.js";
import { runGate, type GateRun } from "./policy/check.js";
import { parsePolicy } from "./policy/config.js";
import { POLICY_PRESETS } from "./policy/presets.js";
import { verifyGateProof } from "./policy/verify.js";

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

  pharos-agent dryrun [kind] [options]                     Task 08, Dry-Run Executor
      What a transaction would do and cost before it is sent: the state it changes, read at one block,
      simulated with eth_call there, priced with estimate_gas and the fee market. Kinds:
      erc20-transfer (default), native-transfer, erc20-approve, call.
      --token SYMBOL|0x…   an official token (USDC by default) or a token address
      --from 0x… --to 0x…  sender and recipient (the call's contract, for call)
      --amount N           in token units; "max" for an unlimited approval
      --spender 0x…        erc20-approve
      --signature S --args JSON --value N    call: "deposit(uint256)", ["1000"], native value
      --network ID         pharos-mainnet (default) or atlantic-testnet
      --submit             Atlantic only: send it (signed with PRIVATE_KEY; --from defaults to its
                           address), then compare the prediction with the receipt
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent gate [policy] [kind] [options]              Task 11, Policy Gatekeeper
      Checks one requested transfer or approval against a policy at one block, every rule, before
      anything is signed: allowlists, a per-action limit, a window limit from the sender's own
      Transfer logs, a time window at the block's time, a gas cap and a dry run. Policies: treasury
      (Pharos Mainnet, default), atlantic-treasury, or a policy JSON file. Kinds: erc20-transfer
      (default), native-transfer, erc20-approve. Exits with 9 when the request is denied.
      --token, --from, --to, --spender, --amount   the request, as for dryrun (a preset fills in its own)
      --execute            Atlantic only: when allowed and the dry run succeeds, send it (PRIVATE_KEY)
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

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
  submit: boolean;
  values: Record<string, string>;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positional: [], help: false, json: false, execute: false, verbose: false, submit: false, values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--submit") flags.submit = true;
    else if (["--from", "--to", "--token", "--amount", "--spender", "--signature", "--args", "--value", "--network"].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new AgentError("usage", `${arg} needs a value.`);
      flags.values[arg.slice(2)] = value;
    }
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

/** An official token by symbol on `net`, or any address as given. */
function tokenFor(net: Network, value: string): string {
  if (/^0x/i.test(value)) return value;
  const token = net.tokens.find((entry) => entry.symbol.toLowerCase() === value.toLowerCase());
  if (!token) throw new AgentError("usage", `${value} is not an official ${net.name} token. Use one of ${net.tokens.map((t) => t.symbol).join(", ")}, or a token address.`);
  return token.address;
}

function printDryRun(run: DryRun): void {
  const verdict = run.verdict === "would-succeed" ? "WOULD SUCCEED" : run.verdict === "would-revert" ? "WOULD REVERT" : "CANNOT PAY";
  out(`Pharos Dry-Run Executor · ${run.summary}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${BigInt(run.block.number).toLocaleString("en-US")} · ${run.block.timestamp}`);
  out(`  Verdict     ${verdict}${run.reason ? `: ${run.reason}` : run.returns ? `: returns ${run.returns}` : ""}`);
  out();
  const width = Math.max(...run.outcome.map((l) => `${l.role} ${l.asset}`.length)) + 2;
  run.outcome.forEach((l, index) => {
    const label = `${l.role === "allowance" ? "Allowance" : l.role === "sender" ? "Sender" : "Recipient"} ${l.asset}`.padEnd(width);
    out(`  ${index === 0 ? "Outcome " : "        "}    ${label}${l.shown.before}${l.shown.after ? ` → ${l.shown.after}${l.shown.change && l.role !== "allowance" ? ` (${l.shown.change})` : ""}` : " (unchanged: it would not go through)"}`);
  });
  if (run.gas) {
    out(`  Gas         ${BigInt(run.gas.gas).toLocaleString("en-US")} (limit ${BigInt(run.gas.gasLimit).toLocaleString("en-US")}) at about ${formatGwei(BigInt(run.gas.expectedFeePerGas))}: about ${formatAmount(BigInt(run.gas.expectedCost), 18, 8)} ${network(run.network.id).nativeSymbol}, at most ${formatAmount(BigInt(run.gas.maxCost), 18, 8)} ${network(run.network.id).nativeSymbol}`);
  }
  out(`  Funds       the sender holds ${run.funds.shown.holds}${run.funds.shown.needs ? `; it needs up to ${run.funds.shown.needs}` : ""}`);
  for (const [index, warning] of run.warnings.entries()) out(`  ${index === 0 ? "Warnings" : "        "}    ${warning.message}`);
  const s = run.submission;
  if (!s) out(`  Submitted   no${run.network.chainId === 1672 ? ": the hosted Chain MCP is read-only; --submit runs on Atlantic" : ""}`);
  else {
    out(`  Submitted   ${s.txHash} (nonce ${s.nonce}): ${s.status}${s.blockNumber ? ` in block ${BigInt(s.blockNumber).toLocaleString("en-US")}` : ""}`);
    for (const c of s.comparisons) out(`    ${c.match ? "match" : "DIFF "}  ${c.what.padEnd(18)} predicted ${c.predicted}; actual ${c.actual}`);
    out(`  Prediction  ${s.matched ? "matched the receipt in every line" : "did not match in every line (see DIFF)"}`);
  }
  out();
  out(`  ${run.toolCalls} Chain MCP calls.${s ? "" : " Nothing was signed or sent."}`);
}

async function dryrun(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const kind = flags.positional[1] ?? "erc20-transfer";
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  if (flags.submit && !v.from) v.from = keySigner().address;
  const example = net.id === "pharos-mainnet";
  const intent: Record<string, unknown> = { kind, from: v.from ?? (example ? EXAMPLE_PAYER : undefined), to: v.to ?? (example && kind !== "call" ? EXAMPLE_RECIPIENT : undefined), amount: v.amount ?? (kind === "native-transfer" ? "0.01" : "25") };
  if (kind === "erc20-transfer" || kind === "erc20-approve") intent.token = tokenFor(net, v.token ?? "USDC");
  if (kind === "erc20-approve") intent.spender = v.spender;
  if (kind === "call") {
    intent.signature = v.signature;
    try {
      intent.args = v.args ? (JSON.parse(v.args) as unknown) : [];
    } catch {
      throw new AgentError("usage", "--args must be a JSON list, like '[\"1000\"]'.");
    }
    intent.value = v.value ?? "0";
  }
  const input = { network: net.id, intent };
  const request = parseDryRun(input);
  if (flags.submit && net.id !== "atlantic-testnet") throw new AgentError("usage", "--submit is limited to the Atlantic testnet (--network atlantic-testnet).");
  const started = new Date();
  const endpoint: ChainMcpEndpoint = flags.submit
    ? { kind: "local", network: flags.rpc ? { ...net, rpcUrl: flags.rpc } : net, broadcast: true }
    : flags.chainMcp
      ? { kind: "hosted", url: flags.chainMcp }
      : net.hostedChainMcp && !flags.rpc
        ? { kind: "hosted", url: net.hostedChainMcp }
        : { kind: "local", network: flags.rpc ? { ...net, rpcUrl: flags.rpc } : net, broadcast: false };
  const mcp = await ChainMcp.connect(endpoint, { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 60 });
  try {
    const run = await runDryRun(request.intent, { chain: new Chain(mcp, net), block: flags.block, signer: flags.submit ? keySigner() : undefined });
    if (flags.proof) {
      const proof = proofFile({ task: "08", capability: "dry-run-executor", about: "One Dry-Run Executor run: the transaction (input), the prediction (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: request, result: run });
      await writeFile(flags.proof, `${JSON.stringify(proof, null, 2)}\n`);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printDryRun(run);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.submission && !run.submission.matched ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

function printGate(run: GateRun): void {
  const mark = (passed: boolean | null) => (passed === true ? "pass" : passed === false ? "FAIL" : "n/a ");
  const shown = (value: string) => (/^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);
  out(`Pharos Policy Gatekeeper · ${run.policy.name}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${BigInt(run.block.number).toLocaleString("en-US")} · ${run.block.timestamp}`);
  out(`  Request     ${run.summary}`);
  out();
  const seen = (r: GateRun["rules"][number]) => (r.passed === null ? `unreadable (${r.error})` : r.observed === null ? "does not apply" : shown(r.observed));
  const [width, seenWidth, limitWidth] = [(r: GateRun["rules"][number]) => r.label, seen, (r: GateRun["rules"][number]) => r.limit].map((column) => Math.max(...run.rules.map((r) => column(r).length)));
  for (const r of run.rules) {
    out(`  ${mark(r.passed)}  ${r.label.padEnd(width!)}  ${seen(r).padEnd(seenWidth!)}  ${r.limit.padEnd(limitWidth!)}  [${r.tool}]`);
    if (r.note) out(`        ${"".padEnd(width!)}  ${r.note}`);
  }
  out();
  const { decision: d } = run;
  out(`  Decision    ${d.allowed ? "ALLOWED" : "DENIED"}: ${d.passed} of ${d.total} rules hold${d.failed.length ? `; failing: ${d.failed.join(", ")}` : ""}${d.unreadable.length ? `; unreadable: ${d.unreadable.join(", ")}` : ""}`);
  const dry = run.dryRun;
  if (dry) out(`  Dry run     ${dry.verdict.replace("-", " ")}${dry.gas ? `; gas ${BigInt(dry.gas.gas).toLocaleString("en-US")} (limit ${BigInt(dry.gas.gasLimit).toLocaleString("en-US")}), about ${formatAmount(BigInt(dry.gas.expectedCost), 18, 8)} ${network(run.network.id).nativeSymbol}` : ""}${dry.reason ? `: ${dry.reason}` : ""}`);
  const e = run.execution;
  if (e) {
    out(`  Sent        ${e.txHash} (nonce ${e.nonce}): ${e.status}${e.blockNumber ? ` in block ${BigInt(e.blockNumber).toLocaleString("en-US")}` : ""}`);
    for (const c of e.comparisons) out(`    ${c.match ? "match" : "DIFF "}  ${c.what.padEnd(18)} predicted ${c.predicted}; actual ${c.actual}`);
  } else if (run.notSent) out(`  Not sent    ${run.notSent}`);
  else out(`  Sent        no${d.allowed ? (run.network.chainId === 1672 ? ": the hosted Chain MCP is read-only; --execute runs on Atlantic" : "") : ": denied"}`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls.${e ? "" : " Nothing was signed or sent."}`);
}

async function gate(flags: Flags): Promise<number> {
  const v = flags.values;
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  const name = flags.positional[1] ?? "treasury";
  const preset = POLICY_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset.policy());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No policy preset or file "${name}".`, "Presets: treasury (mainnet), atlantic-treasury (testnet, from PRIVATE_KEY's address). Or pass a path to a policy JSON file.");
    }
  }
  // "$SIGNER" stands for the address of PRIVATE_KEY, in the policy and in the request.
  const needsKey = () => {
    if (!process.env.PRIVATE_KEY) throw new AgentError("usage", `"${name}" uses your own wallet ($SIGNER), so it needs PRIVATE_KEY (an Atlantic testnet key) for the address.`, "export PRIVATE_KEY=0x... (never commit it)");
    return keySigner().address;
  };
  if (text.includes("$SIGNER")) text = text.replaceAll("$SIGNER", needsKey());
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const policy = parsePolicy(json);
  const net = network(policy.network);
  const kind = flags.positional[2] ?? "erc20-transfer";
  const defaults: Record<string, string> = preset?.request ?? {};
  const fill = (value: string | undefined) => (value === "$SIGNER" ? needsKey() : value);
  const intent: Record<string, unknown> = { kind, from: fill(v.from ?? defaults.from ?? (flags.execute ? "$SIGNER" : undefined)), to: fill(v.to ?? defaults.to), amount: v.amount ?? defaults.amount ?? "1" };
  if (kind === "erc20-transfer" || kind === "erc20-approve") intent.token = v.token ? tokenFor(net, v.token) : (defaults.token ?? tokenFor(net, "USDC"));
  if (kind === "erc20-approve") intent.spender = fill(v.spender);
  const request = parseDryRun({ network: net.id, intent });
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const run = await runGate(policy, request.intent, { chain: new Chain(mcp, net), block: flags.block, signer: flags.execute ? keySigner() : undefined });
    if (flags.proof) {
      const proof = proofFile({ task: "11", capability: "policy-gatekeeper", about: "One Policy Gatekeeper run: the policy and the request (input), the decision (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { policy: json, request }, result: run });
      await writeFile(flags.proof, `${JSON.stringify(proof, null, 2)}\n`);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printGate(run);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.outcome === "denied" ? 9 : run.execution && !run.execution.matched ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

async function verify(flags: Flags): Promise<number> {
  const path = flags.positional[1];
  if (!path) throw new AgentError("usage", "verify needs a proof file.");
  const proof = JSON.parse(await readFile(path, "utf8")) as ProofFile;
  const verifiers: Record<string, (proof: ProofFile) => Promise<{ name: string; ok: boolean; detail: string }[]>> = { "threshold-guardian": verifyGuardianProof, "dry-run-executor": verifyDryRunProof, "policy-gatekeeper": verifyGateProof };
  const verifier = verifiers[proof.capability];
  if (!verifier) throw new AgentError("usage", `No verifier for "${proof.capability}".`);
  const checks = await verifier(proof);
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
  if (command === "dryrun") return dryrun(flags);
  if (command === "gate") return gate(flags);
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

