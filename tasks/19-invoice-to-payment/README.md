# Task 19: Invoice-to-Payment Agent

An agent that takes an invoice, or a payment request link, and prepares the payment it asks for on
Pharos. It reads the invoice with every figure checked against the others, checks the payee against
the addresses you have checked and against what the payer sent before, then prepares the payment
through **Pharos Chain MCP**: Task 08's dry run at one block, the transaction to sign, the **Pharos
Skill Engine**'s `cast send`, and the same payment as an EIP-681 link. Anything that calls for a
check holds the payment. On Atlantic, with a key, the CLI sends it only when nothing does, and checks
it against its receipt.

Code: [`agent/src/invoice/`](../../agent/src/invoice), on the shared agent runtime
([`agent/`](../../agent)): Task 17's payment flow, Task 08's dry run, Task 25's lookalike rule.
Page: `/tasks/19`.

## Requirement

The official task map: *"Takes an invoice/payment request and prepares the corresponding payment."*
The full task page could not be reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| An invoice | Its text, as pasted from an email or a PDF: labelled lines (`Invoice:`, `From:`, `Bill to:`, `Issued:`, `Due:` or `Terms: Net 30`, `Pay to:`, `Network:`, `Subtotal:`, `Discount:`, `Tax:`, `Total:`, `Amount paid:`, `Amount due:`), with or without a colon, a label alone with its value on the next line, and the lines that end with an amount. Read by rules, not a language model (below). |
| Or a payment request | An EIP-681 link (`ethereum:0x…@1672?value=…`, or `ethereum:<token>@1672/transfer?address=0x…&uint256=…`), alone or inside the invoice. It must agree with the invoice: the same payee, asset and amount. Only payments are read: another function, an ENS name, a parameter it does not read, or an amount that is not a whole number of base units is refused. |
| The corresponding payment | The amount due, in the invoice's asset (PROS or an official token of the Skill Engine's list), to its payee. Every figure must agree with the others: the lines with the subtotal, the subtotal less any discount plus tax with the total, the total less what was paid with the amount due, the link with all of them. An invoice that does not add up is refused, saying which figures disagree: it is never paid. |
| Prepared | Through Chain MCP at one block: the payer's transfers of the token over the last 2,000 blocks (`get_logs`, one query a page), the payer's nonce (`get_transaction_count`), then Task 08's dry run (`get_code`, `eth_call` for the balances and the transfer from the payer, `get_balance`, `estimate_gas`, the fee market) and the funds it needs, gas included. The payment comes as the EIP-1559 transaction a wallet signs, as the Skill Engine's `cast send`, and as an EIP-681 link. |

## What it checks

- **The figures** (offline): as above. A currency rather than an asset ("$20", "20 EUR") is refused:
  the agent does not take a dollar for a USDC. So is an asset that is not official, an amount with
  more decimals than its asset has, and amounts in two assets.
- **The network**: an invoice for another chain ("Network: Ethereum"), or a link for another chain
  ID, is refused; one for Atlantic is refused on mainnet with the network to run it on. "Mainnet"
  alone is refused too: of which chain? An invoice that names none is read as the run's network.
- **The address**: 0x and 40 hex characters, with a good checksum when written in mixed case (a
  character typed wrong usually fails it). Not the zero address, not a token contract, not the payer.
- **Your payees** (offline): names and the addresses you have checked for them. The invoice's name
  (its `From`) with the same address is fine; your payees giving that name another address holds the
  payment ("Not the address your payees give": a changed address is how invoice fraud starts); so does
  the address under another name, and a payee in neither your payees nor the payer's recent transfers.
- **The payer's history** (`get_logs`, tokens only): the same amount to the payee already (it may be
  paid); a payee that starts and ends like an address the payer pays but is another (address
  poisoning, Task 25's rule); transfers of nothing to the payee (how poisoning plants one). A PROS
  payment leaves no log, so for PROS this is said, not checked.
- **The due date**, counted at the block's time: due in N days, today, or overdue by N days. A due date,
  or terms (Net 30, on receipt) from the issue date. It informs; it does not hold the payment.
- **The dry run and the funds**: whether the payment would go through, and whether the payer holds
  the amount and its gas.

A held payment is still prepared, so you can see what it would be. The payee is then shown in full,
never by the name the invoice claims: a lookalike looks the same when shortened.

## Run it

```sh
cd agent && npm ci
printf 'Example Studio = 0x…\n' > payees.txt                # or JSON: {"Example Studio": "0x…"}
node dist/src/cli.js invoice invoice.txt --payees payees.txt
node dist/src/cli.js invoice "ethereum:0x…@1672?value=1e16" --payees payees.txt --json
cat invoice.txt | node dist/src/cli.js invoice - --from 0x… --blocks 10000
# Atlantic, sent with your testnet key (--from defaults to its address), only when nothing is held:
PRIVATE_KEY=0x... node dist/src/cli.js invoice invoice.txt --payees payees.txt --network atlantic-testnet --execute
```

The CLI exits with 9 when the payment is held for a check. On Pharos Mainnet the payer is the agent's
example address when neither `--from` nor the invoice's bill-to gives one.

## The page

`/tasks/19` prepares an invoice on Pharos Mainnet, from an optional payer, against payees you can
edit. Its example invoice is from "Example Studio", paid at the agent's example recipient (Tasks 05,
08, 11 and 17): a sample name for a sample address. It shows:
- the verdict and its sentence: Ready, Check first (held), Short, Would fail, or Not prepared with the
  reason an invoice was refused;
