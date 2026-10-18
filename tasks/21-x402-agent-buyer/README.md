# Task 21: X402 Agent Buyer

An agent with a job and a budget. The job: check a planned transfer before it is sent, and prepare it.
What it needs to know it buys with x402 from Task 20's API, which sells two of the lab's own agents as
paid answers: Task 25's risk check of where the transfer goes, and Task 08's dry run of it. It asks each
price first (a 402 costs nothing), pays USDC only within its budget, uses what it bought, and finishes:
ready to sign with the transaction, do not send, check first, would fail, or not done and why. Every
chain read and write, the API's and its facilitator's, goes through **Pharos Chain MCP**.

Code: [`agent/src/buyer/`](../../agent/src/buyer), with the API's products in
[`agent/src/x402/products.ts`](../../agent/src/x402/products.ts) and
[`api.ts`](../../agent/src/x402/api.ts), on the shared agent runtime ([`agent/`](../../agent)).
Page: `/tasks/21`.

## Requirement

The official task map: *"Build an agent that calls x402-paywalled APIs, pays within a defined budget,
uses the purchased result, and finishes its task."* The full task page could not be reached from the
build environment; this is built to that statement, on the official Pharos x402 skill
([PharosNetwork/examples `skills/x402-pharos`](https://github.com/PharosNetwork/examples/tree/f08e921b7643f3ecfa5f388b8508778daa93b97a/skills/x402-pharos)
at `f08e921`) and Task 20's API.

| What it asks | Where |
|---|---|
| Calls x402-paywalled APIs | `GET /risk` and `GET /dryrun` on Task 20's API, each answering 402 with its price until paid. The buyer pays with x402's own client (`@x402/fetch`, the `exact` EVM scheme), in-process or over HTTP: `--api URL` buys from any x402 API that sells the two, such as `x402 serve`. |
| Pays within a defined budget | The budget is in USDC. The buyer asks each price for free first, then plans: the check, then the dry run, each only if it fits what is left. x402's spend controls cap each payment at what is left, and a hook refuses any payment past it, or at another price than the 402 asked. Every signed authorization counts against the budget, settled or not, since whoever holds it could settle it until it expires. The ledger says what was signed for, what settled and what is left. |
| Uses the purchased result | The answers decide the job. "Do not send" or "check first" ends it there, and the dry run is not bought: it would not change the answer, so that part of the budget is kept. Otherwise the dry run says whether the transfer would succeed, what its gas would cost, and gives the transaction to sign. |
| Finishes its task | Ready to sign (with the transaction), do not send, check first, would fail, or not done with the reason (a price over the budget, a payment refused). The report holds every purchase: the 402's terms, the authorization signed, the answer bought and its settlement. |

## How a job goes

1. **The asset**, read through Chain MCP at one block: the official USDC, its decimals and EIP-712 domain.
2. **Discover**: `GET /risk?asset=USDC&from=…&to=…&amount=25` and `/dryrun` asked once each without
   paying; each 402 gives the price. A job the API cannot answer (an unknown asset, a bad address) is
   refused with 400 before any 402, so nobody pays for an answer that cannot be given.
3. **Buy the check**, if it fits. The API's facilitator verifies the payment on chain, the API runs
   Task 25's check through Chain MCP, the facilitator settles, and only then does the answer come back.
4. **Decide or buy on**: do not send or check first ends the job. Looks fine: the dry run, if it still
   fits what is left.
5. **Finish**: the outcome, the ledger, every purchase, and on "ready" the transaction to sign.

On Pharos Mainnet nothing settles: the hosted Chain MCP is read-only. A run there, the page's or the
CLI's, pays with a key made for it that holds nothing: the prices, the plan and the first authorization
are real, the API's facilitator refuses it on chain, and the job is not done. On Atlantic, with keys,
the job is finished.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js buy                          # Pharos Mainnet: prices, plan, the first payment refused (exit 9)
node dist/src/cli.js buy --budget 0.001           # too little for anything: nothing signed
# Atlantic: the buyer pays with PRIVATE_KEY (and, by default, sends from its address); the API in this
# process settles with FACILITATOR_PRIVATE_KEY, else PRIVATE_KEY:
PRIVATE_KEY=0x... FACILITATOR_PRIVATE_KEY=0x... node dist/src/cli.js buy --network atlantic-testnet --execute --to 0x...
# From an x402 API elsewhere, such as Task 20's served in another terminal:
FACILITATOR_PRIVATE_KEY=0x... node dist/src/cli.js x402 serve --network atlantic-testnet --execute
PRIVATE_KEY=0x... node dist/src/cli.js buy --network atlantic-testnet --execute --to 0x... --api http://127.0.0.1:4020
```

Options: `--to`, `--amount` (default 25), `--token` (PROS or an official token; default USDC),
`--from` (default the example sender, or PRIVATE_KEY's address with `--execute`), `--budget` (USDC,
default 0.01), `--api URL`, `--vendor 0x…` (who the API in this process is paid; default a sample
address of the lab), `--json`, `--proof FILE`, `--verbose`. Exit 0 when the transfer is ready to sign,
9 otherwise. The API's prices are its own: 0.005 USDC for the check, 0.003 for the dry run.

## The page

`/tasks/21` gives the agent a job on Pharos Mainnet: the amount and asset, who it goes to and from, and
the budget. It shows:
- the verdict and its sentence;
- what it bought: each answer, its price, and what became of it (bought and settled, refused, not
  needed, over the budget);
- the budget: a meter of what was signed for, and the ledger (budget, signed for, settled, left);
- what the answers said, and on "ready" the transaction to sign with a Copy button;
- how it got there: every step with its source, folded on a phone.

The page holds no key, so nothing settles from it: its runs end at the API's facilitator refusing the
first payment on chain, and say so. The address bar keeps the job and the budget.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
mkdir -p ../tasks/21-x402-agent-buyer/proof
# Pharos Mainnet, no key: exit 9 (not done) is expected, and the proof is as valid
node dist/src/cli.js buy --proof ../tasks/21-x402-agent-buyer/proof/mainnet.json
node dist/src/cli.js verify ../tasks/21-x402-agent-buyer/proof/mainnet.json
# Atlantic, finished, with a testnet key holding a little USDC and some PHRS (one key can be both):
PRIVATE_KEY=0x... node dist/src/cli.js buy --network atlantic-testnet --execute --to 0x1F3546a29EeC2102c8d52E21a45114124014c85C --amount 0.01 --proof ../tasks/21-x402-agent-buyer/proof/atlantic.json
node dist/src/cli.js verify ../tasks/21-x402-agent-buyer/proof/atlantic.json
```

As for Task 20, everything rests on whether the official USDC answers EIP-3009: the run reads it first.

The payments cannot be replayed (a random nonce, the clock, a key made for the run), so `verify` checks
their facts against the recorded Chain MCP answers, and replays what can be replayed:
- the official server answered, at the hosted endpoint (or run locally for Atlantic), with
  `get_chain_info` first, on the right chain;
- the job, the budget and the API's payee are the ones asked; the asset is read again by replay;
- within the budget: each authorization signed only within what was left, in order, and the ledger
  exactly what was signed and settled;
- each authorization recovers to the buyer and is for exactly the price its 402 asked;
- nothing was sent by a facilitator without a key; each settlement claimed is exactly its
  authorization, sent by the facilitator, its receipt a success holding the Transfer;
- every answer bought is recomputed through the same code (Task 25's check, Task 08's dry run) from its
  own recorded calls, and must come out exactly as bought;
- the outcome is recomputed from what was bought;
- no key material is anywhere in it.

## Tests

```sh
cd agent && npm test                                                    # the agent's tests, offline
node --test tasks/21-x402-agent-buyer/tests/page.test.mjs              # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/21-x402-agent-buyer/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it, whose USDC implements EIP-3009
as Circle's does. They cover:
- the products: a transfer read from the query, a request that cannot be answered refused with 400
  before any 402, the free listing, and the outcome as a function of what was bought;
- Atlantic: ready (both bought and settled, the API paid on chain, the transaction to sign, the proof
  verifying, and forged proofs failing: a verdict not what was bought says, an answer changed, a ledger
  that hides a purchase); do not send for a lookalike (the dry run not bought, half the budget kept); a
  budget enough for the check only, and one enough for nothing (nothing signed); a price changed after
  the 402 (not signed); the same job bought from an API over HTTP;
- Pharos Mainnet: the first payment refused, the signed authorization counted, nothing sent, the proof
  verifying; a key refused off Atlantic;
- the CLI (mainnet, Atlantic `--execute`, `--api` against `x402 serve`, refusals) and the HTTP route.

The browser suite drives the page against the real API handler: the example on load, a budget too small,
a job of your own, a job finished (a real run on a fake Atlantic chain, answered to the page), bad fields
never sent, the proof, and six widths in both themes.

## Limits

- **One kind of job.** Checking and preparing a transfer of PROS or an official token. The buyer's
  shopping list is fixed: the check, then the dry run.
- **USDC only, the official one.** It pays in nothing else, and only by x402's `exact` scheme (EIP-3009).
- **Settling is Atlantic's.** On Pharos Mainnet the API's facilitator only verifies, so the job is not
  done there. The page never settles.
- **Counted when signed.** A refused payment still counts against the budget until it expires (300 s):
  the buyer cannot know that nobody will settle it.
- **One API.** It buys from the API it is given; it does not compare sellers.
