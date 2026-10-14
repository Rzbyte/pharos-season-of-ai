# Task 01: Read Contract State

## Overview

A TypeScript CLI that reads the **Circle USDC Contract** on Pharos Mainnet through the official **Pharos Chain MCP** server and prints the values in plain language. Every chain read is an MCP tool call; the CLI never calls Pharos JSON-RPC directly.

A small web demo shows the same read as an on-chain snapshot, next to the **Pharos Inspector**, which reads any contract address or transaction hash through the same server and can explain a result in plain language when asked. See [Web Demo](#web-demo).

<!-- live-status:start -->
**Live run:** captured 2026-10-14T07:10:47Z against `https://mcp.pharos.xyz/mcp`, contract `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`, block 20202384. Output in [Live Sample Output](#live-sample-output), raw MCP messages in [proof/mcp-transcript.json](proof/mcp-transcript.json).
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
| `eth_call` | `name()`, `symbol()`, `decimals()`, `totalSupply()` and `paused()` at that block |
| `get_chain_info` | Confirms chain ID 1672 before the address is labelled `Circle USDC Contract`; network name in the output |
| `get_transaction` | Web Inspector only: a pasted transaction's block, sender, recipient, value and gas limit |
| `get_transaction_receipt` | Web Inspector only: that transaction's status, gas used and number of logs |

## Requirement Checklist

- [x] **Read at least 3 different values from one contract via Chain MCP:** `name()`, `symbol()`, `decimals()`, `totalSupply()` and `paused()`, each with MCP `eth_call`. All five are required; the run fails if any is missing. See [The fifth read](#the-fifth-read-paused).
- [x] **Show the contract address and the block number the data was read at:** the `Contract address` and `Read at block` lines. Every `eth_call` is pinned to that block, as the [proof transcript](#proof) shows request by request.
- [x] **Format raw values for humans, token decimals applied, addresses labelled:** total supply is divided by `10^decimals` (raw value shown too), names are decoded to text, and the address is labelled `Circle USDC Contract`. That label is used only when the endpoint confirms chain ID 1672 and `symbol()` returns `USDC`; otherwise the address is labelled from its on-chain name, with a warning.
- [x] **Short README covering the contract chosen, how to run it, and sample output:** [Contract / Network](#contract--network), [How to Run](#how-to-run), [Live Sample Output](#live-sample-output). Ticked by `npm run proof` when the live output is captured. <!-- req-4 -->

### The fifth read: `paused()`

`paused()` (selector `0x5c975abb`) returns the contract's pause flag. It is read like the other four: one more `eth_call` through Chain MCP, pinned to the same block, retried once at that block after a transient error, never through direct RPC. It adds live state the four ERC-20 values cannot show, because a pausable token can be paused while its name, symbol, decimals and supply stay exactly the same. Before it became a required read, a probe through the hosted Chain MCP confirmed that this contract answers it with a valid ABI bool (`false` at block 20200229).

The output reports only the flag: its `Paused` line says `No` when `paused()` returned `false` and `Yes` when it returned `true`. `No` is not a claim that the contract or the token is safe. The answer must be exactly one 32-byte word holding 0 or 1; anything else fails the run as a failed Task 01 state read, instead of being read as "not paused" or as a sign the contract is not an ERC-20. Only the Circle USDC Contract is asked for `paused()`. Any other address gets the four ERC-20 reads, since a token without `paused()` is still a valid ERC-20.

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
Captured by `npm run proof` at 2026-10-14T07:10:47Z against `https://mcp.pharos.xyz/mcp`: block 20202384, 5 successful `eth_call` reads. Saved as [sample-output/live-run.txt](sample-output/live-run.txt); the raw MCP messages from the same run are in [proof/mcp-transcript.json](proof/mcp-transcript.json).

```text
Pharos Contract State Reader

  Contract          Circle USDC Contract
  Contract address  0xC879C018dB60520F4355C26eD1a6D572cdAC1815
  Read at block     20202384
  Network           Pharos Mainnet (chain ID 1672)
  Data source       Pharos Chain MCP (server: pharos-mcp-server 0.1.0)
                    https://mcp.pharos.xyz/mcp

  Token name        USDC
  Symbol            USDC
  Decimals          6
  Total supply      21,042,483.561526 USDC
                    raw value 21042483561526, divided by 10^6
  Paused            No

  In plain words: At Pharos Mainnet block 20202384, the Circle USDC Contract
  reports a total supply of 21,042,483.561526 USDC. The contract stores
  amounts as whole numbers with 6 decimals, so its raw value 21042483561526 is
  divided by 10^6 to get that figure. paused() returned false, so the contract
  is not paused.

  Read with MCP eth_call at block 20202384: name(), symbol(), decimals(),
  totalSupply(), paused(). 7 MCP tool calls in 4.64s.
```
<!-- live-output:end -->

## Proof

One `npm run proof` run against `https://mcp.pharos.xyz/mcp` writes:

- `proof/mcp-transcript.json`: every MCP JSON-RPC message of the run, verbatim, including each `eth_call` request with its `block` argument and its raw result
- `sample-output/live-run.txt`: exactly what the CLI printed
- the Live Sample Output section above

It refuses to update this README unless the run used the hosted endpoint, every `eth_call` was pinned to the reported block, all five reads succeeded, and the saved output matches the transcript.

The web demo's optional Explain this result is not part of this proof: it never runs in `npm run proof` or `/api/state`, and it reads nothing from the chain.

## Web Demo

A static page (`public/`) and three Vercel functions (`api/`, configured in `vercel.json`):

- `GET /api/state` runs this CLI with `--json` against the hosted endpoint. The page shows the report as an on-chain snapshot: total supply, name, symbol, decimals, network, the pause flag (`Yes` in the warning colour), and the block and time of the read, with every MCP call behind it under Proof & technical details. A response served again from the edge cache is marked as a cached snapshot.
- `GET /api/inspect?q=<address or transaction hash>` is the Pharos Inspector: the four ERC-20 reads of any contract at one block, or a transaction's status, block, sender, recipient, value, gas and logs. It is a separate function, so it cannot change the Task 01 read.
- `POST /api/explain` is **Explain this result**, optional and only on request. After an inspection, one button asks an AI model what that result means, in a few short paragraphs for someone new to blockchains, with any extra points folded away behind Show details. It is an explanation layer only: the Inspector's values, read through Chain MCP, stay the source of truth, and inspecting never calls the model. The same result is explained once and then served from a cache, and new explanations are rate limited. It needs `DEEPSEEK_API_KEY` in the server's environment; without it the button says explanations are unavailable and everything else works as before.

The browser calls only these three endpoints of its own site; it never talks to MCP, Pharos RPC or the AI provider. The snapshot's contract and block, and an inspected address or transaction, link to the Pharos Mainnet explorer (SocialScan); only a well-formed value is ever turned into a link. Design, behaviour and the web tests: [TECHNICAL.md](TECHNICAL.md#web-demo).

## Safety

- **Read-only:** the CLI uses only `eth_call`, `get_block_number` and `get_chain_info`; the web Inspector adds `get_transaction` and `get_transaction_receipt`, which only read too. No private key, no signing, no transactions.
- **No API key:** the hosted endpoint is public, and no key or token is ever sent to `mcp.pharos.xyz`. `PHAROS_MCP_TOKEN` is used only for a custom self-hosted endpoint and is never written to the transcript. The web functions always use the hosted endpoint and never send a token, whatever `PHAROS_MCP_URL` or `PHAROS_MCP_TOKEN` say on the deployment.
- **Untrusted strings:** token names and symbols are sanitized before printing, so they cannot inject terminal escape codes. The web page writes every value as text, never as markup.
- **Explain this result:** runs only when a visitor clicks it. The model gets a fixed, validated summary of one inspection (public on-chain facts; no IP address, cookies or visitor text), told that every value in it is untrusted data, never instructions. It has no tools and cannot read the chain or make transactions, and its answer is checked before it is shown. The provider key lives only in the server's environment and never reaches the browser. Details: [TECHNICAL.md](TECHNICAL.md#explain-this-result).

Architecture, error handling, the web demo and tests: [TECHNICAL.md](TECHNICAL.md).
