# Program status: Pharos Agent Lab

Resume with: *"Continue the Pharos Agent Lab program exactly from PROGRAM_STATUS.md. Do not re-plan
completed work. Continue from the next unfinished action."* This file is updated in every checkpoint
commit on `main`.

- **Canonical site:** https://pharos-agent-lab.vercel.app (one Vercel project, built from the repo root)
- **Repository:** https://github.com/Rzbyte/pharos-season-of-ai
- **Updated:** 2026-10-17

## Next action

Task 11, Policy Gatekeeper, on branch `task-11-policy-gatekeeper`. Official statement: *"Checks
requested actions against rules such as spend limits, allowlists, and time windows."* It builds on
Task 08's intents and dry run (`agent/src/dryrun/`), the guardian's rule evaluation
(`agent/src/guardian/evaluate.ts`) and the agent page layer (`shared/ui/agent.js`). After that,
follow the [build order](#build-order).

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
   "6 / 30 built". `/tasks/05` should open with a guardian decision, and `/tasks/08` with a dry-run
   verdict.
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
   cd .. && git add tasks/*/proof && git commit -m "Live proofs: Tasks 05 and 08" && git push origin main
   ```

   Optionally, Tasks 05 and 08 can also send on Atlantic. Use a testnet key holding at least 2 USDC
   and some PHRS, from the Atlantic faucet:

   ```sh
   PRIVATE_KEY=0x... node dist/src/cli.js guardian atlantic-payout --execute --proof ../tasks/05-threshold-guardian/proof/atlantic-executed.json
   PRIVATE_KEY=0x... node dist/src/cli.js dryrun --network atlantic-testnet --to 0xRECIPIENT --amount 1 --submit --proof ../tasks/08-dry-run-executor/proof/atlantic-submitted.json
   ```

   The second sends 1 testnet USDC to any address you choose and checks the receipt against the
   prediction.

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
| Developer Docs MCP | `https://docs.pharos.xyz/~gitbook/mcp` (Task 04 proof) | `searchDocumentation`, `getPage`, `askQuestion`, `sendFeedback` |
| Skill Engine | [PharosNetwork/pharos-skill-engine](https://github.com/PharosNetwork/pharos-skill-engine) at `a873387` (v0.1.0) | Networks: Atlantic 688689 at `https://atlantic.dplabs-internal.com`, mainnet 1672 at `https://rpc.pharos.xyz`. Also token addresses, `cast`/`forge` recipes, and viem/ethers/web3.py script templates. |
| x402 | [PharosNetwork/examples `skills/x402-pharos`](https://github.com/PharosNetwork/examples/tree/main/skills/x402-pharos) at `f08e921` | `@x402/core`, `@x402/evm`, `@x402/fetch`, `@x402/express` v2 with viem. Networks `eip155:1672` and `eip155:688689`. The facilitator URL and USDC address are supplied by the builder. |

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
| 05 | Threshold Guardian | BLOCKED | six conditions at one block, rule, simulated action; Atlantic execution with re-check (`agent/src/guardian`); page on the shared agent layer | main, "Task 05:" | pass: agent 44 (shared); page 6, browser 8 | pending the first live run | in main, not deployed yet | [ready](tasks/05-threshold-guardian/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 06 | Saga Executor | NOT STARTED | dependent steps with retry and rollback | | | | | | |
| 07 | Arbitrage Scanner | NOT STARTED | two-source rates net of fees | | | | | | needs verified Pharos DEX sources |
| 08 | Dry-Run Executor | BLOCKED | a transfer, approval or call: state read at one block, `eth_call` from the sender, `estimate_gas` and fee cap, before → after per balance, warnings; Atlantic `--submit` diffed against the receipt (`agent/src/dryrun`) | main, "Task 08:" | pass: agent 44 (shared); page 7, browser 11; site 20 | pending the first live run | in main, not deployed yet | [ready](tasks/08-dry-run-executor/SUBMISSION.md) | user action 3 (live proof), then DONE |
| 09 | Trend Watcher | NOT STARTED | persisted observations, trend condition | | | | | | |
| 10 | Batch Executor | NOT STARTED | bundle independent actions | | | | | | |
| 11 | Policy Gatekeeper | NOT STARTED | spend limits, allowlists, time windows | | | | | | next action |
| 12 | Skill + Chain MCP Flow | NOT STARTED | Skill Engine skill + Chain MCP | | | | | | |
| 13 | Docs MCP + Chain MCP Agent | NOT STARTED | understand via docs, then call | | | | | | |
| 14 | Portfolio Assistant | NOT STARTED | balances, positions, yields Q&A | | | | | | needs verified protocol sources |
| 15 | Yield Optimizer | NOT STARTED | compare yields, rebalance | | | | | | needs verified protocol sources |
| 16 | Liquidation Watchdog | NOT STARTED | lending risk warnings | | | | | | needs a verified lending protocol |
| 17 | Natural-Language Payment Agent | NOT STARTED | request → prepared payment | | | | | | |
| 18 | Recurring Payment Agent | NOT STARTED | repeating payments | | | | | | |
| 19 | Invoice-to-Payment Agent | NOT STARTED | invoice → prepared payment | | | | | | |
| 20 | X402 Paywalled API | NOT STARTED | paid endpoint + facilitator + paying client | | | | | | live payment needs funded wallets |
| 21 | X402 Agent Buyer | NOT STARTED | buys x402 data within a budget | | | | | | after 20 |
| 22 | On-Chain Alert Bot | NOT STARTED | conditions → alerts | | | | | | |
| 23 | Whale-Watching Agent | NOT STARTED | tracked addresses, significant activity | | | | | | |
| 24 | Gas Fee Optimizer | NOT STARTED | gas observation → timing and cost | | | | | | |
| 25 | Wallet Risk Checker | NOT STARTED | wallet/contract history before a tx | | | | | | |
| 26 | Audit-Log Agent | NOT STARTED | plain-language activity report | | | | | | |
| 27 | dApp Support Agent | NOT STARTED | explain transaction failures | | | | | | |
| 28 | Weekly Digest Agent | NOT STARTED | periodic activity summary | | | | | | |
| 29 | Doc-Grounded Builder Agent | NOT STARTED | docs how-to, then perform/prepare | | | | | | |
| 30 | Multi-Protocol Aggregator | NOT STARTED | across more than one protocol | | | | | | needs verified protocol sources |

The task summaries come from the owner's restatement of the official map. A task's full official brief
is checked before it is built, where a source is reachable.
