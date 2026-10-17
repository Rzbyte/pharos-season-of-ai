# The unified site

One Vercel project, one domain: the repository root (`vercel.json`, `package.json`, `api/`).

| Route | Served from |
|---|---|
| `/` | `lab/public/index.html` |
| `/tasks/01` | `tasks/01-read-contract-state/public/index.html` |
| `/tasks/02` | `tasks/02-event-log-monitor/public/index.html` |
| `/tasks/03` | `tasks/03-docs-mcp-onboarding/public/index.html` |
| `/tasks/04` | `tasks/04-doc-search-cli/public/index.html` |
| `/tasks/05` | `tasks/05-threshold-guardian/public/index.html` |
| `/tasks/08` | `tasks/08-dry-run-executor/public/index.html` |
| `/tasks/09` | `tasks/09-trend-watcher/public/index.html` |
| `/tasks/11` | `tasks/11-policy-gatekeeper/public/index.html` |
| `/tasks/13` | `tasks/13-docs-chain-agent/public/index.html` |
| `/tasks/17` | `tasks/17-natural-language-payment/public/index.html` |
| `/tasks/22` | `tasks/22-on-chain-alert-bot/public/index.html` |
| `/tasks/23` | `tasks/23-whale-watching-agent/public/index.html` |
| `/tasks/24` | `tasks/24-gas-fee-optimizer/public/index.html` |
| `/tasks/25` | `tasks/25-wallet-risk-checker/public/index.html` |
| `/tasks/26` | `tasks/26-audit-log-agent/public/index.html` |
| `/tasks/27` | `tasks/27-dapp-support-agent/public/index.html` |
| `/tasks/28` | `tasks/28-weekly-digest-agent/public/index.html` |
| `/tasks/29` | `tasks/29-doc-grounded-builder/public/index.html` |
| `/assets/*` | every deployment's `public/assets/`, merged |
| `/api/state`, `/api/inspect`, `/api/explain` | Task 01's handlers |
| `/api/events` | Task 02's handler |
| `/api/search` | Task 04's handler |
| `/api/agent?task=NN` | the agent's one function for Tasks 05 onward (`agent/api/agent.js`) |

`site/build.mjs` copies the existing pages and assets into `site/public` as they are. The pages already
load `/assets/...` and call `/api/...` by absolute path, so they work at `/tasks/NN` unchanged. Shared
files are identical in every deployment and task files have their own names; the build stops on any
collision. `api/*.js` are one-line re-exports of each task's own handler. `vercel.json` rewrites
`/tasks/NN` to `/tasks/NN/index.html` and keeps each function's `maxDuration`.

A new task: add its folder to `TASK_DIRS` in `site/build.mjs` (it is then served at `/tasks/NN`) and
mark it built in `shared/ui/tasks.js`. A task on the agent adds a route to `agent/src/web.ts` instead of
a function, so the project keeps one function for all of them; a task with its own handler adds one
`api/<name>.js` re-export.

```bash
npm run install:tasks   # npm ci in tasks 01, 02, 04 and agent
npm run build           # compile them, then assemble site/public
npm run preview         # http://127.0.0.1:3000, the same routes and rewrites (real handlers)
NODE_PATH="$(npm root -g)" npm test
```

The standalone deployments of Task 01 and Task 02 (their own `vercel.json`) still work as before; a
page served there links the other tasks (arrows and task switcher) through `LEGACY` in
`shared/ui/tasks.js`. On the unified site every link is a same-domain route.

Environment: Explain on Task 01 needs `DEEPSEEK_API_KEY` set on the project, as on Task 01's own
deployment.
