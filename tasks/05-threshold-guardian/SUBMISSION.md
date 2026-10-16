# Task 05 submission: Threshold Guardian

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/05 |
| Repository | [`tasks/05-threshold-guardian/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/05-threshold-guardian); code in [`agent/src/guardian/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/guardian) |
| Proof | `proof/` (pending the first live run; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp`, and the official server run locally for Atlantic execution (`send_raw_transaction`) |

## Reviewer note

The guardian reads six on-chain conditions of five kinds at one pinned Pharos Mainnet block, all
through Chain MCP:
- a contract flag;
- a token balance;
- a native balance;
- contract code;
- gas price and block age.

It fires a USDC payout only when all six hold. The payout is then simulated at that same block and
priced; a revert or missing gas money blocks it. A value that cannot be read never counts as holding.
On Atlantic, `--execute` re-reads every condition at the newest block before signing locally and
broadcasting through Chain MCP.

## Key implementation detail

One block number pins every state read, so the decision is about one consistent state. The simulation
runs at that same block, so it sees exactly the state the conditions saw. A proof records every MCP
message, and `pharos-agent verify` replays the recorded answers through the same code. That code must
ask exactly the same questions and reach the identical decision; any edited answer, decision or block
number fails.

## Video walkthrough (about 60 s)

1. Open `/tasks/05`: Fire, six green conditions, each with its value and the Chain MCP tool that read it.
2. Point at the block number, then at the Action: transfer returns true in simulation, gas priced, not sent (read-only endpoint).
3. Change the payout: raise the amount above the payer's balance and evaluate. The balance condition turns red: Hold, nothing prepared.
4. Open Proof & technical details: the 11 Chain MCP calls of the run, all at the same block.
5. In a terminal: `guardian payout --proof p.json`, then `verify p.json`. Every check passes.

## X post draft

A threshold guardian on Pharos: six on-chain conditions read at one block through the Pharos Chain
MCP, and a USDC payout that fires only if all of them hold, simulated at that same block first. A
value it can't read counts as a no. The proof replays every MCP answer to check the decision.
https://pharos-agent-lab.vercel.app/tasks/05

## How it works (reply)

It pins one block, reads each condition at it through Chain MCP, and fires only if the rule holds.
The payout is simulated at the same block, so a revert blocks it. On testnet it re-checks at the
newest block, then signs locally and broadcasts via the MCP's send_raw_transaction.
