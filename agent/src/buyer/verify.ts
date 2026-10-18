// Task 21: checking buyer proofs offline. The x402 payments themselves cannot be replayed (a random nonce,
// the clock, a key made for the run), so their facts are checked against the recorded Chain MCP answers,
// as Task 20's are. What can be replayed is: the asset read at the start, and every answer bought, each
// recomputed through the same code from its own recorded calls. The outcome is then recomputed from
// what was bought, and the ledger from what was signed.
import { authorizationTypes } from "@x402/evm";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import { parseAmount } from "../core/amounts.js";
import { Chain } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, recordedCalls, ReplayMcp, ReplayMismatch, type Check, type ProofFile, type RecordedCall } from "../core/proof.js";
import type { DryRun } from "../dryrun/run.js";
import type { RiskReport } from "../risk/check.js";
import { readAsset } from "../x402/pharos.js";
import { answer, transferIntent } from "../x402/products.js";
import { settlementCheck, type Authorization } from "../x402/verify.js";
import { API_VENDOR, decide, type BuyerRun } from "./run.js";

interface BuyerInput {
  job?: Record<string, string>;
  budget?: string;
  payTo?: string;
}

const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const valueOf = (payment: BuyerRun["purchases"][number]["payment"]): bigint => {
  try {
    return BigInt((payment?.payload as { authorization?: { value?: string } } | undefined)?.authorization?.value ?? "0");
  } catch {
    return -1n;
  }
};

