# Task 20: X402 Paywalled API

An API that charges per request with x402 on Pharos: a paid endpoint, a facilitator, and a paying client
that receives the requested data. All three are built on the official x402 packages, as the Pharos x402
skill sets them up, and the facilitator's every chain read and write goes through **Pharos Chain MCP**.
The endpoint answers 402 with its terms. The client signs an EIP-3009 authorization for exactly them,
never above its cap. The facilitator verifies it (the transfer simulated on chain) and settles it
(`transferWithAuthorization` sent and its receipt checked). Only then is the data released.

Code: [`agent/src/x402/`](../../agent/src/x402), on the shared agent runtime ([`agent/`](../../agent)).
Page: `/tasks/20`.

## Requirement

The official task map: *"Build an API that charges per request with x402 on Pharos: a paid endpoint, a
facilitator, and a paying client that receives the requested data."* The full task page could not be
reached from the build environment; this is built to that statement, on the official Pharos x402 skill
([PharosNetwork/examples `skills/x402-pharos`](https://github.com/PharosNetwork/examples/tree/f08e921b7643f3ecfa5f388b8508778daa93b97a/skills/x402-pharos)
at `f08e921`). The skill names the packages (`@x402/core`, `@x402/evm`, `@x402/fetch`, `@x402/express`,
v2, with viem), the networks (`eip155:1672` Pharos Mainnet, `eip155:688689` Atlantic), the `exact`
scheme and USDC. It leaves the USDC address and the facilitator to the builder.

| What it asks | Where |
|---|---|
| An API that charges per request | `GET /data`: live chain data (the newest block and the gas price) read through Chain MCP, priced in USDC a request. Asked without a payment, it answers `402 Payment Required` with its terms in `PAYMENT-REQUIRED`: the amount, who is paid, the asset, the network, the `exact` scheme. Built on x402's HTTP resource server (`x402HTTPResourceServer` from `@x402/core`, the class `@x402/express`'s middleware wraps), as a function from a `Request` to a `Response`: the same handler runs in the CLI's run, behind its HTTP server, and in the page's serverless function. |
| With x402 on Pharos | x402's `exact` EVM scheme (`@x402/evm`) on `eip155:1672` and `eip155:688689`. The asset is the official USDC of the network (the Skill Engine's token list), and the EIP-712 name and version an authorization signs are read from the token itself, through Chain MCP, never assumed. |
| A facilitator | x402's facilitator (`x402Facilitator` with the `exact` EVM scheme) whose signer is Chain MCP: `eth_call` for its reads and its simulation of the transfer, `get_code`, `estimate_gas`, `send_raw_transaction` to settle, `get_transaction_receipt` to check the Transfer. It verifies (the signature, the recipient, the amount, the validity window, then `transferWithAuthorization` simulated on chain; refused, it reads why: the payer's balance, the token's name and version, the nonce) and settles. It is served over HTTP with x402's routes, `POST /verify`, `POST /settle` and `GET /supported`, so any x402 endpoint can use it, and the endpoint can use any x402 facilitator. |
| A paying client that receives the data | x402's fetch (`wrapFetchWithPayment` from `@x402/fetch`) with the `exact` EVM client scheme. Answered 402, it signs an EIP-3009 `TransferWithAuthorization` for the terms and asks again with it in `PAYMENT-SIGNATURE`. It receives `200` with the data and `PAYMENT-RESPONSE`, naming the settlement. It pays only in the asset given, at most a cap a request (x402's own spend controls). |

## How a request goes

