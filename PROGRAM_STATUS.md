# Program status: Pharos Agent Lab

Resume with: *"Continue the Pharos Agent Lab program exactly from PROGRAM_STATUS.md. Do not re-plan
completed work. Continue from the next unfinished action."* This file is updated in every checkpoint
commit on `main`.

- **Canonical site:** https://pharos-agent-lab.vercel.app (one Vercel project, built from the repo root)
- **Repository:** https://github.com/Rzbyte/pharos-season-of-ai
- **Updated:** 2026-10-18

## Next action

Task 21, X402 Agent Buyer, on branch `task-21-x402-agent-buyer`. The task map: *"Build an agent that
calls x402-paywalled APIs, pays within a defined budget, uses the purchased result, and finishes its
task."* Read its official brief first, where a source is reachable, and build to what it says. Build
on Task 20 ([`agent/src/x402/`](agent/src/x402)): its paying client already pays only one asset, at
most a cap a payment (x402's own spend controls), and `x402 serve` is a real x402 API on Atlantic to buy
from. A buyer adds a budget across calls, the choice of what to buy, and the use of what it bought. On
Pharos Mainnet nothing settles (the hosted Chain MCP is read-only), so a live purchase is an Atlantic
run from Termux. Only what the official sources name; nothing invented. After that, follow the
[build order](#build-order).

## User actions required

1. **Deploy `main` and check Task 04 in production.** From the Termux checkout linked to the existing
   project (don't create or link another project): `git checkout main && git pull origin main && vercel --prod`.
   Then ask these on `/tasks/04`:

   | | Question (exact) | Expected |
   |---|---|---|
   | A | `What is the Atlantic chain ID?` | An answer with numbered `docs.pharos.xyz` sources; the run line reads "Developer Docs MCP (askQuestion)" |
   | B | `How do I deploy a contract with Foundry on Pharos?` | A procedural answer with `docs.pharos.xyz` sources; same run line |
   | C | `bagaimana cara deploy Anchor program ke Solana?` | Tagged "No answer": "No good answer found." with a reason; no answer text, no steps; "Nearby in the docs" may follow |

   The shell check is `curl -sG https://pharos-agent-lab.vercel.app/api/search --data-urlencode "q=<question>"`:
   - A and B give `status` `answered`.
   - C gives `no_answer`, with reason `not_in_docs` expected.
   - All three report `meta.transport` `docs-mcp`.

   If C comes back `answered`, keep that JSON: it is a real regression. The lab at `/` should read
   "21 / 30 built". `/tasks/05` should open with a guardian decision, `/tasks/08` with a dry-run
   verdict, `/tasks/09` with a first observation, `/tasks/11` with a gatekeeper decision,
   `/tasks/22` with an alert bot run over the last 1,000 blocks, `/tasks/23` with the four
   tracked addresses and their holdings, `/tasks/24` with a send-or-wait decision and six
   base fees, `/tasks/25` with a verdict on Task 08's example recipient (its lookalike example
   should say Do not send whenever the example sender has a partner in the last 2,000 blocks),
   `/tasks/26` with the example address's last hour as a report, `/tasks/28` with USDC hour by hour,
   and `/tasks/27` with a 5,000,000 USDC transfer explained as it would fail. Its
   "A real transfer from Task 02" example should say it succeeded in block 20,250,972. `/tasks/13`
   should answer the USDC question from the live docs, then read what they name on chain: its verdict
   is the first sight of how the live docs pages give addresses, so keep its JSON (the page's "API
   JSON" link) whatever it says. `/tasks/29` should prepare "How do I send USDC to another wallet…":
   the docs' answer, the transfer dry-run, and the Skill Engine's `cast` commands. `/tasks/17` should
   prepare "Pay alice 25 USDC and send 0.01 PROS to bob for lunch" from the example sender: two
   payments dry-run at one block, their totals against its holdings, and (when it holds enough) the
   transactions to sign. `/tasks/19` should read the example invoice INV-1042 (every check shown) and
   prepare its 20 USDC payment to the example payee; "A changed address" should hold it, Check first.
   `/tasks/18` should show the example schedule's payments due since the first of the month, oldest
   first, each dry-run, with each payment's next due day. `/tasks/20` should show GET /data's 402
   terms in USDC, an authorization signed by a key made for the request, and the facilitator's verdict
   on chain: Refused is expected (that key holds nothing). Keep its JSON (the page's "API JSON" link)
   whatever it says: its asset step is the first sight of whether Pharos Mainnet USDC answers EIP-3009,
   and of its EIP-712 name and version.
2. **Optional, speeds up everything: network access for Claude sessions.** In the cloud
   environment's settings (Network access, Allowed domains), add:
   - `mcp.pharos.xyz`
   - `docs.pharos.xyz`
   - `rpc.pharos.xyz`
   - `atlantic.dplabs-internal.com`
   - `pharos-agent-lab.vercel.app`

   With those, read-only live proofs can be captured in-session instead of from Termux.
3. **Live proof runs.** Run these from Termux, then commit the `proof/` files they write. The offline
   verifier re-checks them in any later session.

   ```sh
   cd ~/pharos-season-of-ai && git checkout main && git pull origin main
   cd agent && npm ci
   # Task 05 (mainnet, read-only, no key):
   node dist/src/cli.js guardian payout --proof ../tasks/05-threshold-guardian/proof/payout-mainnet.json
   node dist/src/cli.js verify ../tasks/05-threshold-guardian/proof/payout-mainnet.json
   # Task 08 (mainnet, read-only, no key):
   node dist/src/cli.js dryrun --proof ../tasks/08-dry-run-executor/proof/transfer-mainnet.json
   node dist/src/cli.js verify ../tasks/08-dry-run-executor/proof/transfer-mainnet.json
   # Task 11 (mainnet, read-only, no key; exit code 9 means denied, and its proof is just as valid):
   node dist/src/cli.js gate treasury --proof ../tasks/11-policy-gatekeeper/proof/treasury-mainnet.json
   node dist/src/cli.js verify ../tasks/11-policy-gatekeeper/proof/treasury-mainnet.json
   # Task 09 (mainnet, read-only, no key): four runs about 30 s apart, then one history
   for i in 1 2 3 4; do node dist/src/cli.js watch --store ../tasks/09-trend-watcher/proof/store.json --proof ../tasks/09-trend-watcher/proof/run-$i.json; sleep 30; done
   node dist/src/cli.js verify ../tasks/09-trend-watcher/proof/run-1.json ../tasks/09-trend-watcher/proof/run-2.json ../tasks/09-trend-watcher/proof/run-3.json ../tasks/09-trend-watcher/proof/run-4.json
   # Task 22 (mainnet, read-only, no key): three runs about a minute apart, then one history
   for i in 1 2 3; do node dist/src/cli.js alert --store ../tasks/22-on-chain-alert-bot/proof/store.json --proof ../tasks/22-on-chain-alert-bot/proof/run-$i.json; sleep 60; done
   node dist/src/cli.js verify ../tasks/22-on-chain-alert-bot/proof/run-1.json ../tasks/22-on-chain-alert-bot/proof/run-2.json ../tasks/22-on-chain-alert-bot/proof/run-3.json
   # Task 23 (mainnet, read-only, no key): three runs about a minute apart, then one history
   for i in 1 2 3; do node dist/src/cli.js whales --store ../tasks/23-whale-watching-agent/proof/store.json --proof ../tasks/23-whale-watching-agent/proof/run-$i.json; sleep 60; done
   node dist/src/cli.js verify ../tasks/23-whale-watching-agent/proof/run-1.json ../tasks/23-whale-watching-agent/proof/run-2.json ../tasks/23-whale-watching-agent/proof/run-3.json
   # Task 24 (mainnet, read-only, no key): three runs about a minute apart, then one history
   for i in 1 2 3; do node dist/src/cli.js gas --store ../tasks/24-gas-fee-optimizer/proof/store.json --proof ../tasks/24-gas-fee-optimizer/proof/run-$i.json; sleep 60; done
   node dist/src/cli.js verify ../tasks/24-gas-fee-optimizer/proof/run-1.json ../tasks/24-gas-fee-optimizer/proof/run-2.json ../tasks/24-gas-fee-optimizer/proof/run-3.json
   # Task 27 (mainnet, read-only, no key): a real transaction, and a transfer that would fail
   node dist/src/cli.js explain 0x968810950de8d8fa80d17a9e1d03b72e8806a0d11d89579459bceaee45ce510c --proof ../tasks/27-dapp-support-agent/proof/real-transfer.json
   node dist/src/cli.js explain --amount 5000000 --proof ../tasks/27-dapp-support-agent/proof/would-fail.json
   node dist/src/cli.js verify ../tasks/27-dapp-support-agent/proof/real-transfer.json
   node dist/src/cli.js verify ../tasks/27-dapp-support-agent/proof/would-fail.json
   # Task 25 (mainnet, read-only, no key): the example, an unlimited approval, and a lookalike of the
   # example sender's busiest partner in the first check (or of 0x1F35…c85C if it had none)
   node dist/src/cli.js risk --proof ../tasks/25-wallet-risk-checker/proof/example.json
   node dist/src/cli.js risk erc20-approve --spender 0x3333333333333333333333333333333333333333 --amount max --proof ../tasks/25-wallet-risk-checker/proof/approval.json
   TO=$(node -e 'const p=require(process.argv[1]).result.history?.partners[0]?.address??"0x1F3546a29EeC2102c8d52E21a45114124014c85C";console.log(`0x${p.slice(2,6)}${"0".repeat(32)}${p.slice(-4)}`.toLowerCase())' ../tasks/25-wallet-risk-checker/proof/example.json)
   node dist/src/cli.js risk --to $TO --proof ../tasks/25-wallet-risk-checker/proof/lookalike.json
   node dist/src/cli.js verify ../tasks/25-wallet-risk-checker/proof/example.json ../tasks/25-wallet-risk-checker/proof/approval.json ../tasks/25-wallet-risk-checker/proof/lookalike.json
   # Task 26 (mainnet, read-only, no key): the example address's last hour, and another's last 6 hours
   node dist/src/cli.js audit --proof ../tasks/26-audit-log-agent/proof/last-hour.json
   node dist/src/cli.js audit 0x936564245B69f5a293b42cbd752E0eE3bb68b470 --hours 6 --proof ../tasks/26-audit-log-agent/proof/six-hours.json
   node dist/src/cli.js verify ../tasks/26-audit-log-agent/proof/last-hour.json ../tasks/26-audit-log-agent/proof/six-hours.json
   # Task 28 (mainnet, read-only, no key): USDC hour by hour; a wallet's day, run again a day later
   node dist/src/cli.js digest usdc --every hour --periods 3 --so-far --proof ../tasks/28-weekly-digest-agent/proof/usdc-hours.json
   node dist/src/cli.js digest 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647 --every day --store ../tasks/28-weekly-digest-agent/proof/wallet-store.json --proof ../tasks/28-weekly-digest-agent/proof/wallet-day-1.json
   node dist/src/cli.js verify ../tasks/28-weekly-digest-agent/proof/usdc-hours.json ../tasks/28-weekly-digest-agent/proof/wallet-day-1.json
   # Task 13 (mainnet, read-only, no key): two questions to the Developer Docs MCP, then the chain
   node dist/src/cli.js ask "What is the USDC token address on Pharos Mainnet?" --proof ../tasks/13-docs-chain-agent/proof/usdc.json
   node dist/src/cli.js ask "What is the WPROS token address on Pharos Mainnet?" --proof ../tasks/13-docs-chain-agent/proof/wpros.json
   node dist/src/cli.js verify ../tasks/13-docs-chain-agent/proof/usdc.json ../tasks/13-docs-chain-agent/proof/wpros.json
   # Task 29 (mainnet, read-only, no key): how-tos answered by the docs, then prepared
   node dist/src/cli.js howto "How do I send USDC to another wallet on Pharos Mainnet?" --proof ../tasks/29-doc-grounded-builder/proof/send-usdc.json
   node dist/src/cli.js howto "How do I wrap 0.5 PROS into WPROS?" --proof ../tasks/29-doc-grounded-builder/proof/wrap.json
   node dist/src/cli.js verify ../tasks/29-doc-grounded-builder/proof/send-usdc.json ../tasks/29-doc-grounded-builder/proof/wrap.json
   # Task 17 (mainnet, read-only, no key): a request in plain words, prepared, with the page's address book
   mkdir -p ../tasks/17-natural-language-payment/proof
   printf 'alice = 0xB2749BD12f19C24a2244176658F3dF3e48e79553\nbob = 0x1F3546a29EeC2102c8d52E21a45114124014c85C\n' > ../tasks/17-natural-language-payment/proof/contacts.txt
   node dist/src/cli.js pay "Pay alice 25 USDC and send 0.01 PROS to bob for lunch" --contacts ../tasks/17-natural-language-payment/proof/contacts.txt --proof ../tasks/17-natural-language-payment/proof/two-payments.json
   node dist/src/cli.js pay "Split 30 USDC between alice and bob for dinner" --contacts ../tasks/17-natural-language-payment/proof/contacts.txt --proof ../tasks/17-natural-language-payment/proof/split.json
   node dist/src/cli.js verify ../tasks/17-natural-language-payment/proof/two-payments.json ../tasks/17-natural-language-payment/proof/split.json
   # Task 19 (mainnet, read-only, no key): the page's example invoice, and a payment link
   mkdir -p ../tasks/19-invoice-to-payment/proof
   printf 'Example Studio = 0xB2749BD12f19C24a2244176658F3dF3e48e79553\n' > ../tasks/19-invoice-to-payment/proof/payees.txt
   node -e 'import("./dist/src/web.js").then((m) => process.stdout.write(m.DEFAULT_INVOICE))' > ../tasks/19-invoice-to-payment/proof/invoice.txt
   node dist/src/cli.js invoice ../tasks/19-invoice-to-payment/proof/invoice.txt --payees ../tasks/19-invoice-to-payment/proof/payees.txt --proof ../tasks/19-invoice-to-payment/proof/invoice.json
   node dist/src/cli.js invoice "ethereum:0xB2749BD12f19C24a2244176658F3dF3e48e79553@1672?value=1e16" --payees ../tasks/19-invoice-to-payment/proof/payees.txt --proof ../tasks/19-invoice-to-payment/proof/link.json
   node dist/src/cli.js verify ../tasks/19-invoice-to-payment/proof/invoice.json ../tasks/19-invoice-to-payment/proof/link.json
   # Task 18 (mainnet, read-only, no key): the page's example schedule, two runs on one store
   mkdir -p ../tasks/18-recurring-payment/proof
   node -e 'import("./dist/src/web.js").then((m) => process.stdout.write(m.DEFAULT_SCHEDULE + "\n"))' > ../tasks/18-recurring-payment/proof/schedule.txt
   node dist/src/cli.js recurring ../tasks/18-recurring-payment/proof/schedule.txt --store ../tasks/18-recurring-payment/proof/store.json --since "$(date -u +%Y-%m-01)" --proof ../tasks/18-recurring-payment/proof/run-1.json
   node dist/src/cli.js recurring ../tasks/18-recurring-payment/proof/schedule.txt --store ../tasks/18-recurring-payment/proof/store.json --proof ../tasks/18-recurring-payment/proof/run-2.json
   node dist/src/cli.js verify ../tasks/18-recurring-payment/proof/run-1.json ../tasks/18-recurring-payment/proof/run-2.json
   # Task 20 (mainnet, no key; exit code 9, nothing settled, is expected and its proof is as valid)
   mkdir -p ../tasks/20-x402-paywalled-api/proof
   node dist/src/cli.js x402 --proof ../tasks/20-x402-paywalled-api/proof/mainnet.json
   node dist/src/cli.js verify ../tasks/20-x402-paywalled-api/proof/mainnet.json
   cd .. && git add tasks/*/proof && git commit -m "Live proofs: Tasks 05, 08, 09, 11, 13, 17 to 20 and 22 to 29" && git push origin main
   ```

   Optionally, Tasks 05, 08, 11, 24, 29, 17, 19, 18 and 20 can also send on Atlantic. Use a testnet key
   holding at least 10 USDC and some PHRS, from the Atlantic faucet:

   ```sh
   PRIVATE_KEY=0x... node dist/src/cli.js guardian atlantic-payout --execute --proof ../tasks/05-threshold-guardian/proof/atlantic-executed.json
   PRIVATE_KEY=0x... node dist/src/cli.js dryrun --network atlantic-testnet --to 0xRECIPIENT --amount 1 --submit --proof ../tasks/08-dry-run-executor/proof/atlantic-submitted.json
   PRIVATE_KEY=0x... node dist/src/cli.js gate atlantic-treasury --execute --proof ../tasks/11-policy-gatekeeper/proof/atlantic-executed.json
   PRIVATE_KEY=0x... node dist/src/cli.js gas atlantic-usdc --store ../tasks/24-gas-fee-optimizer/proof/atlantic-store.json --execute --proof ../tasks/24-gas-fee-optimizer/proof/atlantic-run.json
   PRIVATE_KEY=0x... node dist/src/cli.js howto "How do I send 1 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553?" --network atlantic-testnet --execute --proof ../tasks/29-doc-grounded-builder/proof/atlantic-sent.json
   PRIVATE_KEY=0x... node dist/src/cli.js pay "Pay alice 1 USDC and bob 0.5 USDC" --contacts ../tasks/17-natural-language-payment/proof/contacts.txt --network atlantic-testnet --execute --proof ../tasks/17-natural-language-payment/proof/atlantic-sent.json
   printf 'Invoice: T-1\nFrom: Example Studio\nTotal: 1.25 USDC\nNetwork: Atlantic\nPay to: 0xB2749BD12f19C24a2244176658F3dF3e48e79553\n' > ../tasks/19-invoice-to-payment/proof/atlantic.txt
   PRIVATE_KEY=0x... node dist/src/cli.js invoice ../tasks/19-invoice-to-payment/proof/atlantic.txt --payees ../tasks/19-invoice-to-payment/proof/payees.txt --network atlantic-testnet --execute --proof ../tasks/19-invoice-to-payment/proof/atlantic-sent.json
   printf 'Rent: 1.1 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553, monthly on the 1st\nTool: 0.2 USDC to 0x1F3546a29EeC2102c8d52E21a45114124014c85C, daily\n' > ../tasks/18-recurring-payment/proof/atlantic.txt
   PRIVATE_KEY=0x... node dist/src/cli.js recurring ../tasks/18-recurring-payment/proof/atlantic.txt --store ../tasks/18-recurring-payment/proof/atlantic-store.json --since "$(date -u +%Y-%m-01)" --network atlantic-testnet --execute --proof ../tasks/18-recurring-payment/proof/atlantic-1.json
   PRIVATE_KEY=0x... node dist/src/cli.js recurring ../tasks/18-recurring-payment/proof/atlantic.txt --store ../tasks/18-recurring-payment/proof/atlantic-store.json --network atlantic-testnet --execute --proof ../tasks/18-recurring-payment/proof/atlantic-2.json
   node dist/src/cli.js verify ../tasks/18-recurring-payment/proof/atlantic-1.json ../tasks/18-recurring-payment/proof/atlantic-2.json
   PRIVATE_KEY=0x... node dist/src/cli.js x402 --network atlantic-testnet --execute --price 0.01 --proof ../tasks/20-x402-paywalled-api/proof/atlantic-paid.json
   node dist/src/cli.js verify ../tasks/20-x402-paywalled-api/proof/atlantic-paid.json
   ```

   The second sends 1 testnet USDC to any address you choose and checks the receipt against the
   prediction. The third sends 1 testnet USDC to the example recipient, the only address its policy
   allows. The fourth sends 1 testnet USDC to the example recipient once the base fee is at or below
   the median of its observations (run it again until it says Sent), with the fee capped there. The
   fifth asks the docs how to send USDC, then sends 1 testnet USDC to the example recipient. The sixth
   sends 1 and 0.5 testnet USDC to the two names of the address book, in order, each checked against
   its receipt. The seventh pays a 1.25 USDC invoice from Example Studio, the payee in its payees, and
   checks the receipt: an amount none of the others sent to the example recipient, which Task 19
   would otherwise hold as possibly paid already. The last two run a schedule twice from one store: the
   first pays what is due this month (at most 3 of one payment), the second only what the first left,
   and `verify` checks the two as one history. The last pays Task 20's x402 API 0.01 testnet USDC for
   one request, settled by its facilitator (the same key, unless `FACILITATOR_PRIVATE_KEY` names
   another, pays the gas), and receives the data. It first reads whether Atlantic USDC answers EIP-3009;
   if it does not, it says so and nothing settles. Keep that proof too: it is the finding.

   A day after the Task 28 wallet run, run its line again with `--proof
   ../tasks/28-weekly-digest-agent/proof/wallet-day-2.json`, then verify `wallet-day-1.json` and
   `wallet-day-2.json` together: one history, the day digested once.

   If you know the hash of a failed Pharos Mainnet transaction, Task 27 can explain it as a third
   proof: `node dist/src/cli.js explain 0x<hash> --proof ../tasks/27-dapp-support-agent/proof/failed.json`.

## Environment facts (verified; don't re-check)

- **This build sandbox** can't reach Pharos, Vercel, the docs or the explorers (proxy CONNECT 403).
  `npm` and `git clone` of public GitHub repositories work.
- **The owner's Termux** (Android, ARM64) runs Node. Foundry does not run there
  ([Task 03 evidence](tasks/03-docs-mcp-onboarding/evidence.json)), so the Skill Engine is used
  through its official viem TypeScript script templates, not `cast`/`forge`.

## Verified integrations

| Integration | Official source | What it provides |
|---|---|---|
| Chain MCP | [PharosNetwork/pharos-mcp](https://github.com/PharosNetwork/pharos-mcp) at `9a3750c`; hosted `https://mcp.pharos.xyz/mcp` (mainnet, chain 1672, read-only, 120 req/min) | `get_chain_info`, `get_block_number`, `get_balance`, `get_transaction_count`, `get_gas_price`, `get_block`, `get_transaction`, `get_transaction_receipt`, `get_code`, `get_storage_at`, `eth_call`, `estimate_gas`, `get_logs` (≤1,000 blocks). `send_raw_transaction` is disabled on the hosted endpoint and enabled by `ENABLE_SEND_RAW_TRANSACTION` when self-hosted (`PHAROS_RPC_URL`, `PHAROS_CHAIN_ID`). |
| Developer Docs MCP | `https://docs.pharos.xyz/~gitbook/mcp` (Task 04 proof) | `searchDocumentation`, `getPage`, `askQuestion`, `sendFeedback`. Stateless JSON-RPC POSTs (no initialize), each answered as an event stream of `message` events. Task 13 calls `askQuestion` and `getPage`. |
| Skill Engine | [PharosNetwork/pharos-skill-engine](https://github.com/PharosNetwork/pharos-skill-engine) at `a873387` (v0.1.0) | Networks: Atlantic 688689 at `https://atlantic.dplabs-internal.com`, mainnet 1672 at `https://rpc.pharos.xyz`. Also token addresses, `cast`/`forge` recipes, and viem/ethers/web3.py script templates. |
| x402 | [PharosNetwork/examples `skills/x402-pharos`](https://github.com/PharosNetwork/examples/tree/main/skills/x402-pharos) at `f08e921`; the packages' repository, [x402-foundation/x402](https://github.com/x402-foundation/x402) | `@x402/core`, `@x402/evm`, `@x402/fetch`, `@x402/express` v2 with viem; Task 20 uses `@x402/core`, `@x402/evm` and `@x402/fetch` 2.28.0 (Apache-2.0), and `@x402/express`'s middleware wraps the same `x402HTTPResourceServer`. Networks `eip155:1672` and `eip155:688689`, the `exact` scheme by EIP-3009. The facilitator URL and USDC address are supplied by the builder: here x402's own facilitator on Chain MCP, and the Skill Engine's official USDC. Tested: x402 2.28's client pays only its default assets unless `spendControls.allowedAssets` names one, so the skill's sample client refuses Pharos USDC as written. Not yet known: whether Pharos USDC answers EIP-3009 (every run reads it), and whether Multicall3 is on Pharos (not relied on). |

## Architecture (decided)

- **`agent/`** is one TypeScript package, the agent runtime that Tasks 05 to 30 share
  ([README](agent/README.md)). It holds the core and one module per capability:
  - a Chain MCP client on the official SDK that records a transcript;
  - the official network config;
  - reads pinned to one block;
  - local signing, with `send_raw_transaction` as the only way out;
  - proofs verified by replay.

  It vendors the official Chain MCP server, unmodified, with a test that pins its git blob hashes.
  Tests talk to that real server code; only the chain under it is a fake. Tasks 01 to 04 keep their
  own code.
- **`tasks/NN-name/`** holds each task's page, README, SUBMISSION and proof. Its HTTP endpoint is a
  route of one shared serverless function, so the project stays within Vercel's function limits.
- **Chain MCP use:**
  - The hosted endpoint for mainnet reads.
  - The official server, run locally over stdio against Atlantic, when a task must sign and broadcast.
    It signs locally and broadcasts with `send_raw_transaction`.

## Build order

05 → 08 → 11 → 09 → 22 → 23 → 24 → 27 → 25 → 26 → 28 → 13 → 29 → 17 → 19 → 18 → 20 → 21 → 10 →
06 → 12 → 07 → 14 → 15 → 16 → 30.

Read-only Chain MCP capabilities come first, each reusing the last. Then come the Docs MCP
compositions, then payments and x402, then write-heavy flows. Last are the DeFi tasks, which need
Pharos protocol addresses not yet verified.

## Tasks

| # | Task | Status | Capability | Commit | Tests | Proof | Deploy | Submission | Next / blocker |
|---|---|---|---|---|---|---|---|---|---|
| 01 | Read Contract State | DONE | 5 pinned `eth_call` reads; address/tx inspector | `305daf4` | pass | live, 2026-10-14 | on site (not checkable here) | [ready](tasks/01-read-contract-state/SUBMISSION.md); submitted | none |
| 02 | Event / Log Monitor | DONE | `get_logs` monitor, dedup | `305daf4` | pass | live, verified, 2026-10-14 | on site (not checkable here) | [ready](tasks/02-event-log-monitor/SUBMISSION.md); submitted | none |
| 03 | Docs MCP Onboarding | DONE | onboarding evidence page | `305daf4` | pass | Drive proof + video | on site (not checkable here) | [ready](tasks/03-docs-mcp-onboarding/SUBMISSION.md); submitted | none |
| 04 | Doc-Search CLI | DONE | Docs MCP `askQuestion` + source gate (EN/ID) | `26c64fe` | pass | live, verified, 2026-10-15 | main not deployed yet | [ready](tasks/04-doc-search-cli/SUBMISSION.md) | user action 1 |
| 05 | Threshold Guardian | BLOCKED | six conditions at one block, rule, simulated action; Atlantic execution with re-check (`agent/src/guardian`); page on the shared agent layer | main, "Task 05:" | pass: agent 248 (shared); page 6, browser 8 | pending the first live run | in main, not deployed yet | [ready](tasks/05-threshold-guardian/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 06 | Saga Executor | NOT STARTED | dependent steps with retry and rollback | | | | | | |
| 07 | Arbitrage Scanner | NOT STARTED | two-source rates net of fees | | | | | | needs verified Pharos DEX sources |
| 08 | Dry-Run Executor | BLOCKED | a transfer, approval or call: state read at one block, `eth_call` from the sender, `estimate_gas` and fee cap, before → after per balance, warnings; Atlantic `--submit` diffed against the receipt (`agent/src/dryrun`) | main, "Task 08:" | pass: agent 248 (shared); page 7, browser 11 | pending the first live run | in main, not deployed yet | [ready](tasks/08-dry-run-executor/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 09 | Trend Watcher | BLOCKED | one observation per run kept in a store across runs (CLI file, page's browser storage); falling, rising, % change or sustained over the last N since the last action; acts once per trend with a Task 08 dry run; proofs chain run to run (`verify` checks one history) (`agent/src/trend`) | main, "Task 09:" | pass: agent 248 (shared); page 7, browser 9; site 22 | pending the first live runs | in main, not deployed yet | [ready](tasks/09-trend-watcher/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 10 | Batch Executor | NOT STARTED | bundle independent actions | | | | | | |
| 11 | Policy Gatekeeper | BLOCKED | a transfer or approval against a policy at one block: asset and counterparty allowlists, per-action and window limits (window from the sender's Transfer logs via `get_logs`), hours at the block's time, gas cap, Task 08 dry run; fail-closed; Atlantic `--execute` (`agent/src/policy`) | main, "Task 11:" | pass: agent 248 (shared); page 8, browser 9 | pending the first live run | in main, not deployed yet | [ready](tasks/11-policy-gatekeeper/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 12 | Skill + Chain MCP Flow | NOT STARTED | Skill Engine skill + Chain MCP | | | | | | |
| 13 | Docs MCP + Chain MCP Agent | BLOCKED | a question about a Pharos contract: the Developer Docs MCP's answer (`askQuestion`), the pages it cites read (`getPage`, at most two) until an address fits the question and is on a page (an address only the synthesized answer gives is marked, and not called where a page gives another); the address's code, the functions the docs write with a return type, and a token's symbol, name, decimals and supply, through Chain MCP at one block; the chain's own name against the docs' and the Skill Engine's; confirmed, mismatch, no contract, another network, nothing to call, or not in the docs, each step with its source; proofs hold and replay both transcripts (`agent/src/docs`) | main, "Task 13:" | pass: agent 248 (shared); page 7, browser 8; site 30 | pending the first live runs | in main, not deployed yet | [ready](tasks/13-docs-chain-agent/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 14 | Portfolio Assistant | NOT STARTED | balances, positions, yields Q&A | | | | | | needs verified protocol sources |
| 15 | Yield Optimizer | NOT STARTED | compare yields, rebalance | | | | | | needs verified protocol sources |
| 16 | Liquidation Watchdog | NOT STARTED | lending risk warnings | | | | | | needs a verified lending protocol |
| 17 | Natural-Language Payment Agent | BLOCKED | a payment request in plain words read by a small grammar, every word (pay, send, transfer, give, split; amounts with their asset, PROS or an official token; recipients by address or an address book; "each" or an exact "split"; a note; a sender; polite words passed over), refused with the words not read; the sender's nonce, then Task 08's dry run of each payment through Chain MCP at one block; each asset's total against what the sender holds, PROS with every maximum fee; ready, short or would fail; the EIP-1559 transactions to sign in nonce order with the Skill Engine's `cast send`; Atlantic `--execute` sends in order, stopping at the first that fails, each checked against its receipt; the proof replays and checks every signed transaction (`agent/src/payment`) | main, "Task 17:" | pass: agent 248 (shared); page 7, browser 6; site 32 | pending the first live runs | in main, not deployed yet | [ready](tasks/17-natural-language-payment/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 18 | Recurring Payment Agent | BLOCKED | a schedule a line ("Rent: 25 USDC to 0x…, monthly on the 1st") read by a small grammar: daily or every N days, weekly or every N weeks on a weekday, monthly or every N months on a day (past a month's end, its last day), yearly on a date, from and until a day; each run at the pinned block's UTC day: every due day since the start not recorded as paid is owed, the oldest taken (at most 3 of one payment, 10 in all; 6 on the page), prepared as Task 17's flow; the CLI store records each payment paid with its transaction, a pending send settled by its receipt next run (`get_transaction_receipt`), so a missed run is caught up and nothing is paid twice; Atlantic `--execute` (needs `--store`); proofs replay from the store and verify as one history (`agent/src/recurring`) | main, "Task 18:" | pass: agent 248 (shared); page 7, browser 6; site 34 | pending the first live runs | in main, not deployed yet | [ready](tasks/18-recurring-payment/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 19 | Invoice-to-Payment Agent | BLOCKED | an invoice as text (labelled lines with or without a colon, a label with its value on the next line, line items, dates and terms) or an EIP-681 payment link, read by rules; every figure checked against the others (lines, subtotal, discount, tax, total, paid, amount due, the link) or refused saying which disagree; a currency, another network, a failed checksum, an unofficial asset refused; the payee against your payees (same, another name, a changed address, new) and the payer's last 2,000 blocks of the token via `get_logs` (paid already, a lookalike, transfers of nothing); held while any calls for a check, the payee then shown in full; Task 17's flow: Task 08's dry run, the funds, the transaction to sign, the Skill Engine's `cast send`, an EIP-681 link; Atlantic `--execute` only when nothing is held, checked against its receipt; exit 9 when held (`agent/src/invoice`) | main, "Task 19:" | pass: agent 248 (shared); page 7, browser 6; site 33 | pending the first live runs | in main, not deployed yet | [ready](tasks/19-invoice-to-payment/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 20 | X402 Paywalled API | BLOCKED | `GET /data` (the newest block and gas price via Chain MCP) priced in USDC on x402's HTTP resource server: 402 with its terms; x402's client signs an EIP-3009 authorization for exactly them, one asset, a cap a payment; x402's facilitator on a Chain MCP signer verifies (signature, terms, window, `transferWithAuthorization` simulated with `eth_call`, a refusal's reason read call by call) and settles (`send_raw_transaction`, the receipt's Transfer checked); the data released only once settled; the EIP-712 domain read from the token; Pharos Mainnet verify-only with a key made for the run; Atlantic `--execute` pays and settles; `x402 serve` (the endpoint and the facilitator's routes over HTTP) and `x402 pay URL`; the proof verifier checks the payment's facts against the recorded answers (`agent/src/x402`) | main, "Task 20:" | pass: agent 248 (shared); page 7, browser 7; site 34 | pending the first live runs | in main, not deployed yet | [ready](tasks/20-x402-paywalled-api/SUBMISSION.md) | user action 3 (live proof; whether Pharos USDC answers EIP-3009 decides if a payment can settle), then DONE |
| 21 | X402 Agent Buyer | NOT STARTED | buys x402 data within a budget | | | | | | after 20 |
| 22 | On-Chain Alert Bot | BLOCKED | transfer rules from `get_logs` (token, sender, recipient, smallest amount) from a cursor kept between runs, each transfer once; state rules (the guardian's conditions) alerting when they start and stop; CLI store file and webhook delivery with retry; the page keeps the store in browser storage; proofs chain run to run (`agent/src/alert`) | main, "Task 22:" | pass: agent 248 (shared); page 7, browser 10; site 23 | pending the first live runs | in main, not deployed yet | [ready](tasks/22-on-chain-alert-bot/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 23 | Whale-Watching Agent | BLOCKED | labelled addresses read at one block (native, nonce, official tokens, code once); their transfers since a cursor from `get_logs`, two OR-topic queries a page; significant moves (transfers over an amount, native balance changes over another between runs) surfaced once, the rest summed per address; CLI store file, the page's in browser storage; proofs chain run to run (`agent/src/whale`) | main, "Task 23:" | pass: agent 248 (shared); page 7, browser 9; site 24 | pending the first live runs | in main, not deployed yet | [ready](tasks/23-whale-watching-agent/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 24 | Gas Fee Optimizer | BLOCKED | the base fee observed per run and kept (a first run reads five earlier blocks); one transaction dry-run and timed: send at or below a target (a percentile of the observations, or a fixed fee) or past a deadline, else wait; fee settings capped at the target, costs now, at the target and at most; Atlantic `--execute` sends once, the proof checks the signed fee cap (`agent/src/gas`) | main, "Task 24:" | pass: agent 248 (shared); page 7, browser 9; site 25 | pending the first live runs | in main, not deployed yet | [ready](tasks/24-gas-fee-optimizer/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 25 | Wallet Risk Checker | BLOCKED | the counterparty of a planned transaction (recipient, spender or contract) at one block: code (wallet, contract, EIP-7702 delegate), nonce, balance; its recent Transfer history with the sender from `get_logs`, two queries a page; signals with severity and tool: a lookalike of a real partner, transfers of nothing (never counted as dealings), approval to a wallet, unlimited approval, tokens to a token contract, zero address, never used, contract recipient, delegated, the dry run; do not send, check first or looks fine (`agent/src/risk`) | main, "Task 25:" | pass: agent 248 (shared); page 7, browser 9; site 27 | pending the first live runs | in main, not deployed yet | [ready](tasks/25-wallet-risk-checker/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 26 | Audit-Log Agent | BLOCKED | an address over a selected period (the last hours, two times, two blocks), placed in blocks by interpolating on block times; read at the block before and the last block (PROS, nonce, official tokens, code); its logs over every official token, two queries a page (Transfer, Approval, WETH-style Deposit/Withdrawal from it, Transfer to it); plain sentences: transactions sent, flows and counterparties, approvals, transfers of nothing, balances reconciled with the logs, a timeline; 20,000 blocks on the page, 100,000 in the CLI, paced under 120 calls a minute (`agent/src/audit`) | main, "Task 26:" | pass: agent 248 (shared); page 7, browser 8; site 28 | pending the first live runs | in main, not deployed yet | [ready](tasks/26-audit-log-agent/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 27 | dApp Support Agent | BLOCKED | why a transaction failed, by hash: receipt, call replayed before its block for the revert, decoded (Error, Panic, OpenZeppelin 5 errors with token amounts), code, token balance and allowance, out of gas, earlier in its block, each finding with its tool, a fix; by description: Task 08's dry run; no language model (`agent/src/support`) | main, "Task 27:" | pass: agent 248 (shared); page 7, browser 7; site 26 | pending the first live runs | in main, not deployed yet | [ready](tasks/27-dapp-support-agent/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 28 | Weekly Digest Agent | BLOCKED | periodic summaries on the UTC calendar (hours, days, weeks from Monday) of a protocol (an official token's every transfer: volume, senders and recipients, the largest, top movers, mints and burns) or a wallet (its transfers and approvals over every official token); periods placed with `get_block`, logs read once, each period against the one before and its busiest part named; supply or holdings at the newest block, nothing else in the past; a store so a scheduled run digests each period once, proofs verified as one history; page hour by hour (`agent/src/digest`) | main, "Task 28:" | pass: agent 248 (shared); page 7, browser 6; site 29 | pending the first live runs | in main, not deployed yet | [ready](tasks/28-weekly-digest-agent/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 29 | Doc-Grounded Builder Agent | BLOCKED | a how-to question: the Developer Docs MCP's answer (an uncovered or uncited one stops it), the action its words ask for (send PROS or an official token, approve, wrap into WPROS, a balance) with each value's origin, the chain ID, RPC URL, token address (cited pages read) and function set beside the Pharos Skill Engine's and the docs'; Task 08's dry run at one block or a balance read; the Skill Engine's `cast` templates (quoted from `a873387`) filled in, with its gas rule; Atlantic `--execute` signs, sends and checks the receipt; proofs replay both transcripts (`agent/src/builder`) | main, "Task 29:" | pass: agent 248 (shared); page 7, browser 8; site 31 | pending the first live runs | in main, not deployed yet | [ready](tasks/29-doc-grounded-builder/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 30 | Multi-Protocol Aggregator | NOT STARTED | across more than one protocol | | | | | | needs verified protocol sources |

The task summaries come from the owner's restatement of the official map. A task's full official brief
is checked before it is built, where a source is reachable.
