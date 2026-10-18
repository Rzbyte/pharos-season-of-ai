// Task 21: what the x402 API sells, besides Task 20's GET /data: two of the lab's own agents, each a paid
// answer about one planned transfer, read through Pharos Chain MCP only once it is paid for.
//
//   GET /data                                         the newest block and the gas price (Task 20)
//   GET /risk?asset=USDC&from=0x…&to=0x…&amount=25    Task 25's check of where the transfer goes
//   GET /dryrun?asset=USDC&from=0x…&to=0x…&amount=25  Task 08's dry run of it
//
// A request the API cannot answer (an unknown asset, a bad address, an amount it cannot read) is refused
// with 400 before any 402, so nobody pays for an answer that cannot be given.
import { getAddress, isAddress } from "viem";
import { parseAmount } from "../core/amounts.js";
import type { Chain } from "../core/chain.js";
import { AgentError } from "../core/errors.js";
import type { Network } from "../core/networks.js";
import { parseDryRun, type Intent } from "../dryrun/intent.js";
import { runDryRun } from "../dryrun/run.js";
import { checkRisk, DEFAULT_BLOCKS } from "../risk/check.js";
import type { PaidRoute } from "./parties.js";
import { chainData } from "./run.js";

export type ProductName = "data" | "risk" | "dryrun";

export interface Product {
  name: ProductName;
  path: string;
  description: string;
  /** Whether it answers about a planned transfer, given in the query. */
  transfer: boolean;
}

export const PRODUCTS: Readonly<Record<ProductName, Product>> = Object.freeze({
  data: Object.freeze({ name: "data", path: "/data", description: "The newest block and the gas price, read through Pharos Chain MCP", transfer: false }),
  risk: Object.freeze({ name: "risk", path: "/risk", description: "Task 25's check of where a planned transfer goes: what the recipient is, its history with the sender, lookalikes, the dry run; a verdict", transfer: true }),
  dryrun: Object.freeze({ name: "dryrun", path: "/dryrun", description: "Task 08's dry run of a planned transfer: whether it would succeed, every balance it changes, its gas and cost, the transaction to sign", transfer: true }),
});

/** Prices in USDC, the API's defaults. */
export const DEFAULT_PRICES: Readonly<Record<ProductName, string>> = Object.freeze({ data: "0.001", risk: "0.005", dryrun: "0.003" });

const bad = (message: string) => new AgentError("usage", message);

/** The planned transfer a product answers about, from the query: asset (a symbol), from, to, amount. */
export function transferIntent(query: URLSearchParams, net: Network): Intent {
  const get = (key: string) => query.get(key)?.trim() ?? "";
  const asset = get("asset") || "USDC";
  const token = net.tokens.find((t) => t.symbol === asset);
  if (!token && asset !== net.nativeSymbol) throw bad(`asset must be ${net.nativeSymbol} or one of ${net.tokens.map((t) => t.symbol).join(", ")}.`);
  for (const [key, what] of [["from", "The sender"], ["to", "The recipient"]] as const) {
    if (!isAddress(get(key), { strict: false })) throw bad(`${what} (${key}) must be a 0x address (40 hex characters).`);
  }
  const amount = get("amount");
  if (!/^\d+(\.\d+)?$/.test(amount) || parseAmount(amount, token?.decimals ?? 18, "The amount") === 0n) throw bad("The amount must be a number more than zero, like 25.");
  if (Number(amount) > 1e12) throw bad("The amount is too large to check here.");
  const from = getAddress(get("from"));
  const to = getAddress(get("to"));
  const intent = token ? { kind: "erc20-transfer", token: getAddress(token.address), from, to, amount } : { kind: "native-transfer", from, to, amount };
  return parseDryRun({ network: net.id, intent }).intent;
}

/** The query that names `intent` to a product. */
export function transferQuery(intent: Intent, net: Network): URLSearchParams {
  if (intent.kind !== "erc20-transfer" && intent.kind !== "native-transfer") throw bad("A product answers about a transfer.");
  const asset = intent.kind === "native-transfer" ? net.nativeSymbol : (net.tokens.find((t) => t.address.toLowerCase() === intent.token.toLowerCase())?.symbol ?? null);
  if (!asset) throw bad("A product answers about PROS or an official token.");
  return new URLSearchParams({ asset, from: intent.from, to: intent.to, amount: intent.amount });
}

/** A product's answer, read through Chain MCP: what a paid request receives. */
export async function answer(name: ProductName, chain: Chain, query: URLSearchParams, now?: () => Date): Promise<unknown> {
  if (name === "data") return chainData(chain);
  const intent = transferIntent(query, chain.network);
  if (name === "risk") return checkRisk(intent, { chain, blocks: DEFAULT_BLOCKS, now });
  return runDryRun(intent, { chain });
}

/** The API's paid routes for `names`, priced in an asset of `decimals` (base units). */
export function productRoutes(chain: Chain, decimals: number, prices: Partial<Record<ProductName, string>> = {}, names: readonly ProductName[] = ["data", "risk", "dryrun"]): (PaidRoute & { name: ProductName })[] {
  return names.map((name) => {
    const product = PRODUCTS[name];
    const amount = parseAmount(prices[name] ?? DEFAULT_PRICES[name], decimals, `The price of ${product.path}`);
    if (amount === 0n) throw bad(`The price of ${product.path} must be more than zero.`);
    return {
      name,
      path: product.path,
      amount: amount.toString(),
      description: product.description,
      check: product.transfer ? (request: Request) => void transferIntent(new URL(request.url).searchParams, chain.network) : undefined,
      data: (request: Request) => answer(name, chain, new URL(request.url).searchParams),
    };
  });
}
