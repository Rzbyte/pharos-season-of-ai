// Task 21, X402 Agent Buyer: an agent with a job and a budget. The job: decide whether a planned transfer
// should be sent, and prepare it. What it needs to know it buys from an x402 API (Task 20's, which sells
// Task 25's risk check and Task 08's dry run), paying USDC by x402, never past its budget.
//
//   1. Discover: it asks each product once without paying. The 402 says the price; that costs nothing.
//   2. Plan: the check first, then the dry run, each only if it fits what is left of the budget.
//   3. Buy: x402's client signs an authorization only within what is left (its own spend controls cap
//      each payment there, and a hook refuses any payment past it or at another price than the 402 said).
//      Every signed authorization counts against the budget, settled or not: whoever holds it could
//      settle it until it expires.
//   4. Use: "do not send" or "check first" ends the job (the dry run would not change the answer, so it
//      is not bought); otherwise the dry run says whether the transfer would succeed, what it would cost,
//      and gives the transaction to sign.
//   5. Finish: ready to sign, do not send, check first, would fail, or not done and why, with every
//      purchase and the budget's ledger.
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { formatAmount, parseAmount } from "../core/amounts.js";
import type { Address, BlockHeader, Chain, Hex } from "../core/chain.js";
import { AgentError, errorMessage } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import { knownToken, type Network } from "../core/networks.js";
import type { DryRun } from "../dryrun/run.js";
import type { Intent } from "../dryrun/intent.js";
import type { RiskReport } from "../risk/check.js";
import { paidApi } from "../x402/api.js";
import { localFetch } from "../x402/parties.js";
import { readAsset, x402Network, type X402Network } from "../x402/pharos.js";
import { PRODUCTS, transferQuery, type ProductName } from "../x402/products.js";
import { reasonWords } from "../x402/run.js";

/** The API's payee when the buyer runs it in this process: a sample address of the lab (Tasks 18 and 23). */
export const API_VENDOR = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
/** What the buyer buys, in order. */
export const SHOPPING = ["risk", "dryrun"] as const satisfies readonly ProductName[];
type Item = (typeof SHOPPING)[number];

export interface Purchase {
  product: Item;
  url: string;
  /** The terms the buyer paid against: the 402's requirement in its asset, on its network. */
  terms: PaymentRequirements;
  /** The authorization it signed, as sent in PAYMENT-SIGNATURE; null when it did not sign. */
  payment: PaymentPayload | null;
  /** The API's last answer: its status, and PAYMENT-RESPONSE decoded when there was one. */
  status: number;
  settlement: { success: boolean; transaction: string | null; network: string | null } | null;
  /** Why it was not bought, in words, when it was not. */
  refused: string | null;
  /** The answer bought; null unless the API answered 200. */
  data: unknown;
}

export interface PlanItem {
  product: Item;
  path: string;
  url: string;
  /** The price the 402 asked, in the asset; null when the API asked none the buyer can pay. */
  price: { amount: string; shown: string } | null;
  status: "bought" | "refused" | "not-needed" | "over-budget" | "unpriced";
  note: string;
}

export interface BuyerRun {
  schema: "pharos-agent/x402-buyer/1";
  network: { id: string; name: string; chainId: number; x402: X402Network };
  /** The Chain MCP the API in this process read through; null for an API elsewhere. */
  chainMcp: { where: string; server: string | null } | null;
  block: { number: string; timestamp: string } | null;
  /** The API: where it is, who it is paid, and (in this process) whether its facilitator settles, with which key's address. */
  api: { url: string; where: "in-process" | "remote"; payTo: Address | null; settles: boolean | null; facilitator: Address | null };
  evaluatedAt: string;
  job: { summary: string; intent: Intent };
  asset: { address: Address; symbol: string; decimals: number };
  budget: { amount: string; shown: string };
  payer: { address: Address; key: "given" | "new" };
  plan: PlanItem[];
  purchases: Purchase[];
  ledger: { committed: { amount: string; shown: string }; settled: { amount: string; shown: string }; remaining: { amount: string; shown: string } };
  verdict: "ready" | "do-not-send" | "check-first" | "would-fail" | "not-done";
  reason: string | null;
  headline: string;
  /** Ready: the transaction to sign, from the dry run bought; and about what its gas would cost. */
  tx: { from: Address; to: Address; data: Hex; value: string } | null;
  gas: { expectedCost: string; maxCost: string; shown: string } | null;
  steps: { source: string; text: string }[];
  toolCalls: number;
}

