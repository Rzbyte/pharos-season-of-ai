export const TOOL_NAME = "event-log-monitor";
export const VERSION = "1.0.0";

/** Official hosted Pharos Chain MCP server (Streamable HTTP transport). */
export const HOSTED_ENDPOINT = "https://mcp.pharos.xyz/mcp";

export const EXPECTED_CHAIN_ID = 1672;
export const CHAIN_NAME = "Pharos Mainnet";

/**
 * The one contract this monitor watches: Circle USDC on Pharos Mainnet (chain ID 1672), the same
 * address Task 01 reads. Sources: developers.circle.com/stablecoins/usdc-contract-addresses and
 * docs.chain.link/ccip/directory/mainnet/chain/pharos-mainnet. 6 decimals, read live in Task 01.
 */
export const WATCHED_TOKEN = {
  label: "Circle USDC",
  address: "0xC879C018dB60520F4355C26eD1a6D572cdAC1815",
  symbol: "USDC",
  decimals: 6,
} as const;

/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value). */
export const TRANSFER_EVENT = "Transfer(address,address,uint256)";
/** keccak256 of TRANSFER_EVENT: topic0 of every ERC-20 Transfer log. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** get_logs accepts at most 1,000 blocks per call, inclusive (the upstream RPC limit, enforced by pharos-mcp). */
export const MAX_BLOCK_RANGE = 1_000n;
/** At most this many get_logs ranges per poll, so a long outage is caught up over several polls. */
export const MAX_RANGES_PER_POLL = 10;

export const DEFAULT_INTERVAL_SECONDS = 5;
/** Finite mode without --from-block/--to-block: the last N blocks up to the head. One get_logs call. */
export const DEFAULT_FINITE_BLOCKS = 1_000n;
/** Largest finite scan or watch lookback, so one command cannot turn into thousands of get_logs calls. */
export const MAX_SCAN_BLOCKS = 100_000n;

export const DEFAULT_TIMEOUT_MS = 20_000;
/** Wait before repeating a get_logs range whose call failed for a transient reason. */
export const RETRY_DELAY_MS = 1_000;

/** Dedup memory: keys of the most recently reported events (insertion order, oldest evicted first). */
export const SEEN_CAPACITY = 50_000;

/** The only MCP tools this monitor calls. */
export const TOOLS = ["get_chain_info", "get_block_number", "get_logs"] as const;
