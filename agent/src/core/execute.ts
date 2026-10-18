// Signing and broadcasting, kept apart from everything else. The key is read from the environment here,
// used only to sign, and never logged, stored, sent or put in a result: only the signed transaction leaves
// this module, through Chain MCP send_raw_transaction (the official server, run locally with broadcasting
// on; the hosted endpoint is read-only), or, for x402 (Task 20), the account that signs an authorization,
// which never gives out its key. Execution is limited to the Atlantic testnet.
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Chain, Hex, Receipt } from "./chain.js";
import { AgentError } from "./errors.js";

export interface Signer {
  address: Address;
  sign(tx: { chainId: number; nonce: number; to: Address; data?: Hex; value?: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex>;
}

/**
 * The account of a key in the environment (PRIVATE_KEY unless named), for what signs more than a
 * transaction (x402's EIP-712 authorization). The key itself stays inside the account.
 */
export function accountFromEnv(env: NodeJS.ProcessEnv = process.env, name = "PRIVATE_KEY"): PrivateKeyAccount {
  const key = env[name]?.trim();
  if (!key) throw new AgentError("usage", `Executing needs ${name} in the environment (a funded Atlantic testnet key).`, `export ${name}=0x... (never commit it)`);
  const hex = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new AgentError("usage", `${name} must be 32 bytes of hex.`);
  return privateKeyToAccount(hex as Hex);
}

/** A signer from PRIVATE_KEY (0x + 64 hex), or the key named. The account object never leaves this closure. */
export function signerFromEnv(env: NodeJS.ProcessEnv = process.env, name = "PRIVATE_KEY"): Signer {
  const account: PrivateKeyAccount = accountFromEnv(env, name);
  return {
    address: account.address,
    sign: (tx) => account.signTransaction({ type: "eip1559", chainId: tx.chainId, nonce: tx.nonce, to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }),
  };
}

export interface Sent {
  hash: Hex;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  receipt: Receipt | null;
}

/** Fee settings chosen by the caller (Task 24 caps the fee at its target) instead of the standard ones. */
export interface FeeSettings {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Sign `tx` with a nonce and fees read through Chain MCP, broadcast it with send_raw_transaction, and
 * poll for its receipt (45 polls, 2 s apart, by default). The gas limit is the estimate plus 20 %; the
 * fee cap is twice the latest base fee plus the priority fee (twice the gas price without a base fee),
 * unless `fees` are given.
 */
export async function signAndSend(chain: Chain, signer: Signer, tx: { to: Address; data?: Hex; value?: bigint; gasEstimate: bigint }, options: { polls?: number; pollMs?: number; fees?: FeeSettings } = {}): Promise<Sent> {
  if (chain.network.id !== "atlantic-testnet") throw new AgentError("execution", "Executing is limited to the Atlantic testnet.");
  const nonce = Number(await chain.nonce(signer.address, "pending"));
  let fees = options.fees;
  if (!fees) {
    const latest = await chain.block("latest");
    const { gasPrice, priorityFee } = await chain.gasPrice();
    fees = { maxPriorityFeePerGas: priorityFee, maxFeePerGas: latest.baseFeePerGas !== null ? latest.baseFeePerGas * 2n + priorityFee : gasPrice * 2n };
  }
  const { maxFeePerGas, maxPriorityFeePerGas } = fees;
  const gasLimit = (tx.gasEstimate * 12n) / 10n;
  const raw = await signer.sign({ chainId: chain.network.chainId, nonce, to: tx.to, data: tx.data, value: tx.value, gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas });
  const hash = await chain.sendRaw(raw);
  // A fixed number of polls rather than a deadline, so a replay of this run asks the same questions.
  let receipt: Receipt | null = null;
  for (let poll = 0; !receipt && poll < (options.polls ?? 45); poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000));
    receipt = await chain.receipt(hash);
  }
  return { hash, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, receipt };
}