- the invoice as read: the amount due, the payee against your payees, the due date, the network, the
  lines and figures, its payment link, and the lines it did not read;
- the checks, each with what it found and its source;
- the payment: its dry run, gas and nonce, and its `cast send` with a Copy button;
- to sign, when ready: the transaction as JSON and the EIP-681 link, each with a Copy button;
- how it got there: every step with its source, folded on a phone.

The address bar keeps the invoice, the payer and the payees. Ctrl+Enter prepares the invoice; Enter
starts a new line in it. Nothing is sent from the page: it holds no key.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
mkdir -p ../tasks/19-invoice-to-payment/proof
printf 'Example Studio = 0xB2749BD12f19C24a2244176658F3dF3e48e79553\n' > ../tasks/19-invoice-to-payment/proof/payees.txt
node -e 'import("./dist/src/web.js").then((m) => process.stdout.write(m.DEFAULT_INVOICE))' > ../tasks/19-invoice-to-payment/proof/invoice.txt
node dist/src/cli.js invoice ../tasks/19-invoice-to-payment/proof/invoice.txt --payees ../tasks/19-invoice-to-payment/proof/payees.txt --proof ../tasks/19-invoice-to-payment/proof/invoice.json
node dist/src/cli.js invoice "ethereum:0xB2749BD12f19C24a2244176658F3dF3e48e79553@1672?value=1e16" --payees ../tasks/19-invoice-to-payment/proof/payees.txt --proof ../tasks/19-invoice-to-payment/proof/link.json
node dist/src/cli.js verify ../tasks/19-invoice-to-payment/proof/invoice.json ../tasks/19-invoice-to-payment/proof/link.json
# Optionally, sent on Atlantic with a testnet key holding 1.25 USDC and some PHRS (an amount it has not
# just sent the example payee: the same amount would be held as possibly paid already):
printf 'Invoice: T-1\nFrom: Example Studio\nTotal: 1.25 USDC\nNetwork: Atlantic\nPay to: 0xB2749BD12f19C24a2244176658F3dF3e48e79553\n' > ../tasks/19-invoice-to-payment/proof/atlantic.txt
PRIVATE_KEY=0x... node dist/src/cli.js invoice ../tasks/19-invoice-to-payment/proof/atlantic.txt --payees ../tasks/19-invoice-to-payment/proof/payees.txt --network atlantic-testnet --execute --proof ../tasks/19-invoice-to-payment/proof/atlantic-sent.json
```

`verify` checks each proof:
- the official server answered, at the hosted endpoint (or run locally for Atlantic), with
  `get_chain_info` first, on the right chain;
- the invoice reads again to the same invoice;
- every state read before the send is at the one block;
- replaying the recorded answers gives exactly the recorded checks, payment and verdict;
- a sent payment is exactly its dry-run one, at its recorded nonce, signed by the payer;
- no key material is anywhere in it (the command names `$PRIVATE_KEY`, a variable, never a key).

## Tests

```sh
cd agent && npm test                                                    # the agent's tests, offline
node --test tasks/19-invoice-to-payment/tests/page.test.mjs            # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/19-invoice-to-payment/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. They cover:
- reading invoices: labelled lines, lines without a colon, a label with its value on the next line,
  line items, subtotal, discount, tax, total, paid and amount due, dates in seven forms, terms, mail
  headers, the lines not read; a payment link alone or agreeing with the invoice, and a link written
  and read back;
- refusals, each with its reason: figures that disagree (four ways), a figure given twice
  differently, a link that disagrees, two payees, no payee, no amount, nothing due, no asset, a
  currency, an unofficial asset, two assets, another network, "Mainnet" alone, the wrong network, a
  link for another chain, a checksum that fails, a cut address, a date that reads two ways or does not
  exist, an ENS name, a link that calls approve, an unknown link parameter, an amount not in whole base
  units, two links, a negative line, too long; payees that cannot be read;
- a known payee: the history read, the dry run, the transaction to sign and its link, and the proof
  verifying;
- held: a new payee, one paid before (fine), one maybe paid already, a lookalike with transfers of
  nothing and a changed address (never named for the studio);
- one that would not go through; one in PROS; a payer only Atlantic lacks; a changed recorded answer
  failing the proof;
- Atlantic: a new payee held even with a key, then a known one sent, its receipt matching, and the
  proof verifying its signature and nonce;
- the CLI (exit 9 when held) and the HTTP route.

The browser suite drives the page against the real API handler. It covers:
- the example on load, in full;
- a payment link, an invoice typed and sent with Ctrl+Enter, a payer given, and both Copy buttons;
- a changed address and a new payee held, with nothing to sign;
- an invoice that does not add up, one that would fail, and bad fields never sent;
- the proof, and six widths in both themes.

## Limits

- **The reading is rules.** An invoice laid out in a way the rules do not read is refused, or its
  lines are shown as not read: nothing is guessed. A table whose amounts have no asset and no two
  decimals is not read as lines. Numbers are read with "," for thousands and "." for decimals.
- **PROS and the official tokens only**, those of the Skill Engine's list, and amounts in them: no
  currency is converted.
- **The history is the last 2,000 blocks** (up to 10,000 with `--blocks`), so an earlier payment is
  not seen; and for PROS, none is, since a native transfer leaves no log.
- **Your payees are what you give.** The page's example book is a sample: a real check is against
  addresses you have confirmed yourself, another way than the invoice.
- **No note on chain.** An ERC-20 transfer carries no memo; the invoice number stays with the prepared
  payment.
- **Mainnet is prepared, not sent.** The page and the API send nothing; the CLI sends only on Atlantic.