1. **The asset**, read through Chain MCP at one block: `name()`, `symbol()`, `version()`, `decimals()`,
   and whether it answers EIP-3009's `authorizationState`, which the `exact` scheme settles by. One that
   does not is said so, with whether x402's other way to settle, Permit2, has its contracts on the
   chain (Permit2 and x402's proxy, by `get_code`). This agent settles by EIP-3009, as the skill does.
2. **402**: `GET /data` without a payment, answered with its terms.
3. **The authorization**: the client signs for exactly the terms, valid for 300 s, never above its cap.
4. **Verify**: the facilitator checks it; refused, the data stays locked, and nothing is sent.
5. **Settle**: verified, the data is made, then the payment settled. `transferWithAuthorization` is sent
   through Chain MCP and its receipt checked for the Transfer of the amount to the recipient. Only a
   settled payment releases the data, with `PAYMENT-RESPONSE`.

On Pharos Mainnet nothing can settle: the hosted Chain MCP is read-only. A run there, the CLI's or the
page's, pays with a key made for the run that holds nothing and is never kept. Everything real happens
up to the facilitator's check on chain, which refuses it, and the data stays locked. On Atlantic, with
keys, the payment is made and settled.

## What building it showed (tested here)

- **The skill's sample client, as written, refuses a Pharos price with the 2.28.0 packages.** x402's
  client now pays only "default assets", and Pharos USDC is not among them. The skill's client
  (`x402Client` with `ExactEvmScheme`, nothing else) fails with "All payment requirements were rejected
  by spendControls: only default assets or entries in spendControls.allowedAssets are allowed". The
  skill pins `^2.0.0`, so a fresh install gets this. This client sets
  `spendControls.allowedAssets` to the one asset, with a cap a payment, which is also what keeps a
  paying agent within budget.
- **The domain an authorization signs comes from the token.** The skill's sample server takes the
  token's EIP-712 name from `USDC_NAME` (default `"USDC"`) and fixes the version at `"2"`. If the
  token's own `name()` or `version()` differs, every payment is refused as a name or version mismatch.
  Here both are read from the token through Chain MCP.
- **The facilitator is registered for this chain only.** x402's `registerExactEvmScheme` also registers
  x402 v1 on two dozen named networks (Base, Polygon…), none of them Pharos, which a facilitator
  reaching Pharos through Chain MCP cannot serve. So the scheme is registered for the one network, and
  `GET /supported` names only it.
- **No Multicall3 is assumed.** The facilitator batches its reads for a refused payment's reason
  through Multicall3's `tryAggregate`. Whether Pharos has Multicall3 is not something this code relies
  on: the signer answers a `tryAggregate` by making each call through Chain MCP.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js x402                         # Pharos Mainnet: the 402, an authorization, refused at verify (exit 9)
node dist/src/cli.js x402 --price 0.01 --cap 0.001  # the client's cap below the price: it does not sign
# Atlantic, paid and settled. The payer needs Atlantic USDC; the facilitator (FACILITATOR_PRIVATE_KEY,
# else PRIVATE_KEY) needs PHRS for the gas:
PRIVATE_KEY=0x... FACILITATOR_PRIVATE_KEY=0x... node dist/src/cli.js x402 --network atlantic-testnet --execute
# As a real API on 127.0.0.1:4020, and a client paying it:
FACILITATOR_PRIVATE_KEY=0x... node dist/src/cli.js x402 serve --network atlantic-testnet --execute
PRIVATE_KEY=0x... node dist/src/cli.js x402 pay http://127.0.0.1:4020/data --network atlantic-testnet --cap 0.01
```

`x402 serve` answers `GET /data` (paid), `GET /` (free: the terms) and the facilitator's routes under
`/facilitator/`. With `--facilitator URL` it verifies and settles with another x402 facilitator instead.
`x402 pay` works against any x402 endpoint on Atlantic: it pays only the asset given (default the
official USDC), at most `--cap` (default 0.001) a request, and prints the 402's terms, the authorization,
the settlement and the answer. Options: `--price`, `--cap`, `--to` (who is paid; default the example
recipient), `--token` (an official token's symbol or an address), `--json`, `--proof FILE`, `--verbose`.

## The page

`/tasks/20` runs a request on Pharos Mainnet through the hosted Chain MCP: the price (default 0.001
USDC), the client's cap, and who is paid. It shows:
- the verdict and its sentence: Refused, Not paid (the client did not sign, and why), Not settled, or
  Paid;
- the exchange in four stages: the endpoint's 402 terms, the client's signed authorization, the
  facilitator's verify and settle, and the data, locked unless the payment settled;
- the asset as the chain reports it: its EIP-712 name and version, its decimals, and EIP-3009 or not
  (and, when not, the Permit2 contracts looked for);
- how it got there: every step with its source, folded on a phone.

The page holds no key and can settle nothing. Each request pays with a key made for it that holds
nothing and is never kept, so the facilitator's check on chain is real and its refusal expected. The
address bar keeps the price, cap and recipient.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
mkdir -p ../tasks/20-x402-paywalled-api/proof
# Pharos Mainnet, no key: exit 9 (nothing settled) is expected, and the proof is as valid
node dist/src/cli.js x402 --proof ../tasks/20-x402-paywalled-api/proof/mainnet.json
node dist/src/cli.js verify ../tasks/20-x402-paywalled-api/proof/mainnet.json
# Atlantic, paid and settled, with a testnet key holding a little USDC and some PHRS (one key can be both):
PRIVATE_KEY=0x... node dist/src/cli.js x402 --network atlantic-testnet --execute --price 0.01 --proof ../tasks/20-x402-paywalled-api/proof/atlantic-paid.json
node dist/src/cli.js verify ../tasks/20-x402-paywalled-api/proof/atlantic-paid.json
```

Both runs first read whether the official USDC answers EIP-3009. That decides whether x402's `exact`
scheme can settle in it at all, and it is not stated by any official source this build could reach. If
the asset step says it does not, that is the finding: keep the proof, which shows it from the chain.

A payment cannot be replayed whole: a fresh random nonce, the time it ran, and on mainnet a key made for
it and never kept. So `verify` checks the proof's facts against its recorded Chain MCP answers:
- the official server answered, at the hosted endpoint (or run locally for Atlantic), with
  `get_chain_info` first, on the right chain;
- the price, cap, recipient and asset are the ones asked;
- the asset, read again by replaying the run's first calls through the same code, is as recorded;
- the 402's terms are exactly the endpoint's: the amount, the recipient, the asset and its EIP-712 name
  and version, on this network;
- the authorization recovers to the payer and is for exactly those terms, within the cap;
- the facilitator's verdict is what the chain answered: a successful simulation of exactly that
  authorization, or a reverted one, with the payer's recorded balance under the price for a refusal for
  want of funds;
- nothing was sent by a facilitator without a key; when settled, the one transaction sent is
  `transferWithAuthorization` of exactly the signed authorization, signed by the facilitator, its hash
  the one settled, its receipt a success holding the Transfer;
- the data was released only for a settled payment, and it is what Chain MCP answered;
- no key material is anywhere in it.

## Tests

```sh
cd agent && npm test                                                    # the agent's tests, offline
node --test tasks/20-x402-paywalled-api/tests/page.test.mjs            # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/20-x402-paywalled-api/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it, whose USDC implements EIP-3009
as Circle's does (the signature recovered by EIP-712, the validity window, each nonce used once). They
cover:
- the asset read: an EIP-3009 token, a plain token, no token;
- Pharos Mainnet: the 402's terms, an authorization signed by a key made for the run, refused for want
  of funds, nothing sent, and the proof verifying; forged proofs failing (data released for a refused
  payment, an authorization for more, a recorded balance changed);
- the client's cap below the price; a token without EIP-3009, with Permit2 looked for; refusals before
  anything runs;
- Atlantic: paid, settled through Chain MCP, the balances moved, the data released, the proof
  verifying, and a forged settlement failing; the same authorization a second time refused as used; a
  payer short of the price refused at verify, nothing sent;
- Chain MCP failing is an error, never a verdict: x402's facilitator takes any failed read for a failed
  check, so a failure during its simulation ends the run as an error rather than a refusal, and one after
  the settlement is signed names that transaction, so it is not paid again;
- over HTTP as the skill sets it up: the endpoint asking x402's HTTP facilitator client, the facilitator
  answering `/supported`, `/verify` and `/settle`, the client paying with fetch;
- the CLI (mainnet, Atlantic `--execute`, `serve` and `pay` against each other) and the HTTP route.

The browser suite drives the page against the real API handler. It covers the example on load, over the
client's cap, a recipient of your own, an asset without EIP-3009, a settled payment (a real run of the
agent on a fake Atlantic chain, answered to the page), bad fields never sent, the proof, and six widths
in both themes.

## Limits

- **EIP-3009 only.** The `exact` scheme settles by `transferWithAuthorization`, as the skill does. x402's
  Permit2 path is not built; a run says whether its contracts exist on the chain.
- **Wallets that sign as an account.** The facilitator checks an EOA's signature. A smart wallet's
  (ERC-1271, or ERC-6492 before it is deployed) is not accepted.
- **Settling is Atlantic's.** On Pharos Mainnet the facilitator only verifies (the hosted Chain MCP is
  read-only), so nothing is paid there and no data is released. The page never settles.
- **One paid route.** `GET /data`, at one price. The facilitator pays the gas of each settlement.
- **A payment is valid for 300 s.** x402's default for the `exact` scheme; the facilitator checks the
  window against its clock, and the token against the block's.
