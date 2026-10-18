// Task 20: the facilitator's hands on the chain. x402's EVM facilitator (the official @x402/evm scheme)
// asks its signer to read contracts, check a signature, send a transaction and wait for its receipt.
// Here each goes through Pharos Chain MCP (eth_call, get_code, send_raw_transaction,
// get_transaction_receipt), so every read and the one send are on the record, as in every other task.
// The facilitator's failure diagnosis batches reads through Multicall3; whether Pharos has it deployed is
// not something this code assumes, so a tryAggregate is answered by making each call through Chain MCP.
// x402 takes any failed read for a failed check (its simulation is in a catch-all), so every failure that
// is not the chain's own revert is also told to the caller, who must not report it as a refusal.
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, verifyTypedData, type Abi } from "viem";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { CallReverted, type Address, type Chain, type Hex, type Receipt } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import { signAndSend, type Signer } from "../core/execute.js";

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

export interface FacilitatorSignerOptions {
  /** Receipt polling: a fixed number of polls, so a replay asks the same questions. */
  wait?: { polls?: number; pollMs?: number };
  /** Told of each receipt the facilitator waited for. */
  onReceipt?: (receipt: Receipt) => void;
  /**
   * Told of each failure that is not the chain's answer (Chain MCP unreachable or out of its budget, a
   * tool error, no receipt in time), with the hash of a settlement signed before it, if any.
   */
  onFault?: (error: unknown, signed: Hex | null) => void;
}

/** A FacilitatorEvmSigner whose every chain read and write is a Pharos Chain MCP call. `signer` is null for a facilitator that only verifies, which has no address. */
export function chainFacilitatorSigner(chain: Chain, signer: Signer | null, options: FacilitatorSignerOptions = {}): FacilitatorEvmSigner {
  let signed: Hex | null = null;
  const watched = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof CallReverted)) options.onFault?.(error, signed);
      throw error;
    }
  };
  const call = (to: Address, data: Hex): Promise<Hex> => watched(() => chain.call({ to, data }, "latest"));
  const send = async (to: Address, data: Hex): Promise<Hex> => {
    if (!signer) throw new AgentError("execution", "This facilitator only verifies: it holds no key to settle with.");
    // The hash is known once signed, before the broadcast, so a failure after it can name the settlement.
    const noting: Signer = { address: signer.address, sign: async (tx) => {
      const raw = await signer.sign(tx);
      signed = keccak256(raw);
      return raw;
    } };
    return watched(async () => {
      const gasEstimate = await chain.estimateGas({ from: signer.address, to, data });
      return (await signAndSend(chain, noting, { to, data, value: 0n, gasEstimate }, { polls: options.wait?.polls ?? 45, pollMs: options.wait?.pollMs ?? 2_000 })).hash;
    });
  };
  return {
    getAddresses: () => (signer ? [signer.address] : []),
    async readContract({ address: to, abi, functionName, args }) {
      if (to.toLowerCase() === MULTICALL3 && functionName === "tryAggregate") {
        const [, calls] = args as [boolean, { target: Address; callData: Hex }[]];
        const results: { success: boolean; returnData: Hex }[] = [];
        for (const c of calls) {
          try {
            results.push({ success: true, returnData: await call(getAddress(c.target), c.callData) });
          } catch (error) {
            if (!(error instanceof CallReverted)) throw error;
            results.push({ success: false, returnData: error.data ?? "0x" });
          }
        }
        return results;
      }
      const data = await call(to, encodeFunctionData({ abi: abi as Abi, functionName, args } as never));
      return decodeFunctionResult({ abi: abi as Abi, functionName, data } as never);
    },
    // An externally owned account's signature, recovered here; a contract wallet's (ERC-1271) is not read.
    verifyTypedData: (args) => verifyTypedData(args as never),
    async writeContract({ address: to, abi, functionName, args, dataSuffix }) {
      const data = encodeFunctionData({ abi: abi as Abi, functionName, args } as never);
      return send(to, dataSuffix ? (`${data}${dataSuffix.slice(2)}` as Hex) : data);
    },
    sendTransaction: ({ to, data }) => send(to, data),
    waitForTransactionReceipt: ({ hash }) =>
      watched(async () => {
        for (let poll = 0; poll < (options.wait?.polls ?? 45); poll += 1) {
          const receipt = await chain.receipt(hash);
          if (receipt) {
            options.onReceipt?.(receipt);
            return { status: receipt.status, logs: receipt.logs as never };
          }
          await new Promise((resolve) => setTimeout(resolve, options.wait?.pollMs ?? 2_000));
        }
        throw new AgentError("execution", `No receipt for ${hash} yet: it may still be pending.`);
      }),
    getCode: ({ address: at }) => watched(() => chain.code(at, "latest")),
  };
}
