# Task 18: Recurring Payment Agent

An agent that handles repeating payments on Pharos: rent, payroll, subscriptions. You write a schedule,
a payment a line. Each run works out, at the chain's own time, what fell due and is not paid yet. It
takes the oldest, and prepares them through **Pharos Chain MCP** as Task 17's flow: each dry-run at
one block, the totals against what the payer holds, the transactions to sign in nonce order, the
**Pharos Skill Engine**'s `cast send`. With a store, what is paid is kept, so a missed run is caught
up and nothing is paid twice. On Atlantic, with a key, the CLI sends the payments and records each.
Run it from cron.

Code: [`agent/src/recurring/`](../../agent/src/recurring), on the shared agent runtime
([`agent/`](../../agent)): Task 17's payment flow, Task 08's dry run, the run-to-run store and history
of Tasks 09, 22 and 28. Page: `/tasks/18`.

## Requirement

The official task map: *"Handles repeating payments such as subscriptions, payroll, or rent."* The full
task page could not be reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| Repeating payments | A schedule, a payment a line, read by a small grammar (below): who is paid, how much of PROS or an official token, how often, and from and until which day. A line not read whole is refused, saying which part. |
| Subscriptions, payroll, rent | Rules for each: daily or every N days; weekly or every N weeks on a weekday; monthly or every N months on a day (a day past a month's end falls on its last day, so "the 31st" is February's 28th or 29th) or on "the last day"; yearly on a month and day. |
| Handles them | Each run reads the pinned block's UTC day. Every day a payment fell due since the start, and that is not recorded as paid, is owed. A run takes the oldest, at most 3 of one payment and 10 in all (6 on the page); the rest wait for the next run. They are prepared as Task 17's flow: the payer's nonce, Task 08's dry run of each (`get_code`, `eth_call` for the balances and the transfer, `get_balance`, `estimate_gas`, the fee market), and the totals against what the payer holds. |
| Each paid once | The CLI's store keeps the day it counts from and each payment paid, by its name and due day, with its transaction. What is owed is worked out again every run, so a payment that did not go through stays owed until one does. One sent but not yet in a block is recorded as pending: it is never sent again while it may still land, and the next run reads its receipt (`get_transaction_receipt`). It is then paid, owed again if it reverted, or still pending. |

## The schedule

```text
Rent: 25 USDC to 0x…, monthly on the 1st
Payroll: 1,000 USDC to 0x…, monthly on the last day, from 2026-10-01
Design tool: 2 USDC to 0x…, weekly on Monday, until 2027-06-30
Gym: 0.01 PROS to 0x…, every 2 weeks on Friday, from 2026-10-02
Domain: 12 USDC to 0x…, yearly on March 1
# a line starting with # is a comment
```

- **A line**: a name, a colon, the amount and asset, "to" and the address, then the rule, then
  optionally "from" and "until" a day (dates as `2026-10-01`, `1 October 2026` or `Oct 1, 2026`).
- **The name** is what each payment is recorded under (`rent@2026-10-01`), so two lines cannot share
  one. Renaming a line starts its record afresh.
- **Every N** of weeks or months, and every N days, count from the "from" day, which they then need.
- **Refused**: an asset that is not official, an amount with more decimals than its asset has, an
  address that fails its checksum, the zero address or a token contract, a rule it does not read, two
  rules, an end before the start, a day a month does not have (February 30), more than 20 lines.

## Run it

```sh
cd agent && npm ci
printf 'Rent: 25 USDC to 0x…, monthly on the 1st\n' > schedule.txt
node dist/src/cli.js recurring schedule.txt                                  # due today, prepared
node dist/src/cli.js recurring schedule.txt --store store.json --since 2026-10-01
node dist/src/cli.js recurring schedule.txt --store store.json               # the next run: from the store
# Atlantic, sent with your testnet key (--from defaults to its address), each payment recorded:
PRIVATE_KEY=0x... node dist/src/cli.js recurring schedule.txt --store atlantic.json --network atlantic-testnet --execute
```

A cron line makes it a recurring agent, for example once a day:
`7 6 * * * cd ~/pharos-season-of-ai/agent && PRIVATE_KEY=… node dist/src/cli.js recurring schedule.txt --store atlantic.json --network atlantic-testnet --execute`.
Sending needs `--store`: without one, nothing would record what was paid. On Pharos Mainnet nothing is
sent (the hosted Chain MCP is read-only), so what is owed stays owed, prepared for you to sign.

## The page

`/tasks/18` runs a schedule on Pharos Mainnet from the first of the block's month (or a day you give),
from an optional payer. Its example names are samples, paid at the agent's example addresses. It
shows:
- the verdict and its sentence: Ready, Nothing due, Short, or Would fail;
- what is due, oldest first: each payment's name, due day and how late, its dry run, gas and nonce,
  and its `cast send` (folded, with a Copy button); and how many more wait for the next run;
- in all: each asset's total against what the payer holds;
- the schedule: each payment, how often, what it owes and its next due day;
- to sign, in order: the transactions as JSON, with a Copy button;
- how it got there: every step with its source, folded on a phone.

