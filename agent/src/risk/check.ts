// Task 25, Wallet Risk Checker: before a transaction, what the history of the address it goes to says.
//
//   1. Check the chain (get_chain_info) and pin the newest block.
//   2. The counterparty: the recipient of a transfer, the spender of an approval, the contract called.
//      Its code (get_code: a wallet, a contract, or an account delegated to a contract under EIP-7702),
//      its nonce (get_transaction_count) and its native balance (get_balance), at the pinned block.
//   3. Its recent history with the sender: the token's Transfer logs over the last `blocks` blocks
//      (get_logs, pages of at most 1,000 blocks, two queries a page: sent by either, received by
//      either). From them: the transfers between the two, zero-value transfers between them (what
//      address poisoning leaves), and every address the sender moved tokens with, to catch a lookalike:
//      the same first and last four characters as one of them, but a different address. Transfers of
//      nothing are not dealings, so a real partner is never taken for a lookalike of its poisoner.
//   4. What the transaction does: an approval to a wallet, an unlimited approval, tokens sent to a token
//      contract, the zero address, a never-used address; and Task 08's dry run at the same block.
//   5. A risk level from the worst signal, and a verdict: do not send, check first, or it looks fine.
import { getAddress, pad, zeroAddress } from "viem";
import { formatAmount } from "../core/amounts.js";
import type { Address, BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { knownToken } from "../core/networks.js";
import type { Intent } from "../dryrun/intent.js";
import { runDryRun } from "../dryrun/run.js";
import { LOG_PAGE, TRANSFER_TOPIC } from "../policy/check.js";

export type Severity = "high" | "medium" | "low" | "info";

export interface Signal {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  tool: string;
}

export interface RiskReport {
  schema: "pharos-agent/risk-check/1";
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: Hex; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  transaction: { summary: string; kind: Intent["kind"]; from: Address; counterparty: Address; role: "recipient" | "spender" | "contract" };
  counterparty: { address: Address; code: "none" | "contract" | "delegated"; delegate: Address | null; nonce: string; balance: string; balanceShown: string; token: string | null };
  /**
   * The history scanned: the blocks, the token, and what it held. `partners` are the addresses the
   * sender moved the token with most often, apart from the counterparty (at most three): what a
   * lookalike would copy.
   */
  history: { from: string; to: string; pages: number; token: string; transfers: number; withSender: number; zeroValue: number; lookalikes: Partner[]; partners: Partner[] } | null;
  signals: Signal[];
  level: "high" | "medium" | "low";
  verdict: "do-not-send" | "check-first" | "looks-fine";
  dryRun: { verdict: string; reason: string | null };
  headline: string;
  toolCalls: number;
}

export interface Partner {
  address: Address;
  times: number;
}

export interface RiskOptions {
  chain: Chain;
  /** Blocks of history to scan (default 2,000, at most 10,000). */
  blocks?: number;
  block?: bigint;
  now?: () => Date;
}

export const DEFAULT_BLOCKS = 2000;
export const MAX_BLOCKS = 10_000;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const addressOf = (topic: string) => getAddress(`0x${topic.slice(-40)}`);
/** Address poisoning copies the first and last characters of an address its victim uses. */
export const looksLike = (a: string, b: string) => a.toLowerCase() !== b.toLowerCase() && a.slice(2, 6).toLowerCase() === b.slice(2, 6).toLowerCase() && a.slice(-4).toLowerCase() === b.slice(-4).toLowerCase();
const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

export async function checkRisk(intent: Intent, options: RiskOptions): Promise<RiskReport> {
  const { chain } = options;
  const net = chain.network;
  const blocks = options.blocks ?? DEFAULT_BLOCKS;
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_BLOCKS) throw new AgentError("usage", `blocks must be a whole number from 1 to ${MAX_BLOCKS.toLocaleString("en-US")}.`);
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  await chain.expectChain();
  const pinned: BlockHeader = await chain.block(options.block ?? (await chain.blockNumber()));
  const at = pinned.number;
  const source = options.block === undefined ? "latest" : "requested";
  const from = intent.from;
  const [counterparty, role] = intent.kind === "erc20-approve" ? [intent.spender, "spender" as const] : intent.kind === "call" ? [intent.to, "contract" as const] : [intent.to, "recipient" as const];
  const signals: Signal[] = [];
  const add = (signal: Signal) => signals.push(signal);

  // The counterparty at the pinned block.
  const code = await chain.code(counterparty, at);
  const delegated = /^0xef0100[0-9a-fA-F]{40}$/.test(code);
  const kind = /^0x0*$/.test(code) ? "none" : delegated ? "delegated" : "contract";
  const delegate = delegated ? getAddress(`0x${code.slice(8)}`) : null;
  const nonce = await chain.nonce(counterparty, at);
  const balance = await chain.balance(counterparty, at);
  const asToken = knownToken(net, counterparty) ?? null;
  const balanceShown = `${formatAmount(balance, 18, 6)} ${net.nativeSymbol}`;

  // The token whose history is read: the transaction's own, or USDC for anything else.
  const token = intent.kind === "erc20-transfer" || intent.kind === "erc20-approve" ? (knownToken(net, intent.token) ?? null) : (net.tokens.find((t) => t.symbol === "USDC") ?? null);
  let history: RiskReport["history"] = null;
  if (token) {
    const start = at - BigInt(blocks) + 1n > 0n ? at - BigInt(blocks) + 1n : 0n;
    const either = [pad(from.toLowerCase() as Hex, { size: 32 }), pad(counterparty.toLowerCase() as Hex, { size: 32 })];
    const seen = new Map<string, { sender: Address; recipient: Address; amount: bigint }>();
    let pages = 0;
    for (let page = start; page <= at; page += LOG_PAGE) {
      const end = page + LOG_PAGE - 1n < at ? page + LOG_PAGE - 1n : at;
      for (const topics of [[TRANSFER_TOPIC as Hex, either], [TRANSFER_TOPIC as Hex, null, either]]) {
        pages += 1;
        for (const log of await chain.logs({ address: getAddress(token.address), topics, fromBlock: page, toBlock: end })) {
          if (log.removed || log.topics.length !== 3 || typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
          seen.set(`${log.transactionHash}:${Number(log.logIndex)}`, { sender: addressOf(log.topics[1]!), recipient: addressOf(log.topics[2]!), amount: BigInt(log.data) });
        }
      }
    }
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const transfers = [...seen.values()];
    const between = transfers.filter((t) => (same(t.sender, from) && same(t.recipient, counterparty)) || (same(t.sender, counterparty) && same(t.recipient, from)));
    const zeroValue = between.filter((t) => t.amount === 0n).length;
    // Everyone the sender moved tokens with, and how often, apart from the counterparty itself.
    const dealt = new Map<string, Partner>();
    for (const t of transfers) {
      const other = same(t.sender, from) ? t.recipient : same(t.recipient, from) ? t.sender : null;
      if (!other || t.amount === 0n || same(other, counterparty) || same(other, from)) continue;
      const entry = dealt.get(other.toLowerCase()) ?? { address: other, times: 0 };
      entry.times += 1;
      dealt.set(other.toLowerCase(), entry);
    }
    const ranked = [...dealt.values()].sort((a, b) => b.times - a.times);
    const lookalikes = ranked.filter((d) => looksLike(d.address, counterparty));
    history = { from: start.toString(), to: at.toString(), pages, token: token.symbol, transfers: transfers.length, withSender: between.length - zeroValue, zeroValue, lookalikes, partners: ranked.slice(0, 3) };
    const span = `the last ${blocks.toLocaleString("en-US")} blocks`;
    for (const look of lookalikes.slice(0, 3)) add({ id: "lookalike", severity: "high", title: "Looks like an address the sender uses", detail: `${short(counterparty)} starts and ends like ${short(look.address)}, which the sender dealt with ${look.times} ${look.times === 1 ? "time" : "times"} in ${span}, but it is a different address. Address poisoning copies the start and end of an address its victim uses.`, tool: "get_logs" });
    if (zeroValue) add({ id: "zero-value", severity: "high", title: "Zero-value transfers with the sender", detail: `${zeroValue} ${token.symbol} ${zeroValue === 1 ? "transfer" : "transfers"} of nothing between the sender and ${short(counterparty)} in ${span}: that is how address poisoning plants a lookalike in a wallet's history.`, tool: "get_logs" });
    if (between.length - zeroValue > 0) add({ id: "known", severity: "info", title: "The sender has dealt with it before", detail: `${between.length - zeroValue} ${token.symbol} ${between.length - zeroValue === 1 ? "transfer" : "transfers"} between them in ${span}.`, tool: "get_logs" });
    if (kind === "none" && nonce === 0n && balance === 0n && transfers.every((t) => !same(t.sender, counterparty) && !same(t.recipient, counterparty))) add({ id: "never-used", severity: "medium", title: "Never used", detail: `${short(counterparty)} has sent no transaction, holds no ${net.nativeSymbol}, and moved no ${token.symbol} in ${span}. A new address is often right; check it is the one you mean.`, tool: "get_transaction_count · get_balance · get_logs" });
  }

  // What the transaction does to it.
  if (counterparty.toLowerCase() === zeroAddress) add({ id: "zero-address", severity: "high", title: "The zero address", detail: "Whatever is sent to the zero address is gone: no one holds its key.", tool: "the transaction" });
  if (intent.kind === "erc20-approve") {
    if (kind === "none") add({ id: "approve-wallet", severity: "high", title: "An approval to a wallet", detail: `${short(counterparty)} has no code. Approvals are for contracts (a DEX router, a vault); a wallet asking for one can take the tokens whenever it likes.`, tool: "get_code" });
    if (intent.amount === "max") add({ id: "unlimited", severity: "medium", title: "An unlimited approval", detail: `It lets ${short(counterparty)} take all of the sender's ${token?.symbol ?? "tokens"}, now and later, until the approval is revoked.`, tool: "the transaction" });
  }
  if (intent.kind === "erc20-transfer" && asToken) add({ id: "to-token", severity: "high", title: "Tokens sent to a token contract", detail: `${short(counterparty)} is the ${asToken.symbol} contract. Tokens sent to a token's own contract are almost always lost.`, tool: "get_code" });
  else if ((intent.kind === "erc20-transfer" || intent.kind === "native-transfer") && kind === "contract") add({ id: "to-contract", severity: "medium", title: "A contract as the recipient", detail: `${short(counterparty)} is a contract. What is sent to a contract that cannot move it stays there.`, tool: "get_code" });
  if (kind === "delegated") add({ id: "delegated", severity: "low", title: "A wallet delegated to a contract", detail: `${short(counterparty)} runs the code of ${short(delegate!)} (EIP-7702): a wallet whose transactions that contract can shape.`, tool: "get_code" });

  // Whether the transaction itself would go through, at the same block.
  const dry = await runDryRun(intent, { chain, at: { header: pinned, source } });
  if (dry.verdict !== "would-succeed") add({ id: "would-fail", severity: "medium", title: dry.verdict === "cannot-pay" ? "It cannot pay for itself" : "It would fail as it is", detail: dry.reason ?? "The dry run did not succeed.", tool: "eth_call · estimate_gas" });

  signals.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const top = signals[0]?.severity;
  const level: RiskReport["level"] = top === "high" || top === "medium" ? top : "low";
  const verdict = level === "high" ? "do-not-send" : level === "medium" ? "check-first" : "looks-fine";
  const lead = { "do-not-send": "High risk: do not send", "check-first": "Some risk: check first", "looks-fine": "Low risk: nothing suspicious found" }[verdict];
  const headline = `${lead}. ${dry.summary}.${signals[0] && signals[0].severity !== "info" ? ` ${signals[0].detail}` : ""}`;
  return {
    schema: "pharos-agent/risk-check/1",
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: at.toString(), hash: pinned.hash, timestamp: new Date(Number(pinned.timestamp) * 1000).toISOString(), source },
    evaluatedAt,
    transaction: { summary: dry.summary, kind: intent.kind, from, counterparty, role },
    counterparty: { address: counterparty, code: kind, delegate, nonce: nonce.toString(), balance: balance.toString(), balanceShown, token: asToken?.symbol ?? null },
    history,
    signals,
    level,
    verdict,
    dryRun: { verdict: dry.verdict, reason: dry.reason },
    headline,
    toolCalls: chain.mcp.toolCalls,
  };
}
