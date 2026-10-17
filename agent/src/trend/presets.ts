// Task 09: the watcher that ships with the agent. "usdc-outflow" watches the USDC held by the same
// example address as Tasks 05, 08 and 11 (a public address seen moving USDC in Task 02's live proof; it
// trades every few blocks, so its balance moves). When the balance has fallen across three observations
// at least 10 blocks apart, it prepares a 100 USDC top-up from the example recipient and simulates it:
// on mainnet nothing is ever sent.
import { EXAMPLE_PAYER, EXAMPLE_RECIPIENT, USDC_MAINNET } from "../guardian/presets.js";

export interface OutflowParams {
  holder: string;
  trend: "falling" | "rising";
  observations: number;
  everyBlocks: number;
}

export const OUTFLOW_DEFAULTS: Readonly<OutflowParams> = Object.freeze({ holder: EXAMPLE_PAYER, trend: "falling", observations: 3, everyBlocks: 10 });

/** The mainnet USDC watcher: one holder's balance, a falling (or rising) trend, a top-up prepared when it holds. */
export function outflowWatcher(params: OutflowParams = OUTFLOW_DEFAULTS): Record<string, unknown> {
  return {
    name: `USDC ${params.trend === "falling" ? "outflow" : "inflow"} watcher`,
    network: "pharos-mainnet",
    observe: { kind: "erc20-balance", token: USDC_MAINNET, holder: params.holder },
    everyBlocks: params.everyBlocks,
    keep: 50,
    trend: { kind: params.trend, observations: params.observations },
    action: { kind: "erc20-transfer", token: USDC_MAINNET, from: EXAMPLE_RECIPIENT, to: params.holder, amount: "100" },
  };
}

export const WATCHER_PRESETS: Readonly<Record<string, () => Record<string, unknown>>> = Object.freeze({ "usdc-outflow": () => outflowWatcher() });
