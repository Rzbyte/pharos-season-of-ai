// Task 17, Natural-Language Payment Agent: a payment request turned into a prepared on-chain payment flow.
//
//   1. The request, read into payments (request.ts): recipients by address or by the address book's
//      names, amounts in PROS or an official token, "each" and "split", a note for each. Nothing is
//      asked of the chain for a request that is not read whole.
//   2. Through Chain MCP at one block: the sender's next nonce, and Task 08's dry run of every payment
//      (the balances it changes, eth_call from the sender, estimate_gas and the fee).
//   3. The flow as a whole: each asset's total against what the sender holds, the native token's with
//      every payment's maximum fee on top, since the dry runs each start from the same block.
//   4. Prepared: each payment as the transaction a wallet signs (its nonce in order, its gas and fee
//      caps), and as the Pharos Skill Engine's cast command. On Atlantic, with a key, they are sent in
//      order, each checked against its receipt; the first that does not go through stops the rest.
import type { Address, Chain, Hex } from "../core/chain.js";
import { formatAmount } from "../core/amounts.js";
import { AgentError } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import type { Intent } from "../dryrun/intent.js";
import { runDryRun, submitDryRun, type DryRun, type DryRunOptions, type Submission } from "../dryrun/run.js";
import { EXAMPLE } from "../builder/action.js";
import { SKILL_ENGINE, TEMPLATES } from "../builder/skill.js";
import { parseRequest, type Contacts, type RequestedPayment } from "./request.js";

export interface PlannedPayment {
  n: number;
  to: { address: Address; name: string | null };
  asset: string;
  token: Address | null;
  amount: string;
  raw: string;
  share: "each" | "split" | null;
  memo: string | null;
  words: string;
  dryRun: DryRun;
  /** The transaction to sign, in the flow's nonce order; null for one that would not go through. */
  tx: { chainId: number; nonce: number; to: Address; data: Hex; value: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } | null;
  /** The Skill Engine's cast command that sends it. */
  command: string;
  /** Its send, on Atlantic with a key. */
  submission: Submission | null;
}

export interface PaymentFlow {
  schema: "pharos-agent/payment-flow/1";
  request: string;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: string; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  sender: { address: Address; from: "input" | "request" | "example" };
  /** The sender's next nonce at the block: the first payment's. */
  nonce: number;
  payments: PlannedPayment[];
  /** Each asset the flow pays: in all, against what the sender holds at the block. */
  totals: { asset: string; token: Address | null; raw: string; shown: string; holds: string; holdsShown: string; needs: string; needsShown: string; covered: boolean }[];
  /** The gas of all the payments: what blocks are expected to charge, and the most the caps allow. */
  fees: { expected: string; max: string; expectedShown: string; maxShown: string } | null;
  skillEngine: { repo: string; commit: string; reference: string };
  verdict: "ready" | "short" | "would-fail" | "sent" | "partly-sent";
  headline: string;
  steps: { source: string; text: string }[];
  toolCalls: number;
}

