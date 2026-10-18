// Task 20: checking x402 proofs offline. An x402 payment cannot be replayed whole: the client signs with a
// fresh random nonce, valid from the time it ran, and a run on Pharos Mainnet pays with a key made for it
// and never kept. So the proof's facts are checked instead, each against the recorded Chain MCP answers:
// the asset read again (the run's first calls, replayed through the same code); the 402's terms exactly
// what was asked; the authorization signed by the payer for exactly those terms, within the cap; the
// facilitator's verdict as the chain answered its simulation; and, when settled, the one transaction
// sent: transferWithAuthorization of exactly that authorization, signed by the facilitator, its receipt a
// success holding the Transfer. The data goes out only for a settled payment, and it is the chain's answer.
import { authorizationTypes, eip3009ABI } from "@x402/evm";
import { decodeEventLog, decodeFunctionData, encodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, serializeSignature, type Hex } from "viem";
import { parseAmount } from "../core/amounts.js";
import { Chain, type Address } from "../core/chain.js";
import { network } from "../core/networks.js";
import { commonChecks, firstDifference, recordedCalls, ReplayMcp, ReplayMismatch, type Check, type ProofFile, type RecordedCall } from "../core/proof.js";
import { readAsset } from "./pharos.js";
import type { X402Run } from "./run.js";

interface X402Input {
  payTo?: string;
  price?: string;
  cap?: string;
  asset?: string;
}

interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const BALANCE_OF = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
/** The 4-byte selectors of both transferWithAuthorization forms (v, r, s and bytes signature). */
const SETTLE_SELECTORS = ["0xe3ee160e", "0xcf092995"];
const callTo = (c: RecordedCall) => (c.args.transaction as { to?: string; data?: string } | undefined) ?? {};
/** A recorded number as decimal digits, or null where it is not one (a proof is checked, not trusted). */
const digits = (value: unknown): string | null => {
  try {
    return BigInt(String(value)).toString();
  } catch {
    return null;
  }
};

