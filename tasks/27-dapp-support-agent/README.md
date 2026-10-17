# Task 27: dApp Support Agent

A support agent that answers "why did my transaction fail?" for any Pharos Mainnet transaction,
through **Pharos Chain MCP**. Each finding comes with the tool it was read with, and the answer ends
with what to do about it. It explains a transaction that was never sent, too: why it would fail if
sent now.

Code: [`agent/src/support/`](../../agent/src/support), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/27`.

## Requirement

The official task map: *"Explains transaction failures on request."* The full task page could not be
reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| On request | A transaction hash, asked on the page, in the CLI (`explain 0x…`) or the API (`?task=27&hash=0x…`). Or a transaction described as Task 08 takes it, not sent. |
| Transaction failures | `get_transaction` and `get_transaction_receipt`: succeeded, failed, still pending, or unknown to the network. For a failure, the call is replayed at the block before its own (`eth_call` with its sender, target, data and value), which returns the revert data. `get_code` says whether the target is a contract. For a transfer of an official token, the sender's balance there; for a `transferFrom`, the allowance too. All of it is read at that one block. |
| Explains | The revert in plain language: `Error(string)` with hints for the common token messages, Solidity's `Panic` codes, and the custom errors of OpenZeppelin Contracts 5 (`ERC20InsufficientBalance`, `ERC20InsufficientAllowance`, `OwnableUnauthorizedAccount`, `AccessControlUnauthorizedAccount`, `EnforcedPause` and more), with token amounts in the token's units. A failure that used all its gas ran out of gas. One whose replay succeeds failed on something earlier in its own block. Each answer gives the cause, every finding with its tool, and a fix where there is one. |

No language model is involved. Every sentence is built from a decoded value, so the answer replays
from the recorded Chain MCP answers exactly.

## Examples

The page opens on a transfer of 5,000,000 USDC from the example sender of Tasks 05 to 24, which holds
far less. It is described, not sent, and explained as it would fail now, against the real chain. No
failed mainnet transaction hash was available to the build, and none is made up. The second example
is a real transaction from [Task 02's live proof](../02-event-log-monitor/proof): 600 USDC in block
20,250,972 (`0x968810…510c`). It succeeded, and the agent says so.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js explain 0x968810950de8d8fa80d17a9e1d03b72e8806a0d11d89579459bceaee45ce510c
node dist/src/cli.js explain 0x<your failed transaction>
node dist/src/cli.js explain --amount 5000000                 # Task 08's example transfer, too large
node dist/src/cli.js explain erc20-approve --spender 0x… --amount max --json
```

## The page

`/tasks/27` has a box for a transaction hash and the two examples. An answer shows:
- the state: Failed, Succeeded, Would fail, Would succeed, Pending or Not found, with the cause in a
  few words;
- the transaction in words, the cause in a sentence, and what to do about it;
- what it checked: each finding, what it saw, and the Chain MCP tool, the ones that are the cause
  marked;
- the transaction: its hash (linked to the explorer), sender, target, gas used of its limit, fee and
  nonce.

The hash, or the description, is kept in the address bar, so an answer can be linked.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
node dist/src/cli.js explain 0x968810950de8d8fa80d17a9e1d03b72e8806a0d11d89579459bceaee45ce510c --proof ../tasks/27-dapp-support-agent/proof/real-transfer.json
node dist/src/cli.js explain --amount 5000000 --proof ../tasks/27-dapp-support-agent/proof/would-fail.json
node dist/src/cli.js verify ../tasks/27-dapp-support-agent/proof/real-transfer.json
node dist/src/cli.js verify ../tasks/27-dapp-support-agent/proof/would-fail.json
```

A failed mainnet transaction's hash, when one is found, makes a third: `explain 0x… --proof
../tasks/27-dapp-support-agent/proof/failed.json`. For each answer, `verify` confirms:
- the official server answered, at the hosted endpoint;
- `get_chain_info` came first, on the right chain;
- every state read was at one block (the one before the transaction's, or the dry run's);
- replaying the recorded answers through the same code makes exactly the recorded calls and gives
  exactly the recorded cause, findings and fix.

## Tests

```sh
cd agent && npm test                                                # the agent's tests, offline
node --test tasks/27-dapp-support-agent/tests/page.test.mjs        # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/27-dapp-support-agent/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it, which serves transactions by
hash and contracts that revert with chosen data. They cover:
- each error family decoded, with token amounts, and an unknown selector;
- a revert replayed and explained with the sender's balance;
- a contract's custom error, out of gas, and a failure caused earlier in its block;
- a success, an unknown hash and a pending transaction;
- a description that would fail, would succeed, or cannot pay for gas;
- the reads at one block, the proofs, the CLI and the HTTP route with its input checks and caching.

The browser suite drives the page against the real API handler: the failing example, a failed
transaction by hash, the real example and an unknown hash, a malformed hash, an unreachable Chain
MCP, the proof, and six widths in both themes.

## Limits

- **The replay is against the state before the transaction's block**, not the state just before the
  transaction itself. When something earlier in the same block made it fail, the agent says that.
  It does not replay that block's earlier transactions.
- **Errors it does not know are named by their selector.** Pharos protocols with their own errors
  read as "a custom error the agent does not know (selector 0x…)".
- **Pharos Mainnet on the page and API**; the CLI also takes `--network atlantic-testnet`.
- **It explains; it does not resend.** A fix is advice. Nothing is signed or sent.
