// Task 10, Batch Executor: several independent actions bundled into one optimized execution flow.
//
//   1. The batch, read whole (read.ts): sends, approvals and wraps from one sender. Nothing is asked of
//      the chain for a batch that is not read whole.
//   2. The plan: sends of one asset to one address merged into one transaction, unless asked not to.
//      Two approvals of one spender for one token are not independent (the one sent last wins).
//   3. Through Chain MCP at one block: the sender's next nonce, and Task 08's dry run of each
//      transaction, every read they share made once (the chain, the block, a token, the sender's
//      balances, the fee quote). What the same dry runs ask, run one by one, is counted beside it.
//   4. Independence, shown rather than assumed: every balance the batch takes from must cover all it
//      takes before anything the batch adds to it, so any order works, and no allowance is set twice.
//      A send that needs a wrap first is not independent. A transaction that would revert alone is left
//      out; the others do not depend on it.
//   5. The flow: the transactions in one nonce sequence with one fee quote. On Atlantic, with a key,
//      they are signed and sent back to back, without waiting between, and their receipts are awaited
//      together; then every balance and allowance the batch changes is compared with the prediction.
import { formatUnits } from "viem";
import { decodeCall, ERC20, encodeCall } from "../core/abi.js";
import { formatAmount, formatGwei } from "../core/amounts.js";
import { Chain, type Address, type BlockHeader, type Hex, type Receipt, type ToolCaller } from "../core/chain.js";
import { AgentError, ToolCallError } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import type { Network } from "../core/networks.js";
import { EXAMPLE } from "../builder/action.js";
import type { Intent } from "../dryrun/intent.js";
import { runDryRun, type DryRun } from "../dryrun/run.js";
import { readBatch, type BatchAction, type BatchKind } from "./read.js";

export interface BatchSubmission {
  txHash: Hex | null;
  nonce: number;
  /** Refused: the node would not take it, so nothing after it was sent (its nonce would wait). */
  status: "success" | "reverted" | "pending" | "refused";
  blockNumber: string | null;
  gasUsed: string | null;
  /** What it paid for gas, from its receipt. */
  cost: string | null;
  error: string | null;
}

export interface BatchTx {
  /** Its place in the batch's transactions, from 1. */
  n: number;
  /** The batch lines it carries: more than one when sends were merged. */
  lines: number[];
  kind: BatchKind;
  asset: string;
  /** The token sent or approved, or the wrapped token a wrap makes; null for the native token sent. */
  token: Address | null;
  /** The recipient of a send, the spender of an approval; null for a wrap. */
  to: Address | null;
  amount: string;
  raw: string;
  summary: string;
  notes: string[];
  dryRun: DryRun;
  /** In the plan; left out, since it would revert alone; or not independent of another line. */
  state: "planned" | "left-out" | "dependent";
  reason: string | null;
  /** The transaction to sign, in the batch's nonce order; null for one not in the plan, or a batch not ready. */
  tx: { chainId: number; nonce: number; to: Address; data: Hex; value: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } | null;
  submission: BatchSubmission | null;
}

export interface BatchCheck {
  what: string;
  ok: boolean;
  detail: string;
}

export interface Comparison {
  what: string;
  predicted: string;
  actual: string;
  match: boolean;
}

export interface BatchRun {
  schema: "pharos-agent/batch/1";
  batch: string;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: Hex; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  sender: { address: Address; from: "input" | "key" | "example" };
  actions: BatchAction[];
  merge: boolean;
  /** Sends merged into one transaction: the lines, and what they became. */
  merged: { lines: number[]; into: number; what: string }[];
  /** The sender's next nonce at the block; null when the batch was refused before it was read. */
  nonce: number | null;
  txs: BatchTx[];
  /** Why the batch is, or is not, independent, one check at a time. */
  independence: BatchCheck[];
  /** The gas of the transactions in the plan: expected, and the most their caps allow; one fee quote for all. */
  fees: { expected: string; max: string; expectedShown: string; maxShown: string; maxFeePerGas: string; priorityFee: string; shown: string } | null;
  /** What bundling saved, measured: calls, and transactions. */
  savings: { calls: number; oneByOne: number; lines: number; transactions: number; merged: number; leftOut: number };
  /** Atlantic, with a key: what was sent back to back, and the batch compared with its prediction. */
  execution: {
    nonce: number;
    sent: number;
    receipts: number;
    blocks: { first: string; last: string; span: number } | null;
    comparisons: Comparison[];
    matched: boolean;
    calls: number;
  } | null;
  verdict: "ready" | "partial" | "would-fail" | "dependent" | "short" | "sent" | "partly-sent";
  headline: string;
  steps: { source: string; text: string }[];
  toolCalls: number;
}

