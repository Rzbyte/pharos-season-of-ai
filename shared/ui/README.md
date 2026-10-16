# Shared UI

The design system every page in this repository uses: one source here, an exact copy in each
deployment (each task deploys from its own folder, so it cannot load files from outside it).

| File | What it is |
|---|---|
| `lab.css` | Tokens (Pharos palette, dark and light), the compact type and spacing scale, the shell (bar, task switcher, one-line footer, the two page models below), and primitives: panel, status, rows, technical values, actions, buttons, field, pager, pill, state block, disclosure, toggle row, sheet, counts, steps, key/value, sources. A page adds its own workspace styles in the `task` layer. |
| `lab.js` | DOM-free helpers (digits, hex, explorer links, `pageOf`, `neighbours`, `taskLink`) and small DOM helpers (`renderHex`, `wireCopy`, `linkExplorer`, `renderTaskNav`, `taskMenu`, `wireToggle`). |
| `theme.js` | Light and dark, following the system until the reader chooses. |
| `tasks.js` | The task manifest: one entry per task of the official map, 30 in all, in order (Tasks 20 and 21 are the x402 tasks). A built task's link is its route on the unified site, `/tasks/NN`; `LEGACY` keeps the standalone Task 01 and 02 addresses, used only by pages served from those deployments. |
| `header.html`, `footer.html` | The shell markup, stamped into each page between `<!-- shell:header NN -->` markers. |
| `fonts/` | Geist, Geist Mono and Departure Mono (SIL OFL 1.1). |

```bash
node shared/ui/sync.mjs           # copy into every deployment and stamp the shell
node shared/ui/sync.mjs --check   # fail if any copy differs (every page test checks this too)
NODE_PATH="$(npm root -g)" node --test shared/ui/tests/ui.test.mjs
```

Scale: label 12 · meta 13 · small/button 14 · body 15→16 · section 17→19 · value 20→24 · title 22→26 px.
Spacing: 4 · 8 · 12 · 16 · 24 · 32 · 40 px; sections 24→32 px apart; page gutter 18 px on phones, at
least the safe area; panels 16 px; 44 px targets.

## Navigation

Moving between tasks happens in one place, the shell bar: the lab link, the arrows either side of
`NN / 30`, and the counter itself, which opens the task switcher (a native popover listing every built
task, the current one marked, then the lab). The footer is one line: the lab and its links. The total
is `LAB.total` in `tasks.js`; `header.html` carries the same number for a page before its script runs,
and the shared tests fail if the two differ.

## Page models

Pick the one the interaction needs; they share the shell, tokens and primitives.

- **Document** (`main.rail.page`): the task header, the workspace, then secondary sections in
  disclosures, and the page scrolls. For an instrument whose content has a fixed size (01, 02) or a
  case study read top to bottom (03). With room, a page may use two columns: Task 01 keeps the
  snapshot beside the inspector, Task 03 keeps its summary card beside the story.
- **App** (`body.app`): one workspace exactly as tall as the screen (dynamic viewport), whose own
  regions scroll while the document does not; the footer's links move into the page's About. For an
  interaction that grows with use, like Task 04's questions. With `interactive-widget=resizes-content`
  in the page's viewport meta, Android browsers shrink it above the keyboard, so a box at its bottom
  stays in view.
