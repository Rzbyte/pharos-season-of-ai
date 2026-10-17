# Task 09: Trend Watcher

A watcher that reads one on-chain value through **Pharos Chain MCP** on each run and keeps every
observation in a store between runs. It acts only when the observations show a trend, and once per
trend. The action is a transaction that is dry-run first (Task 08) and, on the Atlantic testnet, sent.

Code: [`agent/src/trend/`](../../agent/src/trend), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/09`.

## Requirement

The official task map: *"Persists observations across runs and acts only when a multi-observation
trend condition is satisfied."* The full task page could not be reached from the build environment;
this is built to that statement.

| What it asks | Where |
|---|---|
| Persists observations | A store (JSON). Each run adds one observation, read at the newest block: its block, time and raw value. A run fewer than `everyBlocks` blocks after the last observation records nothing, and the newest `keep` observations are kept. The CLI's store is a file (`--store`); the page's is the browser's storage, sent with each run. |
| Across runs | Each proof records the store its run started from and the one it left. `verify run-1.json run-2.json …` checks the runs as one history: each must start from exactly the store the run before it left. |
| A multi-observation trend condition | Falling or rising across the last N observations, a change in percent over the last N, or a threshold held in each of the last N. Only observations made since the watcher last acted count. |
| Acts only when it is satisfied | Only a run whose new observation completes the trend acts. Its action is dry-run at the same block and, on Atlantic with `--execute`, sent if the dry run succeeds. The store records the block it acted at, so one trend is acted on once. |

## The USDC watcher

The shipped watcher (`usdc-outflow`) watches the USDC held by the example address from Tasks 05, 08
and 11, a public address seen moving USDC in Task 02's live proof. It trades every few blocks, so its
balance moves.

| | |
|---|---|
| Observes | `balanceOf(holder)` on Circle USDC, with `eth_call` at the newest block (and `decimals()`, checked against the official token list) |
| Spacing | at least 10 blocks between observations |
| Trend | the balance fell across the last 3 observations (2 steps down out of 2) |
| Action | a 100 USDC top-up from the example recipient, prepared and simulated; never sent on mainnet |

## Run it

Each run is one observation, so a watcher runs on a schedule (cron, a loop, or by hand):

```sh
cd agent && npm ci
node dist/src/cli.js watch --store watch.json                # one run; the store file is created
for i in 1 2 3; do sleep 30; node dist/src/cli.js watch --store watch.json; done
node dist/src/cli.js watch my-watcher.json --store mine.json
```

A watcher is JSON. The full schema and its checks are in
[`agent/src/trend/config.ts`](../../agent/src/trend/config.ts):

```json
{
  "name": "Gas watcher", "network": "pharos-mainnet",
  "observe": { "kind": "gas-price" },
  "everyBlocks": 50, "keep": 100,
  "trend": { "kind": "sustained", "observations": 3, "op": ">", "value": "5" },
  "action": { "kind": "native-transfer", "from": "0x…", "to": "0x…", "amount": "0.1" }
}
```

- **Observe:** `erc20-balance`, `native-balance`, `call` (a view returning an integer, with its
  decimals), `gas-price`, `nonce`.
- **Trend:** `falling` or `rising` (`observations`), `change` (`observations`, `percent` like `"-5"`),
  `sustained` (`observations`, `op` `<` `<=` `>` `>=`, `value` in the value's own units).
- **Action:** optional, a transfer or approval as `dryrun` takes it. Without one, the watcher fires as
  an alert.

On Atlantic, a watcher of your own (`"network": "atlantic-testnet"`, its action from the address of
`PRIVATE_KEY`) can send its action: `PRIVATE_KEY=0x... node dist/src/cli.js watch my-watcher.json
--store mine.json --execute`.

## The page

`/tasks/09` runs the USDC watcher on load. The page keeps the store: each run sends the observations
kept in this browser to `GET /api/agent?task=09`, and the agent adds one, read through Chain MCP.
It shows:
- the state, Watching or Fired, and how far the trend has got;
- the observations, newest first, with their changes, the ones the trend was judged on marked and the
  ones before the last action dimmed;
- the action: when it fires, what it does, this run's dry run, and that nothing was sent.

"Observe now" runs again, and "Observe every 15 s" keeps it running while the page is open. The holder,
trend, number of observations and block spacing can be changed. A holder's observations stay apart from
any other holder's, and the settings are kept in the address bar.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works), run the watcher a few times, some blocks apart:

```sh
cd agent && npm ci
for i in 1 2 3 4; do node dist/src/cli.js watch --store ../tasks/09-trend-watcher/proof/store.json --proof ../tasks/09-trend-watcher/proof/run-$i.json; sleep 30; done
node dist/src/cli.js verify ../tasks/09-trend-watcher/proof/run-1.json ../tasks/09-trend-watcher/proof/run-2.json ../tasks/09-trend-watcher/proof/run-3.json ../tasks/09-trend-watcher/proof/run-4.json
```

Whether the trend fires depends on the real balance. Either way the runs prove the watching. `verify`
does not trust the results. For each run it confirms:
- the official server answered, at the hosted endpoint;
- `get_chain_info` came first, on the right chain;
- the observation was read at the pinned block and comes after every stored one;
- replaying the recorded answers through the same code makes exactly the recorded calls and leaves
  exactly the recorded store.

For the runs together, it confirms they are one history, each starting from the store the last one
left.

## Tests

```sh
cd agent && npm test                                                # the agent's tests, offline
node --test tasks/09-trend-watcher/tests/page.test.mjs             # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/09-trend-watcher/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it, moved on between runs. They
cover:
- every malformed watcher and store refused;
- each kind of trend, judged exactly;
- four runs: observations accumulating, firing on the third, and the fourth starting over;
- too soon (nothing read or recorded), and a failed read (nothing judged on stale values);
- execution on Atlantic when the trend holds, refused on mainnet;
- proofs, a changed store, and the history check (out of order, a run missing);
- the CLI over three runs of one store file, and the HTTP route with its input checks.

The browser suite drives the page against the real API handler: the first run, persistence across
runs and a reload, firing once, too soon, forgetting, settings, invalid input, the 15 s timer, an
unreachable Chain MCP, and six widths in both themes.

## Limits

- **The page's store is the browser's own.** The agent checks its shape and order but takes its
  values as given: they are the viewer's own observations. The CLI's store file, with its proofs, is
  the record that verifies.
- **One observation per run, at the newest block.** The gas price is read live; the other values at
  the pinned block.
- **Acting is once per trend.** A trend whose action fails in the dry run is still used up; the next
  trend counts only later observations.
- **Execution is limited to Atlantic.** Mainnet runs prepare and simulate only.
