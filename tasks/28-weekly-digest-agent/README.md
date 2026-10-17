# Task 28: Weekly Digest Agent

An agent that sums up activity on Pharos Mainnet period by period, in plain language, through
**Pharos Chain MCP**. It covers a protocol (an official token: every transfer of it) or a wallet (its
transfers and approvals over every official token). Periods are UTC hours, days, or weeks from
Monday. Each period is compared with the one before, and its busiest part is named (a week's day, a
day's hour). With a store, a scheduled run digests each period once.

Code: [`agent/src/digest/`](../../agent/src/digest), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/28`.

## Requirement

The official task map: *"Produces a periodic summary of wallet or protocol activity."* The full task
page could not be reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| Periodic | Periods on the UTC calendar: hours, days, or weeks from Monday 00:00. Each period's first block is placed with `get_block`, by interpolating on the chain's own block times; each search starts where the last ended, so a boundary costs about two reads. A period holds its blocks from its start up to the next period's start, so periods never share a block. With `--store`, each run digests the periods completed since the last run, oldest first, each once: a cron line makes it a weekly digest. |
| Summary | Each period in sentences built from its figures, with no language model. It is compared with the period before (in the same run, or the store's last digest), and its busiest part is named. |
| Protocol activity | An official token's every `Transfer` log, one `get_logs` query per 1,000 blocks. From them: transfers between holders and their volume, senders and recipients, the largest transfer, who sent and who received the most, mints and burns, and transfers of nothing. The total supply now comes from `eth_call` at the newest block. |
| Wallet activity | Its Transfer and Approval logs over every official token, two queries per 1,000 blocks (as Task 26). From them: transfers in and out per token, its main counterparty, the approvals it gave, and transfers of nothing. Its holdings now come from `get_balance` and `eth_call` at the newest block. |

No state is read at an old block, only logs and block times. A node that keeps no history beyond
recent blocks can still serve a digest.

## Examples

The page opens on USDC over the last 3 complete hours and the hour so far. "WPROS" switches the
token. "A wallet" digests the address that moved the most USDC in Task 02's live proof, a public
address picked from real activity, not known to be anyone in particular.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js digest usdc --every day --periods 2         # the last two days of USDC
node dist/src/cli.js digest                                       # USDC, the last complete week
node dist/src/cli.js digest 0x… --every week --store weekly.json  # a wallet, on a schedule
node dist/src/cli.js digest wpros --every hour --periods 3 --so-far --json
```

A weekly line for cron (Mondays, 00:30 UTC): `30 0 * * 1 cd ~/pharos-season-of-ai/agent && node
dist/src/cli.js digest usdc --store usdc-weekly.json >> usdc-weekly.log`.

## The page

`/tasks/28` digests by the hour: a day or a week is more blocks than one request reads. It shows:
- the status: the last complete hour against the one before (Busier, Quieter, Steady, or Quiet);
- each hour, newest first, its lead sentence then the rest, and its blocks;
- the transfers each hour as bars;
- now: the token's total supply, or the wallet's holdings.

"Change the digest" takes a token or a wallet and 1 to 5 hours. The address bar keeps them, so a
digest can be linked.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
node dist/src/cli.js digest usdc --every hour --periods 3 --so-far --proof ../tasks/28-weekly-digest-agent/proof/usdc-hours.json
node dist/src/cli.js digest 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647 --every day --store ../tasks/28-weekly-digest-agent/proof/wallet-store.json --proof ../tasks/28-weekly-digest-agent/proof/wallet-day-1.json
# The next day (or later), the same line digests the day since, once:
node dist/src/cli.js digest 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647 --every day --store ../tasks/28-weekly-digest-agent/proof/wallet-store.json --proof ../tasks/28-weekly-digest-agent/proof/wallet-day-2.json
node dist/src/cli.js verify ../tasks/28-weekly-digest-agent/proof/usdc-hours.json
node dist/src/cli.js verify ../tasks/28-weekly-digest-agent/proof/wallet-day-1.json ../tasks/28-weekly-digest-agent/proof/wallet-day-2.json
```

The proofs are hourly and daily on purpose. A week of USDC records every transfer of the week, which
makes a proof of tens of megabytes. For each run, `verify` confirms:
- the official server answered, at the hosted endpoint;
- `get_chain_info` came first, on the right chain;
- the only state read was at the newest block;
- every `get_logs` page is inside the blocks the run says it read;
- replaying the recorded answers gives exactly the recorded figures, sentences and store.

Runs with one store also verify as one history: each starts from the store the last one left, so each
period is digested once.

## Tests

```sh
cd agent && npm test                                                  # the agent's tests, offline
node --test tasks/28-weekly-digest-agent/tests/page.test.mjs         # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/28-weekly-digest-agent/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. They cover:
- the calendar (weeks from Monday) and its labels;
- a token's hours, in exact sentences, each against the one before, the hour so far not compared;
- a wallet's hours, with an approval and its holdings;
- a week's busiest day and a day's busiest hour, on a chain of one block a minute;
- a schedule: each hour digested once, an idle run, two hours caught up, one history;
- the block cap, which cuts or defers periods and says so;
- the input checks, a token with no code, and the replay;
- the CLI and the HTTP route.

The browser suite drives the page against the real API handler. It covers:
- USDC on load, the example wallet, the form, and an invalid wallet;
- an unreachable Chain MCP;
- the proof, and six widths in both themes.

## Limits

- **The page digests by the hour, 5 hours at most.** One request reads at most 20,000 blocks. A day or
  a week is the CLI's: a week of a token is about 480 `get_logs` calls, paced under the hosted
  endpoint's 120 a minute, so it takes minutes. One run reads at most 1,000,000 blocks.
- **Official tokens only.** Other tokens' transfers, and PROS sent or received, leave no logs the
  agent reads.
- **The supply and holdings are now, not at each period's end.** Reading them at an old block would
  need a node that serves history, which a digest is built not to depend on.
- **Mints and burns are transfers from or to the zero address.** A token that mints otherwise is not
  counted as minting.
- **Pharos Mainnet on the page and API.** The CLI also takes `--network atlantic-testnet`.
