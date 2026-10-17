# Task 05: Threshold Guardian

A guardian that reads several on-chain conditions at one Pharos block through **Pharos Chain MCP**,
and fires its action only when its rule holds. The action is simulated first and blocked if it would
fail. On the Atlantic testnet it can execute: it re-reads every condition at the newest block, signs
locally, and broadcasts through Chain MCP.

Code: [`agent/src/guardian/`](../../agent/src/guardian), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/05`.

## Requirement

The official task map: *"Evaluates multiple on-chain conditions before deciding whether to fire an
action."* The full task page could not be reached from the build environment; this is built to that
statement.

| What it asks | Where |
|---|---|
| Multiple on-chain conditions | Six conditions of five kinds: a contract flag, a token balance, a native balance, contract code, gas price, block age. Every value comes from a Chain MCP tool call. |
| Evaluated before deciding | All are read first, at one pinned block, then decided by one rule: all, any, or at least N. A value that cannot be read never counts as holding. |
| Whether to fire an action | The action is prepared only when the rule holds. It is then simulated at the same block (`eth_call`) and priced (`estimate_gas`, `get_gas_price`), and blocked if it reverts or the payer can't pay. With `--execute` on Atlantic, it is sent after a re-check at the newest block. |

## The payout guardian

The shipped guardian pays 25 USDC on Pharos Mainnet, only if all six hold at one block:

| Condition | Read with | Holds when |
|---|---|---|
| USDC is not paused | `eth_call` `paused()` on Circle USDC | `paused() = false` |
| The payer holds at least the payout | `eth_call` `balanceOf(payer)` | ≥ 25 USDC (decimals read from the token) |
| The payer holds PROS for gas | `get_balance` | ≥ 0.001 PROS |
| The recipient is a wallet, not a contract | `get_code` | no contract code |
| Gas costs at most 10 gwei | `get_gas_price` (live; the tool takes no block) | ≤ 10 gwei |
| The latest block is at most 60 s old | `get_block` at the pinned block | ≤ 60 s |

The simulation catches what no condition checks. For example, USDC refusing a blacklisted recipient
blocks the payout even though all six hold (tested).

The example payer and recipient are public addresses seen moving USDC in Task 02's live proof. On
mainnet nothing is ever signed or sent: the hosted Chain MCP is read-only (`send_raw_transaction` is
disabled there).

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js guardian payout                  # mainnet, hosted Chain MCP
node dist/src/cli.js guardian payout --json           # the full result
node dist/src/cli.js guardian my-guardian.json        # your own guardian
PRIVATE_KEY=0x... node dist/src/cli.js guardian atlantic-payout --execute
```

`atlantic-payout` reads your own wallet (`$SIGNER`, the address of `PRIVATE_KEY`) on Atlantic. It
needs at least 1 testnet USDC and some PHRS, and pays 1 USDC to itself once the conditions hold.
`--execute` starts the official Chain MCP server locally over stdio with broadcasting on. It then
re-reads every condition at the newest block, signs locally, sends with `send_raw_transaction`, and
waits for the receipt. If the conditions stopped holding in between, it sends nothing.

A guardian is JSON. The full schema and its checks are in
[`agent/src/guardian/config.ts`](../../agent/src/guardian/config.ts):

```json
{
  "name": "…", "network": "pharos-mainnet", "fireWhen": "all",
  "conditions": [
    { "id": "usdc-live", "label": "USDC is not paused",
      "read": { "kind": "call", "to": "0xC879…1815", "signature": "paused() returns (bool)" }, "op": "==", "value": false }
  ],
  "action": { "type": "erc20-transfer", "token": "0xC879…1815", "from": "0x…", "to": "0x…", "amount": "25" }
}
```

- **Reads:** `erc20-balance`, `native-balance`, `call` (any view function returning a bool, address or
  integer), `has-code`, `gas-price`, `block-age`, `nonce`.
- **Rules:** `"all"`, `"any"`, `{ "atLeast": N }`.
- **Actions:** `erc20-transfer`, `native-transfer`.

## The page

`/tasks/05` evaluates the payout guardian on load, through `GET /api/agent?task=05`:
- the decision: Fire, Hold or Blocked;
- the block every value was read at;
- each condition, with the value seen and the Chain MCP tool that read it;
- the simulated payout.

Payer, recipient, amount and gas cap can be changed, and the payout is kept in the address bar so it
can be shared. Proof & technical details lists every Chain MCP call of the run and the raw result.

## Proof

**Pending: the first live run.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works), run:

```sh
cd agent && npm ci
node dist/src/cli.js guardian payout --proof ../tasks/05-threshold-guardian/proof/payout-mainnet.json
node dist/src/cli.js verify ../tasks/05-threshold-guardian/proof/payout-mainnet.json
```

Optional, with a funded Atlantic key:

```sh
PRIVATE_KEY=0x... node dist/src/cli.js guardian atlantic-payout --execute --proof ../tasks/05-threshold-guardian/proof/atlantic-executed.json
```

`verify` does not trust the result. It confirms:
- the official server answered, at the hosted endpoint (mainnet) or locally (Atlantic);
- `get_chain_info` came first, on the right chain;
- every state read before execution names the pinned block;
- replaying the recorded answers through the same code makes exactly the recorded calls and gives the
  identical result;
- for an executed run, the broadcast transaction is exactly the prepared action, signed by the payer.

## Tests

```sh
cd agent && npm test                                                    # the agent's tests, offline
node --test tasks/05-threshold-guardian/tests/page.test.mjs            # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/05-threshold-guardian/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it: in-process, over stdio and
over HTTP. They cover:
- fire, hold, blocked (a revert, a blacklisted recipient, no gas money);
- an unreadable value, a wrong chain, an explicit block, an at-least rule;
- execution on Atlantic, and a re-check that aborts it;
- proofs, and six kinds of tampering;
- the CLI binary.

The browser suite drives the page against the real API handler at six widths in both themes.

## Limits

- **Gas price and block age are read live.** `get_gas_price` and `estimate_gas` take no block, so
  they describe the latest state, not the pinned block.
- **Execution is limited to Atlantic.** Mainnet runs prepare and simulate only.
- **One action per guardian:** an ERC-20 or native transfer.
