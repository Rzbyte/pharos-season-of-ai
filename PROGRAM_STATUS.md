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

The same deploy also carries the 30-task map, so the lab at `/` should read "4 / 30 built".

## Tasks

| Task | Route | Status | Proof |
|---|---|---|---|
| 01 Read Contract State | `/tasks/01` | Built | Live Chain MCP read, 2026-10-14T07:10:47Z, block 20202384 ([transcript](tasks/01-read-contract-state/proof/mcp-transcript.json)) |
| 02 Event / Log Monitor | `/tasks/02` | Built | 19 live Transfer events, 2026-10-14T20:47:42Z, verified ([proof](tasks/02-event-log-monitor/proof)) |
| 03 Docs MCP Onboarding | `/tasks/03` | Built | The evidence page; proof folder and video on Drive ([evidence.json](tasks/03-docs-mcp-onboarding/evidence.json)) |
| 04 Doc-Search CLI | `/tasks/04` | **Frozen**; done once the production check above passes | Live Developer Docs MCP runs, 2026-10-15T20:39:19Z, 3/3 verified ([SUBMISSION.md](tasks/04-doc-search-cli/SUBMISSION.md)) |

Every route is served by the one Vercel project built from the repository root ([site/](site)).
Whether production is up to date can't be checked from this environment.

## Task map

The manifest ([shared/ui/tasks.js](shared/ui/tasks.js)) follows the official map of 30 tasks. That map
inserted two x402 tasks as 20 and 21, so the legacy Tasks 20 to 28 are now 22 to 30, titles unchanged.
Tasks 01 to 04 keep their numbers, their routes (`/tasks/01` to `/tasks/04`) and their proof. Every
page's counter reads `NN / 30`, and the lab reads "4 / 30 built".

The shared tests ([shared/ui/tests/ui.test.mjs](shared/ui/tests/ui.test.mjs)) pin all of this: the
numbering, the insertion, the built routes, each page's counter, and the neighbours around 04/05,
19 to 22, and 30.

The official titles of Tasks 20 and 21 aren't in this repository, and no reachable source gives them.
So the manifest doesn't guess: their `official` is null, and the lab lists them as
"x402 task (title pending)".

## Needed to continue

1. **The official brief for Task 05, Threshold Guardian**, the next task in order.
   - Each brief so far came with its task (difficulty, tool, goal, requirements), as for Tasks 02 and 04.
     For Tasks 05 to 30 this repository has only titles, and no public source lists the briefs.
   - Building Task 05 from its title alone would mean guessing what it must do and which integration it
     uses.
2. **The official titles of Tasks 20 and 21** (x402). Each is a one-line change in `shared/ui/tasks.js`,
   plus the two test lists that pin the titles.

Integrations already verified in this repository:

- **Pharos Chain MCP** at `https://mcp.pharos.xyz/mcp`, used by Tasks 01 and 02: `get_chain_info`,
  `get_block_number`, `eth_call`, `get_logs`, `get_code`, `get_balance`, `get_transaction_count`,
  `get_transaction` and `get_transaction_receipt`.
- **The Pharos Developer Docs MCP** `askQuestion`, used by Task 04.

SkillEngine and x402 are not verified from this environment yet.
