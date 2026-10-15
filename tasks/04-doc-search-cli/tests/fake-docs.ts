// In-process stand-in for docs.pharos.xyz, used by the tests. Every page, value and answer below is
// MADE UP for testing (for example the chain ID 424242 and the 0x4242... address): none of it is Pharos
// data, and none of it is ever used as an answer outside the tests.
//
// It serves the same three request shapes the real provider makes:
//   GET /sitemap.md                       the page list
//   GET /<path>.md?ask=<q>&goal=<g>       a page, asked a question (behavior set per path)
//   GET /<path>                           the HTML page (fallback)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Behavior =
  | { page: string } // the page's markdown, as is (ask ignored)
  | { answer: string } // a short composed answer (text/markdown)
  | { json: unknown } // application/json body
  | { status: number; body?: string }
  | "hang" // never answers
  | "empty" // 200 with an empty body
  | "huge" // a body over the size limit
  | "offsite" // redirect to another host
  | { html: string }; // only the HTML page exists (the .md is 404)

export interface FakeDocs {
  url: string;
  requests: Array<{ path: string; ask: string | null; goal: string | null; raw: string }>;
  set(path: string, behavior: Behavior): void;
  /** Back to the fixture pages, and forget the request log. */
  reset(): void;
  close(): Promise<void>;
}

export const SITEMAP = `# Pharos Docs (test fixture)

## Getting Started
- [Overview](https://docs.pharos.xyz/getting-started/overview.md)
- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md)
- [Pacific Mainnet](https://docs.pharos.xyz/getting-started/network/pacific-mainnet.md)
- [Canonical Contracts](/getting-started/canonical-contracts.md)
  - [Token Registry](getting-started/token-registry)

## Developer Guide
* [Foundry](https://docs.pharos.xyz/developer-guide/foundry.md)
* [Hardhat](https://docs.pharos.xyz/developer-guide/hardhat.md)

## API & SDK
- [JSON-RPC API Methods](https://docs.pharos.xyz/api-and-sdk/json-rpc-methods.md)

## Elsewhere
- [Some blog](https://blog.example.com/post.md)
- [Logo](https://docs.pharos.xyz/assets/logo.png)
- [Atlantic Testnet again](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
`;

export const PAGES: Record<string, string> = {
  "/getting-started/network/atlantic-testnet": `---
description: Test fixture page
---

# Atlantic Testnet

Connect to the Atlantic testnet (test fixture values).

## Network details

| Parameter | Value |
| --- | --- |
| Network name | Fixture Atlantic |
| Chain ID | 424242 |
| RPC URL | https://rpc.fixture.invalid |
| Currency | FIX |

## Faucet

Request test tokens from the fixture faucet.
`,
  "/developer-guide/foundry": `# Foundry

Use Foundry to build and deploy contracts on Pharos (test fixture).

## Install Foundry

- Run \`curl -L https://foundry.fixture.invalid | bash\` then \`foundryup\`.

## Deploy a contract

Deploy the contract with forge create, pointing it at the network RPC URL and your private key.

\`\`\`bash
forge create src/Counter.sol:Counter --rpc-url $RPC_URL --private-key $PRIVATE_KEY
\`\`\`

See [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet) for network details.
`,
  "/developer-guide/hardhat": `# Hardhat

Hardhat is another way to compile and deploy contracts (test fixture).
`,
  "/getting-started/canonical-contracts": `# Canonical Contracts

## Multicall

The Multicall3 contract address is 0x4242424242424242424242424242424242424242 (test fixture).
`,
  "/getting-started/token-registry": `# Token Registry

Tokens listed for the fixture network.
`,
  "/getting-started/overview": `# Overview

Pharos is a fixture overview page.
`,
  "/getting-started/network/pacific-mainnet": `# Pacific Mainnet

Mainnet page without any network table (test fixture).
`,
  "/api-and-sdk/json-rpc-methods": `# JSON-RPC API Methods

## eth_blockNumber

Returns the number of the most recent block.
`,
};

