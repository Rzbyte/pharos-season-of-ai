export const TOOL_NAME = "read-contract-state";
export const VERSION = "1.0.2";

/** Official hosted Pharos Chain MCP server (Streamable HTTP transport). */
export const HOSTED_ENDPOINT = "https://mcp.pharos.xyz/mcp";

/**
 * USDC on Pharos Mainnet (chain ID 1672). Listed in Circle's official USDC
 * contract address docs and in Chainlink's CCIP directory for pharos-mainnet.
 * It has 6 decimals, so the decimals conversion is visible in the output.
 */
export const DEFAULT_TOKEN = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";

/**
 * Human labels for addresses we have verified from official sources, keyed by lowercase address.
 * A label is only applied when the endpoint reports the same chain and symbol() matches, so the
 * CLI never puts a wrong name on a contract. Every other address is labelled from its on-chain name.
 * `pausable` marks a contract whose paused() was checked live through Chain MCP: for it, paused()
 * is a fifth required read. Any other address keeps the four ERC-20 reads.
 */
export const KNOWN_CONTRACTS: Readonly<Record<string, { label: string; chainId: number; symbol: string; pausable?: boolean }>> = {
  // Sources: developers.circle.com/stablecoins/usdc-contract-addresses and
  // docs.chain.link/ccip/directory/mainnet/chain/pharos-mainnet. paused() (Circle's FiatToken)
  // answered false through the hosted Chain MCP at block 20200229.
  "0xc879c018db60520f4355c26ed1a6d572cdac1815": { label: "Circle USDC Contract", chainId: 1672, symbol: "USDC", pausable: true },
};

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Wait before re-reading a value whose read failed for a transient reason (e.g. a lagging RPC node). */
export const RETRY_DELAY_MS = 1_000;

export const CHAIN_NAMES: Readonly<Record<number, string>> = {
  1672: "Pharos Mainnet",
};
