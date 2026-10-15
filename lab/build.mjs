#!/usr/bin/env node
// The lab's landing page: render public/index.html from the task manifest (public/assets/tasks.js, the
// synced copy of shared/ui/tasks.js), so a new task appears by changing the manifest, never the page.
//
//   node build.mjs           write public/index.html
//   node build.mjs --check   change nothing; exit 1 if public/index.html is out of date
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = new URL("./", import.meta.url);

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ACROSS = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEV = '<span class="chev" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

/**
 * One built task: number, name and verb, its one line, and its page on this site (/tasks/NN). The name
 * is the link, and it covers the whole row, so the row is one target however narrow the screen.
 */
function row(task) {
  const title = task.href ? `<a class="row-title" href="${esc(task.href)}">${esc(task.title)}</a>` : `<span class="row-title">${esc(task.title)}</span>`;
  return [
    `      <li class="row">`,
    `        <span class="row-n">${esc(task.n)}</span>`,
    `        <span class="row-main">${title}<span class="row-purpose">${esc(task.purpose ?? "")}</span></span>`,
    `        <span class="row-verb label">${esc(task.verb ?? "")}</span>`,
    `        <span class="row-tool">${esc(task.tool ?? "")}</span>`,
    `        <span class="row-go" aria-hidden="true">${ACROSS}</span>`,
    `      </li>`,
  ].join("\n");
}

export function renderMain(tasks, lab) {
  const built = tasks.filter((task) => task.status === "built");
  const planned = tasks.filter((task) => task.status !== "built");
  return `<main id="main" class="rail page lab-page">
  <header class="task-head lab-head">
    <p class="label">Season of AI · Agent Arena</p>
    <h1 class="task-title">${esc(lab.name)}</h1>
    <p class="task-via">Pharos instruments, one per task: on-chain reads, live events and the developer docs, each with its proof.</p>
    <p class="lab-count"><b>${built.length}</b> / ${lab.total} built</p>
  </header>

  <section class="section" aria-labelledby="built-h">
    <h2 class="sr" id="built-h">Built</h2>
    <ol class="rows-index">
${built.map(row).join("\n")}
    </ol>
  </section>

  <div class="lab-more">
    <section aria-labelledby="planned-h">
      <h2 class="planned-head"><button class="toggle-row" id="planned-toggle" type="button" aria-expanded="false" aria-controls="planned-body"><span id="planned-h">Planned</span><span class="disclosure-meta">${planned.length} tasks, ${planned[0]?.n ?? ""}–${planned.at(-1)?.n ?? ""}</span>${CHEV}</button></h2>
      <ol class="planned" id="planned-body">
${planned.map((task) => `        <li><span class="row-n">${esc(task.n)}</span><span>${esc(task.title)}</span></li>`).join("\n")}
      </ol>
    </section>

    <details class="disclosure" id="about">
      <summary><h2 class="disclosure-title">About this lab</h2>${CHEV}</summary>
      <div class="disclosure-body">
        <dl class="faq">
          <div><dt>What is this?</dt><dd>One builder's entries for the Pharos Season of AI Agent Arena: each task is a small tool that does one job against Pharos, with its source and a committed proof of a real run.</dd></div>
          <div><dt>What does each task use?</dt><dd>01 and 02 read Pharos through Pharos Chain MCP. 03 records onboarding with the Pharos Developer Docs MCP. 04 asks the Pharos Developer Docs MCP (askQuestion) and shows an answer only with the docs pages it cites.</dd></div>
          <div><dt>Where is the proof?</dt><dd>On each task's page, under Proof, and in its folder of the <a href="https://github.com/Rzbyte/pharos-season-of-ai" target="_blank" rel="noopener noreferrer">repository<span class="sr">, opens in a new tab</span></a>.</dd></div>
        </dl>
      </div>
    </details>
  </div>
</main>`;
}

export function renderPage(tasks, lab) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(lab.name)}</title>
<meta name="description" content="${esc(lab.name)}: Pharos Season of AI tasks, one instrument each, with source and proof.">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0B0B0B" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#EFF1F2" media="(prefers-color-scheme: light)">
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%3E%3Crect%20width='16'%20height='16'%20rx='3'%20fill='%230113B7'/%3E%3Crect%20x='3'%20y='7'%20width='10'%20height='2'%20fill='%23FFFFFF'/%3E%3C/svg%3E">
<script src="/assets/theme.js"></script>
<link rel="preload" href="/assets/fonts/Geist-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/lab.css">
<link rel="stylesheet" href="/assets/landing.css">
<script type="module" src="/assets/landing.js"></script>
</head>
<body>
<a class="skip" href="#main">Skip to the tasks</a>

<!-- shell:header lab -->
<!-- /shell:header -->

${renderMain(tasks, lab)}

<!-- shell:footer lab -->
<!-- /shell:footer -->
</body>
</html>
`;
}

async function main(check) {
  const { TASKS, LAB } = await import(new URL("public/assets/tasks.js", ROOT).href);
  const target = new URL("public/index.html", ROOT);
  const current = await readFile(target, "utf8").catch(() => "");
  let page = renderPage(TASKS, LAB);
  // The shell markers are filled by shared/ui/sync.mjs; keep what is between them.
  for (const part of ["header", "footer"]) {
    const re = new RegExp(`<!-- shell:${part} lab -->[\\s\\S]*?<!-- /shell:${part} -->`);
    const kept = current.match(re)?.[0];
    // A function replacer: the kept markup is inserted as is, with no "$" patterns expanded.
    if (kept) page = page.replace(re, () => kept);
  }
  if (check) {
    if (page !== current) {
      process.stderr.write("public/index.html is out of date: run node build.mjs\n");
      process.exitCode = 1;
    }
    return;
  }
  await writeFile(target, page);
  process.stdout.write("Wrote public/index.html\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.includes("--check"));
