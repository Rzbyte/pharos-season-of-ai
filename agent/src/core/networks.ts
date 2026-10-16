// The Pharos networks the agent can work on, from official sources only:
//   - RPC URLs, chain IDs, native symbols, explorers and token addresses: the Pharos Skill Engine,
//     assets/networks.json and assets/tokens.json (github.com/PharosNetwork/pharos-skill-engine, a873387).
//   - The hosted Chain MCP endpoint: github.com/PharosNetwork/pharos-mcp (README); it serves mainnet and is
//     read-only (send_raw_transaction is disabled there).
// Atlantic has no hosted Chain MCP: the agent runs the official server itself (vendor/pharos-mcp) over
// stdio, pointed at the Atlantic RPC, which is also how it can broadcast a transaction it signed locally.

export type NetworkId = "pharos-mainnet" | "atlantic-testnet";

export interface Token {
  symbol: string;
  name: string;
  decimals: number;
  address: `0x${string}`;
}

export interface Network {
  id: NetworkId;
  name: string;
  chainId: number;
  rpcUrl: string;
  nativeSymbol: string;
  explorerUrl: string;
  /** The hosted Pharos Chain MCP endpoint for this network, or null where there is none. */
  hostedChainMcp: string | null;
  tokens: readonly Token[];
}

export const HOSTED_CHAIN_MCP = "https://mcp.pharos.xyz/mcp";

export const NETWORKS: Readonly<Record<NetworkId, Network>> = Object.freeze({
  "pharos-mainnet": Object.freeze({
    id: "pharos-mainnet",
    name: "Pharos Mainnet",
    chainId: 1672,
    rpcUrl: "https://rpc.pharos.xyz",
    nativeSymbol: "PROS",
    explorerUrl: "https://www.pharosscan.xyz/",
    hostedChainMcp: HOSTED_CHAIN_MCP,
    tokens: Object.freeze([
      { symbol: "WPROS", name: "Wrapped PROS", decimals: 18, address: "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0" },
      { symbol: "USDC", name: "USDC", decimals: 6, address: "0xc879c018db60520f4355c26ed1a6d572cdac1815" },
      { symbol: "LINK", name: "Chainlink Token", decimals: 18, address: "0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29" },
      { symbol: "WETH", name: "Wrapped ETH", decimals: 18, address: "0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9" },
    ] as Token[]),
  }),
  "atlantic-testnet": Object.freeze({
    id: "atlantic-testnet",
    name: "Atlantic Testnet",
    chainId: 688689,
    rpcUrl: "https://atlantic.dplabs-internal.com",
    nativeSymbol: "PHRS",
    explorerUrl: "https://atlantic.pharosscan.xyz/",
    hostedChainMcp: null,
    tokens: Object.freeze([
      { symbol: "USDC", name: "USD Coin", decimals: 6, address: "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8" },
      { symbol: "USDT", name: "Tether USD", decimals: 6, address: "0xE7E84B8B4f39C507499c40B4ac199B050e2882d5" },
      { symbol: "WBTC", name: "Wrapped BTC", decimals: 18, address: "0x0c64F03EEa5c30946D5c55B4b532D08ad74638a4" },
      { symbol: "WETH", name: "Wrapped ETH", decimals: 18, address: "0x7d211F77525ea39A0592794f793cC1036eEaccD5" },
      { symbol: "WPHRS", name: "Wrapped PHRS", decimals: 18, address: "0x838800b758277CC111B2d48Ab01e5E164f8E9471" },
    ] as Token[]),
  }),
});

export function network(id: string): Network {
  if (id in NETWORKS) return NETWORKS[id as NetworkId];
  throw new Error(`Unknown network "${id}". Use pharos-mainnet or atlantic-testnet.`);
}

/** The official token at `address` on `net`, if it is one (case-insensitive). */
export function knownToken(net: Network, address: string): Token | undefined {
  const lower = address.toLowerCase();
  return net.tokens.find((token) => token.address.toLowerCase() === lower);
}
