# Archived: docs-http proof (2026-10-15), not MCP

These files are the live proof captured on 2026-10-15 (01:44–01:45 UTC) with the earlier transport of
`pharos-docs`, **docs-http**: plain HTTPS GET requests to the docs' query interface
(`https://docs.pharos.xyz/sitemap.md`, then `<page>.md?ask=<question>&goal=<goal>`). They are **not MCP
calls**, and every transcript here says so (`"transport": "docs-http"`).

They are kept unchanged as history. They are not the Task 04 proof: Task 04 now runs on the Pharos
Developer Docs MCP (`https://docs.pharos.xyz/~gitbook/mcp`), and its proof is `proof/query-a.json`,
`proof/query-b.json` and `proof/query-c.json`, written by `npm run proof`.

| File | What it is |
|---|---|
| `query-a.json`, `query-b.json`, `query-c.json` | docs-http transcripts: every GET request, the bodies, the result |
| `probe.json` | the docs-http probe of the live `?ask=` response shape |
| `sample-output/` | the CLI output of those runs, as printed |

They were verified at capture time by the docs-http verifier (`verifyHttpRun` in `src/proof.ts`).
