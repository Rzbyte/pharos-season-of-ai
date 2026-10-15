# 03 · Docs MCP Onboarding

The evidence from onboarding with the Pharos Developer Docs MCP, from the first attempt to a working
Atlantic RPC call, shown as one short case-study page: the outcome, the journey (Started → Blocked →
Recovered → Successful), the strongest gaps with a suggested fix each, and links to the full proof
and the video.

## How the page is made

`evidence.json` is the only content. `npm run build` checks it and renders `public/index.html`, a static
page with no runtime requests. A field that is `null` or empty is left off the page; nothing is filled
in with placeholder text, so the page only ever says what the evidence says.

| Field | What goes in it |
|---|---|
| `summary` | the one line under the title |
| `goal`, `environment`, `environmentNote` | one short line each, or `null` |
| `journey[]` | `{ "stage", "detail": "one line", "log": [{ "kind": "query" \| "answer" \| "command" \| "result", "text" }] }`, in order. Queries are verbatim; `answer` entries are short summaries of Docs MCP's replies and are labelled that way |
| `outcome[]` | the final results: a statement, or `{ "text", "detail" }` |
| `gaps[]` | at most 3: `{ "title", "happened", "fix", "queries": [exact queries], "queryNote"?, "evidenceUrl"?, "evidence": { "thumb", "full", "alt" } \| null }` |
| `links.proof`, `links.video` | https URLs, or `null` |
| `sources[]` | `{ "title", "url" }`, https only |

The page shows the outcome first, the four journey stages as one line each, the full step-by-step log
collapsed under them, then the gaps, each with its exact queries collapsed and an evidence link. No
screenshots are in this repository, so each gap's evidence is the proof folder on Drive.

Evidence images go in `public/evidence/` (`.png`, `.jpg` or `.webp`). Use a small thumbnail (about
320 × 200) for `thumb`; the full image is loaded only when it is opened.

## Commands

```bash
npm run build   # validate evidence.json and write public/index.html
npm run check   # fail if public/index.html is out of date
npm test        # the content checks and the renderer
```

Then `node ../../shared/ui/sync.mjs` from here (or `node shared/ui/sync.mjs` from the repository root)
refreshes the shared shell and design system.

## Deploying

Its own Vercel project with this folder as the root: `npm run build`, output `public/`. No functions.