export async function verifyX402Proof(proof: ProofFile): Promise<Check[]> {
  const result = proof.result as X402Run;
  const net = network(proof.network.id);
  const checks = commonChecks(proof, { task: "20", capability: "x402-payment", network: net });
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let calls: RecordedCall[];
  try {
    calls = recordedCalls(proof.transcript);
  } catch {
    return checks; // already reported by "every request answered"
  }
  const input = proof.input as X402Input;

  // What was asked: the asset, the recipient, the price and the cap.
  const decimals = result.asset.decimals ?? 6;
  const wanted = input.asset ?? net.tokens.find((t) => t.symbol === "USDC")?.address;
  let price: bigint | null = null;
  let cap: bigint | null = null;
  try {
    price = parseAmount(String(input.price), decimals, "The price");
    cap = parseAmount(String(input.cap ?? input.price), decimals, "The cap");
  } catch {
    // reported below
  }
  const asked = same(wanted, result.asset.address) && same(input.payTo, result.payTo) && price !== null && String(price) === result.endpoint.price.amount && cap !== null && String(cap) === result.cap.amount;
  add("terms as asked", asked, asked ? `${result.endpoint.price.amount} base units of ${result.asset.address} to ${result.payTo}, the client's cap ${result.cap.amount}` : "the endpoint's asset, recipient, price or cap is not the one asked");

  // The asset, read again from the run's first calls.
  try {
    const replay = new ReplayMcp(calls, result.chainMcp.where, proof.chainMcp.server ?? undefined);
    const chain = new Chain(replay, net);
    await chain.expectChain();
    const head = await chain.block(await chain.blockNumber());
    const asset = await readAsset(chain, result.asset.address, head.number);
    const again = { ...asset, decimals: asset.decimals ?? result.asset.decimals };
    const ok = head.number.toString() === result.block.number && JSON.stringify(again) === JSON.stringify(result.asset);
    add("asset read again", ok, ok ? `${replay.toolCalls} calls replayed at block ${result.block.number}: ${asset.name ?? "no name()"}, ${asset.version ? `version ${asset.version}` : "no version()"}, ${asset.eip3009 ? "EIP-3009" : "not EIP-3009"}` : firstDifference(again, result.asset, "asset"));
  } catch (error) {
    add("asset read again", false, error instanceof ReplayMismatch ? error.message : `replay failed: ${(error as Error).message}`);
  }

  // The 402's terms: exactly the endpoint's.
  const accepted = result.required?.accepts?.[0];
  const domain = { name: (accepted?.extra?.name as string | null | undefined) ?? null, version: (accepted?.extra?.version as string | null | undefined) ?? null };
  const terms = Boolean(accepted) && accepted!.scheme === "exact" && accepted!.network === `eip155:${net.chainId}` && same(accepted!.asset, result.asset.address) && accepted!.amount === result.endpoint.price.amount && same(accepted!.payTo, result.payTo) && domain.name === result.asset.name && domain.version === result.asset.version;
  add("402 terms", terms, terms ? `exact on ${accepted!.network}: ${accepted!.amount} base units to ${accepted!.payTo}, EIP-712 domain ${domain.name ?? "none"} / ${domain.version ?? "none"}` : accepted ? "the 402's terms are not the endpoint's price, asset, recipient and domain" : "no 402 terms recorded");

  // The authorization the client signed.
  const payload = result.payment?.payload as { authorization?: Authorization; signature?: Hex } | undefined;
  const auth = payload?.authorization;
  if (result.payment && auth && payload?.signature) {
    const [value, after, before, capped] = [digits(auth.value), digits(auth.validAfter), digits(auth.validBefore), digits(result.cap.amount)];
    const signer = domain.name && domain.version && value !== null && after !== null && before !== null
      ? await recoverTypedDataAddress({ domain: { name: domain.name, version: domain.version, chainId: net.chainId, verifyingContract: result.asset.address }, types: authorizationTypes, primaryType: "TransferWithAuthorization", message: { from: auth.from, to: auth.to, value: BigInt(value), validAfter: BigInt(after), validBefore: BigInt(before), nonce: auth.nonce }, signature: payload.signature }).catch(() => null)
      : null;
    const ok = same(signer, auth.from) && same(auth.from, result.payer.address) && same(auth.to, result.payTo) && value === result.endpoint.price.amount && capped !== null && BigInt(value) <= BigInt(capped) && JSON.stringify(result.payment.accepted) === JSON.stringify(accepted);
    add("signed authorization", ok, ok ? `signed by ${auth.from} for exactly ${auth.value} base units to ${auth.to}, within the cap of ${result.cap.amount}` : "the signature does not recover to the payer, or the authorization is not for exactly the terms");
  } else {
    add("no payment signed", result.verdict === "not-paid" && !result.verify && !result.settle, `the client did not sign: ${result.reason ?? "no reason recorded"}`);
  }

  // The facilitator's verdict, as the chain answered its simulation.
  if (result.verify && auth) {
    const sim = calls.find((c) => c.name === "eth_call" && same(callTo(c).to, result.asset.address) && SETTLE_SELECTORS.some((s) => String(callTo(c).data).startsWith(s)));
    const simulatedExactly = sim ? decodedAuthorization(callTo(sim).data as Hex, auth, payload!.signature!) : false;
    if (result.verify.isValid) {
      const ok = Boolean(sim) && !sim!.isError && simulatedExactly;
      add("facilitator's check", ok, ok ? "transferWithAuthorization of exactly this authorization, simulated through Chain MCP (eth_call): it succeeds" : "no successful simulation of exactly this authorization is recorded");
    } else if (result.verify.invalidReason === "invalid_exact_evm_insufficient_balance") {
      const data = encodeFunctionData({ abi: BALANCE_OF, functionName: "balanceOf", args: [auth.from] });
      const read = calls.find((c) => c.name === "eth_call" && same(callTo(c).to, result.asset.address) && same(callTo(c).data, data) && !c.isError);
      const balance = read ? digits((read.payload as { result?: unknown }).result) : null;
      const value = digits(auth.value);
      const ok = Boolean(sim?.isError) && balance !== null && value !== null && BigInt(balance) < BigInt(value);
      add("facilitator's check", ok, ok ? `the simulation reverts, and the payer's recorded balance (${balance} base units) is under ${auth.value}: refused` : "the refusal for want of funds is not what the recorded answers show");
    } else {
      const ok = !sim || sim.isError;
      add("facilitator's check", ok, ok ? `refused: ${result.verify.invalidReason}` : "refused, though the recorded simulation succeeded");
    }
  }

  // The settlement: nothing sent unless settling; when settled, exactly the authorization.
  const sends = calls.filter((c) => c.name === "send_raw_transaction");
  if (!result.facilitator.settles) {
    add("nothing sent", sends.length === 0 && !result.settle?.success, sends.length ? `${sends.length} transactions sent by a facilitator that only verifies` : "a facilitator without a key: no transaction sent");
  } else if (result.settle?.success && auth) {
    const raw = sends.length === 1 ? (sends[0]!.args.rawTransaction as Hex) : null;
    let detail = sends.length === 1 ? "" : `${sends.length} transactions sent, not one`;
    let ok = false;
    if (raw) {
      const tx = parseTransaction(raw);
      const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
      const hash = keccak256(raw);
      const receipt = calls.filter((c) => c.name === "get_transaction_receipt" && same(c.args.hash, hash) && c.payload !== null && !c.isError).at(-1)?.payload as { status?: string; logs?: { address: string; topics: Hex[]; data: Hex }[] } | undefined;
      const transfer = receipt?.logs?.some((log) => {
        if (!same(log.address, result.asset.address)) return false;
        try {
          const { args } = decodeEventLog({ abi: TRANSFER, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
          return same(args.from, auth.from) && same(args.to, auth.to) && args.value === BigInt(auth.value);
        } catch {
          return false;
        }
      });
      const conditions = [
        [tx.chainId === net.chainId && same(tx.to, result.asset.address) && (tx.value ?? 0n) === 0n, "not a call to the asset on this chain"],
        [same(from, result.facilitator.address), `signed by ${from}, not the facilitator`],
        [decodedAuthorization(tx.data ?? "0x", auth, payload!.signature!), "not transferWithAuthorization of exactly the signed authorization"],
        [same((sends[0]!.payload as { txHash?: unknown }).txHash, hash) && same(result.settle.transaction, hash), "its hash is not the one settled"],
        [receipt?.status === "0x1" && transfer === true, "no successful receipt holding the Transfer"],
      ] as const;
      const failed = conditions.find(([pass]) => !pass);
      ok = !failed;
      detail = failed ? `the settlement is ${failed[1]}` : `${hash}: transferWithAuthorization of exactly the signed authorization, sent by the facilitator ${from}; its receipt a success, holding the Transfer of ${auth.value} base units to ${auth.to}`;
    }
    add("settlement", ok, detail);
  } else if (result.settle) {
    // A settlement can fail after it is sent (a reverted transaction): at most that one.
    add("not settled", result.verdict === "not-settled" && result.data === null && sends.length <= 1, `the facilitator did not settle: ${result.settle.errorReason ?? "no reason recorded"}`);
  } else {
    add("nothing sent", sends.length === 0, sends.length ? `${sends.length} transactions sent, though the payment never reached settling` : "refused before settling: no transaction sent");
  }

  // The data: released only for a settled payment, and the chain's answer.
  const paid = result.verdict === "paid";
  const verdict = paid ? result.settle?.success === true : result.verdict === "refused" ? result.verify?.isValid === false : result.verdict === "not-settled" ? result.settle?.success === false : !result.verify;
  const released = paid ? result.response.status === 200 && result.data !== null && same((result.response.paymentResponse as { transaction?: unknown } | null)?.transaction, result.settle?.transaction) : result.data === null && result.response.status !== 200;
  add("data only when paid", verdict && released, verdict && released ? (paid ? "released with PAYMENT-RESPONSE naming the settlement" : `withheld: ${result.verdict}`) : "the data or the verdict does not follow from the payment's outcome");
  if (paid) {
    const data = result.data as { block?: { number?: string }; gasPrice?: string } | null;
    const block = calls.some((c) => c.name === "get_block" && c.args.block === "latest" && !c.isError && same(digits((c.payload as { number?: unknown } | null)?.number), data?.block?.number));
    const gas = calls.some((c) => c.name === "get_gas_price" && !c.isError && String((c.payload as { gasPriceWei?: unknown }).gasPriceWei) === data?.gasPrice);
    add("data from Chain MCP", block && gas, block && gas ? `block ${data!.block!.number} and the gas price, each a recorded answer` : "the data released is not what Chain MCP answered");
  }
  return checks;
}

/** Whether `data` is transferWithAuthorization of exactly `auth`, carrying `signature` (in either form). */
function decodedAuthorization(data: Hex, auth: Authorization, signature: Hex): boolean {
  try {
    const { functionName, args } = decodeFunctionData({ abi: eip3009ABI, data });
    if (functionName !== "transferWithAuthorization") return false;
    const a = args as readonly unknown[];
    const fields = same(a[0], auth.from) && same(a[1], auth.to) && a[2] === BigInt(auth.value) && a[3] === BigInt(auth.validAfter) && a[4] === BigInt(auth.validBefore) && same(a[5], auth.nonce);
    const sig = a.length === 7 ? (a[6] as Hex) : serializeSignature({ v: BigInt(a[6] as number), r: a[7] as Hex, s: a[8] as Hex });
    return fields && same(sig, signature);
  } catch {
    return false;
  }
}
