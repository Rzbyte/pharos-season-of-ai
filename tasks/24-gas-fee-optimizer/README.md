# Task 24: Gas Fee Optimizer

An optimizer that watches the fee on Pharos through **Pharos Chain MCP**, run after run, and decides
for one transaction whether to send it now or wait for a cheaper block. It also says what fee settings
to send it with: a cap at the target, so it never pays more. And it prices the transaction both ways.
On the Atlantic testnet it sends the transaction itself when the decision is to send, once.

Code: [`agent/src/gas/`](../../agent/src/gas), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/24`.

## Requirement

The official task map: *"Observes gas conditions and optimizes transaction timing/cost."* The full
task page could not be reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| Observes gas conditions | Each run pins the newest block and reads its base fee and how full it is (`get_block`), and the node's priority fee (`get_gas_price`). On a chain whose blocks carry no base fee, the gas price is the observation instead. The store keeps the newest observations between runs (12 by default). A run with none yet reads the base fee of 5 earlier blocks, 200 apart, so a first run has something to judge by. The CLI's store is a file (`--store`); the page's is the browser's storage, sent with each run. |
| Optimizes timing | The target is a percentile of the observed fees (the cheapest quarter by default) or a fixed fee. At or below the target: send now. Above it: wait, and say what waiting would save. A deadline in blocks bounds the wait: past it, it sends at the fee of the moment. A steady fee is sent at once, since waiting saves nothing. |
| Optimizes cost | The transaction is dry-run at the pinned block (Task 08) for its gas. The run prices it now, at the target and at most, and gives the fee settings: `maxFeePerGas` is the target plus the priority fee, so it never pays more than the target (past the deadline, the fee of the moment). It sets that against the usual cap of twice the base fee plus the priority fee. |
| Transaction | Any transaction Task 08 takes: a transfer of PROS or a token, an approval, or a contract call. A transaction that would revert is not sent at any fee. |

## Pharos's fee

No live gas data could be read from the build environment. Rather than assume what Pharos fees look
like, the optimizer judges each fee against the fees it has observed, so its defaults hold whatever
the real numbers are. If the base fee sits at a floor, every observation is the same. The optimizer
then says so and sends: "The base fee has held at 1 gwei across 6 observations, so waiting saves
nothing." (That line comes from a test, not the chain.)

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js gas                                       # the usdc plan; gas-store.json is created
for i in 1 2 3; do node dist/src/cli.js gas --store gas.json; sleep 60; done
PRIVATE_KEY=0x... node dist/src/cli.js gas atlantic-usdc --store atlantic.json --execute
```

`atlantic-usdc` sends 1 testnet USDC from the key's address to the example recipient once the fee is
at or below the median of the last 12 observations, or after 240 blocks. A plan is JSON. The full
schema and its checks are in [`agent/src/gas/config.ts`](../../agent/src/gas/config.ts):

```json
{
  "name": "Payroll, timed", "network": "pharos-mainnet",
  "transaction": { "kind": "erc20-transfer", "token": "0x…", "from": "0x…", "to": "0x…", "amount": "1000" },
  "target": { "percentile": 10 },
  "window": 24,
  "backfill": { "samples": 8, "spacing": 150 },
  "deadline": 2880
}
```

`target` can also be `{ "gwei": "1.1" }`. `backfill` can be `null`, to wait for runs instead.
`deadline` can be `null`, to wait for the target however long it takes.

## The page

`/tasks/24` times Task 08's example, a 25 USDC transfer, on load. The page keeps the observations and
shares them between every transaction timed there (the fee is the chain's, not the transaction's).
Each run sends them to `GET /api/agent?task=24`, and the agent adds the newest block's through Chain
MCP. It shows:
- the decision, Send now, Wait or Not sendable, with the fee against the target, and why;
- the observed base fees, newest first, as bars against the highest, the ones at or under the target
  marked, with the lowest, median and highest;
- the target, the fee settings, the cost now and at the target, and the most each cap can cost.

"Check now" runs again, and "Check every 30 s" keeps it running while the page is open. The asset,
amount, sender, recipient and target can be changed, and are kept in the address bar. Waiting is
counted per transaction: another transaction starts its own wait.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works), run the plan a few times, a minute or so apart:

```sh
cd agent && npm ci
for i in 1 2 3; do node dist/src/cli.js gas --store ../tasks/24-gas-fee-optimizer/proof/store.json --proof ../tasks/24-gas-fee-optimizer/proof/run-$i.json; sleep 60; done
node dist/src/cli.js verify ../tasks/24-gas-fee-optimizer/proof/run-1.json ../tasks/24-gas-fee-optimizer/proof/run-2.json ../tasks/24-gas-fee-optimizer/proof/run-3.json
```

Optionally, on Atlantic with a testnet key holding at least 1 USDC and some PHRS:
`PRIVATE_KEY=0x... node dist/src/cli.js gas atlantic-usdc --store ../tasks/24-gas-fee-optimizer/proof/atlantic-store.json --execute --proof ../tasks/24-gas-fee-optimizer/proof/atlantic-run.json`.
Run it again until it sends.

`verify` does not trust the results. For each run it confirms:
- the official server answered, at the hosted endpoint on mainnet;
- `get_chain_info` came first, on the right chain;
- every state read before a send was at the pinned block;
- replaying the recorded answers through the same code makes exactly the recorded calls and gives
  exactly the recorded observations, decision, settings and store;
- for a run that sent, the broadcast transaction is exactly the dry-run one, signed by its sender,
  with exactly the decided `maxFeePerGas` and `maxPriorityFeePerGas`.

For the runs together, it confirms they are one history, each starting from the store the last one
left.

## Tests

```sh
cd agent && npm test                                                # the agent's tests, offline
node --test tasks/24-gas-fee-optimizer/tests/page.test.mjs         # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/24-gas-fee-optimizer/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it, each block with its own base
fee. They cover:
- every malformed plan and store refused;
- a first run reading five earlier blocks, and the exact target, settings and costs;
- waiting, then sending when the fee comes down;
- the deadline, a steady fee, the window keeping the newest;
- a transaction that would revert, never sent, and a fixed target in gwei;
- a chain without base fees, observed by its gas price;
- sending on Atlantic once, with the decided cap checked in the proof, and never on mainnet;
- proofs and the history check;
- the CLI over two runs of one store file, and the HTTP route with its input checks.

The browser suite drives the page against the real API handler: the first run, observations across
runs and a reload, another transaction sharing the observations but not the wait, a revert, invalid
input, the 30 s timer, an unreachable Chain MCP, the proof, and six widths in both themes.

## Limits

- **It judges the fee against what it has seen**, not a forecast. A percentile of the last 12
  observations is a target the chain has met recently, not a promise it will again.
- **The base fee of the pinned block.** A transaction lands in a later block, whose base fee can
  differ. The cap protects the cost: with the target as the cap, a transaction waits rather than pays
  more.
- **Observations are what the runs saw**, one per run, plus five earlier blocks on a first run. Runs
  far apart see little of what happened between them.
- **Sending is limited to Atlantic**, once per plan. On mainnet the optimizer advises.
