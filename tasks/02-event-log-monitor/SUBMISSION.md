# Task 02 submission: Event / Log Monitor

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/02 |
| Repository | [`tasks/02-event-log-monitor/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/02-event-log-monitor) |
| Proof | [`proof/mcp-transcript.json`](proof/mcp-transcript.json) and [`proof/report.json`](proof/report.json): 6 live polls, 19 Transfer events (3 mined after the monitor started), 2026-10-14T20:47:42Z; checked by `npm run verify-proof` |
| Pharos technology | Pharos Chain MCP, `https://mcp.pharos.xyz/mcp` (`get_chain_info`, `get_block_number`, `get_logs`) |

## Reviewer note

The monitor watches Circle USDC `Transfer` events on Pharos Mainnet and reports each new event once.
Each report decodes the event: from, to, amount with 6 decimals applied, transaction hash, block and
log index. It runs as a CLI (`--watch` polls every 5 s) and as a live web page.

## Key implementation detail

Every `get_logs` call filters on the exact contract address and the `Transfer` topic, over an explicit
range of at most 1,000 blocks. A cursor makes consecutive ranges contiguous, with no gaps or overlaps.
The dedup key is `transactionHash` + `logIndex`, so a re-delivered log is never printed twice, and a
removed log retracts what was shown. The verifier recomputes the report from the raw MCP responses.

## Video walkthrough (about 60 s)

1. Open `/tasks/02`: the monitor starts and new transfers appear as they land.
2. Open one event: decoded fields, then the transaction in the explorer.
3. Open Proof: the polls, the block ranges and the 19 events from the live run.
4. In a terminal: `npm run watch`, wait for a new transfer, then Ctrl+C for the summary.

## X post draft

A Pharos Mainnet event monitor on the Pharos Chain MCP: it watches USDC Transfer events, decodes each
one, and reports it once. Exact address and topic filters, contiguous block ranges, and a verifier
that rebuilds the report from the raw MCP responses. https://pharos-agent-lab.vercel.app/tasks/02

## How it works (reply)

It polls `get_logs` over contiguous block ranges of up to 1,000 blocks, filtered by contract and
`Transfer` topic. Each log is keyed by tx hash + log index, so nothing is reported twice.
