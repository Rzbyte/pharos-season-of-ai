# Task 11: Policy Gatekeeper

A gatekeeper between a request and a signature. Every requested transfer or approval is checked
against a written policy at one Pharos block, through **Pharos Chain MCP**, before anything is signed.
It allows the request only when every rule holds, and it lists every rule that does not. On the
Atlantic testnet it can then send an allowed request.

Code: [`agent/src/policy/`](../../agent/src/policy), on the shared agent runtime
([`agent/`](../../agent)), with Task 08's dry run as one of its rules. Page: `/tasks/11`.

## Requirement

The official task map: *"Checks requested actions against rules such as spend limits, allowlists, and
time windows."* The full task page could not be reached from the build environment; this is built to
that statement.

| What it asks | Where |
|---|---|
| Requested actions | A transfer of PROS or a token, or a token approval: the requests Task 08 dry-runs. A contract call is refused, because what it spends cannot be read from the request. |
| Spend limits | Per action, where an approval counts and an unlimited one is over any limit. Per window: the sender's own Transfer logs over the last N blocks, read with `get_logs` in pages of at most 1,000 blocks ending at the pinned block, plus this action. |
| Allowlists | Assets (PROS or official tokens) and counterparties (the recipient of a transfer, the spender of an approval). |
| Time windows | Days and hours at a fixed UTC offset, checked at the pinned block's timestamp, so a decision can be reproduced. A window over midnight, like 22:00 to 06:00, works. |
| Checks | Every rule is evaluated, never stopping at the first that fails. A value that cannot be read never counts as holding. Two more rules use the chain: a gas cap, and a dry run at the same block that must succeed. |

## The treasury policy

The shipped policy guards payments from the example sender on Pharos Mainnet:

| Rule | Read with | Holds when |
|---|---|---|
| Only USDC | the request | the asset is USDC |
| The recipient (or spender) is one of 3 allowed addresses | the request | it is on the list |
| At most 100 USDC per action | the request | the amount is ≤ 100 USDC |
| At most 5,000 USDC sent in 1,000 blocks | `get_logs`: the sender's USDC Transfer logs, then `get_block` for the window's start | what it sent in the window plus this amount is ≤ 5,000 USDC |
| Between 06:00 and 22:00 UTC, every day | `get_block` at the pinned block | the block's time is inside the hours |
| Gas costs at most 10 gwei | `get_gas_price` | ≤ 10 gwei |
| It succeeds in a dry run | `eth_call`, `estimate_gas` (Task 08) | it would succeed, and the sender can pay the value and the fee |

