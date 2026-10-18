# pharos-agent

The agent behind Pharos Agent Lab Tasks 05 onward: one runtime that gains a capability per task,
instead of a separate app for each. Tasks 01 to 04 keep their own code.

```sh
cd agent
npm ci                                   # installs and compiles to dist/
node dist/src/cli.js --help
node dist/src/cli.js guardian payout     # Task 05 on Pharos Mainnet, through the hosted Chain MCP
node dist/src/cli.js dryrun              # Task 08: a USDC transfer, dry-run on Pharos Mainnet
node dist/src/cli.js gate                # Task 11: a payment checked against the treasury policy
node dist/src/cli.js watch --store s.json  # Task 09: one observation per run, kept in s.json
node dist/src/cli.js alert --store a.json  # Task 22: new transfers and condition changes since the last run
node dist/src/cli.js whales --store w.json # Task 23: tracked addresses, their changes and significant moves
node dist/src/cli.js gas --store g.json    # Task 24: send now or wait, with the fee capped at the target
node dist/src/cli.js risk --to 0x…         # Task 25: the recipient's history, checked before sending
node dist/src/cli.js audit 0x… --hours 24  # Task 26: what an address did, in plain sentences
node dist/src/cli.js explain 0x…           # Task 27: why a transaction failed
node dist/src/cli.js digest usdc --every day --periods 2  # Task 28: a token's last two days, summed up
node dist/src/cli.js ask "What is the USDC token address on Pharos Mainnet?"  # Task 13: the docs, then the chain
node dist/src/cli.js howto "How do I wrap 0.5 PROS into WPROS?"  # Task 29: the docs' how-to, prepared
node dist/src/cli.js pay "Pay alice 25 USDC" --contacts c.txt  # Task 17: a request in plain words, prepared
node dist/src/cli.js invoice invoice.txt --payees p.txt  # Task 19: an invoice checked, its payment prepared
node dist/src/cli.js recurring schedule.txt --store r.json  # Task 18: what a schedule owes, paid once
node dist/src/cli.js x402                  # Task 20: a paid API, its facilitator and a paying client (x402)
node dist/src/cli.js buy                   # Task 21: an agent buying what its job needs with x402, within a budget
npm test                                 # every test, offline
```

## What it is made of

