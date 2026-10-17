# Task 09 submission: Trend Watcher

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/09 |
| Repository | [`tasks/09-trend-watcher/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/09-trend-watcher); code in [`agent/src/trend/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/trend) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp`, and the official server run locally for Atlantic execution (`send_raw_transaction`) |

## Reviewer note

Each run reads one value through Chain MCP at the newest block: a USDC balance, read with `eth_call`.
It adds the value to a store that persists between runs: a file for the CLI, the browser's storage on
the page. The watcher acts only when the observations made since its last action show the trend, here
a balance that fell across three observations. It acts once per trend. The action, a top-up, is
dry-run at the same block. Runs too close together record nothing. On Atlantic, `--execute` sends the
action when its dry run succeeds.

## Key implementation detail

Persistence is part of the proof. Each run's proof records the store it started from and the one it
left, and `pharos-agent verify run-1.json run-2.json …` checks two things. Each run replays from its
recorded Chain MCP answers to exactly the recorded result. The runs also form one history: each
started from exactly the store the run before it left. A missing or reordered run fails.

## Video walkthrough (about 60 s)

1. Open `/tasks/09`: Watching, one observation of the holder's USDC, kept in this browser.
2. Press "Observe every 15 s" and let a few observations arrive, each with its change.
3. When the balance has fallen across three: Fired. The watcher dry-runs the top-up, nothing is sent, and the trend's rows are marked.
4. Reload: the observations are still there. The next run counts only observations after the action.
5. In a terminal: three `watch --store s.json --proof run-N.json` runs, then `verify run-1.json run-2.json run-3.json`, ending in "one history".

## X post draft

A trend watcher on Pharos: every run reads one on-chain value through Pharos Chain MCP and adds it to
a store kept between runs. It acts only when the observations show the trend, once per trend, with
the action dry-run first. The proofs chain together: each run starts where the last one left off.
https://pharos-agent-lab.vercel.app/tasks/09

## How it works (reply)

Each run pins the newest block, reads the balance there, and appends it to the store. It then checks
the last N observations made since its last action: has it fallen at every step? If so it acts once,
dry-running the top-up at that block. The verifier replays each run and checks the store chain.