The example sender is a public address seen moving USDC in Task 02's live proof. It moves USDC every
few blocks, so the window limit is sized to that, and the allowed recipients are addresses it was seen
paying. Nothing is ever signed on mainnet: the hosted Chain MCP is read-only.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js gate                                            # the treasury policy, 25 USDC
node dist/src/cli.js gate treasury --to 0x… --amount 150             # denied: exit code 9
node dist/src/cli.js gate treasury erc20-approve --spender 0x… --amount max
node dist/src/cli.js gate my-policy.json --from 0x… --to 0x… --amount 10
node dist/src/cli.js gate --json                                     # the full result
```

A policy is JSON. The full schema and its checks are in
[`agent/src/policy/config.ts`](../../agent/src/policy/config.ts):

```json
{
  "name": "Treasury payouts", "network": "pharos-mainnet",
  "rules": [
    { "id": "assets", "kind": "asset-allowlist", "assets": ["USDC"] },
    { "id": "counterparties", "kind": "counterparty-allowlist", "addresses": ["0x…"] },
    { "id": "per-action", "kind": "max-per-action", "asset": "USDC", "amount": "100" },
    { "id": "rolling", "kind": "max-in-window", "asset": "USDC", "amount": "5000", "blocks": 1000 },
    { "id": "hours", "kind": "time-window", "days": ["mon", "tue", "wed", "thu", "fri"], "from": "09:00", "to": "17:00", "utcOffset": "+07:00" },
    { "id": "gas", "kind": "max-gas-price", "gwei": "10" },
    { "id": "simulates", "kind": "simulates" }
  ]
}
```

On Atlantic, with a key holding testnet USDC and some PHRS:

```sh
PRIVATE_KEY=0x... node dist/src/cli.js gate atlantic-treasury --execute
```

`atlantic-treasury` checks a payment of 1 USDC from your own wallet (`$SIGNER`) to the example
recipient, with the same rules at smaller amounts and the whole day allowed. `--execute` starts the
official Chain MCP server locally over stdio with broadcasting on. It sends only a request that is
allowed and whose dry run succeeds. The transaction is exactly the dry-run one, signed locally and
broadcast with `send_raw_transaction`, and its receipt is compared with the prediction.

## The page

`/tasks/11` checks a 25 USDC payment from the example sender against the treasury policy on load,
through `GET /api/agent?task=11`. It shows:
- the decision, Allowed or Denied, with every failing rule named at the top;
- the block it was checked at;
- each rule, with what was found and the Chain MCP tool that found it;
- beside them, what the request would do if sent, from its dry run, and that nothing was sent.

The request can be changed: action, asset, sender, recipient or spender, amount, and the policy's
allowed hours. Changing the hours is the way to see the time rule deny. The request is kept in the
address bar, so it can be shared. Proof & technical details lists every Chain MCP call and the raw
result, which includes the policy.

## Proof

**Pending: the first live run.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works), run:

```sh
cd agent && npm ci
node dist/src/cli.js gate treasury --proof ../tasks/11-policy-gatekeeper/proof/treasury-mainnet.json
node dist/src/cli.js verify ../tasks/11-policy-gatekeeper/proof/treasury-mainnet.json
```

A denied request makes a proof just as well; its exit code is 9. Optional, with a funded Atlantic key
(an executed, allowed request):

```sh
PRIVATE_KEY=0x... node dist/src/cli.js gate atlantic-treasury --execute --proof ../tasks/11-policy-gatekeeper/proof/atlantic-executed.json
```

`verify` does not trust the result. It confirms:
- the official server answered, at the hosted endpoint (mainnet) or locally (Atlantic);
- `get_chain_info` came first, on the right chain;
- every state read of the check names the pinned block;
- the spend window was read in whole pages of at most 1,000 blocks, with no gap, ending at the pinned
  block;
- replaying the recorded answers through the same code makes exactly the recorded calls and gives the
  identical decision, rule by rule;
- for an executed run, the broadcast transaction is exactly the dry-run one, signed by its sender.

## Tests

```sh
cd agent && npm test                                                  # the agent's tests, offline
node --test tasks/11-policy-gatekeeper/tests/page.test.mjs           # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/11-policy-gatekeeper/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. They cover:
- every malformed policy refused, and what each rule says;
- allowed, and denied with every failing rule listed;
- another asset, a bounded and an unlimited approval;
- the window: transfers just outside it, received or of another token not counted, the cap reached,
  and a 2,500-block window read in three pages with transfers on the page edges counted once;
- the hours at the block's time, a window over midnight, an offset that moves the day, days;
- fail-closed on an unreadable window, a failing dry run;
- refusals: a contract call, a policy for another network, executing on mainnet;
- execution on Atlantic when allowed, nothing sent when denied;
- proofs, and tampering: a hidden transfer, a flipped decision, a swapped policy;
- the CLI, and the HTTP route with its input checks.

The browser suite drives the page against the real API handler: allowed, denied, the hours from the
form, the window limit, an unreadable value, an unlimited approval, invalid input, an unreachable
Chain MCP, and six widths in both themes.

## Limits

- **The window is in blocks, not hours.** `get_logs` takes block ranges, not times; the rule shows how
  many minutes the 1,000 blocks covered, from their timestamps.
- **The window counts tokens, not PROS.** Native transfers leave no logs. A token sent by a contract
  the sender approved (`transferFrom`) is logged as sent by the sender, so it counts.
- **Gas is priced at the latest state.** `get_gas_price` and `estimate_gas` take no block.
- **One request at a time.** Two requests checked at the same block do not see each other.
- **Execution is limited to Atlantic.** Mainnet runs decide only.
