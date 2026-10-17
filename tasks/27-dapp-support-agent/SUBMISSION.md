# Task 27 submission: dApp Support Agent

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/27 |
| Repository | [`tasks/27-dapp-support-agent/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/27-dapp-support-agent); code in [`agent/src/support/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/support) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_transaction`, `get_transaction_receipt`, `eth_call`, `get_code`, `get_block`, and Task 08's dry run) |

## Reviewer note

Ask about a transaction hash and the agent reads it and its receipt through Chain MCP. If it failed,
the agent replays its call at the block before its own to get the revert data, and decodes it in plain
language: `Error(string)`, Solidity's `Panic` codes, and OpenZeppelin Contracts 5's errors, with token
amounts in the token's units. It also checks the target's code and the sender's token balance and
allowance, and spots out-of-gas and failures caused earlier in the same block. The answer gives the
cause, each finding with the tool it came from, and what to do. A transaction described instead of
sent is explained as it would fail now.

## Key implementation detail

There is no language model in the answer. Every sentence is built from a decoded value, and all state
is read at one block, so an answer is a proof. `pharos-agent verify` replays the recorded Chain MCP
answers through the same code and gets exactly the recorded cause, findings and fix. The page's
examples are honest: no failed mainnet hash was available to the build, so the failing example is a
described transfer. The real one is a transaction from Task 02's live proof, which succeeded, and the
agent says so.

## Video walkthrough (about 60 s)

1. Open `/tasks/27`: a transfer of 5,000,000 USDC from the example sender, explained as it would fail now: the token's message, decoded, and the fix.
2. What it checked: the simulation, the sender's USDC, the funds for gas, each with its tool.
3. "A real transfer from Task 02": a real hash; it did not fail, and the page says so.
4. Paste a failed transaction's hash: the cause, the replay before its block, the sender's balance, the fix.
5. In a terminal: `explain 0x… --proof answer.json` then `verify answer.json`.

## X post draft

A support agent for Pharos: give it a transaction hash and it explains why it failed, through Pharos
Chain MCP. It replays the call before its block, decodes the revert, checks the balance, and says
what to do, each finding with its source. No language model, so every answer replays as a proof.
https://pharos-agent-lab.vercel.app/tasks/27

## How it works (reply)

get_transaction and its receipt say how it ended. For a failure, eth_call at the block before its own
returns the revert data, which is decoded: Error, Panic, OpenZeppelin's errors. All the gas used means
it ran out of gas; a replay that succeeds means something earlier in its block changed things.