export interface BatchOptions {
  chain: Chain;
  /** The sender of every action; else the key's address, else (on Pharos Mainnet) the example's. */
  from?: Address;
  block?: bigint;
  /** Merge sends of one asset to one address into one transaction (default true). */
  merge?: boolean;
  /** Atlantic only: send the batch, signed by this key (its address must be the sender). */
  signer?: Signer;
  wait?: { polls?: number; pollMs?: number };
  maxActions?: number;
  now?: () => Date;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const group = (n: number | bigint) => n.toLocaleString("en-US");
const lineWords = (lines: number[]) => (lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.slice(0, -1).join(", ")} and ${lines.at(-1)}`);
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const uncapital = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Tools whose answer cannot change within one evaluation: the chain, a pinned block, the fee quote. */
const SHAREABLE = new Set(["get_chain_info", "get_block_number", "get_block", "get_balance", "get_code", "get_transaction_count", "eth_call", "estimate_gas", "get_gas_price"]);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b))) : v));

/**
 * A Chain MCP client that makes each read once: asked again with the same arguments, it answers from its
 * first answer. Every count is kept, so what the reads shared saved is measured, not estimated.
 */
class SharedReads implements ToolCaller {
  asked = 0;
  shared = 0;
  private readonly answers = new Map<string, Promise<unknown>>();

  constructor(private readonly inner: ToolCaller) {}

  get where(): string {
    return this.inner.where;
  }

  get server(): { name: string; version: string } | undefined {
    return this.inner.server;
  }

  get toolCalls(): number {
    return this.inner.toolCalls;
  }

  call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    this.asked += 1;
    if (!SHAREABLE.has(name)) return this.inner.call<T>(name, args);
    const key = `${name} ${canonical(args)}`;
    const known = this.answers.get(key);
    if (known) {
      this.shared += 1;
      return known as Promise<T>;
    }
    const answer = this.inner.call<T>(name, args);
    this.answers.set(key, answer);
    return answer;
  }
}

/** A transaction of the plan, before its dry run: one action, or sends of one asset to one address merged. */
interface Planned {
  lines: number[];
  kind: BatchKind;
  asset: string;
  token: BatchAction["token"];
  to: Address | null;
  raw: bigint;
  notes: string[];
}

function planOf(actions: BatchAction[], merge: boolean): Planned[] {
  const out: Planned[] = [];
  for (const a of actions) {
    const same = merge && a.kind !== "approve" ? out.find((p) => p.kind === a.kind && p.asset === a.asset && p.to?.toLowerCase() === a.to?.toLowerCase()) : undefined;
    if (same) {
      same.lines.push(a.line);
      same.raw += BigInt(a.raw);
      if (a.note) same.notes.push(a.note);
      continue;
    }
    out.push({ lines: [a.line], kind: a.kind, asset: a.asset, token: a.token, to: a.to, raw: BigInt(a.raw), notes: a.note ? [a.note] : [] });
  }
  return out;
}

const decimalsOf = (p: Pick<Planned, "kind" | "token">) => (p.kind === "wrap" || !p.token ? 18 : p.token.decimals);
const amountOf = (p: Planned) => (p.kind === "approve" && p.raw === 2n ** 256n - 1n ? "max" : formatUnits(p.raw, decimalsOf(p)));
const shownOf = (p: Planned) => (p.kind === "approve" && p.raw === 2n ** 256n - 1n ? "unlimited" : formatAmount(p.raw, decimalsOf(p), decimalsOf(p)));

function describe(p: Planned, net: Network): string {
  switch (p.kind) {
    case "send":
      return `Send ${shownOf(p)} ${p.asset} to ${short(p.to!)}`;
    case "approve":
      return p.raw === 0n ? `Revoke ${short(p.to!)}'s ${p.asset} allowance` : `Approve ${short(p.to!)} to spend ${shownOf(p)} ${p.asset}`;
    case "wrap":
      return `Wrap ${shownOf(p)} ${net.nativeSymbol} into ${p.token!.symbol}`;
  }
}

function intentOf(p: Planned, from: Address): Intent {
  const amount = amountOf(p);
  if (p.kind === "wrap") return { kind: "call", from, to: p.token!.address, signature: "deposit() payable", args: [], value: amount };
  if (p.kind === "approve") return { kind: "erc20-approve", token: p.token!.address, from, spender: p.to!, amount };
  return p.token ? { kind: "erc20-transfer", token: p.token.address, from, to: p.to!, amount } : { kind: "native-transfer", from, to: p.to!, amount };
}