export interface BuyOptions {
  net: Network;
  /** Reaches the API. x402's paying fetch is built over it. */
  fetcher: typeof fetch;
  api: { url: string; where: "in-process" | "remote"; payTo?: Address | null; settles?: boolean | null; facilitator?: Address | null };
  job: Intent;
  /** In the asset's units: "0.01". */
  budget: string;
  /** The only asset it pays in. */
  asset: { address: Address; symbol: string; decimals: number };
  /** Its key; absent, a key made for the run that holds nothing. */
  payer?: LocalAccount;
  now?: () => Date;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const bad = (message: string) => new AgentError("usage", message);
const SEVERITY: Readonly<Record<string, number>> = Object.freeze({ high: 3, medium: 2, low: 1, info: 0 });

/** The job in words: "Send 25 USDC from 0x912c…f647 to 0xB274…9553". */
export function jobSummary(intent: Intent, net: Network): string {
  if (intent.kind === "native-transfer") return `Send ${intent.amount} ${net.nativeSymbol} from ${short(intent.from)} to ${short(intent.to)}`;
  if (intent.kind === "erc20-transfer") return `Send ${intent.amount} ${knownToken(net, intent.token)?.symbol ?? short(intent.token)} from ${short(intent.from)} to ${short(intent.to)}`;
  throw bad("The buyer's job is a transfer.");
}

/**
 * What the purchases say, as the job's outcome: a pure function of what was bought, so a proof's
 * verdict can be recomputed from its purchases. `gap` says why the next answer was not bought.
 */
export function decide(risk: RiskReport | null, dry: DryRun | null, gap: string | null): Pick<BuyerRun, "verdict" | "reason" | "tx" | "gas"> {
  const none = { tx: null, gas: null };
  if (!risk) return { verdict: "not-done", reason: gap ?? "the risk check was not bought", ...none };
  // The check's own reason: its worst signal, in its words.
  const worst = [...risk.signals].sort((a, b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0))[0];
  const why = worst && worst.severity !== "info" ? worst.detail : risk.headline;
  if (risk.verdict === "do-not-send") return { verdict: "do-not-send", reason: why, ...none };
  if (risk.verdict === "check-first") return { verdict: "check-first", reason: why, ...none };
  if (!dry) return { verdict: "not-done", reason: gap ?? "the dry run was not bought", ...none };
  if (dry.verdict !== "would-succeed") return { verdict: "would-fail", reason: dry.reason ?? dry.headline, ...none };
  const gas = dry.gas ? { expectedCost: dry.gas.expectedCost, maxCost: dry.gas.maxCost, shown: `${formatAmount(BigInt(dry.gas.expectedCost), 18, 8)}` } : null;
  return { verdict: "ready", reason: null, tx: dry.tx, gas };
}

/** Buys what the job needs from the API at `options.api.url`, within the budget, and finishes the job. */
export async function buy(options: BuyOptions): Promise<Omit<BuyerRun, "chainMcp" | "block" | "toolCalls">> {
  const { net, asset } = options;
  const network = x402Network(net);
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  const shown = (raw: bigint) => `${formatAmount(raw, asset.decimals, asset.decimals)} ${asset.symbol}`;
  const budget = parseAmount(options.budget, asset.decimals, "The budget");
  if (budget === 0n) throw bad("The budget must be more than zero.");
  const payer = options.payer ?? privateKeyToAccount(generatePrivateKey());
  const summary = jobSummary(options.job, net);
  const query = transferQuery(options.job, net);
  const steps: BuyerRun["steps"] = [];
  const base = options.api.url.replace(/\/+$/, "");
  const urlOf = (item: Item) => `${base}${PRODUCTS[item].path}?${query}`;

  // 1. Discover: each product asked once without paying; its 402 says the price.
  const plan: PlanItem[] = [];
  for (const item of SHOPPING) {
    const url = urlOf(item);
    const response = await options.fetcher(url);
    let price: bigint | null = null;
    let note = "";
    if (response.status === 402) {
      const header = response.headers.get("payment-required");
      const required = header ? (decodePaymentRequiredHeader(header) as PaymentRequired) : null;
      const offer = required?.accepts.find((a) => a.network === network && a.asset.toLowerCase() === asset.address.toLowerCase() && a.scheme === "exact");
      if (offer) price = BigInt(offer.amount);
      note = offer ? `the 402 asks ${shown(BigInt(offer.amount))}` : `the 402 asks no ${asset.symbol} on ${network}`;
    } else if (response.status === 400) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw bad(`The API cannot answer this job: ${body?.error?.message ?? "it refused the request"}`);
    } else {
      note = `the API answered HTTP ${response.status}, not 402`;
    }
    plan.push({ product: item, path: PRODUCTS[item].path, url, price: price === null ? null : { amount: price.toString(), shown: shown(price) }, status: price === null ? "unpriced" : "over-budget", note });
  }
  steps.push({ source: "the API · 402", text: `Asked each answer without paying: ${plan.map((p) => `${p.path} ${p.price ? p.price.shown : "(no price it can pay)"}`).join(", ")}. The budget is ${shown(budget)}.` });

