# Task 22 submission: On-Chain Alert Bot

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/22 |
| Repository | [`tasks/22-on-chain-alert-bot/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/22-on-chain-alert-bot); code in [`agent/src/alert/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/alert) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_logs`, `eth_call`, `get_gas_price`, `get_block`) |

## Reviewer note

The bot watches two kinds of rule. Transfer rules read a token's Transfer logs through Chain MCP
`get_logs`, from the block after the last run's to the newest, in pages of at most 1,000 blocks.
Every matching transfer is one alert, reported once. State rules read a value at the newest block (a
balance, `paused()`, the gas price) and alert when the condition starts to hold and when it stops, not
on every run. The store between runs holds the last block scanned, which conditions held and any
alert not yet delivered. The CLI posts each alert to a webhook (Slack and Discord read it as it is)
and retries any the webhook refused on the next run.

## Key implementation detail

"Alerts when they occur" needs memory, and the memory is part of the proof. The cursor means no
transfer is reported twice and no block goes unscanned without saying so. The stored states mean a
condition alerts on its change, not on every run. Each run's proof records the store it started from
and the one it left. `pharos-agent verify run-1.json run-2.json …` replays each run from its recorded
Chain MCP answers to exactly the recorded alerts, and checks that the runs form one history.

## Video walkthrough (about 60 s)

1. Open `/tasks/22`: the first run scans the last 1,000 blocks. Any USDC transfer of 500 or more is an alert; the four rules show their state now.
2. Press "Check every 15 s": each run scans only the new blocks, and new alerts land on top, marked.
3. Change the low balance above the holder's balance: a new bot, and "Started: holds now" for the holder's balance.
4. Reload: the alerts are still there, and the next run carries on from the last block.
5. In a terminal: two `alert --store a.json --webhook … --proof run-N.json` runs, then `verify run-1.json run-2.json`, ending in "one history".

## X post draft

An on-chain alert bot on Pharos: it watches USDC through Pharos Chain MCP, run after run. Every large
transfer alerts once, from get_logs; a low balance, a paused token or high gas alert when they start
and when they stop. Alerts go to any webhook, and the proofs chain run to run.
https://pharos-agent-lab.vercel.app/tasks/22

## How it works (reply)

Each run pins the newest block, scans the Transfer logs since the last run's block, and reads each
condition at the pinned block. New transfers and changed conditions are alerts. The bot keeps the
block it got to and which conditions held, so the next run picks up exactly where this one stopped.
The verifier replays each run and checks the store chain.
