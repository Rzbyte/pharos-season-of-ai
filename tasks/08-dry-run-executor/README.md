# Task 08: Dry-Run Executor

Before a transaction is sent, the executor says what it would do and what it would cost, all
through **Pharos Chain MCP**. It reads the state the transaction would change at one block,
simulates the transaction there and prices its gas the way the agent signs. The result is a verdict
and a before → after line for every balance it touches. On the Atlantic testnet it can then submit
the transaction and check the receipt against the prediction, line by line.

Code: [`agent/src/dryrun/`](../../agent/src/dryrun) and
[`agent/src/core/simulate.ts`](../../agent/src/core/simulate.ts), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/08`.

## Requirement

The official task map: *"Simulates a transaction's expected outcome and cost before real
submission."* The full task page could not be reached from the build environment; this is built to
that statement.

| What it asks | Where |
|---|---|
| A transaction | A transfer of PROS or a token, a token approval, or any contract call by signature (CLI). Each becomes the exact calldata that would be signed. |
| Its expected outcome | `eth_call` from the sender at a pinned block gives the verdict (would succeed, would revert with its reason) and the return value. Every value the transaction changes is read at the same block, then predicted after it: the sender's and recipient's token balances, an allowance, and the sender's PROS, which pays the gas. Warnings cover a contract recipient, a self-transfer, an unlimited approval, a spender with no code, and the zero address. |
| Its cost | `estimate_gas`, the latest base fee and `get_gas_price`'s priority fee. These are priced with the formula the agent signs with: the estimate plus 20 % as the limit, and a fee cap of twice the base fee plus the tip. The sender must hold the value plus that maximum, or the verdict is "can't pay". |
| Before real submission | Nothing is signed on mainnet: the hosted Chain MCP is read-only. On Atlantic, `--submit` sends the transaction, which is signed locally and broadcast with the official server's `send_raw_transaction`. It then compares every prediction with the chain after the receipt. |

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js dryrun                                   # 25 USDC between the example addresses, mainnet
node dist/src/cli.js dryrun --amount 1000000                  # more than the sender holds: would revert
node dist/src/cli.js dryrun native-transfer --amount 0.5      # PROS
node dist/src/cli.js dryrun erc20-approve --spender 0x… --amount max
node dist/src/cli.js dryrun call --to 0x… --signature "deposit(uint256)" --args '["1000"]'
node dist/src/cli.js dryrun --json                            # the full result
```

On Atlantic, with a key holding testnet USDC and some PHRS from the faucet:

```sh
PRIVATE_KEY=0x... node dist/src/cli.js dryrun --network atlantic-testnet --to 0x… --amount 1 --submit
```

`--submit` starts the official Chain MCP server locally over stdio with broadcasting on. It dry-runs
first and sends only a transaction that would succeed. After the receipt, it reads every predicted
value again at the receipt's block and the block before it. Token balances must change by exactly
the predicted amount, an allowance must be exactly the approved one, and the sender's PROS must drop
by exactly the value plus the fee the receipt reports. The gas used must fit the limit and the price
paid must fit the cap.

## The page

`/tasks/08` dry-runs a 25 USDC transfer between the example addresses on load, through
`GET /api/agent?task=08`. It shows:
- the verdict: would succeed, would revert or can't pay, with the reason;
- the block every value was read at;
- the outcome: each balance or allowance, its change, and before → after;
- the warnings;
- the cost: the simulation, gas, fee, the sender's funds against what it needs, and whether anything
  was sent (never, from the page).

The action (transfer or approve), asset, sender, recipient or spender, and amount can be changed. An
approval can be `max`. The transaction is kept in the address bar, so it can be shared. Proof &
technical details lists every Chain MCP call of the run and the raw result.

## Proof

**Pending: the first live run.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works), run:

```sh
cd agent && npm ci
node dist/src/cli.js dryrun --proof ../tasks/08-dry-run-executor/proof/transfer-mainnet.json
node dist/src/cli.js verify ../tasks/08-dry-run-executor/proof/transfer-mainnet.json
```

Optional, with a funded Atlantic key (the submitted run, with its receipt comparison):

```sh
PRIVATE_KEY=0x... node dist/src/cli.js dryrun --network atlantic-testnet --to 0xRECIPIENT --amount 1 --submit --proof ../tasks/08-dry-run-executor/proof/atlantic-submitted.json
```

`verify` does not trust the result. It confirms:
- the official server answered, at the hosted endpoint (mainnet) or locally (Atlantic);
- `get_chain_info` came first, on the right chain;
- every read of the dry run names the pinned block;
- replaying the recorded answers through the same code makes exactly the recorded calls and gives
  the identical prediction, cost and verdict;
- for a submitted run, the broadcast transaction is exactly the dry-run one, signed by its sender.

## Tests

```sh
cd agent && npm test                                                # the agent's tests, offline
node --test tasks/08-dry-run-executor/tests/page.test.mjs          # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/08-dry-run-executor/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. They cover:
- would succeed, would revert (a balance too low, a paused token), can't pay;
- the warnings, a native transfer, a raw call with a decoded return, an address with no code;
- an explicit block, which the proof must replay at that block;
- submission on Atlantic, where the receipt must match the prediction for a transfer and an
  approval, and refusal on mainnet or with a key that is not the sender's;
- proofs, and tampering with them;
- the CLI.

The browser suite drives the page against the real API handler: every verdict, the form (an
unlimited approval, invalid input), an unreachable Chain MCP, and six widths in both themes.

## Limits

- **Gas is priced at the latest state.** `estimate_gas` and `get_gas_price` take no block, so the
  cost describes the chain now, while the outcome describes the pinned block. A transaction that
  stops working in between is reported as a revert during gas estimation.
- **The outcome covers the values the transaction is meant to change.** It does not trace every
  internal call. A token with transfer fees or rebasing would differ from the prediction, and a
  submitted run reports that as a DIFF.
- **Submission is limited to Atlantic.** Mainnet runs predict only.