/** Two approvals that set one allowance: the one sent last would win, so their order matters. */
function allowanceConflicts(actions: BatchAction[]): [BatchAction, BatchAction][] {
  const out: [BatchAction, BatchAction][] = [];
  const approvals = actions.filter((a) => a.kind === "approve");
  for (const [k, a] of approvals.entries()) {
    const b = approvals.slice(k + 1).find((x) => x.asset === a.asset && x.to!.toLowerCase() === a.to!.toLowerCase());
    if (b && !out.some(([x]) => x.asset === a.asset && x.to!.toLowerCase() === a.to!.toLowerCase())) out.push([a, b]);
  }
  return out;
}

export async function runBatch(text: string, options: BatchOptions): Promise<BatchRun> {
  const { chain } = options;
  const net = chain.network;
  // The batch is read whole before anything is asked of the chain.
  const actions = readBatch(text, net, options.maxActions);
  const merge = options.merge !== false;
  const senderFrom: BatchRun["sender"]["from"] | null = options.from ? "input" : options.signer ? "key" : net.id === "pharos-mainnet" ? "example" : null;
  const sender = options.from ?? options.signer?.address ?? (net.id === "pharos-mainnet" ? EXAMPLE.account : null);
  if (!sender || !senderFrom) throw new AgentError("usage", "Name the sender with --from (on Atlantic there is no example to fall back on).");
  if (options.signer) {
    if (net.id !== "atlantic-testnet") throw new AgentError("execution", "Sending a batch is limited to the Atlantic testnet; on mainnet the plan is the whole job.");
    if (options.signer.address.toLowerCase() !== sender.toLowerCase()) throw new AgentError("execution", `The key's address ${options.signer.address} is not the sender ${sender}.`);
  }
  const self = actions.find((a) => a.kind === "send" && a.to!.toLowerCase() === sender.toLowerCase());
  if (self) throw new AgentError("usage", `Line ${self.line} sends to the sender itself (${short(sender)}): nothing would move but its gas.`);
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();

  // Every read of the plan goes through one SharedReads: the same question is asked once.
  const reads = new SharedReads(chain.mcp);
  const shared = new Chain(reads, net);
  await shared.expectChain();
  const head: BlockHeader = await shared.block(options.block ?? (await shared.blockNumber()));
  const source = options.block === undefined ? ("latest" as const) : ("requested" as const);
  const steps: BatchRun["steps"] = [];
  const who = { input: "given", key: "the key's", example: "the example's" }[senderFrom];
  steps.push({ source: "the batch", text: `Read as ${plural(actions.length, "action")} from ${short(sender)} (${who}): ${actions.map((a) => a.words).join("; ")}.` });

  const planned = planOf(actions, merge);
  const merged = planned.filter((p) => p.lines.length > 1).map((p) => ({ lines: p.lines, into: planned.indexOf(p) + 1, what: describe(p, net) }));
  for (const m of merged) steps.push({ source: "the plan", text: `${capital(lineWords(m.lines))} merged into one transaction: ${m.what}, ${plural(m.lines.length - 1, "transaction")} fewer.` });

  const base = {
    schema: "pharos-agent/batch/1" as const,
    batch: text,
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: head.number.toString(), hash: head.hash, timestamp: new Date(Number(head.timestamp) * 1000).toISOString(), source },
    evaluatedAt,
    sender: { address: sender, from: senderFrom },
    actions,
    merge,
    merged,
  };
  const notSent = net.id === "pharos-mainnet" ? "Nothing was sent: the hosted Chain MCP is read-only." : "Nothing was sent.";

  // Two approvals of one allowance: not a batch, whatever the chain says; nothing more is asked of it.
  const conflicts = allowanceConflicts(actions);
  if (conflicts.length) {
    const [a, b] = conflicts[0]!;
    const independence: BatchCheck[] = conflicts.map(([x, y]) => ({ what: "Allowances", ok: false, detail: `Lines ${x.line} and ${y.line} both set ${short(x.to!)}'s ${x.asset} allowance: the one sent last wins, so their order matters.` }));
    const headline = `Not a batch: lines ${a.line} and ${b.line} both set ${short(a.to!)}'s ${a.asset} allowance, so the one sent last wins and their order matters. A batch takes actions whose order does not matter: keep one of them. ${notSent}`;
    for (const c of independence) steps.push({ source: "the independence check", text: c.detail });
    steps.push({ source: "the verdict", text: headline });
    return { ...base, nonce: null, txs: [], independence, fees: null, savings: { calls: chain.mcp.toolCalls, oneByOne: 0, lines: actions.length, transactions: planned.length, merged: actions.length - planned.length, leftOut: 0 }, execution: null, verdict: "dependent", headline, steps, toolCalls: chain.mcp.toolCalls };
  }

  const nonce = Number(await shared.nonce(sender, head.number));
  steps.push({ source: "Chain MCP · get_transaction_count", text: `${short(sender)}'s next nonce at block ${group(head.number)} is ${nonce}.` });

  // Each transaction's dry run, as Task 08 runs it on its own; the reads it shares with another are made once.
  const askedBefore = reads.asked;
  const txs: BatchTx[] = [];
  for (const [k, p] of planned.entries()) {
    const dryRun = await runDryRun(intentOf(p, sender), { chain: shared, block: options.block });
    txs.push({ n: k + 1, lines: p.lines, kind: p.kind, asset: p.asset, token: p.token?.address ?? null, to: p.to, amount: amountOf(p), raw: p.raw.toString(), summary: describe(p, net), notes: p.notes, dryRun, state: "planned", reason: null, tx: null, submission: null });
    steps.push({ source: "Chain MCP · eth_call · estimate_gas", text: `Transaction ${k + 1} (${lineWords(p.lines)}): ${dryRun.headline}` });
  }
  const oneByOne = reads.asked - askedBefore;

  // Independence. A wrap adds to the sender's wrapped token; nothing else in a batch adds to the sender.
  const independence: BatchCheck[] = [{ what: "One sender", ok: true, detail: `Every action is signed by ${short(sender)}: one nonce sequence, and nobody else's state is relied on.` }];
  const wrapped = planned.find((p) => p.kind === "wrap")?.token ?? null;
  const wraps = txs.filter((t) => t.kind === "wrap" && t.dryRun.verdict !== "would-revert").reduce((sum, t) => sum + BigInt(t.raw), 0n);
  const senderBalance = (token: Address) => {
    const line = txs.flatMap((t) => t.dryRun.outcome).find((l) => l.role === "sender" && l.token?.toLowerCase() === token.toLowerCase());
    return line ? BigInt(line.before) : null;
  };
  for (const t of txs) {
    if (t.dryRun.verdict !== "would-revert") continue;
    // A send of the wrapped token that fails alone but would not after the batch's wraps needs them first.
    const holds = t.token ? senderBalance(t.token) : null;
    if (t.kind === "send" && wrapped && t.token?.toLowerCase() === wrapped.address.toLowerCase() && holds !== null && holds < BigInt(t.raw) && holds + wraps >= BigInt(t.raw)) {
      const wrapLines = txs.filter((x) => x.kind === "wrap").flatMap((x) => x.lines);
      t.state = "dependent";
      t.reason = `It needs ${lineWords(wrapLines)} first: ${short(sender)} holds ${formatAmount(holds, 18, 8)} ${t.asset}, and the rest comes from the wrap.`;
    } else {
      t.state = "left-out";
      t.reason = t.dryRun.reason ?? "It would revert.";
    }
  }
  const going = () => txs.filter((t) => t.state === "planned");
  const leftOut = txs.filter((t) => t.state === "left-out");
  if (leftOut.length) independence.push({ what: "Alone at the block", ok: true, detail: `${capital(plural(going().length, "transaction"))} would go through on ${going().length === 1 ? "its" : "their"} own; ${leftOut.map((t) => `transaction ${t.n} (${lineWords(t.lines)})`).join(" and ")} would revert, so ${leftOut.length === 1 ? "it is" : "they are"} left out, and the others do not depend on ${leftOut.length === 1 ? "it" : "them"}.` });
  else if (!txs.some((t) => t.state === "dependent")) independence.push({ what: "Alone at the block", ok: true, detail: `Every transaction would go through on its own at block ${group(head.number)}.` });

  // Every balance must cover all the batch takes from it before anything it adds: then every order works.
  let short_ = false;
  const tokens = [...new Set(going().filter((t) => t.kind === "send" && t.token).map((t) => t.token!.toLowerCase()))];
  for (const token of tokens) {
    const sends = going().filter((t) => t.kind === "send" && t.token?.toLowerCase() === token);
    const takes = sends.reduce((sum, t) => sum + BigInt(t.raw), 0n);
    const holds = senderBalance(sends[0]!.token!) ?? 0n;
    const asset = sends[0]!.asset;
    const decimals = sends[0]!.dryRun.outcome.find((l) => l.token?.toLowerCase() === token)!.decimals;
    const fmt = (v: bigint) => `${formatAmount(v, decimals, decimals === 18 ? 8 : decimals)} ${asset}`;
    const adds = wrapped && wrapped.address.toLowerCase() === token ? wraps : 0n;
    if (takes <= holds) independence.push({ what: asset, ok: true, detail: `The ${sends.length === 1 ? "send takes" : `${sends.length} sends take`} ${fmt(takes)}${sends.length === 1 ? "" : " in all"}; ${short(sender)} holds ${fmt(holds)}, enough in any order.` });
    else if (takes <= holds + adds) {
      for (const t of sends) if (t.state === "planned") { t.state = "dependent"; t.reason = `The batch's ${asset} sends take ${fmt(takes)}, more than the ${fmt(holds)} held: the rest comes from the wrap, so it must go first.`; }
      independence.push({ what: asset, ok: false, detail: `The ${asset} sends take ${fmt(takes)}, but ${short(sender)} holds ${fmt(holds)}: the rest comes from the wrap, so the wrap must go first and the order matters.` });
    } else {
      short_ = true;
      independence.push({ what: asset, ok: false, detail: `The ${sends.length === 1 ? "send takes" : `${sends.length} sends take`} ${fmt(takes)}${sends.length === 1 ? "" : " in all"}, but ${short(sender)} holds ${fmt(holds)}: ${fmt(takes - holds)} short.` });
    }
  }
  const dependents = txs.filter((t) => t.state === "dependent");
  if (dependents.length && !independence.some((c) => !c.ok)) independence.push({ what: wrapped?.symbol ?? "Order", ok: false, detail: dependents.map((t) => `Transaction ${t.n} (${lineWords(t.lines)}): ${t.reason}`).join(" ") });

  // The native token: what is sent or wrapped, and every transaction's most gas, all from one balance.
  const gasOf = going().filter((t) => t.dryRun.gas);
  const maxGas = gasOf.reduce((sum, t) => sum + BigInt(t.dryRun.gas!.maxCost), 0n);
  const expectedGas = gasOf.reduce((sum, t) => sum + BigInt(t.dryRun.gas!.expectedCost), 0n);
  const nativeOut = going().filter((t) => (t.kind === "send" && !t.token) || t.kind === "wrap").reduce((sum, t) => sum + BigInt(t.raw), 0n);
  const nativeHolds = BigInt(txs[0]!.dryRun.funds.holds);
  const native = (v: bigint) => `${formatAmount(v, 18, 8)} ${net.nativeSymbol}`;
  if (going().length && !dependents.length) {
    const what = nativeOut > 0n ? `${native(nativeOut)} sent or wrapped and up to ${native(maxGas)} of gas` : `up to ${native(maxGas)} of gas`;
    if (nativeOut + maxGas <= nativeHolds) independence.push({ what: net.nativeSymbol, ok: true, detail: `The batch takes ${what}; ${short(sender)} holds ${native(nativeHolds)}, enough in any order.` });
    else {
      short_ = true;
      independence.push({ what: net.nativeSymbol, ok: false, detail: `The batch takes ${what}, but ${short(sender)} holds ${native(nativeHolds)}: ${native(nativeOut + maxGas - nativeHolds)} short.` });
    }
  }
  const approvals = going().filter((t) => t.kind === "approve");
  if (approvals.length) independence.push({ what: "Allowances", ok: true, detail: `${approvals.length === 1 ? "One allowance is" : `${approvals.length} allowances are`} set, each by one transaction only.` });
  for (const c of independence) steps.push({ source: "the independence check", text: `${c.what}: ${c.detail}` });

  // The verdict before anything is sent.
  const ready = going();
  let verdict: BatchRun["verdict"] = dependents.length ? "dependent" : short_ ? "short" : !ready.length ? "would-fail" : ready.length < txs.length ? "partial" : "ready";
  const fee = ready.find((t) => t.dryRun.gas)?.dryRun.gas ?? null;
  const fees = fee && (verdict === "ready" || verdict === "partial") ? { expected: expectedGas.toString(), max: maxGas.toString(), expectedShown: native(expectedGas), maxShown: native(maxGas), maxFeePerGas: fee.maxFeePerGas, priorityFee: fee.priorityFee, shown: `at most ${formatGwei(BigInt(fee.maxFeePerGas))} a gas, ${formatGwei(BigInt(fee.priorityFee))} of it priority` } : null;
  if (fees) {
    for (const [k, t] of ready.entries()) t.tx = { chainId: net.chainId, nonce: nonce + k, to: t.dryRun.tx.to, data: t.dryRun.tx.data, value: t.dryRun.tx.value, gas: t.dryRun.gas!.gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.priorityFee };
    steps.push({ source: "the plan", text: `${capital(plural(ready.length, "transaction"))} in one nonce sequence, ${ready.length === 1 ? `nonce ${nonce}` : `nonces ${nonce} to ${nonce + ready.length - 1}`}, with one fee quote for all (${fees.shown}): about ${fees.expectedShown} of gas, at most ${fees.maxShown}.` });
  }
  const calls = chain.mcp.toolCalls;
  const savings = { calls, oneByOne, lines: actions.length, transactions: ready.length, merged: actions.length - planned.length, leftOut: leftOut.length };
  steps.push({ source: "the savings", text: `${plural(calls, "Chain MCP call")} for the whole plan; the same ${plural(txs.length, "dry run")}, each run on its own as Task 08 runs it, ask ${group(oneByOne)}.${savings.merged ? ` ${capital(plural(savings.merged, "transaction"))} fewer by merging.` : ""}` });

  // On Atlantic, with a key: signed and sent back to back, the receipts awaited together.
  let execution: BatchRun["execution"] = null;
  if (options.signer && fees) {
    execution = await sendAll(chain, options.signer, ready, options.wait, sender, wrapped?.address ?? null, steps);
    verdict = execution.sent === ready.length && ready.every((t) => t.submission?.status === "success") && execution.matched ? "sent" : "partly-sent";
  }

  const lines = plural(actions.length, "action");
  const inTxs = ready.length === actions.length ? "" : ` in ${plural(ready.length, "transaction")}`;
  const mergedWords = merged.length ? ` (${merged.map((m) => `${lineWords(m.lines)} merged`).join(", ")})` : "";
  const leftWords = leftOut.map((t) => `${lineWords(t.lines)} left out (${uncapital(t.reason!.replace(/\.$/, ""))})`).join("; ");
  const headline =
    verdict === "sent"
      ? `Sent: ${ready.length === 1 ? `one transaction, nonce ${execution!.nonce}` : `${ready.length} transactions back to back, nonces ${execution!.nonce} to ${execution!.nonce + ready.length - 1}`}, ${spanWords(execution!.blocks!, ready.length)}. Every balance and allowance the batch changed matches the prediction.${leftOut.length ? ` ${capital(leftWords)}.` : ""}`
      : verdict === "partly-sent"
        ? partlyWords(ready, execution!)
        : verdict === "dependent"
          ? `Not a batch: ${dependents.map((t) => `transaction ${t.n} (${lineWords(t.lines)})`).join(" and ")} ${dependents.length === 1 ? "depends" : "depend"} on the order. ${dependents[0]!.reason} A batch takes actions whose order does not matter: send these one after the other instead. ${notSent}`
          : verdict === "short"
            ? `Short: ${independence.filter((c) => !c.ok).map((c) => c.detail.replace(/\.$/, "")).join("; ")}. ${notSent}`
            : verdict === "would-fail"
              ? `Nothing to send: ${txs.length === 1 ? "the action" : `every one of the ${plural(txs.length, "transaction")}`} would revert on its own. ${capital(leftWords)}. ${notSent}`
              : verdict === "partial"
                ? `Ready, ${ready.length} of ${txs.length}: ${leftWords}; the others do not depend on ${leftOut.length === 1 ? "it" : "them"}. ${capital(plural(ready.length, "transaction"))} in one nonce sequence, each dry-run at block ${group(head.number)}, for about ${fees!.expectedShown} of gas. ${notSent}`
                : `Ready: ${lines}${inTxs}${mergedWords}, independent, each dry-run at block ${group(head.number)}, in one nonce sequence for about ${fees!.expectedShown} of gas. ${notSent}`;
  steps.push({ source: "the verdict", text: headline });
  return { ...base, nonce, txs, independence, fees, savings, execution, verdict, headline, steps, toolCalls: chain.mcp.toolCalls };
}

