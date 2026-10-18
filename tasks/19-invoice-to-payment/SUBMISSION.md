# Task 19 submission: Invoice-to-Payment Agent

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/19 |
| Repository | [`tasks/19-invoice-to-payment/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/19-invoice-to-payment); code in [`agent/src/invoice/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/invoice) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_logs`, `get_transaction_count`, `get_code`, `eth_call`, `get_balance`, `estimate_gas`, `get_gas_price`); on Atlantic, the official server run locally (`send_raw_transaction`). Pharos Skill Engine at `a873387`: its token list and `cast send` template |

## Reviewer note

The agent takes an invoice, pasted as text, or an EIP-681 payment link, and prepares the payment it
asks for. It reads the invoice by rules: its labelled lines, its line items, its payment link. Every
figure must agree with the others, from the lines to the amount due and the link, or the invoice is
refused, saying which disagree. The payee is checked against your payees and the payer's last 2,000
blocks of transfers. Then the payment is dry-run through Chain MCP at one block and comes ready to
sign: the transaction, the Skill Engine's `cast send`, and an EIP-681 link. On Atlantic the CLI sends
it, and checks the receipt, only when nothing calls for a check first.

## Key implementation detail

An invoice is a fraud surface, so the agent holds rather than guesses. A changed address ("your
payees give Example Studio another address"), a new payee, the same amount already sent to the payee,
or a payee that looks like an address the payer pays (address poisoning) each hold the payment. A held
payee is shown in full and never named for the company it claims to be: a lookalike looks the same
shortened. Amounts are exact in base units, a currency is never taken for a token, and an address in
mixed case must pass its checksum. `pharos-agent verify` reads the invoice again and replays the
recorded answers to the same checks, payment and verdict, and checks a sent payment's signature and
nonce.

## Video walkthrough (about 60 s)

1. Open `/tasks/19`: the example invoice. The invoice as read, every check with its source, the
   payment with its dry run, and the transaction and EIP-681 link to sign, with Copy.
2. "A changed address": the same invoice paying another address. Check first, held: not the address
   your payees give, shown in full.
3. "Does not add up": refused, "The subtotal is 20 USDC, but the total says 25 USDC."
4. In a terminal, on Atlantic: `invoice atlantic.txt --payees payees.txt --network atlantic-testnet
   --execute --proof sent.json`, then `verify sent.json`.

## X post draft

Paste an invoice, get a payment ready to sign on Pharos. The agent checks that every figure adds up,
that the payee is the address you know (not a lookalike), and that it is not paid already, then
dry-runs it through Pharos Chain MCP. https://pharos-agent-lab.vercel.app/tasks/19

## How it works (reply)

Rules read the invoice, so nothing is guessed; figures that disagree refuse it. get_logs reads the
payer's recent transfers for a duplicate or a lookalike payee; eth_call and estimate_gas dry-run the
payment at one block. It comes as a transaction to sign, a Skill Engine cast command, and an EIP-681
link.
