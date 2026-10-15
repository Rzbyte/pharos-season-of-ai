# Shared UI

The design system every page in this repository uses: one source here, an exact copy in each
deployment (each task deploys from its own folder, so it cannot load files from outside it).

| File | What it is |
|---|---|
| `lab.css` | Tokens (Pharos palette, dark and light), the compact type and spacing scale, the shell, and primitives: panel, status, rows, technical values, actions, buttons, field, pager, pill, state block, disclosure, toggle row, counts, steps, key/value, sources. A page adds its own workspace styles in the `task` layer. |
| `lab.js` | DOM-free helpers (digits, hex, explorer links, `pageOf`, `neighbours`) and small DOM helpers (`renderHex`, `wireCopy`, `linkExplorer`, `renderTaskNav`, `wireToggle`). |
| `theme.js` | Light and dark, following the system until the reader chooses. |
| `tasks.js` | The 28-task manifest. A built task's link is its route on the unified site, `/tasks/NN`; `LEGACY` keeps the standalone Task 01 and 02 addresses, used only by pages served from those deployments. |
| `header.html`, `footer.html` | The shell markup, stamped into each page between `<!-- shell:header NN -->` markers. |
| `fonts/` | Geist, Geist Mono and Departure Mono (SIL OFL 1.1). |

```bash
node shared/ui/sync.mjs           # copy into every deployment and stamp the shell
node shared/ui/sync.mjs --check   # fail if any copy differs (every page test checks this too)
NODE_PATH="$(npm root -g)" node --test shared/ui/tests/ui.test.mjs
```

Scale: label 12 · meta 13 · small/button 14 · body 15→16 · section 20→22 · value 22→26 · title 28→34 px.
Spacing: 4 · 8 · 12 · 16 · 24 · 32 · 40 px; page gutter 18 px on phones; panels 16 px; 44 px targets.
