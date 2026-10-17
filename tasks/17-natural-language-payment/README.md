# Task 17: Natural-Language Payment Agent

An agent that turns a payment request in plain words into a prepared on-chain payment flow on Pharos.
It reads every payment the request asks for, then dry-runs each one through **Pharos Chain MCP** at
one block. It checks that the payments together fit in what the sender holds, and gives the
transactions to sign, nonce by nonce, with the **Pharos Skill Engine**'s `cast` commands. On Atlantic,
with a key, the CLI sends them in order and checks each against its receipt.

Code: [`agent/src/payment/`](../../agent/src/payment), on the shared agent runtime
([`agent/`](../../agent)): Task 08's dry run and Atlantic sending. Page: `/tasks/17`.

## Requirement

The official task map: *"Turns a natural-language payment request into a prepared on-chain payment
flow."* The full task page could not be reached from the build environment; this is built to that
statement.

| What it asks | Where |
|---|---|
| A natural-language payment request | Read by a small grammar, every word of it (below). No language model reads it: a request not read whole is refused, with the words that were not read. Nothing is paid that was not asked for, and nothing asked for is dropped. |
| Turned into payments | Each payment has a recipient (an address, or a name from the address book the run is given), an amount and asset (PROS, or an official token of the Skill Engine's list), and a note. "each" sends one amount to every recipient; "split" shares it, exactly in base units, with any remainder going to the first recipient so the parts add up. |
| A prepared on-chain payment flow | Read through Chain MCP at one block: the sender's next nonce (`get_transaction_count`), then Task 08's dry run of every payment (`get_code`, `eth_call` for balances and the transfer from the sender, `get_balance`, `estimate_gas`, the fee market). Each asset's total is checked against what the sender holds; for PROS, every payment's maximum fee is added on top, since each dry run starts from the same balances. Each payment then comes as the EIP-1559 transaction a wallet signs, in nonce order with its gas limit and fee caps, and as the Skill Engine's `cast send`. |
| Performed, where it can be | On Atlantic, with `--execute` and `PRIVATE_KEY`: the payments are signed locally and sent in order through the official server's `send_raw_transaction`, each checked against its receipt. The first that does not go through stops the rest. Mainnet is prepared only: the hosted Chain MCP is read-only. |

## What it reads

```text
Pay alice 25 USDC                          Send 25 USDC to alice for the March invoice
Pay alice 25 USDC and bob 5 USDC           Send 5 USDC each to alice, bob and 0x…
Split 30 USDC between alice and bob        Transfer 0.01 PROS to 0x…; then pay bob 2 USDC
Please pay alice 1,000 USDC from 0x…, thanks
```

- **Verbs:** pay, send, transfer, give, or split. A clause after "and", a comma or "then" keeps the
  verb before it ("Pay alice 25 USDC and bob 5 USDC").
- **Amounts:** a number with its asset, "1,000" grouped or not, within the asset's decimals. The
  asset is PROS (PHRS on Atlantic) or an official token.
- **Recipients:** an address, or a name in the address book. Several are joined by commas and "and";
  they need "each" or "split", since "5 USDC to alice and bob" could mean either.
- **Extras:** "for …" is a note kept with the payment (a token transfer carries none on chain), and
  "from 0x…" names the sender. "please", "could you" and "thanks" are read and passed over.

A request is refused, saying why, when it names someone the address book does not ("Who is
"carol"?"). It is also refused for an asset that is not official, an amount without its asset, or
words that are not part of a payment ("tomorrow"). The page allows up to 5 payments a request, and
the CLI up to 10.

## Run it

```sh
cd agent && npm ci
printf 'alice = 0x…\nbob = 0x…\n' > contacts.txt      # or JSON: {"alice": "0x…", "bob": "0x…"}
node dist/src/cli.js pay "Pay alice 25 USDC and send 0.01 PROS to bob for lunch" --contacts contacts.txt
node dist/src/cli.js pay "Split 30 USDC between alice and bob" --contacts contacts.txt --from 0x… --json
# Atlantic, sent with your testnet key (--from defaults to its address):
PRIVATE_KEY=0x... node dist/src/cli.js pay "Pay alice 1 USDC and bob 0.5 USDC" --contacts contacts.txt --network atlantic-testnet --execute
```

On Pharos Mainnet the sender is the agent's example address when neither `--from` nor the request
names one.

## The page

`/tasks/17` prepares a request on Pharos Mainnet, from an optional sender, with an address book you
can edit. Its example names stand for the agent's example addresses (the example recipient of
Tasks 05, 08 and 11, and a sample address from Task 23): they are no one's real names. It shows:
- the verdict and its sentence: Ready, Short (the sender holds too little for the flow, though each
  payment fits alone), or Would fail;
- each payment: amount and recipient, the dry run's verdict, gas and fee, its nonce, its note, and
  its `cast send` with a Copy button;
- in all: each asset's total against what the sender holds;
- to sign, in order: the transactions as JSON, with a Copy button;
- how it got there: every step with its source, folded on a phone.

The address bar keeps the request, the sender and the address book. Enter prepares the request;
Shift+Enter starts a new line in it. Nothing is sent from the page: it holds no key.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
mkdir -p ../tasks/17-natural-language-payment/proof
printf 'alice = 0xB2749BD12f19C24a2244176658F3dF3e48e79553\nbob = 0x1F3546a29EeC2102c8d52E21a45114124014c85C\n' > ../tasks/17-natural-language-payment/proof/contacts.txt
node dist/src/cli.js pay "Pay alice 25 USDC and send 0.01 PROS to bob for lunch" --contacts ../tasks/17-natural-language-payment/proof/contacts.txt --proof ../tasks/17-natural-language-payment/proof/two-payments.json
node dist/src/cli.js verify ../tasks/17-natural-language-payment/proof/two-payments.json
# Optionally, sent on Atlantic with a testnet key holding 1.5 USDC and some PHRS:
PRIVATE_KEY=0x... node dist/src/cli.js pay "Pay alice 1 USDC and bob 0.5 USDC" --contacts ../tasks/17-natural-language-payment/proof/contacts.txt --network atlantic-testnet --execute --proof ../tasks/17-natural-language-payment/proof/atlantic-sent.json
```

`verify` checks each proof:
- the official server answered, at the hosted endpoint (or run locally for Atlantic), with
  `get_chain_info` first, on the right chain;
- the request reads again to the same payments;
- every state read before the first send is at the one block;
- replaying the recorded answers gives exactly the recorded payments, totals and verdict;
- each sent transaction, in order, is exactly its dry-run one at its recorded nonce, signed by the sender;
- no key material is anywhere in it (the commands name `$PRIVATE_KEY`, a variable, never a key).

## Tests

```sh
cd agent && npm test                                                        # the agent's tests, offline
node --test tasks/17-natural-language-payment/tests/page.test.mjs          # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/17-natural-language-payment/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. They cover:
- reading requests: one payment, several, each, a split (its parts adding up), a note, a sender,
  polite words, the address book by line or JSON;
- refusals, each with its reason: an unknown name or asset, several recipients without "each",
  words left over, a missing amount or asset, a split to one, zero, too many decimals, too long, too
  many payments, a bad address book;
- a flow of two payments: dry runs at one block, totals covered, nonces in order, the transactions
  and commands, and the proof verifying;
- a flow whose payments each fit but not together; one that would not go through; Atlantic with no
  sender;
- a changed recorded answer failing the proof;
- sending on Atlantic: two payments signed with a public test key and sent in order through the
  official server run locally, each receipt matching, and the proof verifying both signatures;
- the CLI and the HTTP route.

The browser suite drives the page against the real API handler. It covers:
- the example on load, in full;
- the split example, a typed request sent with Enter, a sender given, and Copy;
- a flow the sender cannot cover, and one that would fail;
- a refused request, and bad fields never sent;
- the proof, and six widths in both themes.

## Limits

- **The grammar is small.** Phrasings outside it are refused with the words that were not read, never
  guessed at. A different wording usually works ("Send 25 USDC to alice" for "Get alice her 25 USDC").
- **PROS and the official tokens only**, those of the Skill Engine's list.
- **No note on chain.** An ERC-20 transfer carries no memo; the note stays with the prepared flow.
- **One block, one balance.** Each payment is dry-run from the balances at the block. The flow's
  totals are checked against them, but a later payment's dry run does not include an earlier one.
- **Sent in order, never rolled back.** On Atlantic the first payment that does not go through stops
  the rest, and the ones already sent stay sent: a transfer cannot be undone.
- **Mainnet is prepared, not sent.** The page and the API send nothing; the CLI sends only on Atlantic.
