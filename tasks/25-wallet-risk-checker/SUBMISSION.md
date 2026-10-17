# Task 25 submission: Wallet Risk Checker

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/25 |
| Repository | [`tasks/25-wallet-risk-checker/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/25-wallet-risk-checker); code in [`agent/src/risk/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/risk) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_code`, `get_transaction_count`, `get_balance`, `get_logs`, `get_block`, and Task 08's dry run with `eth_call` and `estimate_gas`) |

## Reviewer note

Before a transaction is sent, the agent checks the address it goes to: the recipient, the spender of
an approval, or the contract called. Through Chain MCP it reads what that address is (a wallet, a
contract, or a wallet delegated under EIP-7702), its nonce and balance, and the last 2,000 blocks of
the token's transfers by it or the sender. From those it flags address poisoning: a lookalike of an
address the sender really uses, and transfers of nothing between the two. It also flags approvals to
a wallet, unlimited approvals, tokens sent to a token contract, never-used addresses, and a
transaction that would fail. Each signal has a severity and the tool it came from. The worst decides:
do not send, check first, or looks fine.

## Key implementation detail

Transfers of nothing are not counted as dealings. After a poisoning, the poisoner's lookalike sits in
the sender's history with transfers of nothing. Because they do not count, the real partner is never
flagged as a lookalike of the poisoner's address, while the poisoner's address is flagged twice. There
is no language model and no outside list: every signal is a value read at one block. `pharos-agent
verify` replays the recorded answers through the same code and gets exactly the recorded verdict. The
page's lookalike example is made up and labelled so. It is built from the sender's busiest partner in
the blocks just read.

## Video walkthrough (about 60 s)

1. Open `/tasks/25`: Task 08's example transfer goes to an address with no history, so check first.
2. "A made-up lookalike": the start and end of the sender's real partner. Do not send, with the
   partner and how often the sender dealt with it.
3. "An unlimited approval to a wallet": an approval to an address with no code. Do not send.
4. Change the recipient to the real partner: looks fine, with the dealings shown for information.
5. Proof: each Chain MCP call, the history pages, the result as JSON. In a terminal: `risk --proof
   check.json`, then `verify check.json`.

## X post draft

A wallet risk checker for Pharos: before you send, it reads the recipient's history through Pharos
Chain MCP and flags address poisoning (lookalikes, transfers of nothing), approvals to wallets,
unlimited approvals and tokens sent to token contracts. Every signal comes with its source, and every
check replays as a proof.
https://pharos-agent-lab.vercel.app/tasks/25

## How it works (reply)

get_code says wallet, contract or EIP-7702 delegate. get_logs reads the token's transfers by either
side in pages of 1,000 blocks. An address that starts and ends like one the sender really trades with
is a lookalike. Transfers of nothing are poisoning's trace, never dealings.
