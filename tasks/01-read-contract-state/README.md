# Task 01: Read Contract State

## Overview

A TypeScript CLI that reads the **Circle USDC Contract** on Pharos Mainnet through the official **Pharos Chain MCP** server and prints the values in plain language. Every chain read is an MCP tool call; the CLI never calls Pharos JSON-RPC directly.

<!-- live-status:start -->
**Live run:** pending. The sample output below is written by `npm run proof` from a successful run against the hosted endpoint, never by hand.
<!-- live-status:end -->

## Contract / Network

| | |
|---|---|
| Contract | Circle USDC Contract |
| Address | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` |
| Network | Pharos Mainnet, chain ID 1672 |
| Address sources | [Circle: USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [Chainlink CCIP directory: Pharos Mainnet](https://docs.chain.link/ccip/directory/mainnet/chain/pharos-mainnet) |

Chosen because two official sources agree on the address, and its 6 decimals make the decimals conversion easy to check by eye.

## Pharos Tools Used

Official hosted Pharos Chain MCP server, `https://mcp.pharos.xyz/mcp` ([PharosNetwork/pharos-mcp](https://github.com/PharosNetwork/pharos-mcp)), via the `@modelcontextprotocol/sdk` client.

| MCP tool | Used for |
|---|---|
| `get_block_number` | The block every read is pinned to |
| `eth_call` | `name()`, `symbol()`, `decimals()`, `totalSupply()` at that block |
| `get_chain_info` | Confirms chain ID 1672 before the address is labelled `Circle USDC Contract`; network name in the output |

## Requirement Checklist

- [x] **Read at least 3 different values from one contract via Chain MCP:** `name()`, `symbol()`, `decimals()` and `totalSupply()`, each with MCP `eth_call`. All four are required; the run fails if any is missing.
- [x] **Show the contract address and the block number the data was read at:** the `Contract address` and `Read at block` lines. Every `eth_call` is pinned to that block, as the [proof transcript](#proof) shows request by request.
- [x] **Format raw values for humans, token decimals applied, addresses labelled:** total supply is divided by `10^decimals` (raw value shown too), names are decoded to text, and the address is labelled `Circle USDC Contract`. That label is used only when the endpoint confirms chain ID 1672 and `symbol()` returns `USDC`; otherwise the address is labelled from its on-chain name, with a warning.
- [ ] **Short README covering the contract chosen, how to run it, and sample output:** [Contract / Network](#contract--network), [How to Run](#how-to-run), [Live Sample Output](#live-sample-output). Ticked by `npm run proof` when the live output is captured. <!-- req-4 -->

## How to Run

Requires Node.js 20 or newer.

```bash
cd tasks/01-read-contract-state
npm install        # installs dependencies and builds
npm start          # reads the Circle USDC Contract via Pharos Chain MCP
npm run proof      # live run that saves the proof files and fills in the sample output below
```

`npm start -- --json` prints a JSON report; `npm start -- --verbose` traces each MCP request.

## Live Sample Output

<!-- live-output:start -->
_Pending: no live run has been recorded yet. `npm run proof` writes the real output here._
<!-- live-output:end -->

## Proof

One `npm run proof` run against `https://mcp.pharos.xyz/mcp` writes:

- `proof/mcp-transcript.json`: every MCP JSON-RPC message of the run, verbatim, including each `eth_call` request with its `block` argument and its raw result
- `sample-output/live-run.txt`: exactly what the CLI printed
- the Live Sample Output section above

It refuses to update this README unless the run used the hosted endpoint, every `eth_call` was pinned to the reported block, all four reads succeeded, and the saved output matches the transcript.

## Safety

- **Read-only:** only `eth_call`, `get_block_number` and `get_chain_info`. No private key, no signing, no transactions.
- **No API key:** the hosted endpoint is public, and no key or token is ever sent to `mcp.pharos.xyz`. `PHAROS_MCP_TOKEN` is used only for a custom self-hosted endpoint and is never written to the transcript.
- **Untrusted strings:** token names and symbols are sanitized before printing, so they cannot inject terminal escape codes.

Architecture, error handling and tests: [TECHNICAL.md](TECHNICAL.md).
