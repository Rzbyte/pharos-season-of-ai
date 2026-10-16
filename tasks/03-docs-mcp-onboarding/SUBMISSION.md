# Task 03 submission: Docs MCP Onboarding

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/03 |
| Repository | [`tasks/03-docs-mcp-onboarding/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/03-docs-mcp-onboarding) |
| Proof | The proof folder and the video, linked from the page ([`evidence.json`](evidence.json), `links`) |
| Pharos technology | Pharos Developer Docs MCP; the Atlantic testnet RPC |

## Reviewer note

The page records one onboarding attempt with only the Developer Docs MCP, from Android Termux on
ARM64. The goal was a working read on the Atlantic testnet. It ends with `eth_chainId` returning
688689 and a read-only `eth_call`, and lists the three docs gaps hit on the way, each with a suggested
fix and the exact queries.

## Key implementation detail

`evidence.json` is the only content. The page is generated from it by `npm run build`, which leaves
out any empty field instead of filling it in, so the page says exactly what the evidence says.

## Video walkthrough (about 60 s)

1. Open `/tasks/03`: the outcome first (Atlantic RPC connected, chain ID verified, `eth_call` succeeded).
2. The journey: Started, Blocked (Foundry on ARM64), Recovered (JSON-RPC over curl), Successful.
3. The three gaps, each with its fix, then one gap's exact queries.
4. Open the proof folder and the video.

## X post draft

Onboarding to Pharos with only the Developer Docs MCP, from Android Termux: Foundry wouldn't run on
ARM64, so I went back to plain JSON-RPC and got a working Atlantic call. Three docs gaps and a fix
for each are on the page. https://pharos-agent-lab.vercel.app/tasks/03

## How it works (reply)

Every claim on the page comes from one evidence file, rendered at build time, with the exact Docs MCP
queries for each gap and links to the full proof.
