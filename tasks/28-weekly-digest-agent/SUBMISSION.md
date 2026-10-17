# Task 28 submission: Weekly Digest Agent

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/28 |
| Repository | [`tasks/28-weekly-digest-agent/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/28-weekly-digest-agent); code in [`agent/src/digest/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/digest) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_block`, `get_logs`, `eth_call`, `get_balance`) |

## Reviewer note

The agent writes a digest of on-chain activity, period by period: UTC hours, days, or weeks from
Monday. For a protocol (an official token such as USDC), each digest gives:
- every transfer and its volume, senders and recipients;
- the largest transfer, and who sent and received the most;
- mints, burns, and transfers of nothing.

For a wallet, it gives its transfers and approvals over every official token. Each period is
compared with the one before, and its busiest day or hour is named. With a store, a scheduled run
(cron) digests each period completed since the last one, exactly once. The page digests USDC hour by
hour; the CLI makes daily and weekly digests.

## Key implementation detail

Nothing is read at an old block except logs and block times. The period boundaries are found with
`get_block` by interpolating on the chain's own block times; each search starts from the blocks
already read, so a boundary costs about two reads. The activity comes from `get_logs`, so a digest
works even on a node that keeps no history. No language model: every sentence comes from a figure.
`pharos-agent verify` replays each run to the same figures and sentences, and checks that runs with
one store form one history, with no period digested twice or skipped.

## Video walkthrough (about 60 s)

1. Open `/tasks/28`: USDC hour by hour, newest first. Each hour's transfers, volume, the largest, who
   moved the most, mints and burns, against the hour before; the bars and the supply now.
2. "A wallet": the same for one address, with its approvals and its holdings now.
3. In a terminal: `digest usdc --every day --periods 2`, then `digest 0x… --every week --store
   weekly.json` twice. The second run says no week has ended since.
4. `verify` on two scheduled runs: one history, each period once.

## X post draft

A weekly digest agent for Pharos: it sums up a token's or a wallet's on-chain activity period by
period, through Pharos Chain MCP. Transfers, volume, the largest, who moved the most, mints and burns,
each week against the last. Run it on a schedule and each period is digested exactly once.
https://pharos-agent-lab.vercel.app/tasks/28

## How it works (reply)

get_block places each period's first block by interpolating on block times. get_logs reads every
Transfer of the token (or the wallet's transfers and approvals), and each log falls in its period by
block number. A store remembers the last period digested, so the next run picks up exactly there.
