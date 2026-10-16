# Task 04 submission: Doc-Search CLI

**Status:** frozen. The code is final on `main`; the task is marked done once the production checks in
[PROGRAM_STATUS.md](../../PROGRAM_STATUS.md) pass. Do not change its design unless a real regression is
found.

| | |
|---|---|
| What it is | `pharos-docs`: a question in, a short answer from the official Pharos Developer Docs with its source pages out, or a plain no-answer. A docs search page runs the same search. |
| Tool | Pharos Developer Docs MCP, `https://docs.pharos.xyz/~gitbook/mcp`, tool `askQuestion` (Streamable HTTP, JSON-RPC 2.0, no authentication) |
| Code | [`tasks/04-doc-search-cli/`](.) on `main` |
| Web page | `/tasks/04` on the unified Pharos Agent Lab site, backed by `GET /api/search?q=` (the same `search()` and provider as the CLI) |
| Release commits | `14d30b1` (no-answer detection in Indonesian as well as English), `26c64fe` (the question-log page), on top of `bed7068` (live MCP proof) |

## Official requirements

1. **Accepts a natural-language question.** `pharos-docs "<question>"`, quoted or not ([Usage](README.md#usage)).
2. **Returns a concise answer with source links.** The MCP's answer, then numbered `docs.pharos.xyz`
   sources taken from it ([Text output](README.md#text-output)).
3. **Says so when there is no good answer.** "No good answer found in the Pharos Developer Docs.", with
   the reason and nearby pages; never an invented answer ([No-answer behavior](README.md#no-answer-behavior)).
   A docs answer that says the docs do not cover the topic is recognised in English and Indonesian.
4. **README with installation, usage and at least 3 example queries with output.**
   [Installation](README.md#installation), [Usage](README.md#usage), [Examples](README.md#examples).

## Proof

Captured 2026-10-15T20:39:19Z against the live Developer Docs MCP by `npm run proof`. Each of the
three runs was then checked against its saved JSON-RPC requests and raw responses by
`npm run verify-proof`, 11/11 checks each.

| Query | Result | Transcript |
|---|---|---|
| What is the Atlantic chain ID? | answered, 5 sources | [proof/query-a.json](proof/query-a.json) |
| How do I deploy a contract with Foundry? | answered, 5 sources | [proof/query-b.json](proof/query-b.json) |
| How do I deploy an Anchor program to Solana? | no answer (`not_in_docs`), 3 nearby pages | [proof/query-c.json](proof/query-c.json) |

The verifier recomputes each result from the saved MCP response with the current code. It still passes
after the Indonesian rules were added, so they changed none of the proven results.

## Run it

```sh
cd tasks/04-doc-search-cli
npm ci
node dist/src/cli.js "What is the Atlantic chain ID?"
npm test && npm run test:web && npm run verify-proof
```

## Production

Not yet checked: this build environment cannot reach Vercel or `docs.pharos.xyz`. To deploy `main` to
the existing Pharos Agent Lab project and check queries A, B and C on `/tasks/04`, follow the user
action in [PROGRAM_STATUS.md](../../PROGRAM_STATUS.md).
