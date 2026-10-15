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
| `goal`, `environment` | one short line each, or `null` |
| `journey[]` | `{ "stage": "Started", "detail": "one line" \| null }`, in order |
| `outcome[]` | the final results, one short statement each |
| `gaps[]` | at most 3: `{ "title", "happened", "fix", "evidence": { "thumb", "full", "alt" } \| null }` |
| `links.proof`, `links.video` | https URLs, or `null` |
| `sources[]` | `{ "title", "url" }`, https only |

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
