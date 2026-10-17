# Task 23 submission: Whale-Watching Agent

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/23 |
| Repository | [`tasks/23-whale-watching-agent/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/23-whale-watching-agent); code in [`agent/src/whale/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/whale) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_balance`, `get_transaction_count`, `get_code`, `eth_call`, `get_logs`, `get_block`) |

## Reviewer note

The watcher tracks a list of addresses. On every run it reads each one at the newest block through
Chain MCP: its PROS, nonce and USDC, and whether it has code the first time. It then scans USDC's
Transfer logs since the last run with two `get_logs` queries a page, one for what any tracked address
sent and one for what any received. Significant moves are surfaced once: a USDC transfer of 250 or more,
and a PROS balance change of 100 or more since the last run, since PROS transfers leave no logs. The
rest is summed per address: holdings and their change, transfers in and out, transactions sent. The
example addresses are the four that moved the most USDC in Task 02's live proof.

## Key implementation detail

Tracking means memory, and the memory is part of the proof. The store keeps the block the watcher
scanned to and each address as it was, so every run reports what changed and nothing twice. Each
run's proof records the store it started from and the one it left. `pharos-agent verify run-1.json
run-2.json …` replays each run from its recorded Chain MCP answers to exactly the recorded moves and
reports, and checks that the runs form one history.

## Video walkthrough (about 60 s)

1. Open `/tasks/23`: four tracked addresses with their USDC and PROS, and the significant moves of the last 1,000 blocks.
2. Press "Check every 30 s": each run scans only the new blocks, and each address shows what changed since the last check.
3. A transfer of 250 USDC or more by any of them lands on top, marked, with its transaction.
4. Change the watchlist to one address and a smaller amount: its own watcher, its own memory.
5. In a terminal: two `whales --store w.json --proof run-N.json` runs, then `verify run-1.json run-2.json`, ending in "one history".

## X post draft

A whale watcher on Pharos: it tracks addresses through Pharos Chain MCP, run after run. Each address's
holdings and changes are read at one block, its USDC transfers come from get_logs, and only the
significant moves are surfaced, once each. The proofs chain run to run.
https://pharos-agent-lab.vercel.app/tasks/23

## How it works (reply)

Each run pins the newest block, reads every tracked address there, and scans the Transfer logs since
the last run with two queries a page, whatever the number of addresses. Transfers over the amount, and
native balance changes over theirs, are the moves. The store keeps what the watcher saw, so the next
run reports only what is new.