export async function verifyBuyerProof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as BuyerRun;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "21", capability: "x402-buyer", network: net });
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let calls: RecordedCall[];
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  const input = proof.input as BuyerInput;
  const server = proof.chainMcp.server ?? undefined;
  const where = result.chainMcp?.where ?? "";

  // What was asked: the job, the budget, who the API is paid.
  try {
    const intent = transferIntent(new URLSearchParams(input.job ?? {}), net);
    const budget = parseAmount(String(input.budget), result.asset.decimals, "The budget");
    const ok = JSON.stringify(intent) === JSON.stringify(result.job.intent) && String(budget) === result.budget.amount && same(getAddress(input.payTo ?? API_VENDOR), result.api.payTo);
    add("job as asked", ok, ok ? `${result.job.summary}, within ${result.budget.shown}, the API paid to ${result.api.payTo}` : "the job, the budget or the API's payee is not the one asked");
  } catch (error) {
    add("job as asked", false, (error as Error).message);
  }

  // The asset, read again from the run's first calls.
  try {
    const chain = new Chain(new ReplayMcp(calls, where, server), net);
    await chain.expectChain();
    const head = await chain.block(await chain.blockNumber());
    const asset = await readAsset(chain, result.asset.address, head.number);
    const ok = head.number.toString() === result.block?.number && asset.decimals === result.asset.decimals && (asset.symbol ?? result.asset.symbol) === result.asset.symbol;
    add("asset read again", ok, ok ? `${result.asset.symbol} at ${result.asset.address}, ${result.asset.decimals} decimals, at block ${result.block!.number}` : "the asset or the block is not what the recorded answers say");
  } catch (error) {
    add("asset read again", false, error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`);
  }

  // The ledger: each authorization signed only within what was left, in order; the totals as recorded.
  const budget = BigInt(result.budget.amount);
  let committed = 0n;
  let settled = 0n;
  let within = true;
  for (const p of result.purchases) {
    if (!p.payment) continue;
    const value = valueOf(p.payment);
    if (value < 0n || value > budget - committed) within = false;
    committed += value < 0n ? 0n : value;
    if (p.settlement?.success) settled += value < 0n ? 0n : value;
  }
  const ledger = within && committed <= budget && String(committed) === result.ledger.committed.amount && String(settled) === result.ledger.settled.amount && String(budget - committed) === result.ledger.remaining.amount;
  add("within the budget", ledger, ledger ? `${(() => { const n = result.purchases.filter((p) => p.payment).length; return `${n} ${n === 1 ? "authorization" : "authorizations"}`; })()} signed, each within what was left: ${result.ledger.committed.shown} of ${result.budget.shown}, ${result.ledger.settled.shown} settled` : "an authorization was signed past what was left, or the ledger is not what was signed");

  // Each authorization: signed by the buyer for exactly the 402's price of what it bought.
  const signedOk: string[] = [];
  let signedBad: string | null = null;
  for (const p of result.purchases) {
    if (!p.payment) continue;
    const payload = p.payment.payload as { authorization?: Authorization; signature?: Hex };
    const auth = payload.authorization;
    const planned = result.plan.find((item) => item.product === p.product)?.price?.amount;
    const name = p.terms.extra?.name as string | undefined;
    const version = p.terms.extra?.version as string | undefined;
    let signer: string | null = null;
    try {
      signer = auth && payload.signature && name && version ? await recoverTypedDataAddress({ domain: { name, version, chainId: net.chainId, verifyingContract: result.asset.address }, types: authorizationTypes, primaryType: "TransferWithAuthorization", message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce }, signature: payload.signature }) : null;
    } catch {
      signer = null;
    }
    const ok = Boolean(auth) && same(signer, result.payer.address) && same(auth!.from, result.payer.address) && same(auth!.to, p.terms.payTo) && same(p.terms.payTo, result.api.payTo) && auth!.value === p.terms.amount && p.terms.amount === planned && same(p.terms.asset, result.asset.address) && p.terms.network === result.network.x402;
    if (ok) signedOk.push(`${p.product} ${p.terms.amount}`);
    else signedBad ??= `the authorization for ${p.product} is not the buyer's, for exactly the price its 402 asked`;
  }
  add("each authorization", signedBad === null, signedBad ?? (signedOk.length ? `signed by ${result.payer.address} for exactly each 402's price: ${signedOk.join(", ")} base units` : "nothing signed"));

  // Settlements: none by a facilitator that only verifies; each one claimed, exactly its authorization.
  const sends = calls.filter((c) => c.name === "send_raw_transaction");
  const claimed = result.purchases.filter((p) => p.settlement?.success && p.settlement.transaction);
  if (!result.api.settles) {
    add("nothing sent", sends.length === 0, sends.length ? `${sends.length} transactions sent by a facilitator that only verifies` : "the API's facilitator holds no key: no transaction sent");
  } else {
    const details: string[] = [];
    let ok = sends.length === claimed.length;
    for (const p of claimed) {
      const payload = p.payment!.payload as { authorization: Authorization; signature: Hex };
      const check = await settlementCheck(calls, net.chainId, result.asset.address, payload.authorization, payload.signature, result.api.facilitator, p.settlement!.transaction!);
      ok &&= check.ok;
      details.push(`${p.product}: ${check.detail}`);
    }
    add("settlements", ok, ok ? (details.length ? details.join("; ") : "nothing settled, nothing sent") : sends.length !== claimed.length ? `${sends.length} transactions sent for ${claimed.length} settlements` : details.find((d) => d.includes("is ")) ?? details.join("; "));
  }

  // Each answer bought, recomputed through the same code from its own recorded calls: each starts by
  // checking the chain (get_chain_info), after the run's own check at the start.
  const starts = calls.flatMap((c, k) => (c.name === "get_chain_info" ? [k] : [])).slice(1);
  const bought = result.purchases.filter((p) => p.status === 200 && p.data !== null);
  let answersOk = starts.length === bought.length;
  let answersDetail = answersOk ? "" : `${bought.length} answers bought, ${starts.length} recorded`;
  for (const [k, p] of bought.entries()) {
    if (!answersOk) break;
    try {
      const chain = new Chain(new ReplayMcp(calls, where, server, starts[k]!), net);
      const recorded = p.data as { evaluatedAt?: string };
      const again = await answer(p.product, chain, new URL(p.url).searchParams, recorded.evaluatedAt ? () => new Date(recorded.evaluatedAt!) : undefined);
      if (JSON.stringify(again) !== JSON.stringify(p.data)) {
        answersOk = false;
        answersDetail = firstDifference(again, p.data, p.product);
      }
    } catch (error) {
      answersOk = false;
      answersDetail = error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`;
    }
  }
  add("answers recomputed", answersOk, answersOk ? (bought.length ? `${bought.map((p) => p.product).join(" and ")}, each recomputed from its recorded calls` : "nothing bought") : answersDetail);

  // The outcome, from what was bought.
  const risk = (bought.find((p) => p.product === "risk")?.data as RiskReport | undefined) ?? null;
  const dry = (bought.find((p) => p.product === "dryrun")?.data as DryRun | undefined) ?? null;
  const outcome = decide(risk, dry, result.verdict === "not-done" ? result.reason : null);
  const matches = JSON.stringify(outcome) === JSON.stringify({ verdict: result.verdict, reason: result.reason, tx: result.tx, gas: result.gas });
  add("outcome recomputed", matches, matches ? `${result.verdict}, from what was bought` : firstDifference(outcome, { verdict: result.verdict, reason: result.reason, tx: result.tx, gas: result.gas }, "outcome"));
  return checks;
}
