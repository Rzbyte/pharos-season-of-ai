// Task 24: the gas plans that ship with the agent. "usdc" times the Task 08 example, a 25 USDC transfer
// on Pharos Mainnet, against the cheapest quarter of the last 12 base fees; it only advises (nothing is
// signed on mainnet). "atlantic-usdc" times a 1 USDC transfer from the runner's own wallet ($SIGNER) on
// the Atlantic testnet, where --execute sends it once the fee is right, or after 240 blocks of waiting.
import { EXAMPLE_PAYER, EXAMPLE_RECIPIENT, USDC_ATLANTIC, USDC_MAINNET } from "../guardian/presets.js";

export interface UsdcGasParams {
  from: string;
  to: string;
  amount: string;
  /** Send when the base fee is at or below this percentile of the observed ones. */
  percentile: number;
}

export const USDC_GAS_DEFAULTS: Readonly<UsdcGasParams> = Object.freeze({ from: EXAMPLE_PAYER, to: EXAMPLE_RECIPIENT, amount: "25", percentile: 25 });

export function usdcGasPlan(params: UsdcGasParams = USDC_GAS_DEFAULTS): Record<string, unknown> {
  return {
    name: "USDC transfer, timed",
    network: "pharos-mainnet",
    transaction: { kind: "erc20-transfer", token: USDC_MAINNET, from: params.from, to: params.to, amount: params.amount },
    target: { percentile: params.percentile },
    window: 12,
    backfill: { samples: 5, spacing: 200 },
    deadline: 2880,
  };
}

export function atlanticGasPlan(): Record<string, unknown> {
  return {
    name: "Atlantic USDC transfer, timed",
    network: "atlantic-testnet",
    transaction: { kind: "erc20-transfer", token: USDC_ATLANTIC, from: "$SIGNER", to: EXAMPLE_RECIPIENT, amount: "1" },
    target: { percentile: 50 },
    window: 12,
    backfill: { samples: 5, spacing: 200 },
    deadline: 240,
  };
}

export const GAS_PRESETS: Readonly<Record<string, () => Record<string, unknown>>> = Object.freeze({ usdc: () => usdcGasPlan(), "atlantic-usdc": atlanticGasPlan });
