# Task 08 submission: Dry-Run Executor

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/08 |
| Repository | [`tasks/08-dry-run-executor/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/08-dry-run-executor); code in [`agent/src/dryrun/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/dryrun) |
| Proof | `proof/` (pending the first live run; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp`, and the official server run locally for Atlantic submission (`send_raw_transaction`) |

## Reviewer note

Before a transaction is sent, the executor reads everything it would change at one pinned Pharos
Mainnet block, all through Chain MCP:
- the sender's and recipient's balances, or the allowance;
- the sender's PROS;
- whether the recipient or spender is a contract.

It simulates the transaction there with `eth_call` from the sender and prices it with `estimate_gas`
and the fee market. The answer is a verdict (would succeed, would revert with the reason, or can't
pay the fee) and a before → after line for each value, plus warnings such as an unlimited approval.
Nothing is sent from the page. On Atlantic, `--submit` sends it and checks every predicted change
against the receipt's block.

## Key implementation detail

The prediction is checked, not just shown. A submitted run reads every predicted value again at the
receipt's block and the block before it. Token balances must move by exactly the predicted amount, an
allowance must be exactly the approved one, and the sender's PROS must drop by exactly the value plus
the fee the receipt reports. Any difference is a DIFF. Proofs replay the recorded Chain MCP answers
through the same code, which must reach the identical prediction.

## Video walkthrough (about 60 s)

1. Open `/tasks/08`: "Would succeed" for 25 USDC, the block it read, and the outcome: −25, +25, and the sender's PROS paying the gas.
2. Point at Cost: gas estimated and limited, the fee and its cap, and the sender's funds against what it needs.
3. Change the amount above the sender's balance and simulate: "Would revert" with the token's reason, balances shown as they are.
4. Switch to Approve with `max` and a spender: the allowance becomes unlimited, with two warnings.
5. Open Proof & technical details: the Chain MCP calls, each read at the same block. In a terminal: `dryrun --proof p.json`, then `verify p.json`.

## X post draft

A dry-run executor on Pharos: give it a transfer or an approval and it reads what the transaction
would change at one block through Pharos Chain MCP, simulates it there and prices the gas. You get a
verdict, before → after for every balance, and warnings, before anything is signed.
https://pharos-agent-lab.vercel.app/tasks/08

## How it works (reply)

It pins a block, reads the balances the transaction touches, runs it with eth_call from the sender at
that block, and prices it with estimate_gas the way the agent would sign. On testnet it can send it
and diff every prediction against the receipt.
