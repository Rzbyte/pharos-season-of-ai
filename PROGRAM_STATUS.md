# Program status: Pharos Agent Lab

What is built, what is frozen, and what needs a person. Updated 2026-10-16.

## USER ACTION REQUIRED

**Deploy `main` to the existing Pharos Agent Lab project, then check Task 04 in production.** This build
environment can't do either step. It has no Vercel CLI, token or project link, and its proxy refuses
`vercel.com`, `*.vercel.app` and `docs.pharos.xyz` (CONNECT 403). Deploy from your checkout that is
already linked to the canonical project; don't create or link another project:

```sh
git checkout main && git pull origin main
vercel --prod
```

Then ask each question on the production site's `/tasks/04`:

| | Question (exact) | Expected |
|---|---|---|
| A | `What is the Atlantic chain ID?` | An answer with numbered `docs.pharos.xyz` sources. The run line under it reads "Developer Docs MCP (askQuestion)". |
| B | `How do I deploy a contract with Foundry on Pharos?` | A procedural answer with `docs.pharos.xyz` sources and the same run line. |
| C | `bagaimana cara deploy Anchor program ke Solana?` | The band is tagged "No answer" and reads "No good answer found." with a reason. There is no answer text and no steps. A "Nearby in the docs" list may follow. |

The same checks work from a shell: `curl -sG https://<production-domain>/api/search --data-urlencode "q=<question>"`.

- A and B should return `status` `answered`.
- C should return `status` `no_answer`, with reason `not_in_docs` expected.
- All three should report `meta.provider` `developer-docs-mcp` and `meta.transport` `docs-mcp`.

If C comes back `answered`, that is a real regression. Keep that JSON, because the gate can only be
fixed against the live wording. When all three pass, Task 04 is done.

## Tasks

| Task | Route | Status | Proof |
|---|---|---|---|
| 01 Read Contract State | `/tasks/01` | Built | Live Chain MCP read, 2026-10-14T07:10:47Z, block 20202384 ([transcript](tasks/01-read-contract-state/proof/mcp-transcript.json)) |
| 02 Event / Log Monitor | `/tasks/02` | Built | 19 live Transfer events, 2026-10-14T20:47:42Z, verified ([proof](tasks/02-event-log-monitor/proof)) |
| 03 Docs MCP Onboarding | `/tasks/03` | Built | The evidence page; proof folder and video on Drive ([evidence.json](tasks/03-docs-mcp-onboarding/evidence.json)) |
| 04 Doc-Search CLI | `/tasks/04` | **Frozen**; done once the production check above passes | Live Developer Docs MCP runs, 2026-10-15T20:39:19Z, 3/3 verified ([SUBMISSION.md](tasks/04-doc-search-cli/SUBMISSION.md)) |

Every route is served by the one Vercel project built from the repository root ([site/](site)).
Whether production is up to date can't be checked from this environment.

## Next

The task map moves from the legacy 28 tasks to the official 30. Tasks 20 and 21 are new x402 tasks,
and the old Tasks 20 to 28 become 22 to 30.
