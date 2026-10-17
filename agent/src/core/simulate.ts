// Simulating a transaction before sending it, through Chain MCP: eth_call at a pinned block for what it
// would do, estimate_gas and the fee market for what it would cost. The fee formula is the one the agent
// signs with (execute.ts): a 20 % gas margin, a fee cap of twice the base fee plus the priority fee.
import { revertReason } from "./abi.js";
import { CallReverted, type Chain, type Hex, type TxRequest } from "./chain.js";
import { ToolCallError } from "./errors.js";

export interface Simulation {
  block: string;
  ok: boolean;
  returned: Hex | null;
  /** Why it reverts: Error(string), Panic(code), a custom error's selector, or the node's message. */
  reason: string | null;
}

export interface GasQuote {
  /** estimate_gas, against the latest state (the tool takes no block). */
  gas: string;
  /** What would be signed: the estimate plus 20 %. */
  gasLimit: string;
  baseFee: string | null;
  priorityFee: string;
  gasPrice: string;
  /** What a block is expected to charge per gas: base fee + priority fee (the gas price without a base fee). */
  expectedFeePerGas: string;
  /** The cap that would be signed: twice the base fee plus the priority fee (twice the gas price without one). */
  maxFeePerGas: string;
  /** gas × expected fee per gas. */
  expectedCost: string;
  /** gasLimit × max fee per gas: what the sender must hold for gas, at most. */
  maxCost: string;
}

/** eth_call at `block`. A revert is a result, not an error. */
export async function simulate(chain: Chain, tx: TxRequest, block: bigint): Promise<Simulation> {
  try {
    const returned = await chain.call(tx, block);
    return { block: block.toString(), ok: true, returned, reason: null };
  } catch (error) {
    if (error instanceof CallReverted) return { block: block.toString(), ok: false, returned: error.data, reason: revertReason(error.data, error.reason) };
    if (error instanceof ToolCallError) return { block: block.toString(), ok: false, returned: null, reason: error.detail };
    throw error;
  }
}

/** The gas a transaction needs and what it would cost; a revert during estimation is returned as its reason. */
export async function quoteGas(chain: Chain, tx: TxRequest): Promise<{ quote: GasQuote; reason: null } | { quote: null; reason: string }> {
  let gas: bigint;
  try {
    gas = await chain.estimateGas(tx);
  } catch (error) {
    if (error instanceof CallReverted) return { quote: null, reason: revertReason(error.data, error.reason) };
    if (error instanceof ToolCallError) return { quote: null, reason: error.detail };
    throw error;
  }
  const latest = await chain.block("latest");
  const { gasPrice, priorityFee } = await chain.gasPrice();
  const baseFee = latest.baseFeePerGas;
  const expectedFeePerGas = baseFee !== null ? baseFee + priorityFee : gasPrice;
  const maxFeePerGas = baseFee !== null ? baseFee * 2n + priorityFee : gasPrice * 2n;
  const gasLimit = (gas * 12n) / 10n;
  return {
    reason: null,
    quote: {
      gas: gas.toString(),
      gasLimit: gasLimit.toString(),
      baseFee: baseFee?.toString() ?? null,
      priorityFee: priorityFee.toString(),
      gasPrice: gasPrice.toString(),
      expectedFeePerGas: expectedFeePerGas.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      expectedCost: (gas * expectedFeePerGas).toString(),
      maxCost: (gasLimit * maxFeePerGas).toString(),
    },
  };
}
