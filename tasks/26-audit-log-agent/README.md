# Task 26: Audit-Log Agent

An agent that writes what one Pharos Mainnet address did over a period, as a report anyone can read.
It works through **Pharos Chain MCP**: the period placed in blocks, the address read at the block
before the period and at its end, and its token logs in between. The report covers:
- the transactions it sent;
- what it received and sent, and from and to whom;
- the approvals it gave;
- transfers of nothing (address poisoning's trace);
- every balance at the start and end, reconciled with the logs;
- a timeline.

Code: [`agent/src/audit/`](../../agent/src/audit), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/26`.

## Requirement

The official task map: *"Produces a plain-language activity report for a wallet over a selected
period."* The full task page could not be reached from the build environment; this is built to that
statement.

| What it asks | Where |
|---|---|
| A wallet | Any address: a wallet, a contract, or a wallet delegated under EIP-7702 (`get_code` says which). |
| A selected period | The last N hours (1 to 168), two times (`since` and `until`, UTC when no zone is given), or two blocks. A time is placed with `get_block`: the first block after `since` and the last at or before `until`, found by interpolating on the chain's own block times (about four reads on a regular chain, bisection where it is not). A block is in a period when its time is after the start and at or before the end, so back-to-back periods share no block. |
| Activity | `get_balance`, `get_transaction_count` and each official token's `balanceOf` (`eth_call`) at the block before the period and at its last block. `get_logs` over all four official tokens at once, 1,000 blocks a page, two queries a page: Transfer, Approval and WETH-style Deposit/Withdrawal logs from the address, then Transfer logs to it. |
| A plain-language report | Sentences built from those values, with no language model. Each token's flows and main counterparties come first. Then the approvals given, the transfers of nothing, the PROS change, and each token's balance with the share the logs explain. The page adds the balances and a timeline with links to the explorer. |

## Examples

The page opens on the address that moved the most USDC in Task 02's live proof, over the last hour.
It is a public address picked from real activity, not known to be anyone in particular. "The last 6
hours" widens the period. "Another address" switches to the one that sent the most in that proof.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js audit                                         # the example address, the last hour
node dist/src/cli.js audit 0x… --hours 24
node dist/src/cli.js audit 0x… --since 2026-10-17T00:00 --until 2026-10-17T12:00
node dist/src/cli.js audit 0x… --from-block 20250000 --to-block 20260000 --json
```

## The page

`/tasks/26` makes a report on load and on demand. It shows:
- the status: Active with its counts, Quiet when nothing happened, or Flagged for a transfer of
  nothing, an unlimited approval or a balance the logs do not explain;
- the report, sentence by sentence, under the period and its blocks;
- the balances at the start and end;
- the timeline, newest first, ten at a time.

"Change the report" takes any address and the last hour, the last 6 hours, or two times (UTC). The
address bar keeps the report's inputs, so a report can be linked.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
node dist/src/cli.js audit --proof ../tasks/26-audit-log-agent/proof/last-hour.json
node dist/src/cli.js audit 0x936564245B69f5a293b42cbd752E0eE3bb68b470 --hours 6 --proof ../tasks/26-audit-log-agent/proof/six-hours.json
node dist/src/cli.js verify ../tasks/26-audit-log-agent/proof/last-hour.json ../tasks/26-audit-log-agent/proof/six-hours.json
```

For each report, `verify` confirms:
- the official server answered, at the hosted endpoint;
- `get_chain_info` came first, on the right chain;
- every state read was at the block before the period or at its last block;
- every `get_logs` page is inside the blocks the report says it read;
- replaying the recorded answers through the same code makes exactly the recorded calls and gives
  exactly the recorded figures and sentences.

## Tests

```sh
cd agent && npm test                                                # the agent's tests, offline
node --test tasks/26-audit-log-agent/tests/page.test.mjs           # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/26-audit-log-agent/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. The fake serves past state,
Approval and wrapping logs, and irregular block times. They cover:
- an active hour, in exact sentences, reconciled;
- a quiet hour;
- periods by time and by block, back to back;
- placing a time on an irregular chain, checked against every block;
- a period trimmed to the most a report reads;
- a node that does not serve the older state;
- a contract, with a transfer to itself, a withdrawal, a revoked approval and a balance the logs do
  not explain;
- the input checks, the replay, and the call pacing;
- the CLI and the HTTP route.

The browser suite drives the page against the real API handler. It covers:
- the example on load, and a flagged six-hour report cut to 20,000 blocks;
- another address, and a period between two times;
- the long timeline, invalid input, and an unreachable Chain MCP;
- the proof, and six widths in both themes.

## Limits

- **20,000 blocks a page report, 100,000 in the CLI.** Each 1,000 blocks costs two `get_logs` calls
  on an endpoint allowed 120 a minute. A longer period is cut to its newest blocks, and the report
  says so. The CLI paces its calls under that rate, so a long period takes minutes.
- **Official tokens only.** Transfers of other tokens, and PROS sent or received, leave no logs the
  agent reads. The PROS change is reported as a whole: gas and transfers together.
- **Times on the timeline are estimates.** Only the period's two ends are read; a time in between is
  placed by its block number.
- **WETH-style wrapping is read, not assumed.** Deposit and Withdrawal logs are counted where the
  token emits them. A balance change no log explains is reported as such.
- **History depends on the node.** Reading the state before the period needs a node that serves it.
  If it does not, the opening balances and the count of transactions are unknown, and the report
  says why.
- **Pharos Mainnet on the page and API.** The CLI also takes `--network atlantic-testnet`.
