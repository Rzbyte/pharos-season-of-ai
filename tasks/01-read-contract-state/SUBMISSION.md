# Task 01 submission: Read Contract State

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/01 |
| Repository | [`tasks/01-read-contract-state/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/01-read-contract-state) |
| Proof | [`proof/mcp-transcript.json`](proof/mcp-transcript.json): every MCP message of the live run, 2026-10-14T07:10:47Z, block 20202384 |
| Pharos technology | Pharos Chain MCP, `https://mcp.pharos.xyz/mcp` (`get_chain_info`, `get_block_number`, `eth_call`) |

## Reviewer note

The CLI reads five values from the Circle USDC Contract on Pharos Mainnet: `name()`, `symbol()`,
`decimals()`, `totalSupply()` and `paused()`. Each is an `eth_call` through Chain MCP, pinned to one
block, and the output shows that block and the contract address. Supply is shown with decimals applied
and the raw value beside it. The web page adds the Pharos Inspector, which reads any address or
transaction hash through the same server.

## Key implementation detail

All five reads are pinned to the block from `get_block_number`, so they describe one consistent
state. A transient failure is retried at that same block, never at a newer one. The contract is
labelled "Circle USDC Contract" only after `get_chain_info` confirms chain ID 1672 and `symbol()`
returns `USDC`. Nothing calls JSON-RPC directly, and the transcript records every MCP message to
prove it.

## Video walkthrough (about 60 s)

1. Open `/tasks/01`: the snapshot shows the five values, the contract address and the block.
2. Open Proof: the transcript lists one `eth_call` per value, each at that block.
3. Paste a transaction hash into the Inspector: status, gas and logs from `get_transaction_receipt`.
4. Paste a wallet address: it is classified by `get_code`, then balance and nonce at one block.
5. In a terminal: `npm start`, then `npm start -- --json`.

## X post draft

Read the Circle USDC contract on Pharos Mainnet through the Pharos Chain MCP: name, symbol, decimals,
supply and pause state, all pinned to one block, with the raw MCP transcript as proof. The page also
inspects any address or transaction. https://pharos-agent-lab.vercel.app/tasks/01

## How it works (reply)

Every value is an `eth_call` through Chain MCP at one block number, so the snapshot can't mix two
states. The CLI checks the chain ID before it labels the contract, and the transcript is saved
message by message.