| Path | What it is |
|---|---|
| `src/core/chain-mcp.ts` | The Chain MCP client, on the official MCP SDK. It reaches the hosted endpoint over Streamable HTTP, the official server run locally over stdio, or any transport (tests). It records every JSON-RPC message, never an HTTP header. It can pace its calls under a rate (a long CLI run keeps under the hosted endpoint's 120 a minute). |
| `src/core/chain.ts` | Typed wrappers for the official server's tools, each payload checked against the shape `vendor/pharos-mcp/src/server.ts` returns. Blocks are passed as 0x quantities. |
| `src/core/networks.ts` | Pharos Mainnet and Atlantic: RPCs, chain IDs, explorers and token addresses from the [Pharos Skill Engine](https://github.com/PharosNetwork/pharos-skill-engine) (`a873387`), and the hosted Chain MCP. |
| `src/core/abi.ts`, `amounts.ts` | Calls by signature (`"paused() returns (bool)"`) through viem; exact amounts in human units, with no floats. |
| `src/core/execute.ts` | Signing and broadcasting, apart from everything else. The key comes from `PRIVATE_KEY`, signs, and goes nowhere: only the signed transaction leaves, through Chain MCP `send_raw_transaction` (or, for x402, the account that signs an authorization, which never gives out its key). Atlantic only. |
| `src/core/simulate.ts` | A transaction simulated with `eth_call` at a pinned block (a revert is a result, with its reason), and priced with `estimate_gas` and the fee market by the formula `execute.ts` signs with. |
| `src/core/proof.ts` | The proof format (`pharos-agent-proof/1`) and its replay: recorded answers are fed back through the same code, which must make exactly the recorded calls and produce exactly the recorded result. |
| `src/guardian/` | Task 05, Threshold Guardian: config, deciding, the run, presets, the proof verifier. |
| `src/dryrun/` | Task 08, Dry-Run Executor: intents, the dry run (state, simulation, cost, predicted outcome, warnings), Atlantic submission compared with the receipt, the proof verifier. |
| `src/trend/` | Task 09, Trend Watcher: watchers (what to observe, the trend, the action), the store kept between runs, the run (observe, judge, act once per trend), presets, the proof verifier and the check that runs form one history. |
| `src/policy/` | Task 11, Policy Gatekeeper: policies (allowlists, per-action and window limits, hours, gas cap, dry run), the check of one request at one block, presets, the proof verifier. |
| `src/alert/` | Task 22, On-Chain Alert Bot: bots (transfer and state rules), the store kept between runs (the last block scanned, which conditions held, alerts not yet delivered), the run (Transfer logs from the cursor in pages, conditions compared with the last run), webhook delivery, presets, the proof verifier and the history check. |
| `src/whale/` | Task 23, Whale-Watching Agent: watchlists (labelled addresses, official tokens with their significant amounts, a native amount), the store kept between runs (the cursor, each address as it was), the run (every address at one block, Transfer logs by any tracked address in two queries a page, significant moves, a report per address), presets, the proof verifier and the history check. |
| `src/gas/` | Task 24, Gas Fee Optimizer: plans (a transaction, a target, the window, a first run's backfill, a deadline), the store kept between runs (the observed fees, since when it waits, what it sent), the run (observe, dry-run, decide, settings and costs, Atlantic sending), presets, the proof verifier (with the signed fee cap) and the history check. |
| `src/risk/` | Task 25, Wallet Risk Checker: the counterparty of a planned transaction (code, delegation, nonce, balance) and its recent Transfer history with the sender in two queries a page, the signals (lookalikes, transfers of nothing, approvals to wallets, unlimited approvals, tokens to a token contract, never used, the dry run), the level and verdict, and the proof verifier. |
| `src/audit/` | Task 26, Audit-Log Agent: periods (the last hours, two times, two blocks) placed in blocks by interpolating on block times, the address read before the period and at its end, its logs over every official token in two queries a page, the report (flows, counterparties, approvals, wrapping, transfers of nothing, balances reconciled, a timeline, sentences), and the proof verifier. |
| `src/digest/` | Task 28, Weekly Digest Agent: the UTC calendar (hours, days, weeks from Monday), subjects (an official token, or a wallet), the run (periods and their parts placed in blocks, logs read once, figures, comparisons and sentences, the supply or holdings now), the store kept between runs so each period is digested once, the proof verifier and the history check. |
| `src/core/docs-mcp.ts` | The Pharos Developer Docs MCP client (`askQuestion`, `getPage`), called as Task 04's live proof recorded: stateless JSON-RPC POSTs answered as an event stream or JSON. It records every message for the proof, holds to a budget of calls, and replays a recorded run. |
| `src/docs/` | Task 13, Docs MCP + Chain MCP Agent: reading a docs answer (its sources, the docs saying they do not cover it, contract addresses with the name and network their row or line gives, functions written with a return type), the run (the answer, the cited pages until an address fits and is on a page, the address's code and functions read at one block, the chain's own name against the docs' and the Skill Engine's, the verdict), and the proof verifier that replays both transcripts. |
| `src/builder/` | Task 29, Doc-Grounded Builder Agent: the action a how-to question asks for (send, approve, wrap, a balance) with each value's origin, the docs' chain ID, RPC URL, token address and function set beside the Pharos Skill Engine's, the run (the docs' answer and cited pages, Task 08's dry run or a balance read at one block, Atlantic sending), the Skill Engine's `cast` templates and gas rule (quoted from `a873387`), and the proof verifier. |
| `src/payment/` | Task 17, Natural-Language Payment Agent: the request read by a small grammar (verbs, amounts with their asset, recipients by address or an address book, "each" and "split", a note, a sender; any word not read refuses it), the flow (the sender's nonce, Task 08's dry run of each payment at one block, each asset's total against what the sender holds, the transactions to sign in nonce order with the Skill Engine's `cast send`, Atlantic sending in order), and the proof verifier. |
| `src/recurring/` | Task 18, Recurring Payment Agent: the schedule read by a small grammar (daily, weekly, monthly, yearly, every N from a day, until a day) and its calendar of UTC due days, the store kept between runs (the start, each payment paid with its transaction, a pending one settled by its receipt), the run (what is owed by the block's day, the oldest taken within limits, Task 17's flow, Atlantic sending and recording), and the proof verifier and history check. |
| `src/invoice/` | Task 19, Invoice-to-Payment Agent: EIP-681 payment links read and written, the invoice read by rules (labelled lines with or without a colon, line items, dates and terms, every figure checked against the others and the link, a currency, another network or a bad checksum refused), the run (your payees, the payer's last blocks of the token for a duplicate, a lookalike or transfers of nothing, Task 17's flow, held while anything calls for a check), and the proof verifier. |
| `src/x402/` | Task 20, X402 Paywalled API, on the official x402 packages (`@x402/core`, `@x402/evm`, `@x402/fetch`) as the Pharos x402 skill sets them up: the asset read through Chain MCP (its EIP-712 name and version, EIP-3009 or not), x402's facilitator with a signer whose reads, simulation, send and receipt are Chain MCP calls (Multicall3 answered call by call), the paid endpoint as a `Request` to `Response` handler on x402's HTTP resource server, the paying client (x402's fetch, one asset, a cap a payment), the facilitator's HTTP routes, the run, and the proof verifier, which checks the payment's facts against the recorded answers. Since Task 21 the API sells three products (`products.ts`: the chain data, Task 25's risk check and Task 08's dry run of a transfer, a request it cannot answer refused with 400 before any 402), served by one handler with a free listing of them (`api.ts`). |
| `src/buyer/` | Task 21, X402 Agent Buyer: the job (a planned transfer to check and prepare) and its budget in USDC, each price asked for free (the 402), the plan within the budget, each purchase made with x402's client (spend controls capping a payment at what is left, a hook refusing a price other than the 402's), the outcome from what was bought (do not send, check first, would fail, ready with the transaction to sign, or not done and why), the ledger, and the proof verifier, which recomputes every answer bought from its own recorded calls. |
| `src/support/` | Task 27, dApp Support Agent: revert data decoded in plain language (Error, Panic, OpenZeppelin 5 errors), the explanation of a transaction by hash (receipt, replay before its block, code, token balance and allowance, out of gas, earlier in its block) or by description (Task 08's dry run), and the proof verifier. |
| `src/web.ts`, `api/agent.js` | One serverless function for every task: `GET /api/agent?task=NN`. |
| `vendor/pharos-mcp/` | The official Chain MCP server, unmodified ([PROVENANCE.md](vendor/pharos-mcp/PROVENANCE.md)). |

## Which Chain MCP, when

| Network | Chain MCP | Can it broadcast? |
|---|---|---|
| Pharos Mainnet (1672) | hosted, `https://mcp.pharos.xyz/mcp` | No: the hosted endpoint is read-only |
| Atlantic (688689) | the official server, started by the agent over stdio, on `https://atlantic.dplabs-internal.com` | Yes, when executing: `ENABLE_SEND_RAW_TRANSACTION=true`, local only |

`--chain-mcp URL` and `--rpc URL` override these. A proof records what was used, and the verifier
flags a mainnet proof that did not use the hosted endpoint.

## Proofs

`--proof FILE` saves:
- the input;
- the result;
- every MCP message of the run.

`pharos-agent verify FILE` checks a proof offline. It confirms:
- the official server (`pharos-mcp-server` in `initialize`) at the expected endpoint;
- the chain checked first;
- the result recomputed by replay.

Each capability adds its own checks. Tampering with any recorded answer, the decision, a block number
or the server identity fails verification ([`tests/proof.test.ts`](tests/proof.test.ts)). An x402
payment (Tasks 20 and 21) cannot be replayed whole: it signs a random nonce, at the time it ran, and on
mainnet with a key made for the run. Its verifier replays the asset's reads and checks the payment's
facts against the recorded answers instead: the terms, the signature, the simulation, the settlement.
Task 21's also recomputes each answer bought from its own recorded calls, and the outcome from them.

## Tests

All offline. The fake is the chain under the official server (`tests/fake-chain.ts`, made-up values);
the server itself is the real, vendored code, reached three ways:
- in-process;
- over stdio, exactly as the CLI starts it for Atlantic, including signed broadcasts;
- over its own HTTP mode, the hosted path.

The CLI tests run the built binary end to end.
