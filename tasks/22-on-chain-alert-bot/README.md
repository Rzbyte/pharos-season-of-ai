# Task 22: On-Chain Alert Bot

An alert bot that watches Pharos through **Pharos Chain MCP**, run after run. It reports every
transfer that matches a rule once, and every watched condition when it starts to hold and when it
stops. Between runs it remembers the last block it scanned and which conditions held, so nothing is
reported twice and no block is skipped silently.

Code: [`agent/src/alert/`](../../agent/src/alert), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/22`.

## Requirement

The official task map: *"Watches for selected on-chain conditions and alerts when they occur."* The
full task page could not be reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| Selected conditions | A bot is JSON: up to 12 rules, each with an id and a label. A **transfer rule** selects a token's transfers by smallest amount, sender and recipient. A **state rule** is a condition as Task 05 reads one: a token or native balance, a view call, the gas price or a nonce, against a threshold. |
| On-chain | Read through Chain MCP at the newest block, pinned for the run. Transfers come from `get_logs` (the token's `Transfer` logs, filtered by sender and recipient as topics), in pages of at most 1,000 blocks, the server's limit. |
| Watches | Each run covers the blocks since the last. The store keeps the last block scanned (the cursor), whether each condition held, and the alerts not yet delivered. The CLI's store is a file (`--store`); the page's is the browser's storage, sent with each run. |
| Alerts when they occur | A matching transfer is one alert, once: the next run starts after this run's block. A condition alerts when it starts to hold ("triggered") and when it stops ("resolved"), not on every run. The CLI prints each alert and, with `--webhook`, posts it as JSON; an alert the webhook refused stays pending and is sent on the next run. The page lists them, newest first. |

## The USDC bot

The shipped bot (`usdc`) watches Circle USDC on Pharos Mainnet:

| Rule | Alerts on | Read with |
|---|---|---|
| `large-transfer` | a USDC transfer of 500 or more | `get_logs` |
| `holder-low` | the example holder's USDC below 100 | `eth_call` `balanceOf` (and `decimals()`, checked against the official token list) |
| `usdc-paused` | `paused()` returning true, which would stop every transfer | `eth_call` |
| `gas-high` | the gas price above 5 gwei | `get_gas_price` |

The example holder is the public address from Tasks 05 to 11, seen moving USDC in Task 02's live
proof. A first run looks back 1,000 blocks, one `get_logs` page, about 20 minutes. A run more than
2,000 blocks behind scans the newest 2,000 and says which blocks it skipped.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js alert                                    # one run; alert-store.json is created
node dist/src/cli.js alert --store alerts.json --webhook https://hooks.example/...
node dist/src/cli.js alert my-bot.json --store mine.json --json
```

A bot runs on a schedule (cron, a loop): each run is one look at the chain. The full schema and its
checks are in [`agent/src/alert/config.ts`](../../agent/src/alert/config.ts):

```json
{
  "name": "Treasury alerts", "network": "pharos-mainnet", "lookback": 1000, "maxScan": 2000,
  "rules": [
    { "kind": "transfer", "id": "out", "token": "0x…", "from": "0xTREASURY", "min": "0" },
    { "kind": "state", "id": "low", "label": "Treasury below 1,000 USDC",
      "read": { "kind": "erc20-balance", "token": "0x…", "holder": "0xTREASURY" }, "op": "<", "value": "1000" }
  ]
}
```

With `--webhook`, each alert is one `POST` of JSON: `{ "text", "content", "bot", "alert" }`. The one-line
summary is in `text` (Slack's field) and `content` (Discord's), so either incoming webhook takes it as
it is; `alert` has everything, including the transaction hash. A delivery that fails (an error, a
non-2xx answer, 10 s without one) leaves the alert pending in the store, and the next run sends it
first. A webhook that does not answer at all is not tried again in the same run; the alerts after it
wait for the next. The webhook's URL, a secret for Slack and Discord, is never written to the store,
the proof or the output.

## The page

`/tasks/22` runs the USDC bot on load. The page keeps the store: each run sends the last block scanned
and which conditions held to `GET /api/agent?task=22`, and the agent reads only what is new through
Chain MCP. It shows:
- the state: Alert when a run found something new, else Watching, and how many conditions hold;
- the blocks this run scanned, and any it had to skip;
- the alerts, newest first, this run's marked: what happened, the rule, the block and the transaction;
- every rule with its state now and the Chain MCP tool that read it.

"Check now" runs again, and "Check every 15 s" keeps it running while the page is open. A run that
alerts while the tab is in the background puts the count in the tab's title. The smallest transfer,
the holder and the low balance can be changed; each set of settings is its own bot with its own
alerts, and the settings are kept in the address bar.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works), run the bot a few times, a minute or so apart:

```sh
cd agent && npm ci
for i in 1 2 3; do node dist/src/cli.js alert --store ../tasks/22-on-chain-alert-bot/proof/store.json --proof ../tasks/22-on-chain-alert-bot/proof/run-$i.json; sleep 60; done
node dist/src/cli.js verify ../tasks/22-on-chain-alert-bot/proof/run-1.json ../tasks/22-on-chain-alert-bot/proof/run-2.json ../tasks/22-on-chain-alert-bot/proof/run-3.json
```

What alerts depends on the real chain. Either way the runs prove the watching. `verify` does not trust
the results. For each run it confirms:
- the official server answered, at the hosted endpoint;
- `get_chain_info` came first, on the right chain;
- every read was at the pinned block, and every `get_logs` page inside the blocks the run says it
  scanned, none over 1,000 blocks;
- replaying the recorded answers through the same code makes exactly the recorded calls and gives
  exactly the recorded alerts and store;
- the delivery names only alerts the run had.

For the runs together, it confirms they are one history: each started from the store the last one
left, minus what it delivered.

## Tests

```sh
cd agent && npm test                                                # the agent's tests, offline
node --test tasks/22-on-chain-alert-bot/tests/page.test.mjs        # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/22-on-chain-alert-bot/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it, moved on between runs. They
cover:
- every malformed bot and store refused;
- a first run: the transfers in the lookback of the smallest amount or more, and not those just under
  it, before the lookback or of another token;
- three runs: each transfer once, the low balance alerted when it starts and when it stops, nothing
  new at the same block;
- a run far behind, scanned in pages with the skipped blocks named;
- an unreadable value keeping its last state, and the 100-transfer cap, which never cuts a condition's
  alert;
- webhook delivery: a refused alert kept and sent on the next run, and a webhook that does not answer
  not tried again in the same run;
- proofs, a changed log, and the history check;
- the CLI over three runs of one store file with a local webhook, and the HTTP route with its input
  checks.

The browser suite drives the page against the real API handler: the first run, alerts across runs and
a reload, the background-tab title, a run far behind, settings, invalid input, the 15 s timer, an
unreachable Chain MCP, the proof, and six widths in both themes.

## Limits

- **The page's store is the browser's own.** The agent checks its shape but takes its values as
  given: they are the viewer's own. The CLI's store file, with its proofs, is the record that
  verifies.
- **The page shows; the CLI delivers.** Alerts on the page appear while it is open. A webhook needs a
  bot that runs on a schedule: the CLI.
- **Polling, not streaming.** The hosted Chain MCP has no subscriptions. A transfer is seen on the
  first run after it lands; between runs nothing is missed, up to 2,000 blocks.
- **One run reports at most 100 transfers**, the oldest first, and says how many more matched; the
  rest are counted, not reported. A condition's change is always reported. A store keeps at most 500
  undelivered alerts, dropping the oldest.
- **The gas price is read live**; every other value at the pinned block.
