// Task 05, Threshold Guardian: the live run.
//
//   1. Check the Chain MCP server is on the guardian's network (get_chain_info), and pin one block.
//   2. Read every condition's value at that block through Chain MCP (gas price is live: the tool takes no block).
//   3. Decide by the rule. A value that could not be read never counts as passing.
//   4. Only if the rule holds: prepare the action, simulate it with eth_call at the same block, estimate
//      its gas, and check the payer can pay for it. A failing simulation blocks the action.
//   5. Only with --execute, on Atlantic: re-read every condition at the newest block, and only if the rule
//      still holds, sign locally and broadcast through Chain MCP send_raw_transaction.
import { decodeCall, ERC20, encodeCall, encodeTransfer, isTrueWord, parseSignature, revertReason } from "../core/abi.js";
import { formatAmount, parseAmount } from "../core/amounts.js";
import { CallReverted, type Address, type BlockHeader, type Chain, type Hex, type TxRequest } from "../core/chain.js";
import { AgentError, errorMessage, ToolCallError } from "../core/errors.js";
import { signAndSend, type Signer } from "../core/execute.js";
import { knownToken } from "../core/networks.js";
import { describeRule, type Condition, type GuardianConfig } from "./config.js";
import { decide, outcome, thresholdValue, type ConditionOutcome, type Decision, type Value } from "./evaluate.js";

export interface ActionResult {
  type: GuardianConfig["action"]["type"];
  summary: string;
  tx: { from: Address; to: Address; data: Hex; value: string };
  simulation: { ok: boolean; block: string; returned: Hex | null; reason: string | null };
  gas: string | null;
  gasPrice: string | null;
  cost: { wei: string; display: string } | null;
  payerBalance: { wei: string; display: string } | null;
  status: "ready" | "blocked";
  reason: string | null;
}

export interface ExecutionResult {
  recheck: { block: string; evaluatedAt: string; decision: Decision; conditions: ConditionOutcome[] };
  sent: boolean;
  txHash: Hex | null;
  nonce: number | null;
  status: "success" | "reverted" | "pending" | "not sent";
  blockNumber: string | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  reason: string | null;
}

export type Outcome = "fire" | "hold" | "blocked" | "executed" | "aborted";