/**
 * A composed ?ask= answer in the shape docs.pharos.xyz really returns (seen live for "What is the chain
 * ID of the Atlantic testnet?"): an H1 restating the question, the answer with a relative docs link, then
 * an H1 "Suggested Follow-up Questions:" with many generated links to unrelated pages. The value is the
 * fixture's made-up 424242, not the live one.
 */
export const ATLANTIC_ASK_ANSWER = `# What is the chain ID of the Atlantic testnet?

The Atlantic testnet chain ID is **424242**. See [Atlantic Testnet](/getting-started/network/atlantic-testnet.md).

# Suggested Follow-up Questions:

- [What is the RPC URL of the Atlantic testnet?](/getting-started/network/atlantic-testnet.md?ask=What+is+the+RPC+URL+of+the+Atlantic+testnet%3F)
- [How do I deploy a contract with Foundry?](/developer-guide/foundry.md?ask=How+do+I+deploy+a+contract+with+Foundry%3F)
- [How do I deploy a contract with Hardhat?](/developer-guide/hardhat.md?ask=How+do+I+deploy+a+contract+with+Hardhat%3F)
- [Which canonical contracts are deployed on Pharos?](/getting-started/canonical-contracts.md)
- [Which tokens are listed in the token registry?](/getting-started/token-registry.md)
- [Which JSON-RPC methods does Pharos support?](/api-and-sdk/json-rpc-methods.md)
- [What is the Pacific mainnet?](/getting-started/network/pacific-mainnet.md)
- [How do bridges move assets between networks?](https://docs.pharos.xyz/getting-started/overview.md)
- [Which RPC providers serve Pharos?](https://docs.pharos.xyz/tooling-and-infrastructure/rpc)
`;

export async function startFakeDocs(): Promise<FakeDocs> {
  const behaviors = new Map<string, Behavior>();
  const requests: FakeDocs["requests"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push({ path: url.pathname, ask: url.searchParams.get("ask"), goal: url.searchParams.get("goal"), raw: req.url ?? "" });
    if (url.pathname === "/sitemap.md") {
      const behavior = behaviors.get("/sitemap.md");
      if (behavior && typeof behavior === "object" && "status" in behavior) return void res.writeHead(behavior.status).end(behavior.body ?? "");
      if (behavior && typeof behavior === "object" && "page" in behavior) return void res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(behavior.page);
      return void res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(SITEMAP);
    }
    const md = url.pathname.endsWith(".md");
    const path = url.pathname.replace(/\.md$/, "");
    const behavior: Behavior = behaviors.get(path) ?? (PAGES[path] !== undefined ? { page: PAGES[path]! } : { status: 404, body: "Not found" });
    if (!md) {
      if (typeof behavior === "object" && "html" in behavior) return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(behavior.html);
      return void res.writeHead(404).end("Not found");
    }
    if (behavior === "hang") return;
    if (behavior === "empty") return void res.writeHead(200, { "content-type": "text/markdown" }).end("");
    if (behavior === "huge") return void res.writeHead(200, { "content-type": "text/markdown" }).end("x".repeat(2_100_000));
    if (behavior === "offsite") return void res.writeHead(302, { location: "https://evil.example.com/page.md" }).end();
    if ("html" in behavior) return void res.writeHead(404).end("Not found");
    if ("status" in behavior) return void res.writeHead(behavior.status).end(behavior.body ?? "");
    if ("json" in behavior) return void res.writeHead(200, { "content-type": "application/json" }).end(typeof behavior.json === "string" ? behavior.json : JSON.stringify(behavior.json));
    if ("answer" in behavior) return void res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(behavior.answer);
    return void res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(behavior.page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    set: (path, behavior) => void behaviors.set(path, behavior),
    reset: () => {
      behaviors.clear();
      requests.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
