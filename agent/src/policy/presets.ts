// Task 11: the policies that ship with the agent. "treasury" runs on Pharos Mainnet through the hosted
// Chain MCP, for the same example sender as Tasks 05 and 08: a public address seen moving USDC in Task
// 02's live proof (nothing is signed on mainnet). It moves USDC often, so the window limit is sized to
// that. Its allowlist holds the example recipient and the two addresses it was seen trading with.
// "atlantic-treasury" checks a payment from the runner's own wallet ($SIGNER) on the Atlantic testnet,
// where the agent can execute; its hours are the whole day, so an execution run is never held by the clock.
import { EXAMPLE_PAYER, EXAMPLE_RECIPIENT, USDC_ATLANTIC, USDC_MAINNET } from "../guardian/presets.js";
import { DAYS } from "./config.js";

export const TREASURY_ALLOWLIST = Object.freeze([EXAMPLE_RECIPIENT, "0x1F3546a29EeC2102c8d52E21a45114124014c85C", "0x936564245B69f5a293b42cbd752E0eE3bb68b470"]);

export interface TreasuryHours {
  /** "HH:MM", UTC. */
  from: string;
  to: string;
}

export const TREASURY_HOURS: Readonly<TreasuryHours> = Object.freeze({ from: "06:00", to: "22:00" });

/** The mainnet treasury policy: USDC only, to three addresses, 100 per action, 5,000 per 1,000 blocks, 06:00 to 22:00 UTC, gas at most 10 gwei, and a dry run that succeeds. */
export function treasuryPolicy(hours: TreasuryHours = TREASURY_HOURS): Record<string, unknown> {
  return {
    name: "Treasury payouts",
    network: "pharos-mainnet",
    rules: [
      { id: "assets", kind: "asset-allowlist", assets: ["USDC"] },
      { id: "counterparties", kind: "counterparty-allowlist", addresses: [...TREASURY_ALLOWLIST] },
      { id: "per-action", kind: "max-per-action", asset: "USDC", amount: "100" },
      { id: "rolling", kind: "max-in-window", asset: "USDC", amount: "5000", blocks: 1000 },
      { id: "hours", kind: "time-window", days: [...DAYS], from: hours.from, to: hours.to, utcOffset: "+00:00" },
      { id: "gas", kind: "max-gas-price", gwei: "10" },
      { id: "simulates", kind: "simulates" },
    ],
  };
}

/** The Atlantic treasury policy, for the runner's own wallet: the same rules, smaller amounts, the whole day. */
export function atlanticTreasuryPolicy(): Record<string, unknown> {
  return {
    name: "Atlantic treasury payouts",
    network: "atlantic-testnet",
    rules: [
      { id: "assets", kind: "asset-allowlist", assets: ["USDC"] },
      { id: "counterparties", kind: "counterparty-allowlist", addresses: [EXAMPLE_RECIPIENT] },
      { id: "per-action", kind: "max-per-action", asset: "USDC", amount: "2" },
      { id: "rolling", kind: "max-in-window", asset: "USDC", amount: "10", blocks: 1000 },
      { id: "hours", kind: "time-window", days: [...DAYS], from: "00:00", to: "24:00", utcOffset: "+00:00" },
      { id: "gas", kind: "max-gas-price", gwei: "50" },
      { id: "simulates", kind: "simulates" },
    ],
  };
}

/** Each preset's policy and the request it checks by default: 25 USDC (1 on Atlantic) to the example recipient. */
export const POLICY_PRESETS: Readonly<Record<string, { policy: () => Record<string, unknown>; request: Record<string, string> }>> = Object.freeze({
  treasury: { policy: () => treasuryPolicy(), request: { kind: "erc20-transfer", token: USDC_MAINNET, from: EXAMPLE_PAYER, to: EXAMPLE_RECIPIENT, amount: "25" } },
  "atlantic-treasury": { policy: atlanticTreasuryPolicy, request: { kind: "erc20-transfer", token: USDC_ATLANTIC, from: "$SIGNER", to: EXAMPLE_RECIPIENT, amount: "1" } },
});
