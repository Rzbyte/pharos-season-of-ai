// Task 20, X402 Paywalled API: an API that charges per request with x402 on Pharos, its facilitator, and a
// client that pays it and receives the data, in one recorded run.
//
//   1. The asset, read through Chain MCP: its EIP-712 name and version (what a payment signs) and whether
//      it answers EIP-3009, which the exact scheme's transferWithAuthorization needs.
//   2. The paid endpoint (parties.ts): GET /data, which answers live Pharos chain data. Asked without a
//      payment, it answers 402 Payment Required with its terms: so much of the asset, to whom, on which
//      network, by the exact scheme.
//   3. The client signs an EIP-3009 authorization for exactly those terms (never more than its cap) and
//      asks again with it. The facilitator verifies it (the signature, then the transfer simulated on
//      chain), the endpoint makes the data, and the facilitator settles: transferWithAuthorization sent
//      through Chain MCP, its receipt checked for the Transfer. Only then is the data released.
//
// On Pharos Mainnet nothing can settle (the hosted Chain MCP is read-only), so a run there pays with a key
// made for it that holds nothing: the endpoint, the client and the facilitator do everything real up to
// the facilitator's check on chain, which refuses it, and the data stays locked. On Atlantic, with keys,
// the payment is made and settled.
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, SettleResponse, VerifyResponse } from "@x402/core/types";
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress } from "@x402/evm";
import { decodeEventLog, getAddress, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { formatAmount, parseAmount } from "../core/amounts.js";
import type { Address, BlockHeader, Chain, Hex, Receipt } from "../core/chain.js";
import { AgentError, errorMessage } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import { knownToken } from "../core/networks.js";
import { LocalFacilitatorClient, localFetch, paidEndpoint, payingFetch, pharosFacilitator } from "./parties.js";
import { readAsset, X402_SKILL, x402Network, type X402Asset, type X402Network } from "./pharos.js";

export interface X402Run {
  schema: "pharos-agent/x402-run/1";
  network: { id: string; name: string; chainId: number; x402: X402Network };
  chainMcp: { where: string; server: string | null };
  block: { number: string; hash: string; timestamp: string };
  evaluatedAt: string;
  skill: typeof X402_SKILL;
  endpoint: { method: "GET"; path: string; price: { amount: string; shown: string }; description: string };
  asset: X402Asset;
  /** Read only for an asset that is not EIP-3009: whether x402's other way to settle, Permit2, has its contracts here. */
  permit2: { permit2: Address; permit2Code: boolean; proxy: Address; proxyCode: boolean } | null;
  payTo: Address;
  payer: { address: Address; key: "given" | "new" };
  /** A facilitator without a key only verifies, and has no address. */
  facilitator: { address: Address | null; settles: boolean };
  /** The most the client pays for one request. */
  cap: { amount: string; shown: string };
  /** The endpoint's 402 answer, decoded from PAYMENT-REQUIRED. */
  required: PaymentRequired | null;
  /** The payment the client sent, decoded from PAYMENT-SIGNATURE. */
  payment: PaymentPayload | null;
  verify: VerifyResponse | null;
  settle: SettleResponse | null;
  /** The settlement's receipt, as the facilitator waited for it: its block and the Transfer it holds. */
  settlement: { tx: Hex; block: string; status: "success" | "reverted"; transfer: { from: Address; to: Address; value: string } | null } | null;
  /** The endpoint's last answer to the client. */
  response: { status: number; body: unknown; paymentResponse: unknown };
  /** What the client received for its payment; null unless it was paid. */
  data: unknown;
  verdict: "paid" | "refused" | "not-settled" | "not-paid";
  /** In words: why it was refused or not settled. */
  reason: string | null;
  headline: string;
  steps: { source: string; text: string }[];
  toolCalls: number;
}

export interface X402Options {
  chain: Chain;
  /** The payer's key; absent, a key made for this run that holds nothing. */
  payer?: LocalAccount;
  /** The facilitator's key, which settles (Atlantic only); absent, the facilitator only verifies. */
  facilitator?: Signer;
  payTo: Address;
  /** The price of GET /data, in the asset's units: "0.001". */
  price: string;
  /** The most the client pays, in the asset's units (default: the price). */
  cap?: string;
  /** The asset (default: the official USDC of the network). */
  asset?: Address;
  wait?: { polls?: number; pollMs?: number };
  now?: () => Date;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const group = (n: number | bigint) => n.toLocaleString("en-US");
const bad = (message: string) => new AgentError("usage", message);
// x402's own reason codes (@x402/evm, exact/facilitator/errors), in words.
const REASONS: Readonly<Record<string, string>> = Object.freeze({
  invalid_exact_evm_insufficient_balance: "the payer does not hold the amount",
  invalid_exact_evm_eip3009_not_supported: "the asset does not support EIP-3009's transferWithAuthorization",
  invalid_exact_evm_transaction_simulation_failed: "the transfer fails when simulated on chain",
  invalid_exact_evm_signature: "the signature does not check",
  invalid_exact_evm_nonce_already_used: "this authorization was used already",
  invalid_exact_evm_token_name_mismatch: "the token's name is not the one signed",
  invalid_exact_evm_token_version_mismatch: "the token's version is not the one signed",
  invalid_exact_evm_missing_eip712_domain: "the terms carry no EIP-712 name and version to sign",
  invalid_exact_evm_recipient_mismatch: "the authorization pays someone other than the endpoint",
  invalid_exact_evm_authorization_value: "the authorization is not for the price",
  invalid_exact_evm_payload_authorization_valid_before: "the authorization has expired",
  invalid_exact_evm_payload_authorization_valid_after: "the authorization is not valid yet",
  invalid_exact_evm_network_mismatch: "the payment is for another network",
  invalid_exact_evm_transaction_failed: "the settling transaction failed",
  invalid_exact_evm_transfer_event_mismatch: "the settling transaction holds no matching Transfer",
});
/** A facilitator's reason code, in words where it is a known one. */
export const reasonWords = (code: string | undefined | null): string | null => (code ? (REASONS[code] ?? code.replaceAll("_", " ")) : null);
const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
/** The Transfer of `asset` a receipt holds, if any. */
const transferIn = (receipt: Receipt, asset: Address): { from: Address; to: Address; value: string } | null => {
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== asset.toLowerCase()) continue;
    try {
      const { args } = decodeEventLog({ abi: TRANSFER, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      return { from: getAddress(args.from), to: getAddress(args.to), value: args.value.toString() };
    } catch {
      continue;
    }
  }
  return null;
};

/** What GET /data answers once paid: the newest block and the gas price, read through Chain MCP. */
export async function chainData(chain: Chain): Promise<{ network: X402Network; chainId: number; block: { number: string; timestamp: string; baseFeePerGas: string | null }; gasPrice: string; source: string }> {
  const block = await chain.block("latest");
  const gas = await chain.gasPrice();
  return { network: x402Network(chain.network), chainId: chain.network.chainId, block: { number: block.number.toString(), timestamp: new Date(Number(block.timestamp) * 1000).toISOString(), baseFeePerGas: block.baseFeePerGas?.toString() ?? null }, gasPrice: gas.gasPrice.toString(), source: "Pharos Chain MCP" };
}

export async function runX402(options: X402Options): Promise<X402Run> {
  const { chain } = options;
  const net = chain.network;
  const network = x402Network(net);
  const given = options.asset ?? net.tokens.find((t) => t.symbol === "USDC")?.address;
  if (!given) throw bad(`No official USDC on ${net.name}: give the asset.`);
  const assetAddress = getAddress(given);
  if (options.facilitator && net.id !== "atlantic-testnet") throw bad("Settling is limited to the Atlantic testnet: on Pharos Mainnet the hosted Chain MCP is read-only.");
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  await chain.expectChain();
  const head: BlockHeader = await chain.block(await chain.blockNumber());
  const steps: X402Run["steps"] = [];

  // 1. The asset, as the chain reports it.
  const asset = await readAsset(chain, assetAddress, head.number);
  const official = knownToken(net, assetAddress);
  if (asset.decimals === null && !official) throw bad(`${assetAddress} answers no decimals(): it is not a token an endpoint can price in.`);
  const decimals = asset.decimals ?? official!.decimals;
  const symbol = asset.symbol ?? official?.symbol ?? "the asset";
  const amount = parseAmount(options.price, decimals, "The price");
  const cap = parseAmount(options.cap ?? options.price, decimals, "The cap");
  if (amount === 0n) throw bad("The price must be more than zero.");
  const shown = (raw: bigint) => `${formatAmount(raw, decimals, decimals)} ${symbol}`;
  steps.push({ source: "Chain MCP · eth_call", text: `The asset at ${short(assetAddress)}: ${asset.name ?? "no name()"} (${symbol}), ${asset.version ? `version ${asset.version}` : "no version()"}, ${decimals} decimals. ${asset.eip3009 ? "It answers EIP-3009's authorizationState: the exact scheme can settle in it." : "It does not answer EIP-3009's authorizationState: the exact scheme cannot settle in it by transferWithAuthorization."}` });
  let permit2: X402Run["permit2"] = null;
  if (!asset.eip3009) {
    const has = async (at: Address) => (await chain.code(at, head.number)) !== "0x";
    permit2 = { permit2: PERMIT2_ADDRESS, permit2Code: await has(PERMIT2_ADDRESS), proxy: x402ExactPermit2ProxyAddress, proxyCode: await has(x402ExactPermit2ProxyAddress) };
    steps.push({ source: "Chain MCP · get_code", text: `x402's other way to settle, Permit2, needs Permit2 (${short(PERMIT2_ADDRESS)}) and x402's proxy (${short(x402ExactPermit2ProxyAddress)}) deployed: ${permit2.permit2Code ? "Permit2 has code" : "Permit2 has no code"} on ${net.name}, ${permit2.proxyCode ? "the proxy has code" : "the proxy has none"}. This agent settles by EIP-3009, as the Pharos skill does.` });
  }

  // 2. The three parties, in this process.
  const payer = options.payer ?? privateKeyToAccount(generatePrivateKey());
  const receipts: Receipt[] = [];
  // A failure that is not the chain's answer ends the run as an error, never as a refusal (see signer.ts).
  const faults: { error: unknown; signed: Hex | null }[] = [];
  const facilitator = new LocalFacilitatorClient(pharosFacilitator(chain, options.facilitator ?? null, { wait: options.wait, onReceipt: (r) => receipts.push(r), onFault: (error, signed) => faults.push({ error, signed }) }));
  const route = {
    path: "/data",
    amount: amount.toString(),
    description: `Live ${net.name} data, read through Pharos Chain MCP: the newest block and the gas price`,
    data: () => chainData(chain),
  };
  const handler = await paidEndpoint({ chain, asset: { ...asset, decimals }, payTo: options.payTo, routes: [route], facilitator });
  const exchanges: { status: number; required: string | null; signature: string | null; paymentResponse: string | null; body: unknown }[] = [];
  const recording: typeof fetch = async (input, init) => {
    const request = new Request(input as never, init);
    const response = await handler(request).catch((error: unknown) => {
      faults.push({ error, signed: null });
      throw error;
    });
    const body = await response.clone().json().catch(() => null);
    exchanges.push({ status: response.status, required: response.headers.get("payment-required"), signature: request.headers.get("payment-signature") ?? request.headers.get("x-payment"), paymentResponse: response.headers.get("payment-response"), body });
    return response;
  };
  let failure: string | null = null;
  let final: Response | null = null;
  try {
    final = await payingFetch(payer, net, assetAddress, cap.toString(), localFetch(recording))(`https://x402.local${route.path}`);
  } catch (error) {
    failure = (error as Error).message;
  }
  const fault = faults[0];
  if (fault?.signed) throw new AgentError("execution", `The settlement ${fault.signed} was signed and may have been sent, then: ${errorMessage(fault.error)}`, "Check its receipt before paying again.");
  if (fault) throw fault.error;

  // 3. What happened, from what was exchanged.
  const challenge = exchanges.find((e) => e.status === 402 && e.required && !e.signature) ?? null;
  const required = challenge?.required ? (decodePaymentRequiredHeader(challenge.required) as PaymentRequired) : null;
  const paid = exchanges.find((e) => e.signature) ?? null;
  const payment = paid?.signature ? (decodePaymentSignatureHeader(paid.signature) as PaymentPayload) : null;
  const verify = (facilitator.log.find((l) => l.op === "verify")?.response as VerifyResponse | undefined) ?? null;
  const settle = (facilitator.log.find((l) => l.op === "settle")?.response as SettleResponse | undefined) ?? null;
  const last = exchanges.at(-1);
  const paymentResponse = last?.paymentResponse ? decodePaymentResponseHeader(last.paymentResponse) : null;
  const receipt = settle?.transaction ? (receipts.find((r) => r.transactionHash.toLowerCase() === settle.transaction.toLowerCase()) ?? null) : null;
  const settlement: X402Run["settlement"] = receipt ? { tx: receipt.transactionHash, block: receipt.blockNumber.toString(), status: receipt.status, transfer: transferIn(receipt, assetAddress) } : null;
  const accepted = required?.accepts?.[0];
  // Why the client did not pay, in words, where x402 says so.
  const unpaid = failure === null ? null : /maxAmountPerPayment|spendControls/.test(failure) && accepted ? `the endpoint asks ${shown(BigInt(accepted.amount))}, more than the client's cap of ${shown(cap)} a request` : /EIP-712 domain parameters/.test(failure) ? `the asset answers no EIP-712 ${asset.name ? "version()" : asset.version ? "name()" : "name() or version()"}, so there is no domain for an authorization to sign` : failure.replace(/\.$/, "");
  if (required && accepted) steps.push({ source: "the paid endpoint", text: `GET ${route.path} without a payment: 402 Payment Required. It asks ${shown(BigInt(accepted.amount))} (${group(BigInt(accepted.amount))} base units) to ${short(accepted.payTo)}, on ${accepted.network}, by the ${accepted.scheme} scheme.` });
  const auth = (payment?.payload as { authorization?: { from: Address; to: Address; value: string; validBefore: string; nonce: Hex } } | undefined)?.authorization;
  if (payment && auth) steps.push({ source: "the client", text: `Signed an EIP-3009 authorization with ${options.payer ? "the payer's key" : "a key made for this run, holding nothing"} (${short(auth.from)}): ${shown(BigInt(auth.value))} to ${short(auth.to)}, valid until ${new Date(Number(auth.validBefore) * 1000).toISOString()}; asked again with it in PAYMENT-SIGNATURE.` });
  else if (unpaid) steps.push({ source: "the client", text: `Did not pay: ${unpaid}.` });
  if (verify) steps.push({ source: "the facilitator · verify", text: verify.isValid ? "The signature checks, and the transfer succeeds when simulated on chain (eth_call through Chain MCP): valid." : `Refused: ${reasonWords(verify.invalidReason) ?? "invalid"} (${verify.invalidReason}).` });
  if (settle) steps.push({ source: "the facilitator · settle", text: settle.success ? `transferWithAuthorization sent through Chain MCP (send_raw_transaction): ${settle.transaction}${settlement ? `, in block ${group(BigInt(settlement.block))}` : ""}; ${settlement?.transfer ? `its receipt holds the Transfer of ${shown(BigInt(settlement.transfer.value))} to ${short(settlement.transfer.to)}` : "its receipt was checked for the Transfer"}.` : `Not settled: ${reasonWords(settle.errorReason) ?? "it failed"}${settle.errorMessage ? ` (${settle.errorMessage})` : ""}.` });
  const ok = final?.status === 200 && settle?.success === true;
  const data = ok ? (last?.body ?? null) : null;
  if (ok) steps.push({ source: "the client", text: `200 OK: the data, and PAYMENT-RESPONSE with the settlement (${settle!.transaction}).` });
  const verdict: X402Run["verdict"] = ok ? "paid" : verify && !verify.isValid ? "refused" : settle && !settle.success ? "not-settled" : "not-paid";
  const reason = verdict === "refused" ? reasonWords(verify!.invalidReason) : verdict === "not-settled" ? reasonWords(settle!.errorReason) : verdict === "not-paid" ? (unpaid ?? "no payment was made") : null;
  const who = options.payer ? short(payer.address) : `a key made for this run, holding nothing (${short(payer.address)}),`;
  const headline =
    verdict === "paid"
      ? `Paid and served: ${shown(amount)} from ${short(payer.address)} to ${short(options.payTo)}, settled in ${settle!.transaction}, and the data released for it.`
      : verdict === "refused"
        ? `The endpoint asked ${shown(amount)}; ${who} signed for it, and the facilitator refused it on ${net.name}: ${reason}. The data stayed locked.`
        : verdict === "not-settled"
          ? `The payment checked, but it was not settled: ${reason}. The data stayed locked.`
          : `Nothing was paid: ${reason}. The data stayed locked.`;
  steps.push({ source: "the verdict", text: headline });
  return {
    schema: "pharos-agent/x402-run/1",
    network: { id: net.id, name: net.name, chainId: net.chainId, x402: network },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    block: { number: head.number.toString(), hash: head.hash, timestamp: new Date(Number(head.timestamp) * 1000).toISOString() },
    evaluatedAt,
    skill: X402_SKILL,
    endpoint: { method: "GET", path: route.path, price: { amount: amount.toString(), shown: shown(amount) }, description: route.description },
    asset: { ...asset, decimals },
    permit2,
    payTo: options.payTo,
    payer: { address: payer.address, key: options.payer ? "given" : "new" },
    facilitator: { address: options.facilitator?.address ?? null, settles: Boolean(options.facilitator) },
    cap: { amount: cap.toString(), shown: shown(cap) },
    required,
    payment,
    verify,
    settle,
    settlement,
    response: { status: final?.status ?? last?.status ?? 0, body: last?.body ?? null, paymentResponse },
    data,
    verdict,
    reason,
    headline,
    steps,
    toolCalls: chain.mcp.toolCalls,
  };
}
