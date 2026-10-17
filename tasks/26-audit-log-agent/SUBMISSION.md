# Task 26 submission: Audit-Log Agent

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/26 |
| Repository | [`tasks/26-audit-log-agent/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/26-audit-log-agent); code in [`agent/src/audit/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/audit) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_block`, `get_balance`, `get_transaction_count`, `get_code`, `eth_call`, `get_logs`) |

## Reviewer note

Give it an address and a period (the last hours, two times, or two blocks) and it writes what the
address did, in plain sentences. Through Chain MCP it places the period in blocks from the chain's
own block times. It reads the address just before the period and at its end, and it reads its logs
over all four official tokens at once, in two queries per 1,000 blocks. The report gives:
- the transactions it sent (its nonce's change);
- what it received and sent, and from and to whom;
- the approvals it gave;
- transfers of nothing, the trace address poisoning leaves;
- each balance at the start and end, with the share the logs explain.

The page adds the balances and a timeline with explorer links, and flags anything worth a look.

## Key implementation detail

There is no language model: every sentence is built from a value read at one of two pinned blocks or
from a log, so a report is a proof. `pharos-agent verify` replays the recorded answers through the
same code and gets the same figures and sentences, word for word. The balances are reconciled: the
start, plus what the logs moved, against the end. A change no log explains is said, not hidden. A
node that cannot serve the older state leaves the opening unknown, and the report says why.

## Video walkthrough (about 60 s)

1. Open `/tasks/26`: the example address over the last hour, as sentences, with its balances and
   timeline.
2. "The last 6 hours": a longer report, flagged where something needs a look.
3. Change the report: another address, and a period between two times in UTC.
4. Proof: the block reads that placed the period, the log pages, the result as JSON.
5. In a terminal: `audit 0x… --hours 24 --proof report.json`, then `verify report.json`.

## X post draft

An audit-log agent for Pharos: pick an address and a period, and it reads the chain through Pharos
Chain MCP and writes what happened in plain sentences. Transactions, transfers and counterparties,
approvals, balances reconciled with the logs, and a timeline. No language model, so every report
replays as a proof.
https://pharos-agent-lab.vercel.app/tasks/26

## How it works (reply)

get_block places the period by interpolating on block times. Balances and the nonce are read just
before it and at its end. get_logs reads all four official tokens at once, two queries a page:
Transfer, Approval and wrapping from the address, then Transfer to it. Every figure feeds a sentence.
