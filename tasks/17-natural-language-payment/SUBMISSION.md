# Task 17 submission: Natural-Language Payment Agent

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/17 |
| Repository | [`tasks/17-natural-language-payment/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/17-natural-language-payment); code in [`agent/src/payment/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/payment) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_transaction_count`, `get_code`, `eth_call`, `get_balance`, `estimate_gas`, `get_gas_price`); on Atlantic, the official server run locally (`send_raw_transaction`). Pharos Skill Engine at `a873387`: its token list and `cast send` template |

## Reviewer note

The agent turns a payment request in plain words, like "Pay alice 25 USDC and send 0.01 PROS to bob
for lunch", into a prepared payment flow. A small grammar reads every word: recipients by address or
by an address book, "each" and "split", a note, a sender. A request it cannot read whole is refused
with the words it did not read. Each payment is then dry-run through Chain MCP at one block, and the
totals are checked against what the sender holds. The flow comes as transactions to sign in nonce
order, with gas limits, fee caps and the Skill Engine's `cast send` for each. On Atlantic, the CLI
sends them in order and checks every receipt.

## Key implementation detail

No language model reads the request, so a payment is never guessed. "5 USDC to alice and bob" is
refused until it says "each" or "split". A split is exact in base units: the remainder goes to the
first recipient, so the parts add up. Each payment fits alone at the block; the flow verdict also
checks that they fit together, PROS with every maximum fee on top. `pharos-agent verify` reads the
request again and replays the recorded answers to the same payments, totals and verdict. For a sent
flow, it checks every signed transaction, in order, against its dry-run one.

## Video walkthrough (about 60 s)

1. Open `/tasks/17`: the two-payment example. Each payment with its dry run, gas, nonce and `cast
   send`; the totals against the sender's holdings; the transactions to sign, and Copy.
2. "Split a bill": two shares that add up. Type "Split 3,000 USDC between alice and bob": each share
   fails alone, and the flow says so.
3. Type "Pay carol 5 USDC": refused, "Who is carol?".
4. In a terminal, on Atlantic: `pay "Pay alice 1 USDC and bob 0.5 USDC" --contacts contacts.txt
   --network atlantic-testnet --execute --proof sent.json`, then `verify sent.json`.

## X post draft

A Pharos payment agent you talk to in plain words: "Pay alice 25 USDC and send 0.01 PROS to bob for
lunch". It reads every word, dry-runs each payment through Pharos Chain MCP, checks the totals, and
hands back the transactions to sign. https://pharos-agent-lab.vercel.app/tasks/17

## How it works (reply)

A small grammar reads the request; anything it cannot read is refused. get_transaction_count gives
the nonces; eth_call and estimate_gas dry-run each payment at one block. The totals are checked
against the sender's balances, and each payment comes as a transaction to sign and a Skill Engine
cast command.
