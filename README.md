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

[`agent/`](agent) is the agent runtime behind Tasks 05 onward: one package that gains a capability per
task. [`lab/`](lab) is the landing page that indexes the tasks, and [`shared/ui/`](shared/ui) is the
design system every page shares (`node shared/ui/sync.mjs` copies it into each deployment).

The whole lab deploys as one site from the repository root: the lab at `/` and each task at
`/tasks/NN` ([`site/`](site) explains how).
