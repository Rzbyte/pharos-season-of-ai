# Task 13 submission: Docs MCP + Chain MCP Agent

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/13 |
| Repository | [`tasks/13-docs-chain-agent/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/13-docs-chain-agent); code in [`agent/src/docs/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/docs) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Developer Docs MCP: `https://docs.pharos.xyz/~gitbook/mcp` (`askQuestion`, `getPage`). Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_code`, `eth_call`, `get_block`) |

## Reviewer note

The agent answers a question about a Pharos contract with both MCPs. The Developer Docs MCP answers
it, and the pages that answer cites are read. From them the agent takes the contract's address, its
network, and the functions the docs write with a return type. Chain MCP then reads that address at
one block: whether a contract is there, what those functions return, and, for a token, its symbol,
name, decimals and supply. The verdict says whether the chain agrees with the docs: confirmed, a
mismatch, no contract, another network, nothing to call, or not in the docs.

## Key implementation detail

`askQuestion` synthesizes its answer, so the agent checks the answer against the docs themselves. It
reads the cited pages until an address fits the question and is on a page. If a page and the answer
each give one, the page's is called, and the steps say the answer's was not. Every step names its
source, a docs page or a Chain MCP tool. The agent adds no language model of its own. `pharos-agent
verify` replays both recorded transcripts, the Docs MCP's and the Chain MCP's, to the same answer,
readings and verdict.

## Video walkthrough (about 60 s)

1. Open `/tasks/13`: the USDC question. The docs' answer and the Token Registry page it cites; the
   USDC contract read on Pharos Mainnet (code, symbol, name, decimals, supply, the Skill Engine's
   list); Confirmed.
2. "How it got there": each step with its source, from `askQuestion` to the last `eth_call`.
3. Ask something the docs do not cover: "Not in the docs", and nothing called on chain.
4. In a terminal: `ask "What is the WPROS token address on Pharos Mainnet?" --proof wpros.json`, then
   `verify wpros.json`.

## X post draft

A Pharos agent that asks the official docs, then checks the chain. The Developer Docs MCP answers a
question about a contract; the agent finds the address and functions on the docs pages, calls them
through Pharos Chain MCP, and says whether the chain agrees with the docs.
https://pharos-agent-lab.vercel.app/tasks/13

## How it works (reply)

askQuestion answers, and getPage reads the pages it cites for the contract's address and functions.
get_code and eth_call read them at one block: code, the docs' functions, symbol and decimals. Then the
chain's own name for it is set beside the docs'.
