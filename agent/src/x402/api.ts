// The x402 API in this process: its paid products (products.ts), its facilitator (pharosFacilitator,
// verify only without a key), and a free listing at GET /. Task 21's buyer uses it as any client uses
// an API, by HTTP requests, here handed over in-process; `x402 serve` puts the same products on a port.
import type { Address, Chain, Hex, Receipt } from "../core/chain.js";
import type { Signer } from "../core/execute.js";
import { formatAmount } from "../core/amounts.js";
import { LocalFacilitatorClient, paidEndpoint, pharosFacilitator } from "./parties.js";
import { x402Network, type X402Asset } from "./pharos.js";
import { productRoutes, type ProductName } from "./products.js";

export const IN_PROCESS_API = "https://x402.local";

export interface ApiListing {
  api: string;
  x402: string;
  asset: { address: Address; symbol: string | null; decimals: number };
  payTo: Address;
  products: { name: ProductName; method: "GET"; path: string; price: { amount: string; shown: string }; description: string }[];
  settles: boolean;
}

export interface PaidApi {
  url: string;
  handler: (request: Request) => Promise<Response>;
  listing: ApiListing;
  facilitator: LocalFacilitatorClient;
  /** Each receipt the facilitator waited for. */
  receipts: Receipt[];
  /** Failures that are not the chain's answer, with any settlement signed before one (see signer.ts). */
  faults: { error: unknown; signed: Hex | null }[];
}

export async function paidApi(options: { chain: Chain; asset: X402Asset & { decimals: number }; payTo: Address; facilitator: Signer | null; prices?: Partial<Record<ProductName, string>>; names?: readonly ProductName[]; wait?: { polls?: number; pollMs?: number } }): Promise<PaidApi> {
  const { chain, asset } = options;
  const receipts: Receipt[] = [];
  const faults: PaidApi["faults"] = [];
  const facilitator = new LocalFacilitatorClient(pharosFacilitator(chain, options.facilitator, { wait: options.wait, onReceipt: (r) => receipts.push(r), onFault: (error, signed) => faults.push({ error, signed }) }));
  const routes = productRoutes(chain, asset.decimals, options.prices, options.names);
  const listing: ApiListing = {
    api: "Pharos x402 API",
    x402: x402Network(chain.network),
    asset: { address: asset.address, symbol: asset.symbol, decimals: asset.decimals },
    payTo: options.payTo,
    products: routes.map((r) => ({ name: r.name, method: "GET", path: r.path, price: { amount: r.amount, shown: `${formatAmount(BigInt(r.amount), asset.decimals, asset.decimals)} ${asset.symbol ?? "units"}` }, description: r.description })),
    settles: Boolean(options.facilitator),
  };
  const endpoint = await paidEndpoint({ chain, asset, payTo: options.payTo, routes, facilitator, free: { "/": async () => listing } });
  const handler = async (request: Request): Promise<Response> => {
    try {
      return await endpoint(request);
    } catch (error) {
      faults.push({ error, signed: null });
      throw error;
    }
  };
  return { url: IN_PROCESS_API, handler, listing, facilitator, receipts, faults };
}