export interface GuardianRun {
  schema: "pharos-agent/guardian-run/1";
  guardian: string;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  /** The block every condition was read at: the latest when the run started, or one asked for. */
  block: { number: string; hash: Hex; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  rule: string;
  conditions: ConditionOutcome[];
  decision: Decision;
  action: ActionResult | null;
  execution: ExecutionResult | null;
  outcome: Outcome;
  headline: string;
  toolCalls: number;
}

export interface RunOptions {
  chain: Chain;
  /** Evaluate at this block instead of the latest. */
  block?: bigint;
  now?: () => Date;
  /** Present only to execute: the signer (whose address must be the action's payer). */
  signer?: Signer;
  wait?: { polls?: number; pollMs?: number };
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Read one condition's value at `block`. A tool error or revert becomes an unreadable value, not a crash. */
async function readCondition(chain: Chain, condition: Condition, block: BlockHeader, now: Date, decimals: Map<string, number | Error>, gasMemo: { price?: bigint }): Promise<{ value: Value | null; error: string | null; unit: string; tokenDecimals: number }> {
  const net = chain.network;
  const { read } = condition;
  try {
    switch (read.kind) {
      case "erc20-balance": {
        const dec = decimals.get(read.token.toLowerCase());
        const unit = knownToken(net, read.token)?.symbol ?? "tokens";
        if (dec instanceof Error || dec === undefined) return { value: null, error: `decimals() could not be read: ${dec instanceof Error ? dec.message : "missing"}`, unit, tokenDecimals: 0 };
        const raw = decodeCall(ERC20.balanceOf, await chain.call({ to: read.token, data: encodeCall(ERC20.balanceOf, [read.holder]) }, block.number));
        return { value: { type: "number", raw: raw as bigint, decimals: dec, unit }, error: null, unit, tokenDecimals: dec };
      }
      case "native-balance": {
        const raw = await chain.balance(read.address, block.number);
        return { value: { type: "number", raw, decimals: 18, unit: net.nativeSymbol }, error: null, unit: net.nativeSymbol, tokenDecimals: 18 };
      }
      case "call": {
        const sig = parseSignature(read.signature);
        const result = decodeCall(sig, await chain.call({ to: read.to, data: encodeCall(sig, read.args) }, block.number));
        if (typeof result === "boolean") return { value: { type: "bool", value: result }, error: null, unit: "", tokenDecimals: 0 };
        if (typeof result === "string") return { value: { type: "address", value: result }, error: null, unit: "", tokenDecimals: 0 };
        return { value: { type: "number", raw: result, decimals: read.decimals ?? 0, unit: "" }, error: null, unit: "", tokenDecimals: read.decimals ?? 0 };
      }
      case "has-code": {
        const code = await chain.code(read.address, block.number);
        return { value: { type: "bool", value: code !== "0x" && code.length > 2 }, error: null, unit: "", tokenDecimals: 0 };
      }
      case "gas-price": {
        gasMemo.price ??= (await chain.gasPrice()).gasPrice;
        return { value: { type: "number", raw: gasMemo.price, decimals: 9, unit: "gwei" }, error: null, unit: "gwei", tokenDecimals: 9 };
      }
      case "block-age": {
        const age = BigInt(Math.max(0, Math.floor(now.getTime() / 1000) - Number(block.timestamp)));
        return { value: { type: "number", raw: age, decimals: 0, unit: "s" }, error: null, unit: "s", tokenDecimals: 0 };
      }
      case "nonce": {
        const raw = await chain.nonce(read.address, block.number);
        return { value: { type: "number", raw, decimals: 0, unit: "" }, error: null, unit: "", tokenDecimals: 0 };
      }
    }
  } catch (error) {
    if (error instanceof CallReverted) return { value: null, error: `reverted: ${revertReason(error.data, error.reason)}`, unit: "", tokenDecimals: 0 };
    if (error instanceof ToolCallError) return { value: null, error: error.detail, unit: "", tokenDecimals: 0 };
    // The connection, the call budget or the chain itself failing stops the run; anything else (an answer
    // that does not decode, say from an address with no contract) leaves just this value unreadable.
    if (error instanceof AgentError && error.kind !== "mcp_tool") throw error;
    return { value: null, error: `unreadable answer: ${errorMessage(error).split("\n")[0]}`, unit: "", tokenDecimals: 0 };
  }
}

/** decimals() of every token the guardian touches, read at the pinned block (cross-checked with the official list). */
async function readDecimals(chain: Chain, tokens: Address[], block: bigint): Promise<Map<string, number | Error>> {
  const out = new Map<string, number | Error>();
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (out.has(key)) continue;
    try {
      const value = Number(decodeCall(ERC20.decimals, await chain.call({ to: token, data: encodeCall(ERC20.decimals, []) }, block)) as bigint);
      const official = knownToken(chain.network, token);
      if (official && official.decimals !== value) throw new AgentError("mcp_tool", `${official.symbol} reports ${value} decimals; the official token list says ${official.decimals}.`);
      out.set(key, value);
    } catch (error) {
      if (error instanceof AgentError && error.kind === "mcp_connection") throw error;
      out.set(key, new Error(error instanceof CallReverted ? revertReason(error.data, error.reason) : errorMessage(error)));
    }
  }
  return out;
}

const tokensOf = (config: GuardianConfig): Address[] => [
  ...config.conditions.flatMap((c) => (c.read.kind === "erc20-balance" ? [c.read.token] : [])),
  ...(config.action.type === "erc20-transfer" ? [config.action.token] : []),
];

async function evaluateAt(chain: Chain, config: GuardianConfig, block: BlockHeader, now: Date, decimals: Map<string, number | Error>, gasMemo: { price?: bigint }) {
  const outcomes: ConditionOutcome[] = [];
  const values = new Map<string, Value | null>();
  for (const condition of config.conditions) {
    const read = await readCondition(chain, condition, block, now, decimals, gasMemo);
    values.set(condition.id, read.value);
    const tokenDec = condition.read.kind === "erc20-balance" ? decimals.get(condition.read.token.toLowerCase()) : undefined;
    const threshold = thresholdValue(condition, typeof tokenDec === "number" ? tokenDec : 0, read.unit);
    outcomes.push(outcome(condition, read.value, threshold, read.error));
  }
  return { outcomes, values, decision: decide(config.fireWhen, outcomes) };
}

/** Prepare the action, simulate it at the pinned block, estimate gas, and check the payer can pay. */
async function prepareAction(chain: Chain, config: GuardianConfig, block: bigint, decimals: Map<string, number | Error>, values: Map<string, Value | null>, gasMemo: { price?: bigint }): Promise<ActionResult> {
  const { action } = config;
  const net = chain.network;
  let tx: TxRequest;
  let summary: string;
  if (action.type === "erc20-transfer") {
    const dec = decimals.get(action.token.toLowerCase());
    const symbol = knownToken(net, action.token)?.symbol ?? "tokens";
    if (typeof dec !== "number") {
      return blocked({ type: action.type, summary: `Transfer ${action.amount} ${symbol} to ${short(action.to)}`, tx: { from: action.from, to: action.token, data: "0x", value: "0" } }, block, "The token's decimals could not be read, so the amount cannot be encoded.");
    }
    const amount = parseAmount(action.amount, dec, "action.amount");
    tx = { from: action.from, to: action.token, data: encodeTransfer(action.to, amount) };
    summary = `Transfer ${formatAmount(amount, dec)} ${symbol} from ${short(action.from)} to ${short(action.to)}`;
  } else {
    const amount = parseAmount(action.amount, 18, "action.amount");
    tx = { from: action.from, to: action.to, value: amount };
    summary = `Send ${formatAmount(amount, 18)} ${net.nativeSymbol} from ${short(action.from)} to ${short(action.to)}`;
  }
  const shown = { type: action.type, summary, tx: { from: tx.from!, to: tx.to, data: tx.data ?? "0x", value: (tx.value ?? 0n).toString() } };

  // Simulate at the pinned block: the same state the conditions were read at.
  let returned: Hex;
  try {
    returned = await chain.call(tx, block);
  } catch (error) {
    if (error instanceof CallReverted) return blocked(shown, block, `The action reverts in simulation: ${revertReason(error.data, error.reason)}.`);
    if (error instanceof ToolCallError) return blocked(shown, block, `The simulation failed: ${error.detail}.`);
    throw error;
  }
  if (action.type === "erc20-transfer" && returned !== "0x" && !isTrueWord(returned)) return blocked(shown, block, "The token's transfer returns false in simulation.", returned);

  let gas: bigint;
  try {
    gas = await chain.estimateGas(tx);
  } catch (error) {
    if (error instanceof CallReverted) return blocked(shown, block, `Gas estimation reverts: ${revertReason(error.data, error.reason)}.`, returned);
    if (error instanceof ToolCallError) return blocked(shown, block, `Gas estimation failed: ${error.detail}.`, returned);
    throw error;
  }
  gasMemo.price ??= (await chain.gasPrice()).gasPrice;
  const cost = gas * gasMemo.price;
  // The payer's native balance: reuse a condition that already read it at this block, or read it.
  const known = config.conditions.find((c) => c.read.kind === "native-balance" && c.read.address.toLowerCase() === action.from.toLowerCase());
  const knownValue = known ? values.get(known.id) : null;
  const payer = knownValue?.type === "number" ? knownValue.raw : await chain.balance(action.from, block);
  const needed = cost + (tx.value ?? 0n);
  const result: ActionResult = {
    ...shown,
    simulation: { ok: true, block: block.toString(), returned, reason: null },
    gas: gas.toString(),
    gasPrice: gasMemo.price.toString(),
    cost: { wei: cost.toString(), display: `${formatAmount(cost, 18, 8)} ${net.nativeSymbol}` },
    payerBalance: { wei: payer.toString(), display: `${formatAmount(payer, 18, 6)} ${net.nativeSymbol}` },
    status: "ready",
    reason: null,
  };
  if (payer < needed) return { ...result, status: "blocked", reason: `The payer holds ${result.payerBalance!.display} but needs ${formatAmount(needed, 18, 8)} ${net.nativeSymbol} for the action and its gas.` };
  return result;
}

function blocked(shown: Pick<ActionResult, "type" | "summary" | "tx">, block: bigint, reason: string, returned: Hex | null = null): ActionResult {
  return { ...shown, simulation: { ok: false, block: block.toString(), returned, reason }, gas: null, gasPrice: null, cost: null, payerBalance: null, status: "blocked", reason };
}

export async function runGuardian(config: GuardianConfig, options: RunOptions): Promise<GuardianRun> {
  const { chain } = options;
  const now = (options.now ?? (() => new Date()))();
  await chain.expectChain();
  const pinned = await chain.block(options.block ?? (await chain.blockNumber()));
  const decimals = await readDecimals(chain, tokensOf(config), pinned.number);
  const gasMemo: { price?: bigint } = {};
  const { outcomes, values, decision } = await evaluateAt(chain, config, pinned, now, decimals, gasMemo);

  let action: ActionResult | null = null;
  let execution: ExecutionResult | null = null;
  let result: Outcome = decision.fire ? "fire" : "hold";
  if (decision.fire) {
    action = await prepareAction(chain, config, pinned.number, decimals, values, gasMemo);
    if (action.status === "blocked") result = "blocked";
  }
  if (options.signer && action?.status === "ready") {
    execution = await execute(config, options, action, decimals);
    result = execution.sent ? "executed" : "aborted";
  }

  const at = `block ${pinned.number.toLocaleString("en-US")}`;
  const headline =
    result === "hold"
      ? `Hold at ${at}: ${decision.summary}`
      : result === "blocked"
        ? `Conditions hold at ${at}, but the action is blocked: ${action?.reason}`
        : result === "fire"
          ? `Fire at ${at}: ${decision.summary} The action is prepared and simulated.`
          : result === "executed"
            ? `Fired: ${execution?.status === "success" ? "the transaction succeeded" : `the transaction is ${execution?.status}`}.`
            : `Not fired: ${execution?.reason}`;
  return {
    schema: "pharos-agent/guardian-run/1",
    guardian: config.name,
    network: { id: chain.network.id, name: chain.network.name, chainId: chain.network.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: pinned.number.toString(), hash: pinned.hash, timestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), source: options.block === undefined ? "latest" : "requested" },
    evaluatedAt: now.toISOString(),
    rule: describeRule(config.fireWhen, config.conditions.length),
    conditions: outcomes,
    decision,
    action,
    execution,
    outcome: result,
    headline,
    toolCalls: chain.mcp.toolCalls,
  };
}