The page keeps nothing between runs, so nothing it shows is recorded as paid: the CLI's store does that.
The address bar keeps the schedule, the day and the payer. Ctrl+Enter prepares; Enter starts a new line.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
mkdir -p ../tasks/18-recurring-payment/proof
node -e 'import("./dist/src/web.js").then((m) => process.stdout.write(m.DEFAULT_SCHEDULE + "\n"))' > ../tasks/18-recurring-payment/proof/schedule.txt
node dist/src/cli.js recurring ../tasks/18-recurring-payment/proof/schedule.txt --store ../tasks/18-recurring-payment/proof/store.json --since "$(date -u +%Y-%m-01)" --proof ../tasks/18-recurring-payment/proof/run-1.json
node dist/src/cli.js recurring ../tasks/18-recurring-payment/proof/schedule.txt --store ../tasks/18-recurring-payment/proof/store.json --proof ../tasks/18-recurring-payment/proof/run-2.json
node dist/src/cli.js verify ../tasks/18-recurring-payment/proof/run-1.json ../tasks/18-recurring-payment/proof/run-2.json
# Optionally, sent on Atlantic with a testnet key holding about 2.5 USDC and some PHRS:
printf 'Rent: 1.1 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, monthly on the 1st\nTool: 0.2 USDC to 0x1F3546a29EeC2102c8d52E21a45114124014c85C, daily\n' > ../tasks/18-recurring-payment/proof/atlantic.txt
PRIVATE_KEY=0x... node dist/src/cli.js recurring ../tasks/18-recurring-payment/proof/atlantic.txt --store ../tasks/18-recurring-payment/proof/atlantic-store.json --since "$(date -u +%Y-%m-01)" --network atlantic-testnet --execute --proof ../tasks/18-recurring-payment/proof/atlantic-1.json
PRIVATE_KEY=0x... node dist/src/cli.js recurring ../tasks/18-recurring-payment/proof/atlantic.txt --store ../tasks/18-recurring-payment/proof/atlantic-store.json --network atlantic-testnet --execute --proof ../tasks/18-recurring-payment/proof/atlantic-2.json
node dist/src/cli.js verify ../tasks/18-recurring-payment/proof/atlantic-1.json ../tasks/18-recurring-payment/proof/atlantic-2.json
```

The second Atlantic run sends what the first left owed (beyond 3 of one payment), and nothing the
first paid. `verify` checks each proof:
- the official server answered, at the hosted endpoint (or run locally for Atlantic), with
  `get_chain_info` first, on the right chain;
- the schedule reads again;
- every state read before the first send is at the one block;
- replaying the recorded answers, from the store the run started with, gives exactly the recorded owed
  payments, flow, store and verdict;
- each sent payment, in order, is exactly its dry-run one, at its recorded nonce, signed by the payer;
- no key material is anywhere in it;
- several runs verified together form one history: each from the store the last one left, no payment
  recorded twice.

## Tests

```sh
cd agent && npm test                                                    # the agent's tests, offline
node --test tasks/18-recurring-payment/tests/page.test.mjs             # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/18-recurring-payment/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. They cover:
- reading schedules: every rule, amounts with commas, a start and an end, comments; refusals, each with
  its reason;
- the calendar: the 31st and the last day across months and a leap year, every 2 weeks and every 3
  months from a start, every 10 days, an end, the next due day;
- the store's shape, network and payer;
- this month so far: every payment owed, oldest first, prepared as one flow, and the proof verifying;
- nothing due; the limits of a run with the rest left for the next; more than the payer holds;
- a mainnet store: prepared, not sent, so still owed next run; two runs as one history, and out of
  order not; a store's start not moved, nor its payer changed;
- a changed recorded answer failing the proof;
- Atlantic: sending refused without a store; four payments sent in order and recorded; the same day
  again, nothing owed; a pending one not paid again until its receipt shows, then recorded; every proof
  verifying, with its signatures and nonces, and as one history;
- the CLI (two runs on one store, verified as one history) and the HTTP route.

The browser suite drives the page against the real API handler. It covers:
- the example on load, in full;
- a daily payment with the rest waiting, a first day given and sent with Ctrl+Enter, and Copy;
- nothing due, and more than the payer holds;
- a schedule refused with the part not read, and bad fields never sent;
- the proof, and six widths in both themes.

## Limits

- **The grammar is small.** A rule outside it is refused, never guessed at.
- **PROS and the official tokens only**, those of the Skill Engine's list.
- **UTC days.** A payment falls due at 00:00 UTC on its day, by the block's time, not the clock's.
- **A store is the record.** The page keeps none; without the CLI's store, nothing is known as paid.
  Payments made another way are not seen: record them by starting the store after them.
- **Sent in order, never rolled back.** On Atlantic, the first payment that does not go through stops
  the rest; it stays owed, and the ones already sent stay sent.
- **Mainnet is prepared, not sent.** The page and the API send nothing; the CLI sends only on Atlantic.
