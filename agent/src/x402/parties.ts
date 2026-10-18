// Task 20: the three parties of an x402 payment on Pharos, each built on the official x402 packages
// (@x402/core, @x402/evm, @x402/fetch, as the Pharos skill names them):
//
//   The facilitator: x402's facilitator with the EVM "exact" scheme, its chain access through Pharos
//     Chain MCP (signer.ts). It verifies a payment (the signature, then the transfer simulated on chain)
//     and settles it (transferWithAuthorization sent, its receipt checked for the Transfer).
//   The paid endpoint: x402's HTTP resource server, as a function from a Request to a Response. A request
//     without a payment gets 402 and the PAYMENT-REQUIRED header; one with a payment is verified, its
//     data made, then settled, and the data is released only once the payment is settled.
//   The paying client: x402's fetch wrapper with the EVM exact scheme, allowed to pay only this asset,
//     at most a set amount a payment (x402's own spend controls).
//
// Each runs in this process or over HTTP: the facilitator's routes are x402's (POST /verify, POST /settle,
// GET /supported), and the endpoint is served as it is.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmFacilitator } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServer } from "@x402/evm/exact/server";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { LocalAccount } from "viem";
import type { Address, Chain } from "../core/chain.js";
import type { Signer } from "../core/execute.js";
import type { Network } from "../core/networks.js";
import { x402Network, type X402Asset } from "./pharos.js";
import { chainFacilitatorSigner, type FacilitatorSignerOptions } from "./signer.js";

/** One exchange between the endpoint and the facilitator, as it went. */
export interface FacilitatorExchange {
  op: "supported" | "verify" | "settle";
  request: unknown;
  response: unknown;
}

/**
 * x402's facilitator for this chain's network only, settling through Chain MCP with `signer` (null: verify
 * only). The scheme is registered by itself: x402's registerExactEvmScheme would also register x402 v1 on
 * two dozen named networks (Base, Polygon…), none of them Pharos, which this facilitator cannot reach.
 */
export function pharosFacilitator(chain: Chain, signer: Signer | null, options: FacilitatorSignerOptions = {}): x402Facilitator {
  return new x402Facilitator().register(x402Network(chain.network), new ExactEvmFacilitator(chainFacilitatorSigner(chain, signer, options)));
}

/** A facilitator client that calls a facilitator in this process, keeping each exchange. */
export class LocalFacilitatorClient implements FacilitatorClient {
  readonly log: FacilitatorExchange[] = [];
  constructor(private readonly facilitator: x402Facilitator) {}
  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    const response = await this.facilitator.verify(paymentPayload, paymentRequirements);
    this.log.push({ op: "verify", request: { paymentPayload, paymentRequirements }, response });
    return response;
  }
  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    const response = await this.facilitator.settle(paymentPayload, paymentRequirements);
    this.log.push({ op: "settle", request: { paymentPayload, paymentRequirements }, response });
    return response;
  }
  async getSupported(): Promise<SupportedResponse> {
    const response = this.facilitator.getSupported() as SupportedResponse;
    this.log.push({ op: "supported", request: null, response });
    return response;
  }
}

export interface PaidRoute {
  path: string;
  /** In the asset's base units. */
  amount: string;
  description: string;
  data: (request: Request) => Promise<unknown>;
}