  // 2 and 3. Buy in order, each only while it fits what is left.
  const purchases: Purchase[] = [];
  const committedOf = () => purchases.reduce((sum, p) => sum + (p.payment ? BigInt((p.payment.payload as { authorization?: { value?: string } }).authorization?.value ?? "0") : 0n), 0n);
  let risk: RiskReport | null = null;
  let dry: DryRun | null = null;
  let gap: string | null = null;
  for (const item of plan) {
    const label = item.product === "risk" ? "the risk check" : "the dry run";
    // The job may already be decided: a dry run does not change "do not send" or "check first".
    if (item.product === "dryrun" && risk && risk.verdict !== "looks-fine") {
      item.status = "not-needed";
      item.note = `not needed: the check says ${risk.verdict === "do-not-send" ? "do not send" : "check first"}`;
      continue;
    }
    if (gap) {
      item.note = `not bought: ${gap}`;
      continue;
    }
    if (!item.price) {
      gap = `${label} has no price the buyer can pay (${item.note})`;
      continue;
    }
    const price = BigInt(item.price.amount);
    const left = budget - committedOf();
    if (price > left) {
      gap = `${label} costs ${shown(price)}, more than the ${shown(left)} left of the budget`;
      item.note = `over the budget: ${shown(left)} left`;
      continue;
    }
    const purchase = await purchaseOne(options, payer, item, price, left, shown);
    purchases.push(purchase);
    if (purchase.data !== null && purchase.status === 200) {
      item.status = "bought";
      item.note = `bought for ${shown(price)}${purchase.settlement?.transaction ? `, settled in ${purchase.settlement.transaction}` : ""}`;
      if (item.product === "risk") risk = purchase.data as RiskReport;
      else dry = purchase.data as DryRun;
    } else {
      item.status = "refused";
      item.note = purchase.payment ? `refused: ${purchase.refused}` : `not bought: ${purchase.refused}`;
      gap = purchase.payment ? `the API refused the payment for ${label}: ${purchase.refused}` : `${label} was not bought: ${purchase.refused}`;
    }
    steps.push({ source: `the client · ${item.path}`, text: purchase.payment ? `Signed an EIP-3009 authorization for ${shown(price)} (${shown(left)} left before it), and asked again. ${purchase.status === 200 ? `200: the answer, paid${purchase.settlement?.transaction ? ` and settled in ${purchase.settlement.transaction}` : ""}.` : `The API refused the payment: ${purchase.refused}.`}` : `Did not pay: ${purchase.refused}.` });
  }

