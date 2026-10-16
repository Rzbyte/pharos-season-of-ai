// Task 05: the guardians that ship with the agent. "payout" runs on Pharos Mainnet through the hosted
// Chain MCP; its payer and recipient are public addresses seen moving USDC in Task 02's live proof, used
// here only as examples (nothing is signed on mainnet). "atlantic-payout" pays from the runner's own
// wallet ($SIGNER) on the Atlantic testnet, where the agent can execute.

export const USDC_MAINNET = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
export const USDC_ATLANTIC = "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8";
export const EXAMPLE_PAYER = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
export const EXAMPLE_RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";

export interface PayoutParams {
  payer: string;
  recipient: string;
  /** USDC, in token units. */
  amount: string;
  /** The highest gas price to fire at, in gwei. */
  maxGasGwei: string;
}

export const PAYOUT_DEFAULTS: Readonly<PayoutParams> = Object.freeze({ payer: EXAMPLE_PAYER, recipient: EXAMPLE_RECIPIENT, amount: "25", maxGasGwei: "10" });

/** The mainnet payout guardian: six conditions of five kinds, all of which must hold, then one USDC transfer. */
export function payoutGuardian(params: PayoutParams = PAYOUT_DEFAULTS): Record<string, unknown> {
  const { payer, recipient, amount, maxGasGwei } = params;
  return {
    name: "USDC payout guardian",
    network: "pharos-mainnet",
    fireWhen: "all",
    conditions: [
      { id: "usdc-live", label: "USDC is not paused", read: { kind: "call", to: USDC_MAINNET, signature: "paused() returns (bool)" }, op: "==", value: false },
      { id: "payer-funded", label: "The payer holds at least the payout", read: { kind: "erc20-balance", token: USDC_MAINNET, holder: payer }, op: ">=", value: amount },
      { id: "payer-gas", label: "The payer holds PROS for gas", read: { kind: "native-balance", address: payer }, op: ">=", value: "0.001" },
      { id: "recipient-wallet", label: "The recipient is a wallet, not a contract", read: { kind: "has-code", address: recipient }, op: "==", value: false },
      { id: "gas-cap", label: `Gas costs at most ${maxGasGwei} gwei`, read: { kind: "gas-price" }, op: "<=", value: `${maxGasGwei} gwei` },
      { id: "chain-fresh", label: "The latest block is at most 60 s old", read: { kind: "block-age" }, op: "<=", value: 60 },
    ],
    action: { type: "erc20-transfer", token: USDC_MAINNET, from: payer, to: recipient, amount },
  };
}

/** The Atlantic payout guardian: the runner's wallet pays itself 1 USDC once it is funded and gas is sane. */
export function atlanticPayoutGuardian(): Record<string, unknown> {
  return {
    name: "Atlantic USDC payout guardian",
    network: "atlantic-testnet",
    fireWhen: "all",
    conditions: [
      { id: "payer-funded", label: "The payer holds at least the payout", read: { kind: "erc20-balance", token: USDC_ATLANTIC, holder: "$SIGNER" }, op: ">=", value: "1" },
      { id: "payer-gas", label: "The payer holds PHRS for gas", read: { kind: "native-balance", address: "$SIGNER" }, op: ">=", value: "0.001" },
      { id: "gas-cap", label: "Gas costs at most 50 gwei", read: { kind: "gas-price" }, op: "<=", value: "50 gwei" },
      { id: "chain-fresh", label: "The latest block is at most 60 s old", read: { kind: "block-age" }, op: "<=", value: 60 },
    ],
    action: { type: "erc20-transfer", token: USDC_ATLANTIC, from: "$SIGNER", to: "$SIGNER", amount: "1" },
  };
}

export const GUARDIAN_PRESETS: Readonly<Record<string, () => Record<string, unknown>>> = Object.freeze({
  payout: () => payoutGuardian(),
  "atlantic-payout": atlanticPayoutGuardian,
});
