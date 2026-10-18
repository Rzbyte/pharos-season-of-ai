# Task 10 submission: Batch Executor

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/10 |
| Repository | [`tasks/10-batch-executor/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/10-batch-executor); code in [`agent/src/batch/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/batch) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_chain_info`, `get_block_number`, `get_block`, `get_transaction_count`, `get_balance`, `get_code`, `eth_call`, `estimate_gas`, `get_gas_price`); on Atlantic, the official server run locally, which also sends (`send_raw_transaction`, `get_transaction_receipt`). The Pharos Skill Engine (`a873387`): the networks and official tokens, and its batch transfer's size, up to ten one transaction each (`references/transaction.md`, simple mode). Task 08's dry run for each transaction. |

## Reviewer note

A batch of actions from one sender, one a line: sends of PROS or an official token, approvals and
revokes, wraps. The agent merges sends of one asset to one address, then shows the batch is independent
before it plans it: every balance the batch takes from must cover all it takes before anything the batch
adds, so any order gives the same end balances, and no allowance is set twice. A batch whose order
matters is refused, saying which lines depend on what. Every transaction is dry-run at one block, with
the reads the dry runs share made once; one that would revert on its own is left out and the others still
go. The plan is one nonce sequence with one fee quote. On Atlantic the CLI signs the transactions, sends
them back to back without waiting between, awaits the receipts together, and checks every balance and
allowance the batch changed. The page plans on Pharos Mainnet and sends nothing.

## Key implementation detail

"Optimized" is measured, not claimed. Every Chain MCP read of the plan goes through one shared-read
client that answers a repeated question from its first answer, so the plan counts both the calls it made
and the calls the same dry runs ask when each runs on its own, as Task 08 runs it (the example: 21
against 36 on the test chain). The proof replays the run through the same code, shared reads included,
and the verifier checks that the calls counted are the calls in the transcript, and that every
transaction sent went out before any receipt was asked for.

## Video walkthrough (about 60 s)

1. Open `/tasks/10`: the payroll batch, two sends to one address merged, independence checked line by
   line, three transactions to sign in one nonce sequence, the calls saved.
2. "One too big": that send left out (it would revert), the others still ready.
3. "Order matters": an approval and a revoke of one allowance, refused as not a batch.
4. In a terminal, on Atlantic: `batch batch.txt --network atlantic-testnet --execute`: sent back to back,
   the blocks they took, every value checked.

## X post draft

A batch executor on Pharos: write the actions one a line, and the agent proves they are independent,
merges what it can, dry-runs each through Pharos Chain MCP at one block with the shared reads made once,
and plans one nonce sequence, sent back to back on Atlantic.
https://pharos-agent-lab.vercel.app/tasks/10

## How it works (reply)

Independence from balances and allowances (every order must work), Task 08's dry run for each
transaction with the reads they share made once and counted, one fee quote, then the sends back to back
and every value the batch changed checked against the plan.