  // 4 and 5. Use what was bought, and finish.
  const outcome = decide(risk, dry, gap);
  const committed = committedOf();
  const settled = purchases.reduce((sum, p) => sum + (p.settlement?.success && p.payment ? BigInt((p.payment.payload as { authorization?: { value?: string } }).authorization?.value ?? "0") : 0n), 0n);
  const bought = purchases.filter((p) => p.status === 200 && p.data !== null).length;
  const spent = `${bought === 0 ? "Nothing bought" : `Bought ${bought === 1 ? "one answer" : `${bought} answers`}`}; ${shown(committed)} signed for of the ${shown(budget)} budget${settled !== committed ? `, ${shown(settled)} settled` : ""}.`;
  const headline =
    outcome.verdict === "ready"
      ? `Ready to sign: ${summary}. The check found nothing suspicious, and the dry run says it would succeed${outcome.gas ? `, for about ${outcome.gas.shown} ${net.nativeSymbol} of gas` : ""}. ${spent}`
      : outcome.verdict === "do-not-send"
        ? `Do not send: ${summary}. ${outcome.reason} ${spent}`
        : outcome.verdict === "check-first"
          ? `Check first: ${summary}. ${outcome.reason} ${spent}`
          : outcome.verdict === "would-fail"
            ? `It would fail: ${summary}. ${outcome.reason} ${spent}`
            : `Not done: ${summary}: ${outcome.reason}. ${spent}`;
  steps.push({ source: "the verdict", text: headline });
  return {
    schema: "pharos-agent/x402-buyer/1",
    network: { id: net.id, name: net.name, chainId: net.chainId, x402: network },
    api: { url: base, where: options.api.where, payTo: options.api.payTo ?? null, settles: options.api.settles ?? null, facilitator: options.api.facilitator ?? null },
    evaluatedAt,
    job: { summary, intent: options.job },
    asset,
    budget: { amount: budget.toString(), shown: shown(budget) },
    payer: { address: payer.address, key: options.payer ? "given" : "new" },
    plan,
    purchases,
    ledger: { committed: { amount: committed.toString(), shown: shown(committed) }, settled: { amount: settled.toString(), shown: shown(settled) }, remaining: { amount: (budget - committed).toString(), shown: shown(budget - committed) } },
    verdict: outcome.verdict,
    reason: outcome.reason,
    headline,
    tx: outcome.tx,
    gas: outcome.gas,
    steps,
  };
}

/** One purchase: x402's client, allowed this asset only, at most what is left, at exactly the 402's price. */
async function purchaseOne(options: BuyOptions, payer: LocalAccount, item: PlanItem, price: bigint, left: bigint, shown: (raw: bigint) => string): Promise<Purchase> {
  const network = x402Network(options.net);
  const client = new x402Client().register(network, new ExactEvmClient(payer as never));
  client.setSpendControls({ allowedAssets: [{ network, asset: options.asset.address, maxAmountPerPayment: left.toString() }] });
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    const amount = BigInt(selectedRequirements.amount);
    if (amount > left) return { abort: true, reason: `${shown(amount)} is more than the ${shown(left)} left of the budget` };
    if (amount !== price) return { abort: true, reason: `the price changed to ${shown(amount)} from the ${shown(price)} the 402 asked` };
  });
  const seen: { status: number; required: string | null; signature: string | null; paymentResponse: string | null; body: unknown }[] = [];
  const recording: typeof fetch = async (input, init) => {
    const request = new Request(input as never, init);
    const response = await options.fetcher(request);
    const body = await response.clone().json().catch(() => null);
    seen.push({ status: response.status, required: response.headers.get("payment-required"), signature: request.headers.get("payment-signature"), paymentResponse: response.headers.get("payment-response"), body });
    return response;
  };
  let failure: string | null = null;
  try {
    await wrapFetchWithPayment(recording, client)(item.url);
  } catch (error) {
    if (error instanceof AgentError) throw error; // the chain, not the payment: an error, never a refusal
    failure = errorMessage(error);
  }
  const first = seen.find((s) => s.status === 402 && s.required && !s.signature);
  const required = first?.required ? (decodePaymentRequiredHeader(first.required) as PaymentRequired) : null;
  const terms = required?.accepts.find((a) => a.network === network && a.asset.toLowerCase() === options.asset.address.toLowerCase()) ?? ({ scheme: "exact", network, asset: options.asset.address, amount: price.toString(), payTo: options.api.payTo ?? "", maxTimeoutSeconds: 0, extra: {} } as PaymentRequirements);
  const paid = seen.find((s) => s.signature);
  const payment = paid?.signature ? (decodePaymentSignatureHeader(paid.signature) as PaymentPayload) : null;
  const last = seen.at(-1);
  const settlement = last?.paymentResponse ? (decodePaymentResponseHeader(last.paymentResponse) as { success: boolean; transaction?: string; network?: string }) : null;
  const ok = last?.status === 200 && Boolean(payment) && settlement?.success === true;
  // Refused after paying: the 402 again, its error the facilitator's reason.
  const again = payment && last?.status === 402 && last.required ? (decodePaymentRequiredHeader(last.required) as PaymentRequired).error : undefined;
  const refused = ok ? null : failure ? failureWords(failure, shown, left) : again ? (reasonWords(again) ?? again) : `the API answered HTTP ${last?.status ?? "nothing"}`;
  return {
    product: item.product,
    url: item.url,
    terms,
    payment,
    status: last?.status ?? 0,
    settlement: settlement ? { success: settlement.success, transaction: settlement.transaction ?? null, network: settlement.network ?? null } : null,
    refused,
    data: ok ? (last?.body ?? null) : null,
  };
}