function spanWords(blocks: { first: string; last: string; span: number }, n: number): string {
  const at = blocks.span === 1 ? `${n > 1 ? "all " : ""}in block ${group(BigInt(blocks.first))}` : `in blocks ${group(BigInt(blocks.first))} to ${group(BigInt(blocks.last))} (${blocks.span} blocks)`;
  return n > 1 ? `${at}; one by one, each sent after the last one's receipt, they take at least ${n} blocks` : at;
}

function partlyWords(ready: BatchTx[], execution: NonNullable<BatchRun["execution"]>): string {
  const refused = ready.find((t) => t.submission?.status === "refused");
  const reverted = ready.filter((t) => t.submission?.status === "reverted");
  const pending = ready.filter((t) => t.submission?.status === "pending");
  const parts = [`${execution.sent} of ${ready.length} sent`];
  if (refused) parts.push(`transaction ${refused.n} was refused by the node (${refused.submission!.error}), so nothing after it was sent: its nonce would have held the rest back`);
  if (reverted.length) parts.push(`${reverted.map((t) => `transaction ${t.n}`).join(" and ")} reverted on chain`);
  if (pending.length) parts.push(`${pending.map((t) => `transaction ${t.n}`).join(" and ")} not yet in a block`);
  if (!execution.matched && execution.receipts) parts.push("what the receipts changed does not all match the prediction");
  return `${capital(parts.join("; "))}.`;
}