/** The paid endpoint: GET routes priced in `asset`, paid to `payTo`, verified and settled by `facilitator`. */
export async function paidEndpoint(options: { chain: Chain; asset: X402Asset; payTo: Address; routes: PaidRoute[]; facilitator: FacilitatorClient; free?: Record<string, (request: Request) => Promise<unknown>> }): Promise<(request: Request) => Promise<Response>> {
  const network = x402Network(options.chain.network);
  const server = new x402ResourceServer(options.facilitator).register(network, new ExactEvmServer());
  const routes = Object.fromEntries(
    options.routes.map((route) => [`GET ${route.path}`, { accepts: { scheme: "exact", price: { asset: options.asset.address, amount: route.amount, extra: { name: options.asset.name, version: options.asset.version } }, network, payTo: options.payTo }, description: route.description, mimeType: "application/json" }]),
  );
  const http = new x402HTTPResourceServer(server, routes as never);
  await http.initialize();
  const json = (body: unknown, status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json", ...headers } });
  return async (request) => {
    const url = new URL(request.url);
    const adapter: HTTPAdapter = {
      getHeader: (name) => request.headers.get(name) ?? undefined,
      getMethod: () => request.method,
      getPath: () => url.pathname,
      getUrl: () => request.url,
      getAcceptHeader: () => request.headers.get("accept") ?? "",
      getUserAgent: () => request.headers.get("user-agent") ?? "",
      getQueryParams: () => Object.fromEntries(url.searchParams),
      getQueryParam: (name) => url.searchParams.get(name) ?? undefined,
    };
    const context = { adapter, path: url.pathname, method: request.method, paymentHeader: adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment") };
    const route = options.routes.find((r) => r.path === url.pathname);
    if (!route || request.method !== "GET") {
      const free = request.method === "GET" ? options.free?.[url.pathname] : undefined;
      return free ? json(await free(request), 200) : json({ error: "Not found." }, 404);
    }
    const result = await http.processHTTPRequest(context);
    if (result.type === "payment-error") return json(result.response.body, result.response.status, result.response.headers);
    if (result.type === "no-payment-required") return json(await route.data(request), 200);
    // Verified: the data is made, then the payment settled; the data goes out only once it is.
    const body = JSON.stringify(await route.data(request));
    const settled = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: context, responseBody: Buffer.from(body), responseHeaders: { "content-type": "application/json" } }, undefined, result.beforeHandlerSettlement);
    if (!settled.success) return json(settled.response.body, settled.response.status, settled.response.headers);
    return new Response(body, { status: 200, headers: { "content-type": "application/json", ...settled.headers } });
  };
}

/** The paying client: x402's fetch, paying `asset` only, on `net`, at most `maxAmount` base units a payment. */
export function payingFetch(account: LocalAccount, net: Network, asset: Address, maxAmount: string, fetcher: typeof fetch = fetch): typeof fetch {
  const network = x402Network(net);
  const client = new x402Client().register(network, new ExactEvmClient(account as never));
  client.setSpendControls({ allowedAssets: [{ network, asset, maxAmountPerPayment: maxAmount }] });
  return wrapFetchWithPayment(fetcher, client);
}

/** A fetch that hands each request to `handler` in this process, as a server would get it. */
export const localFetch =
  (handler: (request: Request) => Promise<Response>): typeof fetch =>
  async (input, init) =>
    handler(new Request(input as never, init));

const toRequest = async (req: IncomingMessage, origin: string): Promise<Request> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url ?? "/", origin), { method: req.method, headers: req.headers as Record<string, string>, ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}) });
};

/** Serves `handler` over HTTP on 127.0.0.1 (port 0: any free one). */
export async function serve(handler: (request: Request) => Promise<Response>, port = 0, host = "127.0.0.1"): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      const response = await handler(await toRequest(req, `http://${req.headers.host ?? host}`));
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => (headers[key] = value));
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  return { url, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** x402's facilitator routes for `facilitator`: POST /verify, POST /settle, GET /supported. */
export function facilitatorRoutes(facilitator: x402Facilitator, log: FacilitatorExchange[] = []): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status, headers: { "content-type": "application/json" } });
    if (request.method === "GET" && path.endsWith("/supported")) {
      const response = facilitator.getSupported();
      log.push({ op: "supported", request: null, response });
      return json(response);
    }
    const op = path.endsWith("/verify") ? "verify" : path.endsWith("/settle") ? "settle" : null;
    if (request.method !== "POST" || !op) return json({ error: "Not found." }, 404);
    const body = (await request.json().catch(() => null)) as { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements } | null;
    if (!body?.paymentPayload || !body.paymentRequirements) return json({ error: "A body of paymentPayload and paymentRequirements is needed." }, 400);
    const response = op === "verify" ? await facilitator.verify(body.paymentPayload, body.paymentRequirements) : await facilitator.settle(body.paymentPayload, body.paymentRequirements);
    log.push({ op, request: body, response });
    return json(response);
  };
}
