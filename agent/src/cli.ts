#!/usr/bin/env node
// pharos-agent: the Pharos Agent Lab's agent, one capability per task.
//
//   pharos-agent guardian [preset | config.json] [--block N] [--json] [--proof FILE] [--execute] [--verbose]
//   pharos-agent dryrun [kind] [--token --from --to --amount ...] [--submit]
//   pharos-agent gate [policy] [kind] [--token --from --to --amount ...] [--execute]
//   pharos-agent watch [preset | watcher.json] [--store FILE] [--execute]
//   pharos-agent alert [preset | bot.json] [--store FILE] [--webhook URL]
//   pharos-agent whales [preset | watchlist.json] [--store FILE]
//   pharos-agent gas [preset | plan.json] [--store FILE] [--execute]
//   pharos-agent explain (0xHASH | [kind] --from --to --amount ...)
//   pharos-agent verify FILE...
import { readFile, rename, writeFile } from "node:fs/promises";
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
import { parseWatcher } from "./trend/config.js";
import { WATCHER_PRESETS } from "./trend/presets.js";
import { runWatch, type TrendRun } from "./trend/run.js";
import { emptyStore, parseStore } from "./trend/store.js";
import { historyCheck, verifyTrendProof } from "./trend/verify.js";
import { parseAlertBot } from "./alert/config.js";
import { deliver } from "./alert/deliver.js";
import { ALERT_PRESETS } from "./alert/presets.js";
import { MAX_ALERTS, runAlerts } from "./alert/run.js";
import { afterDelivery, emptyAlertStore, parseAlertStore } from "./alert/store.js";
import { alertHistoryCheck, verifyAlertProof, type RecordedAlertRun } from "./alert/verify.js";
import { parseWatchlist } from "./whale/config.js";
import { WHALE_PRESETS } from "./whale/presets.js";
import { MAX_MOVES, runWhales, type WhaleRun } from "./whale/run.js";
import { emptyWhaleStore, parseWhaleStore } from "./whale/store.js";
import { verifyWhaleProof, whaleHistoryCheck } from "./whale/verify.js";
import { parseGasPlan } from "./gas/config.js";
import { GAS_PRESETS } from "./gas/presets.js";
import { runGasPlan, type GasRun } from "./gas/run.js";
import { emptyGasStore, parseGasStore } from "./gas/store.js";
import { gasHistoryCheck, verifyGasProof } from "./gas/verify.js";
import { explain as explainTx, type Explanation } from "./support/explain.js";
import { parseExplainRequest, verifyExplanationProof } from "./support/verify.js";

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

  pharos-agent watch [preset | watcher.json] [options]     Task 09, Trend Watcher
      One observation per run, kept in a store file across runs. Acts only when the trend over the last
      N observations holds, once per trend: the action is dry-run, and on Atlantic with --execute sent.
      Preset: usdc-outflow (Pharos Mainnet). A watcher is JSON (agent/src/trend/config.ts).
      --store FILE         where the observations are kept between runs (default: trend-store.json)
      --execute, --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent alert [preset | bot.json] [options]         Task 22, On-Chain Alert Bot
      One run: the blocks since the last run scanned for matching transfers, and each state rule read
      and compared with the last run. Every new alert is printed once, and POSTed to the webhook; one
      the webhook did not take is kept and retried on the next run. Preset: usdc (Pharos Mainnet). A bot
      is JSON (agent/src/alert/config.ts).
      --store FILE         the bot's memory between runs (default: alert-store.json)
      --webhook URL        POST each alert as JSON; its line is in "text" and "content"
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent whales [preset | watchlist.json] [options]  Task 23, Whale-Watching Agent
      One run: each tracked address read at the newest block (holdings, nonce), and the blocks since
      the last run scanned for its token transfers. Surfaces the significant moves (a transfer of at
      least the token's minimum, a native balance change of at least the native minimum since the last
      run) and sums up the rest per address. Preset: usdc (Pharos Mainnet). A watchlist is JSON
      (agent/src/whale/config.ts).
      --store FILE         what the watcher saw last run (default: whale-store.json)
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent gas [preset | plan.json] [options]           Task 24, Gas Fee Optimizer
      Observes the fee (each block's base fee), keeps the observations across runs, and decides for one
      transaction whether to send it now or wait: send when the fee is at or below the target (a
      percentile of the observed fees, or a fixed fee) or the plan has waited past its deadline. Gives
      the fee settings, capped at the target, and the cost now and at the target. Presets: usdc (Pharos
      Mainnet, advice only), atlantic-usdc (testnet, from PRIVATE_KEY's address). A plan is JSON
      (agent/src/gas/config.ts).
      --store FILE         the observations kept between runs (default: gas-store.json)
      --execute            Atlantic only: send it, with those settings, when the decision is to send
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent explain (0xHASH | [kind] [options])          Task 27, dApp Support Agent
      Why a transaction failed, in plain language, with each finding's source. By hash: its receipt,
      its call replayed at the block before its own for the revert, decoded (Error, Panic, OpenZeppelin
      errors), the target's code, the sender's token balance, and whether it ran out of gas. Described
      instead (the kinds and options of dryrun): why it would fail if sent now.
      --network ID, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent verify FILE... check proofs offline by replaying their recorded responses; several
                              proofs of one watcher, alert bot, watchlist or gas plan, in run order,
                              are also checked as one history

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
  store?: string;
  webhook?: string;
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
    else if (arg === "--store") {
      const value = argv[++i];
      if (!value) throw new AgentError("usage", "--store needs a file.");
      flags.store = value;
    } else if (arg === "--webhook") {
      const value = argv[++i];
      if (!value || !/^https?:\/\/\S+$/.test(value)) throw new AgentError("usage", "--webhook must be an http(s) URL.");
      flags.webhook = value;
    } else if (arg === "--block" || arg === "--proof" || arg === "--chain-mcp" || arg === "--rpc") {
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

function printWatch(run: TrendRun, storePath: string): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out(`Pharos Trend Watcher · ${run.watcher}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${n(run.block.number)} · ${run.block.timestamp}`);
  out(`  Observing   ${run.observing.label}`);
  out(`  Store       ${storePath}: ${run.store.observations.length} ${run.store.observations.length === 1 ? "observation" : "observations"}${run.store.actedAt ? `; acted at block ${n(run.store.actedAt)}` : ""}`);
  if (run.skipped) out(`  Skipped     ${run.skipped}`);
  out();
  const width = Math.max(0, ...run.trend.window.map((p) => p.shown.length));
  for (const [index, p] of run.trend.window.entries()) out(`  ${index === 0 ? "Counted " : "        "}    block ${n(p.block).padStart(12)}  ${p.timestamp.slice(11, 19)}  ${p.shown.padStart(width)}${p.change ? `  ${p.change}` : ""}`);
  out(`  Trend       ${run.trend.label}: ${run.trend.detail}${run.trend.holds ? " (holds)" : " (not yet)"}`);
  if (run.action) out(`  Action      ${run.action.headline}`);
  const e = run.execution;
  if (e) {
    out(`  Sent        ${e.txHash} (nonce ${e.nonce}): ${e.status}${e.blockNumber ? ` in block ${n(e.blockNumber)}` : ""}`);
    for (const c of e.comparisons) out(`    ${c.match ? "match" : "DIFF "}  ${c.what.padEnd(18)} predicted ${c.predicted}; actual ${c.actual}`);
  } else if (run.notSent) out(`  Not sent    ${run.notSent}`);
  else if (run.action) out(`  Sent        no${run.network.chainId === 1672 ? ": the hosted Chain MCP is read-only; --execute runs on Atlantic" : ""}`);
  out(`  Outcome     ${run.outcome.toUpperCase()}${run.outcome === "watching" ? "" : ": the next trend counts only observations after this block"}`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls.${e ? "" : " Nothing was signed or sent."}`);
}

async function watch(flags: Flags): Promise<number> {
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  const name = flags.positional[1] ?? "usdc-outflow";
  const preset = WATCHER_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No watcher preset or file "${name}".`, "Preset: usdc-outflow (mainnet). Or pass a path to a watcher JSON file.");
    }
  }
  if (text.includes("$SIGNER")) {
    if (!process.env.PRIVATE_KEY) throw new AgentError("usage", `"${name}" uses your own wallet ($SIGNER), so it needs PRIVATE_KEY (an Atlantic testnet key) for the address.`, "export PRIVATE_KEY=0x... (never commit it)");
    text = text.replaceAll("$SIGNER", keySigner().address);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const watcher = parseWatcher(json);
  const net = network(watcher.network);
  // The store: the observations of earlier runs, or a new one on the first run.
  const storePath = flags.store ?? "trend-store.json";
  let saved: string | null = null;
  try {
    saved = await readFile(storePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${storePath} cannot be read: ${errorMessage(error)}`);
  }
  let stored: unknown = null;
  if (saved !== null) {
    try {
      stored = JSON.parse(saved);
    } catch (error) {
      throw new AgentError("usage", `The store ${storePath} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const store = stored === null ? emptyStore(watcher) : parseStore(stored, watcher);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const run = await runWatch(watcher, store, { chain: new Chain(mcp, net), block: flags.block, signer: flags.execute ? keySigner() : undefined });
    if (flags.proof) {
      const proof = proofFile({ task: "09", capability: "trend-watcher", about: "One Trend Watcher run: the watcher and the store it started from (input), the run and the store it left (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several in run order.", mcp, network: net, startedAt: started, input: { watcher: json, store }, result: run });
      await writeFile(flags.proof, `${JSON.stringify(proof, null, 2)}\n`);
    }
    // Written only after a run that worked, and whole: a new file, then renamed over the old one.
    await writeFile(`${storePath}.tmp`, `${JSON.stringify(run.store, null, 2)}\n`);
    await rename(`${storePath}.tmp`, storePath);
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printWatch(run, storePath);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.execution && !run.execution.matched ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

function printAlerts(run: RecordedAlertRun, storePath: string): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out(`Pharos On-Chain Alert Bot · ${run.bot}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${n(run.block.number)} · ${run.block.timestamp}`);
  out(`  Scanned     ${run.scanned ? `blocks ${n(run.scanned.from)}–${n(run.scanned.to)} (${run.scanned.pages} get_logs ${run.scanned.pages === 1 ? "call" : "calls"})` : "no new blocks"}${run.skipped ? `; skipped ${n(run.skipped.from)}–${n(run.skipped.to)}, too far behind` : ""}`);
  out(`  Store       ${storePath}`);
  out();
  const width = Math.max(...run.rules.map((r) => r.label.length));
  for (const r of run.rules) {
    const now = r.kind === "transfer" ? `${r.matches} new` : r.state === "unreadable" ? `unreadable (${r.error})` : `${r.state === "holds" ? "HOLDS" : "clear"}: ${r.observed}`;
    out(`  ${r.label.padEnd(width)}  ${now}   [${r.tool}]`);
  }
  out();
  if (!run.alerts.length) out("  Alerts      none new");
  for (const [index, a] of run.alerts.entries()) out(`  ${index === 0 ? "Alerts  " : "        "}    ${a.kind === "transfer" ? "" : `${a.kind.toUpperCase()} `}${a.label}: ${a.message}`);
  if (run.truncated) out(`              and ${run.truncated} more matching transfers, beyond the ${MAX_ALERTS} one run reports`);
  const d = run.delivery;
  if (d) out(`  Delivered   ${d.delivered.length} ${d.channel === "webhook" ? "to the webhook" : "here"}${d.failed.length ? `; ${d.failed.length} kept to retry (${d.failed[0]!.error})` : ""}`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls. Nothing was signed or sent.`);
}

async function alert(flags: Flags): Promise<number> {
  const name = flags.positional[1] ?? "usdc";
  const preset = ALERT_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No alert bot preset or file "${name}".`, "Preset: usdc (mainnet). Or pass a path to an alert bot JSON file.");
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const bot = parseAlertBot(json);
  const net = network(bot.network);
  const storePath = flags.store ?? "alert-store.json";
  let saved: string | null = null;
  try {
    saved = await readFile(storePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${storePath} cannot be read: ${errorMessage(error)}`);
  }
  let stored: unknown = null;
  if (saved !== null) {
    try {
      stored = JSON.parse(saved);
    } catch (error) {
      throw new AgentError("usage", `The store ${storePath} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const store = stored === null ? emptyAlertStore(bot) : parseAlertStore(stored, bot);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const run = await runAlerts(bot, store, { chain: new Chain(mcp, net), block: flags.block });
    // Every pending alert, new or kept from a failed delivery, goes out now.
    const delivery = await deliver(bot.name, run.store.pending, flags.webhook ?? null);
    const recorded: RecordedAlertRun = { ...run, delivery };
    // The store first: once alerts are delivered, what the bot remembers must say so.
    await writeFile(`${storePath}.tmp`, `${JSON.stringify(afterDelivery(run.store, delivery.delivered), null, 2)}\n`);
    await rename(`${storePath}.tmp`, storePath);
    if (flags.proof) {
      const proof = proofFile({ task: "22", capability: "alert-bot", about: "One On-Chain Alert Bot run: the bot and the store it started from (input), the run with its alerts, the store it left and the delivery (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several in run order.", mcp, network: net, startedAt: started, input: { bot: json, store }, result: recorded });
      await writeFile(flags.proof, `${JSON.stringify(proof, null, 2)}\n`);
    }
    if (flags.json) out(JSON.stringify(recorded, null, 2));
    else printAlerts(recorded, storePath);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

function printWhales(run: WhaleRun, storePath: string): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out(`Pharos Whale Watcher · ${run.watchlist}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${n(run.block.number)} · ${run.block.timestamp}`);
  out(`  Scanned     ${run.scanned ? `blocks ${n(run.scanned.from)}–${n(run.scanned.to)} (${run.scanned.pages} get_logs ${run.scanned.pages === 1 ? "call" : "calls"}): ${run.transfers} ${run.transfers === 1 ? "transfer" : "transfers"} by tracked addresses` : "no new blocks"}${run.skipped ? `; skipped ${n(run.skipped.from)}–${n(run.skipped.to)}, too far behind` : ""}`);
  out(`  Store       ${storePath}`);
  for (const a of run.addresses) {
    const since = a.since === null ? "first seen" : `since block ${n(a.since)}`;
    out();
    out(`  ${a.label} (${a.address}, ${a.contract ? "has code" : "no code"})`);
    for (const t of a.tokens) {
      const moved = t.in.count || t.out.count ? ` · this run: ${t.in.count} in (${t.in.shown}), ${t.out.count} out (${t.out.shown})` : "";
      out(`    ${t.symbol.padEnd(6)} ${t.shown}${t.changeShown === null ? `, ${since}` : ` ${t.changeShown} ${since}`}${moved}`);
    }
    out(`    ${network(run.network.id).nativeSymbol.padEnd(6)} ${a.native.shown}${a.native.changeShown === null ? `, ${since}` : ` ${a.native.changeShown} ${since}`}`);
    out(`    Nonce  ${n(a.nonce)}${a.sent === null ? "" : ` · ${a.sent} ${a.sent === 1 ? "transaction" : "transactions"} sent ${since}`}`);
  }
  out();
  if (!run.events.length) out("  Significant none this run");
  for (const [index, e] of run.events.entries()) out(`  ${index === 0 ? "Significant" : "           "} ${e.message}`);
  if (run.truncated) out(`              and ${run.truncated} more significant transfers, beyond the ${MAX_MOVES} one run reports`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls. Nothing was signed or sent.`);
}

async function whales(flags: Flags): Promise<number> {
  const name = flags.positional[1] ?? "usdc";
  const preset = WHALE_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No watchlist preset or file "${name}".`, "Preset: usdc (mainnet). Or pass a path to a watchlist JSON file.");
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const list = parseWatchlist(json);
  const net = network(list.network);
  const storePath = flags.store ?? "whale-store.json";
  let saved: string | null = null;
  try {
    saved = await readFile(storePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${storePath} cannot be read: ${errorMessage(error)}`);
  }
  let stored: unknown = null;
  if (saved !== null) {
    try {
      stored = JSON.parse(saved);
    } catch (error) {
      throw new AgentError("usage", `The store ${storePath} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const store = stored === null ? emptyWhaleStore(list) : parseWhaleStore(stored, list);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 120 });
  try {
    const run = await runWhales(list, store, { chain: new Chain(mcp, net), block: flags.block });
    await writeFile(`${storePath}.tmp`, `${JSON.stringify(run.store, null, 2)}\n`);
    await rename(`${storePath}.tmp`, storePath);
    if (flags.proof) {
      const proof = proofFile({ task: "23", capability: "whale-watcher", about: "One Whale-Watching Agent run: the watchlist and the store it started from (input), the run with its significant moves, each address's report and the store it left (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several in run order.", mcp, network: net, startedAt: started, input: { watchlist: json, store }, result: run });
      await writeFile(flags.proof, `${JSON.stringify(proof, null, 2)}\n`);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printWhales(run, storePath);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

function printGas(run: GasRun, storePath: string): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  const d = run.dryRun;
  out(`Pharos Gas Fee Optimizer · ${run.plan}`);
  out();
  out(`  Network      ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP    ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block        ${n(run.block.number)} · ${run.block.timestamp}`);
  out(`  Transaction  ${d.summary} (${d.verdict === "would-succeed" ? `would succeed${d.gas ? `, ${n(d.gas.gas)} gas` : ""}` : d.verdict === "cannot-pay" ? "cannot pay its fee" : "would revert"})`);
  out(`  Store        ${storePath}`);
  out();
  const fresh = new Set(run.observed.map((o) => o.block));
  for (const [index, o] of run.window.entries()) {
    const full = BigInt(o.gasLimit) > 0n ? Number((BigInt(o.gasUsed) * 1000n) / BigInt(o.gasLimit)) / 10 : 0;
    out(`  ${index === 0 ? "Observed    " : "            "} block ${n(o.block).padStart(11)}  ${formatGwei(BigInt(o.fee)).padStart(16)}  ${`${full}% full`.padStart(9)}${o.block === run.block.number ? "  now" : fresh.has(o.block) ? "  read now" : ""}`);
  }
  out(`  ${run.fee.source === "base-fee" ? "Base fee    " : "Gas price   "} now ${run.fee.shown.now} · lowest ${run.stats.shown.min} · median ${run.stats.shown.median} · highest ${run.stats.shown.max}`);
  out(`  Target       ${run.target.shown}: ${run.target.how}`);
  out(`  Decision     ${{ send: "SEND NOW", wait: "WAIT", blocked: "NOT SENDABLE", sent: "ALREADY SENT" }[run.decision]}: ${run.reason}`);
  if (run.settings) out(`  Settings     maxFeePerGas ${run.settings.shown.maxFeePerGas} · maxPriorityFeePerGas ${run.settings.shown.maxPriorityFeePerGas}`);
  const c = run.costs;
  if (c) {
    out(`  Cost         now ${c.shown.now} · at the target ${c.shown.atTarget}${BigInt(c.saving) > 0n ? ` · waiting saves ${c.shown.saving}` : ""}`);
    out(`               at most ${c.shown.cappedMax} with this cap, against ${c.shown.standardMax} with the usual one (twice the base fee plus the priority fee)`);
  }
  const x = run.execution;
  if (x) out(`  Sent         ${x.txHash} · ${x.status}${x.blockNumber ? ` in block ${n(x.blockNumber)}` : ""}${x.cost ? ` · cost ${formatAmount(BigInt(x.cost), 18, 8)} ${network(run.network.id).nativeSymbol}` : ""}`);
  else if (run.notSent) out(`  Sent         ${run.notSent}`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls.`);
}

async function gasPlan(flags: Flags): Promise<number> {
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  const name = flags.positional[1] ?? "usdc";
  const preset = GAS_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No gas plan preset or file "${name}".`, "Presets: usdc (mainnet), atlantic-usdc (testnet, from PRIVATE_KEY's address). Or pass a path to a gas plan JSON file.");
    }
  }
  // "$SIGNER" stands for the address of PRIVATE_KEY.
  if (text.includes("$SIGNER")) {
    if (!process.env.PRIVATE_KEY) throw new AgentError("usage", `"${name}" sends from your own wallet ($SIGNER), so it needs PRIVATE_KEY (an Atlantic testnet key) for the address.`, "export PRIVATE_KEY=0x... (never commit it)");
    text = text.replaceAll("$SIGNER", keySigner().address);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const plan = parseGasPlan(json);
  const net = network(plan.network);
  if (flags.execute && net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (network: atlantic-testnet).");
  const storePath = flags.store ?? "gas-store.json";
  let saved: string | null = null;
  try {
    saved = await readFile(storePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${storePath} cannot be read: ${errorMessage(error)}`);
  }
  let stored: unknown = null;
  if (saved !== null) {
    try {
      stored = JSON.parse(saved);
    } catch (error) {
      throw new AgentError("usage", `The store ${storePath} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const store = stored === null ? emptyGasStore(plan) : parseGasStore(stored, plan);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 120 });
  try {
    const run = await runGasPlan(plan, store, { chain: new Chain(mcp, net), block: flags.block, signer: flags.execute ? keySigner() : undefined });
    await writeFile(`${storePath}.tmp`, `${JSON.stringify(run.store, null, 2)}\n`);
    await rename(`${storePath}.tmp`, storePath);
    if (flags.proof) {
      const proof = proofFile({ task: "24", capability: "gas-optimizer", about: "One Gas Fee Optimizer run: the plan and the store it started from (input), the observations, the decision, the fee settings and costs, the dry run, any transaction sent and the store it left (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several in run order.", mcp, network: net, startedAt: started, input: { plan: json, store }, result: run });
      await writeFile(flags.proof, `${JSON.stringify(proof, null, 2)}\n`);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printGas(run, storePath);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.execution && !run.execution.matched ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

function printExplanation(x: Explanation): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out("Pharos dApp Support Agent");
  out();
  out(`  Network      ${x.network.name} (chain ${x.network.chainId})`);
  out(`  Chain MCP    ${x.chainMcp.where}${x.chainMcp.server ? ` (${x.chainMcp.server})` : ""}`);
  out(`  Asked        ${x.request.kind === "hash" ? `the transaction ${x.request.hash}` : "a transaction described, not sent"}`);
  if (x.transaction) out(`  Transaction  ${x.transaction.summary} (from ${x.transaction.from})`);
  if (x.block) out(`  Block        ${n(x.block.number)} · ${x.block.timestamp}`);
  out(`  Status       ${{ succeeded: "SUCCEEDED", failed: "FAILED", pending: "PENDING", "not-found": "NOT FOUND", "would-succeed": "WOULD SUCCEED", "would-fail": "WOULD FAIL" }[x.status]}`);
  out();
  const width = Math.max(...x.findings.map((f) => f.check.length));
  for (const f of x.findings) out(`  ${f.tone === "cause" ? "!" : " "} ${f.check.padEnd(width)}  ${f.seen}   [${f.tool}]`);
  out();
  if (x.cause) out(`  Why          ${x.cause.text}`);
  if (x.cause?.error?.name) out(`  Error        ${x.cause.error.name}${Object.keys(x.cause.error.args).length ? ` (${Object.entries(x.cause.error.args).map(([k, v]) => `${k}: ${v}`).join(", ")})` : ""}`);
  if (x.fix) out(`  Fix          ${x.fix}`);
  if (!x.cause) out(`  ${x.headline}`);
  out();
  out(`  ${x.toolCalls} Chain MCP calls. Nothing was signed or sent.`);
}

async function explainCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const first = flags.positional[1];
  let input: Record<string, unknown>;
  if (first?.startsWith("0x")) input = { kind: "hash", hash: first };
  else {
    const kind = first ?? "erc20-transfer";
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
    input = { kind: "intent", intent };
  }
  const request = parseExplainRequest(input, net.id);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 40 });
  try {
    const result = await explainTx(request, { chain: new Chain(mcp, net) });
    if (flags.proof) {
      const proof = proofFile({ task: "27", capability: "dapp-support", about: "One dApp Support Agent answer: the transaction asked about (input), the explanation with every finding (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: request, result });
      await writeFile(flags.proof, `${JSON.stringify(proof, null, 2)}\n`);
    }
    if (flags.json) out(JSON.stringify(result, null, 2));
    else printExplanation(result);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

async function verify(flags: Flags): Promise<number> {
  const paths = flags.positional.slice(1);
  if (!paths.length) throw new AgentError("usage", "verify needs a proof file.");
  const verifiers: Record<string, (proof: ProofFile) => Promise<{ name: string; ok: boolean; detail: string }[]>> = { "threshold-guardian": verifyGuardianProof, "dry-run-executor": verifyDryRunProof, "policy-gatekeeper": verifyGateProof, "trend-watcher": verifyTrendProof, "alert-bot": verifyAlertProof, "whale-watcher": verifyWhaleProof, "gas-optimizer": verifyGasProof, "dapp-support": verifyExplanationProof };
  const proofs: ProofFile[] = [];
  let failed = 0;
  let total = 0;
  for (const path of paths) {
    const proof = JSON.parse(await readFile(path, "utf8")) as ProofFile;
    const verifier = verifiers[proof.capability];
    if (!verifier) throw new AgentError("usage", `No verifier for "${proof.capability}".`);
    const checks = await verifier(proof);
    if (paths.length > 1) out(path);
    for (const check of checks) out(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
    failed += checks.filter((c) => !c.ok).length;
    total += checks.length;
    proofs.push(proof);
  }
  // Several runs of one watcher or bot, in order: one history, each run from the store the last one left.
  const histories: Record<string, (proofs: readonly ProofFile[]) => { name: string; ok: boolean; detail: string }> = { "trend-watcher": historyCheck, "alert-bot": alertHistoryCheck, "whale-watcher": whaleHistoryCheck, "gas-optimizer": gasHistoryCheck };
  const historyOf = histories[proofs[0]?.capability ?? ""];
  if (proofs.length > 1 && historyOf && proofs.every((p) => p.capability === proofs[0]!.capability)) {
    const history = historyOf(proofs);
    out(`  ${history.ok ? "PASS" : "FAIL"}  ${history.name}: ${history.detail}`);
    failed += history.ok ? 0 : 1;
    total += 1;
  }
  out(failed ? `\n${failed} check(s) failed.` : `\nProof${paths.length > 1 ? "s" : ""} verified: ${total} checks.`);
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
  if (command === "watch") return watch(flags);
  if (command === "alert") return alert(flags);
  if (command === "whales") return whales(flags);
  if (command === "gas") return gasPlan(flags);
  if (command === "explain") return explainCommand(flags);
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