/**
 * Sign and send every transaction of the plan back to back, then await their receipts together: each
 * round asks for every receipt still missing, a fixed number of rounds so a replay asks the same. A send
 * the node refuses stops the rest, which would wait behind its nonce. Then every balance and allowance
 * the batch changes is read just before its first block and at its last, and compared.
 */
async function sendAll(chain: Chain, signer: Signer, ready: BatchTx[], wait: BatchOptions["wait"], sender: Address, wrapped: Address | null, steps: BatchRun["steps"]): Promise<NonNullable<BatchRun["execution"]>> {
  const before = chain.mcp.toolCalls;
  const nonce = Number(await chain.nonce(sender, "pending"));
  let sent = 0;
  for (const [k, t] of ready.entries()) {
    const tx = { ...t.tx!, nonce: nonce + k };
    t.tx = tx;
    const raw = await signer.sign({ chainId: tx.chainId, nonce: tx.nonce, to: tx.to, data: tx.data === "0x" ? undefined : tx.data, value: BigInt(tx.value), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
    try {
      const hash = await chain.sendRaw(raw);
      t.submission = { txHash: hash, nonce: tx.nonce, status: "pending", blockNumber: null, gasUsed: null, cost: null, error: null };
      sent += 1;
    } catch (error) {
      if (!(error instanceof ToolCallError)) throw error;
      t.submission = { txHash: null, nonce: tx.nonce, status: "refused", blockNumber: null, gasUsed: null, cost: null, error: error.detail };
      break;
    }
  }
  steps.push({ source: "Chain MCP · send_raw_transaction", text: `${capital(plural(sent, "transaction"))} signed here and sent back to back, ${sent === 1 ? `nonce ${nonce}` : `nonces ${nonce} to ${nonce + sent - 1}`}, without waiting between${sent < ready.length ? `; transaction ${ready[sent]!.n} was refused (${ready[sent]!.submission?.error}), so the rest were not sent` : ""}.` });

  const receipts = new Map<BatchTx, Receipt>();
  const waiting = () => ready.filter((t) => t.submission?.status === "pending" && !receipts.has(t));
  for (let poll = 0; waiting().length && poll < (wait?.polls ?? 45); poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, wait?.pollMs ?? 2_000));
    for (const t of waiting()) {
      const receipt = await chain.receipt(t.submission!.txHash!);
      if (receipt) receipts.set(t, receipt);
    }
  }
  for (const [t, r] of receipts) {
    const cost = r.gasUsed * (r.effectiveGasPrice ?? BigInt(t.tx!.maxFeePerGas));
    t.submission = { ...t.submission!, status: r.status, blockNumber: r.blockNumber.toString(), gasUsed: r.gasUsed.toString(), cost: cost.toString() };
  }
  const included = [...receipts.values()].map((r) => r.blockNumber);
  const blocks = included.length ? { first: included.reduce((a, b) => (b < a ? b : a)).toString(), last: included.reduce((a, b) => (b > a ? b : a)).toString(), span: 0 } : null;
  if (blocks) blocks.span = Number(BigInt(blocks.last) - BigInt(blocks.first)) + 1;
  if (blocks) steps.push({ source: "Chain MCP · get_transaction_receipt", text: `${plural(receipts.size, "receipt")}: ${[...receipts].map(([t, r]) => `transaction ${t.n} ${r.status} in block ${group(r.blockNumber)}`).join(", ")}.` });

  const comparisons = blocks ? await compare(chain, ready, receipts, BigInt(blocks.first) - 1n, BigInt(blocks.last), sender, wrapped) : [];
  const matched = comparisons.length > 0 && comparisons.every((c) => c.match);
  if (comparisons.length) steps.push({ source: "Chain MCP · get_balance · eth_call", text: `Read again before block ${group(BigInt(blocks!.first))} and after block ${group(BigInt(blocks!.last))}: ${comparisons.filter((c) => c.match).length} of ${comparisons.length} values as predicted${matched ? "" : `; ${comparisons.filter((c) => !c.match).map((c) => c.what).join(", ")} not`}.` });
  return { nonce, sent, receipts: receipts.size, blocks, comparisons, matched, calls: chain.mcp.toolCalls - before };
}

