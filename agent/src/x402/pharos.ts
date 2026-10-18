// Task 20: x402 on Pharos, as the official skill sets it out (PharosNetwork/examples, skills/x402-pharos at
// f08e921): the networks eip155:1672 (Pacific Mainnet) and eip155:688689 (Atlantic), the "exact" scheme,
// USDC as the asset. The skill leaves the token's address and the facilitator to the builder. Here the
// token is the Skill Engine's official USDC by default, and the EIP-712 name and version a payment signs
// are read from the token itself, through Chain MCP, never assumed.
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { CallReverted, type Address, type BlockRef, type Chain } from "../core/chain.js";
import type { Network } from "../core/networks.js";

export const X402_SKILL = { repo: "https://github.com/PharosNetwork/examples/tree/f08e921b7643f3ecfa5f388b8508778daa93b97a/skills/x402-pharos", commit: "f08e921" } as const;

export type X402Network = `eip155:${number}`;
export const x402Network = (net: Network): X402Network => `eip155:${net.chainId}`;

const TOKEN = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);
const ANYONE = "0x0000000000000000000000000000000000000001";
const NO_NONCE = `0x${"0".repeat(64)}` as const;

export interface X402Asset {
  address: Address;
  symbol: string | null;
  /** The EIP-712 domain an authorization signs: the token's own name and version. */
  name: string | null;
  version: string | null;
  decimals: number | null;
  /** Whether it answers EIP-3009's authorizationState: what the exact scheme's transferWithAuthorization needs. */
  eip3009: boolean;
}

/** The asset as the chain reports it, each read through Chain MCP; a read that reverts (or finds no code) is null. */
export async function readAsset(chain: Chain, address: Address, block: BlockRef): Promise<X402Asset> {
  const read = async (functionName: "name" | "symbol" | "version" | "decimals" | "authorizationState", args: readonly unknown[] = []): Promise<unknown> => {
    try {
      const data = await chain.call({ to: address, data: encodeFunctionData({ abi: TOKEN, functionName, args } as never) }, block);
      return decodeFunctionResult({ abi: TOKEN, functionName, data } as never);
    } catch (error) {
      if (error instanceof CallReverted || (error as Error).name?.startsWith("AbiDecoding")) return null;
      throw error;
    }
  };
  const name = (await read("name")) as string | null;
  const symbol = (await read("symbol")) as string | null;
  const version = (await read("version")) as string | null;
  const decimals = await read("decimals");
  const state = await read("authorizationState", [ANYONE, NO_NONCE]);
  return { address, symbol, name, version, decimals: decimals === null ? null : Number(decimals), eip3009: typeof state === "boolean" && name !== null && version !== null };
}
