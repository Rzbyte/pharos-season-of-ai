# Task 20 submission: X402 Paywalled API

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/20 |
| Repository | [`tasks/20-x402-paywalled-api/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/20-x402-paywalled-api); code in [`agent/src/x402/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/x402) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | The Pharos x402 skill (PharosNetwork/examples `skills/x402-pharos` at `f08e921`): `@x402/core`, `@x402/evm`, `@x402/fetch` 2.28.0 with viem, the `exact` scheme on `eip155:1672` and `eip155:688689`. Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_block`, `eth_call`, `get_code`); on Atlantic, the official server run locally, which also settles (`get_gas_price`, `estimate_gas`, `get_transaction_count`, `send_raw_transaction`, `get_transaction_receipt`). The Skill Engine's token list for the official USDC |

## Reviewer note

An API that charges per request with x402 on Pharos, with all three parties. The paid endpoint,
`GET /data`, answers 402 with its terms. The paying client signs an EIP-3009 authorization for exactly
them, never above its cap, and asks again. The facilitator verifies it, simulating the transfer on chain
through Chain MCP, then settles it with `transferWithAuthorization` sent through Chain MCP, and the data
is released only once the receipt holds the Transfer. On Atlantic the CLI pays and settles, and serves
the API over HTTP for any x402 client. On Pharos Mainnet, where the hosted Chain MCP is read-only, the
page runs everything up to the facilitator's check on chain, with a key made for the request that holds
nothing.

## Key implementation detail

The facilitator is x402's own, with its chain access swapped for Chain MCP: every read, the simulation,
the send and the receipt are recorded MCP calls. Building it showed three things worth knowing:
- x402's 2.28 client refuses assets outside its defaults, so the skill's sample client cannot pay Pharos
  USDC as written; this client allows the one asset with a cap a payment.
- The EIP-712 domain a payment signs is read from the token, not assumed.
- The facilitator is registered for the Pharos network alone, not x402 v1's two dozen others.

A payment cannot be replayed (a random nonce, the clock, a throwaway key), so the verifier checks its
facts against the recorded answers: the terms, the signature, the simulation, and the one transaction
sent, exactly the signed authorization, signed by the facilitator, its receipt holding the Transfer.

## Video walkthrough (about 60 s)

1. Open `/tasks/20`: GET /data's 402 terms in USDC, an authorization signed by a key made for the
   request, and the facilitator refusing it on chain: the payer holds nothing, the data stays locked.
2. "Over the client's cap": the client does not sign at all.
3. In a terminal, on Atlantic: `x402 serve --execute`, then `x402 pay http://127.0.0.1:4020/data`. The
   402, the authorization, the settlement transaction, and the data arrive; then `verify` a run's proof.

## X post draft

An API on Pharos that charges per request with x402. Ask without paying and it answers 402 with its
terms. A client signs a USDC authorization within its cap, a facilitator checks it on chain through
Pharos Chain MCP and settles it, and only then is the data released.
https://pharos-agent-lab.vercel.app/tasks/20

## How it works (reply)

x402's packages throughout: the resource server answers 402, x402's fetch signs an EIP-3009
TransferWithAuthorization, and x402's facilitator verifies (eth_call simulation) and settles
(send_raw_transaction), with every chain call through Pharos Chain MCP.
