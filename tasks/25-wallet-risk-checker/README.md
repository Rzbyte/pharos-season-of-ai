# Task 25: Wallet Risk Checker

A check to run before sending a transaction on Pharos Mainnet. It reads the address the transaction
goes to through **Pharos Chain MCP**: what it is, what it has done, and its recent history with the
sender. Then it says what looks wrong:
- a lookalike of an address the sender uses (address poisoning);
- transfers of nothing between the two;
- an approval to a wallet, or an unlimited one;
- tokens sent to a token's own contract.

Each signal comes with the tool it was read with. The verdict is do not send, check first, or looks
fine.

Code: [`agent/src/risk/`](../../agent/src/risk), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/25`.

## Requirement

The official task map: *"Evaluates suspicious wallet or contract history before a transaction."* The
full task page could not be reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| Before a transaction | A planned transaction, described as Task 08 takes it: a transfer of PROS or an official token, an approval, or a contract call. Its counterparty is checked: the recipient, the spender, or the contract. Nothing is signed or sent. |
| Wallet or contract | `get_code` at the newest block says what the counterparty is: a wallet (no code), a contract (the official tokens are named), or a wallet delegated to a contract under EIP-7702 (`0xef0100…`). `get_transaction_count` and `get_balance` give its nonce and PROS. |
| History | The token's `Transfer` logs over the last 2,000 blocks (`get_logs`, pages of 1,000 blocks, two queries a page: sent by either, received by either). From them: the transfers between the sender and the counterparty, the ones of nothing, and every address the sender moved tokens with. All of it is read at one block. |
| Suspicious | Each signal has a severity (see [Signals](#signals)). The worst one decides: high is do not send, medium is check first, anything else looks fine. Task 08's dry run at the same block adds a signal when the transaction would fail as it is. |

No language model is involved. Every sentence is built from a value read through Chain MCP, so the
check replays from the recorded answers exactly.

## Signals

| Signal | Severity | From |
|---|---|---|
| Looks like an address the sender uses: the same first and last four characters, but a different address | high | `get_logs` |
| Zero-value transfers between the sender and the counterparty, what address poisoning leaves | high | `get_logs` |
| The zero address | high | the transaction |
| An approval to a wallet (no code) | high | `get_code` |
| Tokens sent to a token's own contract | high | `get_code` |
| Never used: no transaction, no PROS, and no transfers in the window | medium | `get_transaction_count`, `get_balance`, `get_logs` |
| An unlimited approval | medium | the transaction |
| A contract as the recipient of a transfer | medium | `get_code` |
| It would fail as it is, or cannot pay for gas (Task 08's dry run) | medium | `eth_call`, `estimate_gas` |
| A wallet delegated to a contract (EIP-7702) | low | `get_code` |
| The sender has dealt with it before | information | `get_logs` |

Transfers of nothing are not dealings. After a poisoning, the poisoner's lookalike shows up in the
sender's history with transfers of nothing. Because those do not count, the real partner is never
taken for a lookalike of the poisoner's address. The poisoner's address is flagged both ways.

## Examples

The page opens on Task 08's example: 25 USDC from a public address seen moving USDC on Pharos Mainnet
in [Task 02's live proof](../02-event-log-monitor/proof), to an address with no activity. Two more
examples are one click away:
- **A made-up lookalike.** The first and last four characters of the address the example sender moved
  USDC with most in the blocks read, with zeros in between, the way address poisoning copies one.
  Until a check finds that partner, it copies `0x1F35…c85C`, which traded with the sender in Task 02's
  proof. The address is made up and labelled so.
- **An unlimited approval to a wallet.** The spender is `0x3333…3333`, an unused address.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js risk                                              # Task 08's example transfer
node dist/src/cli.js risk --to 0x… --amount 100                        # your own recipient
node dist/src/cli.js risk erc20-approve --spender 0x… --amount max     # an approval
node dist/src/cli.js risk native-transfer --to 0x… --amount 1 --blocks 10000 --json
```

`--blocks` reads up to 10,000 blocks of history (default 2,000). The kinds and options are the dry
run's (`pharos-agent help`).

## The page

`/tasks/25` checks Task 08's example on load, and the transaction in the address bar if there is one.
A check shows:
- the verdict (Do not send, Check first, or Looks fine) with the top signal in a few words, and the
  transaction in words;
- the signals, worst first, each with its severity, what it saw and its Chain MCP tool;
- the counterparty: its address (linked to the explorer), its role, its code, its transactions, what
  it holds, and its history with the sender.

"Change the transaction" takes any transfer or approval, checked at its field before anything is
sent. The proof section lists each Chain MCP call of the latest check and its raw result.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
node dist/src/cli.js risk --proof ../tasks/25-wallet-risk-checker/proof/example.json
node dist/src/cli.js risk erc20-approve --spender 0x3333333333333333333333333333333333333333 --amount max --proof ../tasks/25-wallet-risk-checker/proof/approval.json
# The lookalike of the sender's busiest partner in the first run (or of 0x1F35…c85C if it had none):
TO=$(node -e 'const p=require(process.argv[1]).result.history?.partners[0]?.address??"0x1F3546a29EeC2102c8d52E21a45114124014c85C";console.log(`0x${p.slice(2,6)}${"0".repeat(32)}${p.slice(-4)}`.toLowerCase())' ../tasks/25-wallet-risk-checker/proof/example.json)
node dist/src/cli.js risk --to $TO --proof ../tasks/25-wallet-risk-checker/proof/lookalike.json
node dist/src/cli.js verify ../tasks/25-wallet-risk-checker/proof/*.json
```

For each check, `verify` confirms:
- the official server answered, at the hosted endpoint;
- `get_chain_info` came first, on the right chain;
- every state read was at the one pinned block, and every `get_logs` page is inside the history the
  check says it read;
- replaying the recorded answers through the same code makes exactly the recorded calls and gives
  exactly the recorded signals, level and verdict.

## Tests

```sh
cd agent && npm test                                                  # the agent's tests, offline
node --test tasks/25-wallet-risk-checker/tests/page.test.mjs          # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/25-wallet-risk-checker/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. They cover:
- a known partner, read in two queries a page;
- a lookalike and a never-used address;
- zero-value transfers, and a poisoned history where the real partner stays clean;
- an unlimited approval to a wallet, and tokens sent to the token;
- a contract, a delegated wallet, the zero address, and a transfer that would fail;
- the window's bounds and the replay;
- the CLI and the HTTP route with its input checks.

The browser suite drives the page against the real API handler. It covers:
- the example on load, and both examples;
- a lookalike built from the sender's busiest partner, and a known partner;
- invalid input, and an unreachable Chain MCP;
- the proof;
- six widths in both themes.

## Limits

- **The history is recent.** 2,000 blocks on the page and API, up to 10,000 in the CLI. Task 02's
  proof saw about 20 blocks in 25 seconds, so 2,000 blocks is roughly 40 minutes (an estimate from
  that one sample). Every 1,000 blocks costs two `get_logs` calls on an endpoint allowed 120 a minute,
  so a long history is not read per check. The nonce, the balance and the code are lifetime facts.
- **One token's history.** That is the token of a transfer or approval, or USDC for PROS and contract
  calls.
- **A lookalike needs a partner in the window.** An address the sender used before the window is not
  compared. Transfers of a tiny amount count as dealings, so a dust-based poisoning is caught by the
  lookalike check only, not by the zero-value one.
- **No outside lists.** No scam or sanctions database is consulted: there is no Pharos source for
  one, and none is invented. The signals are what the chain itself shows.
- **Pharos Mainnet on the page and API.** The CLI also takes `--network atlantic-testnet`.
