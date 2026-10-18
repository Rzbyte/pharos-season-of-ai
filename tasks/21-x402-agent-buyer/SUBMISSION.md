# Task 21 submission: X402 Agent Buyer

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/21 |
| Repository | [`tasks/21-x402-agent-buyer/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/21-x402-agent-buyer); code in [`agent/src/buyer/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/buyer) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | The Pharos x402 skill (PharosNetwork/examples `skills/x402-pharos` at `f08e921`): `@x402/core`, `@x402/evm`, `@x402/fetch` 2.28.0, the `exact` scheme on `eip155:1672` and `eip155:688689`. Task 20's x402 API. Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_block`, `eth_call`, `get_code`, and on Atlantic every read of the answers bought); on Atlantic, the official server run locally, which also settles (`estimate_gas`, `get_transaction_count`, `send_raw_transaction`, `get_transaction_receipt`) |

## Reviewer note

An agent with a job and a budget. The job is to check a planned transfer before it is sent, and prepare
it. It buys what it needs with x402 from Task 20's API, which sells Task 25's risk check and Task 08's
dry run as paid answers. It asks each price for free (the 402), plans within its USDC budget, and signs
each authorization only within what is left. Then it uses what it bought: "do not send" ends the job
without buying the dry run, keeping the rest of the budget; otherwise the dry run gives the cost and the
transaction to sign. It finishes with a verdict, the ledger and every purchase. On Atlantic it buys,
settles and finishes; on Pharos Mainnet the page shows the prices, the plan and the first payment
refused on chain, since nothing settles there.

## Key implementation detail

The budget is enforced by x402's own client: its spend controls cap each payment at what is left, and a
hook refuses one past it or at another price than the 402 asked. An authorization counts once signed,
whether or not it settles, because whoever holds it could still settle it until it expires. The proof
replays what can be replayed: every answer bought is recomputed by the same code from its own recorded
Chain MCP calls (each starts with its own `get_chain_info`), and the outcome is recomputed from those
answers. The payments' facts are checked against the recorded answers, as in Task 20.

## Video walkthrough (about 60 s)

1. Open `/tasks/21`: the job (25 USDC to the example recipient), a 0.01 USDC budget, the prices the API
   asked, and the first payment refused on chain by a key that holds nothing.
2. "Too little for anything": nothing signed, the job not done, the reason given.
3. In a terminal, on Atlantic: `x402 serve --execute`, then `buy --execute --api http://127.0.0.1:4020`.
   The check and the dry run are bought and settled, and the transaction to sign comes back.

## X post draft

An agent on Pharos that pays for what its job needs with x402, and no more. It asks the prices, plans
within its USDC budget, buys a risk check and a dry run through Pharos Chain MCP-backed APIs, stops early
when the check says don't send, and hands back the transaction to sign.
https://pharos-agent-lab.vercel.app/tasks/21

## How it works (reply)

x402's client with spend controls caps each payment at the budget left; a 402 gives each price for free;
the answers bought (Task 25's check, Task 08's dry run) decide the job, and the proof recomputes them
from their recorded Chain MCP calls.
