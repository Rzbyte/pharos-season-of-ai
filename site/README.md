# The unified site

One Vercel project, one domain: the repository root (`vercel.json`, `package.json`, `api/`).

| Route | Served from |
|---|---|
| `/` | `lab/public/index.html` |
| `/tasks/01` | `tasks/01-read-contract-state/public/index.html` |
| `/tasks/02` | `tasks/02-event-log-monitor/public/index.html` |
| `/tasks/03` | `tasks/03-docs-mcp-onboarding/public/index.html` |
| `/tasks/04` | `tasks/04-doc-search-cli/public/index.html` |
| `/assets/*` | every deployment's `public/assets/`, merged |
| `/api/state`, `/api/inspect`, `/api/explain` | Task 01's handlers |
| `/api/events` | Task 02's handler |
| `/api/search` | Task 04's handler |

`site/build.mjs` copies the existing pages and assets into `site/public` as they are. The pages already
load `/assets/...` and call `/api/...` by absolute path, so they work at `/tasks/NN` unchanged. Shared
files are identical in every deployment and task files have their own names; the build stops on any
collision. `api/*.js` are one-line re-exports of each task's own handler. `vercel.json` rewrites
`/tasks/NN` to `/tasks/NN/index.html` and keeps each function's `maxDuration`.

A new task: add its folder to `TASK_DIRS` in `site/build.mjs` (it is then served at `/tasks/NN`), one
`api/<name>.js` re-export per function it has, and mark it built in `shared/ui/tasks.js`.

```bash
npm run install:tasks   # npm ci in tasks 01, 02 and 04
npm run build           # compile them, then assemble site/public
npm run preview         # http://127.0.0.1:3000, the same routes and rewrites (real handlers)
NODE_PATH="$(npm root -g)" npm test
```

The standalone deployments of Task 01 and Task 02 (their own `vercel.json`) still work as before; a
page served there links its neighbours through `LEGACY` in `shared/ui/tasks.js`. On the unified site
every link is a same-domain route.

Environment: Explain on Task 01 needs `DEEPSEEK_API_KEY` set on the project, as on Task 01's own
deployment.
