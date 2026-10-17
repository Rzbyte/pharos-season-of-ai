// Task 23: the watchlist that ships with the agent, on Pharos Mainnet's Circle USDC. Its addresses are
// the four that moved the most USDC in Task 02's live proof (19 Transfer events over about 110 blocks,
// tasks/02-event-log-monitor/proof/): picked from real activity, not known to be anyone in particular.
// In that sample the largest transfer was 600 USDC and most were under 100, so 250 USDC is the
// default for a significant transfer. 100 PROS for a balance change is a round number, not measured.
import { EXAMPLE_PAYER, USDC_MAINNET } from "../guardian/presets.js";

export interface UsdcWhaleParams {
  addresses: readonly { address: string; label: string }[];
  /** A USDC transfer of at least this much is significant. */
  min: string;
  /** A change of the PROS balance between runs of at least this much is significant. */
  native: string;
}

export const SAMPLE_ADDRESSES = Object.freeze([
  Object.freeze({ address: EXAMPLE_PAYER, label: "Busiest in the sample" }),
  Object.freeze({ address: "0x936564245B69f5a293b42cbd752E0eE3bb68b470", label: "Sent the most" }),
  Object.freeze({ address: "0x1F3546a29EeC2102c8d52E21a45114124014c85C", label: "Trades with the busiest" }),
  Object.freeze({ address: "0x0018b46177c611fc1EfBca63c845c2a69045E28D", label: "Sent the largest transfer" }),
]);

export const USDC_WHALE_DEFAULTS: Readonly<UsdcWhaleParams> = Object.freeze({ addresses: SAMPLE_ADDRESSES, min: "250", native: "100" });

export function usdcWhales(params: UsdcWhaleParams = USDC_WHALE_DEFAULTS): Record<string, unknown> {
  return {
    name: "USDC whales",
    network: "pharos-mainnet",
    lookback: 1000,
    maxScan: 2000,
    addresses: params.addresses.map((a) => ({ address: a.address, label: a.label })),
    tokens: [{ token: USDC_MAINNET, min: params.min }],
    native: { min: params.native },
  };
}

export const WHALE_PRESETS: Readonly<Record<string, () => Record<string, unknown>>> = Object.freeze({ usdc: () => usdcWhales() });