/** Re-check every condition at the newest block, and only if the rule still holds, sign and broadcast. */
async function execute(config: GuardianConfig, options: RunOptions, action: ActionResult, decimals: Map<string, number | Error>): Promise<ExecutionResult> {
  const { chain, signer } = options;
  if (!signer) throw new AgentError("usage", "Executing needs a signer.");
  if (chain.network.id !== "atlantic-testnet") throw new AgentError("execution", "Executing is limited to the Atlantic testnet; this guardian runs on mainnet.");
  if (signer.address.toLowerCase() !== action.tx.from.toLowerCase()) throw new AgentError("execution", `The key's address ${signer.address} is not the action's payer ${action.tx.from}.`);
  const latest = await chain.block(await chain.blockNumber());
  const now = (options.now ?? (() => new Date()))();
  const recheck = await evaluateAt(chain, config, latest, now, decimals, {});
  const base = { recheck: { block: latest.number.toString(), evaluatedAt: now.toISOString(), decision: recheck.decision, conditions: recheck.outcomes } };
  if (!recheck.decision.fire) {
    return { ...base, sent: false, txHash: null, nonce: null, status: "not sent", blockNumber: null, gasUsed: null, effectiveGasPrice: null, reason: `The conditions no longer hold at block ${latest.number}: ${recheck.decision.summary}` };
  }
  const sent = await signAndSend(chain, signer, { to: action.tx.to, data: action.tx.data, value: BigInt(action.tx.value), gasEstimate: BigInt(action.gas ?? "0") }, options.wait);
  return {
    ...base,
    sent: true,
    txHash: sent.hash,
    nonce: sent.nonce,
    status: sent.receipt ? sent.receipt.status : "pending",
    blockNumber: sent.receipt ? sent.receipt.blockNumber.toString() : null,
    gasUsed: sent.receipt ? sent.receipt.gasUsed.toString() : null,
    effectiveGasPrice: sent.receipt?.effectiveGasPrice?.toString() ?? null,
    reason: null,
  };
}
