# pharos-season-of-ai
My builds for the Pharos Season of AI Agent Arena using Chain MCP, Developer Docs MCP, and SkillEngine.

**Live:** https://pharos-agent-lab.vercel.app · **Status:** [PROGRAM_STATUS.md](PROGRAM_STATUS.md)

| Task | What it is |
|---|---|
| [01 · Read Contract State](tasks/01-read-contract-state) | A CLI and a web demo that read the Circle USDC Contract on Pharos Mainnet through Pharos Chain MCP, pinned to one block; the web demo adds the Pharos Inspector, with an optional plain-language explanation of a result |
| [02 · Event / Log Monitor](tasks/02-event-log-monitor) | A CLI and a web monitor of Circle USDC Transfer events on Pharos Mainnet through Pharos Chain MCP `get_logs`, each event shown once |
| [03 · Docs MCP Onboarding](tasks/03-docs-mcp-onboarding) | The onboarding evidence with the Pharos Developer Docs MCP, as a short case-study page built from `evidence.json` |
| [04 · Doc-Search CLI](tasks/04-doc-search-cli) | `pharos-docs`: a question in, a short answer from the official Pharos docs through the Pharos Developer Docs MCP (`askQuestion`) with its source pages out, or a plain no-answer; a docs search page runs the same search |
| [05 · Threshold Guardian](tasks/05-threshold-guardian) | Six on-chain conditions read at one block through Pharos Chain MCP; a USDC payout fires only when all hold, simulated first; on Atlantic it re-checks, signs locally and broadcasts through Chain MCP |
| [08 · Dry-Run Executor](tasks/08-dry-run-executor) | A transfer, approval or contract call simulated at one block through Pharos Chain MCP before it is sent: the verdict, before → after for every balance it changes, the gas and fee, and warnings; on Atlantic it submits and checks the receipt against the prediction |
| [09 · Trend Watcher](tasks/09-trend-watcher) | One on-chain value read through Pharos Chain MCP on each run and kept in a store across runs; it acts only when the observations show a trend (falling, rising, a % change or a threshold held), once per trend, with its action dry-run first; the proofs chain run to run |
| [11 · Policy Gatekeeper](tasks/11-policy-gatekeeper) | A payment request checked against a written policy at one block through Pharos Chain MCP before anything is signed: per-action and window spend limits (the window from the sender's own Transfer logs), asset and counterparty allowlists, allowed hours at the block's time, a gas cap and a dry run; every failing rule named |
| [22 · On-Chain Alert Bot](tasks/22-on-chain-alert-bot) | An alert bot on Pharos Mainnet through Pharos Chain MCP, run after run: transfers of a token (by size, sender and recipient) from `get_logs`, each alerted once from a cursor kept between runs, and conditions on balances, view calls and gas, alerted when they start and when they stop; the CLI posts each alert to a webhook and retries what it refused; the proofs chain run to run |
| [23 · Whale-Watching Agent](tasks/23-whale-watching-agent) | Chosen addresses tracked on Pharos Mainnet through Pharos Chain MCP, run after run: holdings, nonce and code read at one block, their token transfers from `get_logs` (two OR-topic queries a page), and the significant moves surfaced once (transfers over an amount, native balance changes over another); the rest summed per address; the proofs chain run to run |
| [24 · Gas Fee Optimizer](tasks/24-gas-fee-optimizer) | The base fee observed through Pharos Chain MCP, run after run, and one transaction timed against it: send now when the fee is at or below a target (a percentile of the observations, or a fixed fee) or past a deadline, else wait; fee settings capped at the target, and the cost now, at the target and at most; on Atlantic it sends once, and the proof checks the signed fee cap |
| [25 · Wallet Risk Checker](tasks/25-wallet-risk-checker) | The address a Pharos transaction goes to, checked through Pharos Chain MCP before it is sent: what it is (wallet, contract, or EIP-7702 delegate), its nonce and balance, and its recent transfers with the sender from `get_logs`; it flags address poisoning (a lookalike of a real partner, transfers of nothing), approvals to wallets, unlimited approvals, tokens sent to a token contract, never-used addresses and a transaction that would fail, each signal with its tool, and says do not send, check first or looks fine |
| [27 · dApp Support Agent](tasks/27-dapp-support-agent) | Why a Pharos transaction failed, on request, through Pharos Chain MCP: its receipt, its call replayed before its block for the revert, decoded in plain language (Error, Panic codes, OpenZeppelin's errors with token amounts), the sender's balance, out of gas or something earlier in its block, each finding with its tool, and a fix; a transaction described instead is explained as it would fail now; no language model, so each answer replays as a proof |

[`agent/`](agent) is the agent runtime behind Tasks 05 onward: one package that gains a capability per
task. [`lab/`](lab) is the landing page that indexes the tasks, and [`shared/ui/`](shared/ui) is the
design system every page shares (`node shared/ui/sync.mjs` copies it into each deployment).

The whole lab deploys as one site from the repository root: the lab at `/` and each task at
`/tasks/NN` ([`site/`](site) explains how).
