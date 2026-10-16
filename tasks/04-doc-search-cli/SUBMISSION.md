# Task 04 submission: Doc-Search CLI

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/04 |
| Repository | [`tasks/04-doc-search-cli/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/04-doc-search-cli) |
| Proof | [`proof/query-a.json`](proof/query-a.json), [`query-b.json`](proof/query-b.json), [`query-c.json`](proof/query-c.json): three live runs, 2026-10-15T20:39:19Z, each verified 11/11 by `npm run verify-proof` |
| Pharos technology | Pharos Developer Docs MCP, `https://docs.pharos.xyz/~gitbook/mcp`, tool `askQuestion` (Streamable HTTP, JSON-RPC 2.0) |

## Reviewer note

`pharos-docs "<question>"` returns a short answer from the official Pharos docs and the
`docs.pharos.xyz` pages it cites. When the docs don't answer, it prints "No good answer found." with
the reason and nearby pages, and never invents an answer. The `/tasks/04` page runs the same search
through `/api/search`.

| Requirement | Where |
|---|---|
| Natural-language question | [Usage](README.md#usage) |
| Concise answer with source links | [Text output](README.md#text-output) |
| Says so when there is no good answer | [No-answer behavior](README.md#no-answer-behavior) |
| README: install, usage, 3 examples with output | [Installation](README.md#installation), [Examples](README.md#examples) |

| Proof query | Result |
|---|---|
| What is the Atlantic chain ID? | answered, 5 sources |
| How do I deploy a contract with Foundry? | answered, 5 sources |
| How do I deploy an Anchor program to Solana? | no answer (`not_in_docs`), 3 nearby pages |

## Key implementation detail

The MCP client is about 200 lines with no SDK. It POSTs one JSON-RPC request per call, refuses
redirects, caps the body at 2 MB, and accepts only a response with its own request id.

Between the MCP and the reader sits a deterministic source gate:
- An answer is shown only with official `docs.pharos.xyz` sources.
- An answer that says the docs don't cover the topic becomes a no-answer. This is detected from the
  docs' own wording in English and Indonesian, with no topic list and no LLM. A factual "no" stays an
  answer.

The verifier recomputes every proof result from the saved MCP response bytes.

## Video walkthrough (about 60 s)

1. Open `/tasks/04`, tap "What is the Atlantic chain ID?": the answer, then numbered sources.
2. Ask "How do I deploy a contract with Foundry on Pharos?": numbered steps, code with Copy.
3. Ask "bagaimana cara deploy Anchor program ke Solana?": "No good answer found." with nearby pages.
4. Open the JSON toggle on a result: `developer-docs-mcp`, `docs-mcp`, the endpoint.
5. In a terminal: `pharos-docs "What is the Atlantic chain ID?"`.

## X post draft

A small docs search for Pharos: ask in plain English or Indonesian, get an answer from the official
docs with the pages it came from, or a straight "no good answer". It runs on the Pharos Developer
Docs MCP, and the proof is the raw MCP responses. https://pharos-agent-lab.vercel.app/tasks/04

## How it works (reply)

It asks the Developer Docs MCP's `askQuestion` and shows the answer only with the official pages it
cites. When the docs say a topic isn't covered, a deterministic gate turns that into "No good answer
found." instead of an answer.

## Status

Frozen. Production check pending: deploy `main` and run queries A, B and C on `/tasks/04`
([PROGRAM_STATUS.md](../../PROGRAM_STATUS.md)).