/** x402's client refusals, in words where it says why. */
function failureWords(failure: string, shown: (raw: bigint) => string, left: bigint): string {
  if (/spendControls|maxAmountPerPayment/.test(failure)) return `it would pay more than the ${shown(left)} left of the budget`;
  const hook = /aborted[^:]*:\s*(.+)$/i.exec(failure)?.[1] ?? /before.*hook.*?:\s*(.+)$/i.exec(failure)?.[1];
  return (hook ?? failure).replace(/\.$/, "");
}

export interface RunBuyerOptions {
  chain: Chain;
  job: Intent;
  budget: string;
  /** The buyer's key (Atlantic only); absent, a key made for the run that holds nothing. */
  payer?: LocalAccount;
  /** The API's facilitator's key, which settles (Atlantic only); absent, the facilitator only verifies. */
  facilitator?: Signer;
  /** Who the API is paid (default API_VENDOR). */
  payTo?: Address;
  prices?: Partial<Record<ProductName, string>>;
  wait?: { polls?: number; pollMs?: number };
  now?: () => Date;
}

/** The buyer against the API run in this process, every chain read of the API's through `chain`. */
export async function runBuyer(options: RunBuyerOptions): Promise<BuyerRun> {
  const { chain } = options;
  const net = chain.network;
  if ((options.payer || options.facilitator) && net.id !== "atlantic-testnet") throw bad("Paying is limited to the Atlantic testnet: on Pharos Mainnet the hosted Chain MCP is read-only, so nothing settles.");
  const usdc = net.tokens.find((t) => t.symbol === "USDC");
  if (!usdc) throw bad(`No official USDC on ${net.name}.`);
  await chain.expectChain();
  const head: BlockHeader = await chain.block(await chain.blockNumber());
  const read = await readAsset(chain, getAddress(usdc.address), head.number);
  const asset = { ...read, decimals: read.decimals ?? usdc.decimals };
  const payTo = getAddress(options.payTo ?? API_VENDOR);
  const api = await paidApi({ chain, asset, payTo, facilitator: options.facilitator ?? null, prices: options.prices, names: SHOPPING, wait: options.wait });
  const result = await buy({ net, fetcher: localFetch(api.handler), api: { url: api.url, where: "in-process", payTo, settles: api.listing.settles, facilitator: options.facilitator?.address ?? null }, job: options.job, budget: options.budget, asset: { address: asset.address, symbol: asset.symbol ?? usdc.symbol, decimals: asset.decimals }, payer: options.payer, now: options.now });
  // A failure that is not the chain's answer ends the run as an error, never as a refusal (see signer.ts).
  const fault = api.faults[0];
  if (fault?.signed) throw new AgentError("execution", `The settlement ${fault.signed} was signed and may have been sent, then: ${errorMessage(fault.error)}`, "Check its receipt before paying again.");
  if (fault) throw fault.error;
  return {
    ...result,
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: head.number.toString(), timestamp: new Date(Number(head.timestamp) * 1000).toISOString() },
    toolCalls: chain.mcp.toolCalls,
  };
}
