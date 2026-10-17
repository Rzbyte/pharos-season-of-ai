# Task 11 submission: Policy Gatekeeper

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/11 |
| Repository | [`tasks/11-policy-gatekeeper/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/11-policy-gatekeeper); code in [`agent/src/policy/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/policy) |
| Proof | `proof/` (pending the first live run; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp`, and the official server run locally for Atlantic execution (`send_raw_transaction`) |

## Reviewer note

Every requested transfer or approval is checked against a written policy at one pinned Pharos
Mainnet block, through Chain MCP, before anything is signed:
- spend limits: per action, and per window, from the sender's own USDC Transfer logs (`get_logs`);
- allowlists: the asset, and the recipient or spender;
- a time window, checked at the pinned block's timestamp;
- a gas cap, and a dry run at the same block that must succeed.

Every rule is evaluated, so a denial lists everything that is wrong, and a value that cannot be read
never counts as holding. On Atlantic, `--execute` sends an allowed request: the exact dry-run
transaction, signed locally.

## Key implementation detail

The window limit is not a counter kept by the agent. It is read from the chain: the sender's Transfer
logs in the 1,000 blocks up to the pinned one, in pages of at most 1,000 blocks. The hours are judged
at the block's own timestamp, not the server's clock. So every decision can be recomputed. The
verifier replays the recorded Chain MCP answers through the same code, requires the identical
decision rule by rule, and checks that the window was read without a gap up to the pinned block.

## Video walkthrough (about 60 s)

1. Open `/tasks/11`: Allowed, seven green rules, each with what was found and the tool that found it.
2. Point at the window rule: the USDC the sender sent in the last 1,000 blocks, read from its Transfer logs, plus this payment.
3. Change the request: 150 USDC to an address not on the list. Denied: two rules fail, both named at the top.
4. Set the allowed hours to 00:00–01:00 and check again: the time rule denies, at the block's time.
5. Open Proof & technical details: the Chain MCP calls. In a terminal: `gate treasury --proof p.json`, then `verify p.json`.

## X post draft

A policy gatekeeper on Pharos: every payment request is checked against a written policy at one block
through Pharos Chain MCP, before anything is signed. Spend limits, read from the sender's own transfer
logs, plus allowlists, allowed hours, a gas cap and a dry run. A denial names every rule it broke.
https://pharos-agent-lab.vercel.app/tasks/11

## How it works (reply)

It pins a block, then checks each rule: the request against the allowlists and the per-action cap,
the sender's Transfer logs for the window cap, the block's timestamp for the hours, the gas price, and
a dry run at the same block. All must hold. On testnet an allowed request is signed and sent.
