# Task 23: Whale-Watching Agent

A watcher that tracks chosen addresses on Pharos through **Pharos Chain MCP**, run after run. On every
run it reports each address's holdings and what changed since the last run, and it surfaces the
significant moves. Each move is reported once. The rest is summed up per address, so a busy address
does not bury the moves that matter.

Code: [`agent/src/whale/`](../../agent/src/whale), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/23`.

## Requirement

The official task map: *"Tracks specified addresses and surfaces significant activity."* The full
task page could not be reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| Specified addresses | A watchlist is JSON: up to 10 addresses, each with a label, and up to 4 tokens from the network's official list (the Skill Engine's), each with its own significant amount. The page takes up to 5. |
| Tracks | Each run reads every address at the newest block, pinned for the run: its native balance (`get_balance`), nonce (`get_transaction_count`) and token balances (`eth_call` `balanceOf`). The first time it sees an address it also reads `get_code`, to tell a contract from a wallet. The store keeps the last block scanned (the cursor) and each address as it was. The CLI's store is a file (`--store`); the page's is the browser's storage, sent with each run. |
| Activity | The tracked tokens' Transfer logs since the last run, through `get_logs`, in pages of at most 1,000 blocks. Each page is two queries whatever the number of addresses: one for transfers any tracked address sent, one for transfers any received (the addresses as an OR list in the topic). |
| Surfaces significant activity | A transfer of at least the token's significant amount, sent or received by a tracked address, is a move, reported once. A change of an address's native balance of at least the native amount since the last run is a move too, since native transfers leave no logs. Everything else is counted per address: transfers in and out with their totals, holdings and their change, transactions sent (the nonce's change). |

## The USDC watchlist

The shipped watchlist (`usdc`) tracks four addresses on Pharos Mainnet. They are the four that moved
the most USDC in [Task 02's live proof](../02-event-log-monitor/proof): 19 Transfer events over about
110 blocks. They were picked from real activity and are not known to be anyone in particular.

| Address | Label | In the sample |
|---|---|---|
| `0x912c…f647` | Busiest in the sample | 16 transfers (the example holder of Tasks 05 to 22) |
| `0x9365…b470` | Sent the most | 698.77 USDC sent |
| `0x1F35…c85C` | Trades with the busiest | 8 transfers, all with `0x912c…f647` |
| `0x0018…E28D` | Sent the largest transfer | 600 USDC in one transfer |

In that sample the largest transfer was 600 USDC and most were under 100, so a USDC transfer of 250 or
more is significant. A PROS balance change of 100 or more between runs is too. That amount is a round
number, not measured. A first run looks back 1,000 blocks, about 20 minutes. A run more than 2,000
blocks behind scans the newest 2,000 and says which blocks it skipped.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js whales                                    # one run; whale-store.json is created
node dist/src/cli.js whales my-list.json --store mine.json --json
```

A watcher runs on a schedule (cron, a loop): each run is one look at the chain. The full schema and
its checks are in [`agent/src/whale/config.ts`](../../agent/src/whale/config.ts):

```json
{
  "name": "Treasuries", "network": "pharos-mainnet", "lookback": 1000, "maxScan": 2000,
  "addresses": [{ "address": "0x…", "label": "Treasury" }, "0x…"],
  "tokens": [{ "token": "0xC879C018dB60520F4355C26eD1a6D572cdAC1815", "min": "10000" }],
  "native": { "min": "1000" }
}
```

An address can be given alone, and is then labelled with its short form. `native` can be `null` to
show native balances without surfacing their changes.

## The page

`/tasks/23` runs the USDC watchlist on load. The page keeps the store: each run sends the last block
scanned and each address as it was to `GET /api/agent?task=23`, and the agent reads only what is new
through Chain MCP. It shows:
- the state: Spotted when a run surfaced something new, else Watching, with the number of transfers;
- the blocks this run scanned, and any it had to skip;
- the significant moves, newest first, this run's marked: who, what moved and to or from whom (a
  tracked counterparty by its label), the block and the transaction;
- each tracked address: its USDC and PROS now, the change since the last check, the transfers in
  and out this run, the transactions it sent, and whether it is a contract.

"Check now" runs again, and "Check every 30 s" keeps it running while the page is open. A run that
surfaces something while the tab is in the background puts the count in the tab's title. The
addresses (up to 5) and both significant amounts can be changed; each set of settings is its own
watcher with its own memory, and the settings are kept in the address bar.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works), run the watcher a few times, a minute or so apart:

```sh
cd agent && npm ci
for i in 1 2 3; do node dist/src/cli.js whales --store ../tasks/23-whale-watching-agent/proof/store.json --proof ../tasks/23-whale-watching-agent/proof/run-$i.json; sleep 60; done
node dist/src/cli.js verify ../tasks/23-whale-watching-agent/proof/run-1.json ../tasks/23-whale-watching-agent/proof/run-2.json ../tasks/23-whale-watching-agent/proof/run-3.json
```

What is significant depends on the real chain. Either way the runs prove the tracking. `verify` does
not trust the results. For each run it confirms:
- the official server answered, at the hosted endpoint;
- `get_chain_info` came first, on the right chain;
- every read was at the pinned block, and every `get_logs` call inside the blocks the run says it
  scanned, none over 1,000 blocks;
- replaying the recorded answers through the same code makes exactly the recorded calls and gives
  exactly the recorded moves, reports and store.

For the runs together, it confirms they are one history, each starting from the store the last one
left.

## Tests

```sh
cd agent && npm test                                                # the agent's tests, offline
node --test tasks/23-whale-watching-agent/tests/page.test.mjs      # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/23-whale-watching-agent/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it, moved on between runs. They
cover:
- every malformed watchlist and store refused, a token not on the official list included;
- a first run: holdings, contracts told from wallets, and the two `get_logs` queries. Of the
  transfers, a significant one is surfaced; one between two tracked addresses is surfaced once, as
  the sender's; one under the amount, to itself or of nothing is only counted. One between others,
  one before the lookback and one of another token are left out;
- three runs: changes since the last run, transactions sent, a native balance change surfaced once,
  nothing new at the same block;
- a run far behind, scanned in pages with the skipped blocks named, and a snapshot from a later block
  kept and not compared;
- proofs, a changed answer, and the history check;
- the CLI over two runs of one store file, and the HTTP route with its input checks.

The browser suite drives the page against the real API handler: the first run, moves and changes
across runs and a reload, the background-tab title, settings, invalid input, the 30 s timer, an
unreachable Chain MCP, the proof, and six widths in both themes.

## Limits

- **Native transfers are seen as balance changes**, between two runs, not one by one. They leave no
  logs, and finding each would mean reading every block. A change made of several small transfers
  between two runs counts as one change.
- **Tokens are the official list's.** Other tokens' transfers are not scanned.
- **The page's store is the browser's own.** The agent checks its shape but takes its values as
  given. The CLI's store file, with its proofs, is the record that verifies.
- **One run reports at most 100 significant transfers**, the oldest first, and says how many more
  there were. A balance change is always reported.
- **"Significant" is an amount, not a judgement.** The watcher surfaces size; it does not say why a
  move happened or who is behind an address.