export interface FlowOptions {
  chain: Chain;
  contacts?: Contacts;
  /** The sender, over the request's "from"; on Atlantic with a key, the key's address. */
  from?: Address;
  block?: bigint;
  /** Atlantic only: send the flow, signed by this key (its address must be the sender). */
  signer?: Signer;
  wait?: DryRunOptions["wait"];
  maxPayments?: number;
  now?: () => Date;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const group = (n: number | bigint) => n.toLocaleString("en-US");

/** A payment's recipient in words: "alice (0xB274…9553)" or the address. */
const who = (p: { to: RequestedPayment["to"] }) => (p.to.name ? `${p.to.name} (${short(p.to.address)})` : short(p.to.address));

export async function preparePayments(request: string, options: FlowOptions): Promise<PaymentFlow> {
  const { chain } = options;
  const net = chain.network;
  // The request is read whole before anything is asked of the chain.
  const asked = parseRequest(request, options.contacts ?? {}, net, options.maxPayments ?? 10);
  const senderFrom = options.from ? "input" : asked.from ? "request" : net.id === "pharos-mainnet" ? "example" : null;
  const sender = options.from ?? asked.from ?? (net.id === "pharos-mainnet" ? EXAMPLE.account : null);
  if (!sender || !senderFrom) throw new AgentError("usage", 'Name the sender: "from 0x…" in the request, or as an input (on Atlantic there is no example to fall back on).');
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  await chain.expectChain();
  const head = await chain.block(options.block ?? (await chain.blockNumber()));
  const source = options.block === undefined ? ("latest" as const) : ("requested" as const);
  const steps: PaymentFlow["steps"] = [];
  const asset = (p: RequestedPayment) => p.token?.symbol ?? net.nativeSymbol;
  steps.push({ source: "the request", text: `Read as ${asked.payments.length === 1 ? "one payment" : `${asked.payments.length} payments`} from ${short(sender)} (${senderFrom === "input" ? "given" : senderFrom === "request" ? "the request's" : "the example's"}): ${asked.payments.map((p) => `${p.amount} ${asset(p)} to ${who(p)}`).join("; ")}.` });

  // The nonce, then each payment's dry run, all at the one block.
  const nonce = Number(await chain.nonce(sender, head.number));
  steps.push({ source: "Chain MCP · get_transaction_count", text: `${short(sender)}'s next nonce is ${nonce}: the payments take ${asked.payments.length === 1 ? nonce : `${nonce} to ${nonce + asked.payments.length - 1}`}, in order.` });
  const payments: PlannedPayment[] = [];
  for (const [k, p] of asked.payments.entries()) {
    const intent: Intent = p.token ? { kind: "erc20-transfer", token: p.token.address, from: sender, to: p.to.address, amount: p.amount } : { kind: "native-transfer", from: sender, to: p.to.address, amount: p.amount };
    const run = await runDryRun(intent, { chain, at: { header: head, source } });
    steps.push({ source: "Chain MCP · eth_call · estimate_gas", text: `Payment ${k + 1}: ${run.headline}` });
    const gas = run.gas;
    const command = p.token ? `cast send ${p.token.address} "transfer(address,uint256)" ${p.to.address} ${p.raw} --private-key $PRIVATE_KEY --rpc-url ${net.rpcUrl}` : `cast send ${p.to.address} --value ${p.amount}ether --private-key $PRIVATE_KEY --rpc-url ${net.rpcUrl}`;
    payments.push({
      n: k + 1,
      to: p.to,
      asset: asset(p),
      token: p.token?.address ?? null,
      amount: p.amount,
      raw: p.raw.toString(),
      share: p.share,
      memo: p.memo,
      words: p.words,
      dryRun: run,
      tx: run.verdict === "would-succeed" && gas ? { chainId: net.chainId, nonce: nonce + k, to: run.tx.to, data: run.tx.data, value: run.tx.value, gas: gas.gasLimit, maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.priorityFee } : null,
      command,
      submission: null,
    });
  }

  // The flow as a whole: every dry run starts from the same balances, so the totals must fit in them.
  const totals: PaymentFlow["totals"] = [];
  const maxFees = payments.reduce((sum, p) => sum + (p.dryRun.gas ? BigInt(p.dryRun.gas.maxCost) : 0n), 0n);
  const expectedFees = payments.reduce((sum, p) => sum + (p.dryRun.gas ? BigInt(p.dryRun.gas.expectedCost) : 0n), 0n);
  const nativeHolds = BigInt(payments[0]!.dryRun.funds.holds);
  for (const p of payments) {
    if (totals.some((t) => t.asset === p.asset)) continue;
    const same = payments.filter((q) => q.asset === p.asset);
    const raw = same.reduce((sum, q) => sum + BigInt(q.raw), 0n);
    const decimals = p.token ? p.dryRun.outcome.find((line) => line.token?.toLowerCase() === p.token!.toLowerCase())!.decimals : 18;
    const holds = p.token ? BigInt(p.dryRun.outcome.find((line) => line.role === "sender" && line.token?.toLowerCase() === p.token!.toLowerCase())!.before) : nativeHolds;
    const needs = p.token ? raw : raw + maxFees;
    const fmt = (value: bigint) => `${formatAmount(value, decimals, decimals === 18 ? 8 : decimals)} ${p.asset}`;
    totals.push({ asset: p.asset, token: p.token, raw: raw.toString(), shown: fmt(raw), holds: holds.toString(), holdsShown: fmt(holds), needs: needs.toString(), needsShown: fmt(needs), covered: holds >= needs });
  }
  // The native token pays every payment's gas even when the flow sends none of it.
  if (!totals.some((t) => t.token === null)) {
    const fmt = (value: bigint) => `${formatAmount(value, 18, 8)} ${net.nativeSymbol}`;
    totals.push({ asset: net.nativeSymbol, token: null, raw: "0", shown: fmt(0n), holds: nativeHolds.toString(), holdsShown: fmt(nativeHolds), needs: maxFees.toString(), needsShown: fmt(maxFees), covered: nativeHolds >= maxFees });
  }
  const fees = payments.every((p) => p.dryRun.gas) ? { expected: expectedFees.toString(), max: maxFees.toString(), expectedShown: `${formatAmount(expectedFees, 18, 8)} ${net.nativeSymbol}`, maxShown: `${formatAmount(maxFees, 18, 8)} ${net.nativeSymbol}` } : null;
  const failing = payments.find((p) => p.dryRun.verdict !== "would-succeed") ?? null;
  const shortfalls = totals.filter((t) => !t.covered);
  const gasWords = `up to ${formatAmount(maxFees, 18, 8)} ${net.nativeSymbol} of gas`;
  for (const t of totals) {
    const what = t.token !== null ? `${t.shown} in all` : t.raw === "0" ? `${gasWords} for the ${payments.length === 1 ? "payment" : "payments"}` : `${t.shown} in all, and ${gasWords}`;
    steps.push({ source: "the flow", text: `${t.asset}: ${what}; ${short(sender)} holds ${t.holdsShown}${t.covered ? "" : ", not enough"}.` });
  }

  // On Atlantic, with a key: sent in order, each against its receipt; the first that fails stops the rest.
  let sent = 0;
  if (options.signer && !failing && !shortfalls.length) {
    for (const p of payments) {
      const submission = await submitDryRun(chain, p.dryRun, options.signer, options.wait);
      p.submission = submission;
      steps.push({ source: "Chain MCP · send_raw_transaction", text: `Payment ${p.n} signed here and sent: ${submission.txHash}, ${submission.status === "pending" ? "not yet in a block" : `${submission.status} in block ${group(Number(submission.blockNumber))}`}${submission.status === "success" ? `; the receipt ${submission.matched ? "matches" : "does not match"} the prediction` : ""}.` });
      if (submission.status !== "success") break;
      sent += 1;
    }
  }
  steps.push({ source: `Skill Engine · ${TEMPLATES.contractWrite.reference.split("#")[0]}`, text: `Each payment's cast send, from the Skill Engine's templates for ${net.id === "pharos-mainnet" ? "mainnet" : "atlantic-testnet"}, in order. The agent runs none of them.` });

  const all = payments.length === 1 ? "The payment" : `The ${payments.length} payments`;
  const totalWords = totals.filter((t) => t.raw !== "0").map((t) => t.shown).join(" and ");
  const verdict: PaymentFlow["verdict"] = options.signer && sent === payments.length ? "sent" : options.signer && payments.some((p) => p.submission) ? "partly-sent" : failing ? "would-fail" : shortfalls.length ? "short" : "ready";
  const notSent = net.id === "pharos-mainnet" ? "Nothing was sent: the hosted Chain MCP is read-only." : "Nothing was sent.";
  const headline =
    verdict === "sent"
      ? `${all}, ${totalWords} in all, sent and checked against ${payments.length === 1 ? "its receipt" : "their receipts"}.`
      : verdict === "partly-sent"
        ? `${sent} of ${payments.length} payments sent; payment ${sent + 1} did not go through, so the rest were not sent.`
        : verdict === "would-fail"
          ? `Payment ${failing!.n} (${failing!.amount} ${failing!.asset} to ${who(failing!)}) would not go through: ${failing!.dryRun.reason ?? "it fails."} ${notSent}`
          : verdict === "short"
            ? `${all} need ${shortfalls.map((t) => t.needsShown).join(" and ")}, but ${short(sender)} holds ${shortfalls.map((t) => t.holdsShown).join(" and ")}. ${notSent}`
            : `${all}, ${totalWords} in all, ready: each dry-runs at block ${group(head.number)}, for about ${fees!.expectedShown} in gas together. ${notSent}`;
  steps.push({ source: "the verdict", text: headline });
  return {
    schema: "pharos-agent/payment-flow/1",
    request: request.trim(),
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: head.number.toString(), hash: head.hash, timestamp: new Date(Number(head.timestamp) * 1000).toISOString(), source },
    evaluatedAt,
    sender: { address: sender, from: senderFrom },
    nonce,
    payments,
    totals,
    fees,
    skillEngine: { repo: SKILL_ENGINE.repo, commit: SKILL_ENGINE.commit, reference: TEMPLATES.contractWrite.reference },
    verdict,
    headline,
    steps,
    toolCalls: chain.mcp.toolCalls,
  };
}