/** What the batch should have changed, value by value, against what it did between `from` and `to`. */
async function compare(chain: Chain, ready: BatchTx[], receipts: Map<BatchTx, Receipt>, from: bigint, to: bigint, sender: Address, wrapped: Address | null): Promise<Comparison[]> {
  const net = chain.network;
  type Key = { kind: "balance" | "allowance"; token: Address | null; holder: Address; asset: string; decimals: number; change: bigint; set: bigint | null };
  const keys: Key[] = [];
  const key = (kind: Key["kind"], token: Address | null, holder: Address, asset: string, decimals: number) => {
    let k = keys.find((x) => x.kind === kind && x.token?.toLowerCase() === token?.toLowerCase() && x.holder.toLowerCase() === holder.toLowerCase());
    if (!k) keys.push((k = { kind, token, holder, asset, decimals, change: 0n, set: null }));
    return k;
  };
  const nativeKey = key("balance", null, sender, net.nativeSymbol, 18);
  let fees = 0n;
  for (const t of ready) {
    const r = receipts.get(t);
    if (!r) continue;
    fees += BigInt(t.submission!.cost!);
    const decimals = t.dryRun.outcome.find((l) => l.token?.toLowerCase() === t.token?.toLowerCase())?.decimals ?? 18;
    if (t.kind === "send" && t.token) {
      const out = key("balance", t.token, sender, t.asset, decimals);
      const into = key("balance", t.token, t.to!, t.asset, decimals);
      if (r.status === "success") {
        out.change -= BigInt(t.raw);
        into.change += BigInt(t.raw);
      }
    } else if (t.kind === "send") {
      const into = key("balance", null, t.to!, net.nativeSymbol, 18);
      if (r.status === "success") {
        nativeKey.change -= BigInt(t.raw);
        into.change += BigInt(t.raw);
      }
    } else if (t.kind === "approve") {
      const allowance = key("allowance", t.token, t.to!, t.asset, decimals);
      if (r.status === "success") allowance.set = BigInt(t.raw);
    } else if (wrapped) {
      const into = key("balance", wrapped, sender, net.tokens.find((x) => x.address.toLowerCase() === wrapped.toLowerCase())?.symbol ?? "tokens", 18);
      if (r.status === "success") {
        nativeKey.change -= BigInt(t.raw);
        into.change += BigInt(t.raw);
      }
    }
  }
  nativeKey.change -= fees;
  const read = async (k: Key, block: bigint): Promise<bigint> => {
    if (k.kind === "allowance") return decodeCall(ERC20.allowance, await chain.call({ to: k.token!, data: encodeCall(ERC20.allowance, [sender, k.holder]) }, block)) as bigint;
    if (k.token === null) return chain.balance(k.holder, block);
    return decodeCall(ERC20.balanceOf, await chain.call({ to: k.token, data: encodeCall(ERC20.balanceOf, [k.holder]) }, block)) as bigint;
  };
  const fmt = (k: Key, v: bigint) => `${v < 0n ? "−" : v > 0n ? "+" : ""}${formatAmount(v < 0n ? -v : v, k.decimals, 8)} ${k.asset}`;
  const out: Comparison[] = [];
  for (const k of keys) {
    const who = k.holder.toLowerCase() === sender.toLowerCase() ? "Sender" : short(k.holder);
    if (k.kind === "allowance") {
      if (k.set === null) continue;
      const after = await read(k, to);
      const shown = (v: bigint) => (v === 2n ** 256n - 1n ? `unlimited ${k.asset}` : `${formatAmount(v, k.decimals, 8)} ${k.asset}`);
      out.push({ what: `Allowance of ${short(k.holder)} ${k.asset}`, predicted: shown(k.set), actual: shown(after), match: after === k.set });
      continue;
    }
    const change = (await read(k, to)) - (await read(k, from));
    const fee = k === nativeKey ? ` (fees ${formatAmount(fees, 18, 8)} ${net.nativeSymbol}, from the receipts)` : "";
    out.push({ what: `${who} ${k.asset}`, predicted: `${fmt(k, k.change)}${fee}`, actual: fmt(k, change), match: change === k.change });
  }
  return out;
}
