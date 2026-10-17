// Task 22: the alert bot that ships with the agent, on Pharos Mainnet's Circle USDC. Its rules:
//   - a USDC transfer of 500 or more (the example holder of Tasks 05 to 11 trades 40 to 80 at a time;
//     larger transfers come by every few minutes in Task 02's live proof);
//   - the example holder's USDC below 100;
//   - USDC paused, which would stop every transfer;
//   - gas above 5 gwei.
// A first run looks back 1,000 blocks (one get_logs page, about 20 minutes on Pharos Mainnet).
import { EXAMPLE_PAYER, USDC_MAINNET } from "../guardian/presets.js";

export interface UsdcAlertParams {
  /** Alert on a USDC transfer of at least this much. */
  min: string;
  holder: string;
  /** Alert when the holder's USDC is below this. */
  low: string;
}

export const USDC_ALERT_DEFAULTS: Readonly<UsdcAlertParams> = Object.freeze({ min: "500", holder: EXAMPLE_PAYER, low: "100" });

export function usdcAlerts(params: UsdcAlertParams = USDC_ALERT_DEFAULTS): Record<string, unknown> {
  const short = `${params.holder.slice(0, 6)}…${params.holder.slice(-4)}`;
  return {
    name: "USDC alerts",
    network: "pharos-mainnet",
    lookback: 1000,
    maxScan: 2000,
    rules: [
      { kind: "transfer", id: "large-transfer", token: USDC_MAINNET, min: params.min },
      { kind: "state", id: "holder-low", label: `${short} holds less than ${params.low} USDC`, read: { kind: "erc20-balance", token: USDC_MAINNET, holder: params.holder }, op: "<", value: params.low },
      { kind: "state", id: "usdc-paused", label: "USDC is paused", read: { kind: "call", to: USDC_MAINNET, signature: "paused() returns (bool)" }, op: "==", value: true },
      { kind: "state", id: "gas-high", label: "Gas costs more than 5 gwei", read: { kind: "gas-price" }, op: ">", value: "5 gwei" },
    ],
  };
}

export const ALERT_PRESETS: Readonly<Record<string, () => Record<string, unknown>>> = Object.freeze({ usdc: () => usdcAlerts() });
