# Task 18 submission: Recurring Payment Agent

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/18 |
| Repository | [`tasks/18-recurring-payment/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/18-recurring-payment); code in [`agent/src/recurring/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/recurring) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_block`, `get_transaction_count`, `get_code`, `eth_call`, `get_balance`, `estimate_gas`, `get_gas_price`); on Atlantic, the official server run locally (`send_raw_transaction`, `get_transaction_receipt`). Pharos Skill Engine at `a873387`: its token list and `cast send` template |

## Reviewer note

The agent runs a schedule of repeating payments, a line each: "Rent: 25 USDC to 0x…, monthly on the
1st". Each run reads the chain's day and works out what fell due since the start and is not paid. It
takes the oldest, within limits, and prepares them through Chain MCP as one flow: each dry-run at one
block, the totals against the payer's holdings, the transactions to sign in nonce order. With the CLI's
store, what is paid is recorded. A missed run is caught up on the next, and nothing is paid twice. On
Atlantic it sends them, each checked against its receipt. Run it from cron.

## Key implementation detail

What is owed is never stored: each run works it out again from the schedule, the start day and the
payments recorded as paid. A payment that did not go through is simply still owed. One that was sent
but is not yet in a block is kept as pending and never sent again while it may land; the next run reads
its receipt and records it, or owes it again if it reverted. Days are the block's UTC days, not the
clock's, and a day past a month's end falls on its last day. Every run's proof replays from the store
it started with, and several runs verify as one history: each from the store the last one left, no
payment recorded twice.

## Video walkthrough (about 60 s)

1. Open `/tasks/18`: rent, payroll and a weekly tool, everything due since the 1st, oldest first, each
   dry-run, with the next due day of each and the transactions to sign.
2. "Every day": the oldest three taken, the rest waiting for the next run.
3. In a terminal, on Atlantic: run `recurring … --store atlantic.json --execute` twice. The first sends
   what is due, the second only what the first left; then `verify` both as one history.

## X post draft

Rent, payroll, subscriptions: a Pharos agent that pays on schedule. Each run works out what fell due at
the chain's own time, catches up what a missed run left, dry-runs it all through Pharos Chain MCP, and
records each payment so it is never paid twice. https://pharos-agent-lab.vercel.app/tasks/18

## How it works (reply)

A small grammar reads the schedule. The pinned block's UTC day says what is due; the store says what is
paid. eth_call and estimate_gas dry-run each payment at one block, and on Atlantic each is sent, checked
against its receipt, and recorded, with a pending one settled by its receipt next run.
