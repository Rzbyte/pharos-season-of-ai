#!/usr/bin/env node
// Task 03: render evidence.json into the static page public/index.html.
//
//   node build.mjs           validate evidence.json, check its images exist, write public/index.html
//   node build.mjs --check   change nothing; exit 1 if public/index.html is not what evidence.json renders
//
// The page is a case study, not an app: no request at runtime, no data the build did not read from
// evidence.json. A field that is null or empty is left off the page, never filled in with placeholder
// text, so the page only ever states what the evidence says.
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = new URL("./", import.meta.url);
export const MAX_GAPS = 3;

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isHttps = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};
const EVIDENCE_PATH = /^evidence\/[\w.-]+\.(?:png|jpe?g|webp)$/;

/** Every problem with the content, as messages; [] when it can be rendered. */
export function validate(data) {
  const problems = [];
  const need = (ok, message) => void (ok || problems.push(message));
  need(data && typeof data === "object", "evidence.json must be an object");
  if (!data || typeof data !== "object") return problems;
  need(isText(data.title), "title is required");
  for (const key of ["goal", "environment"]) need(data[key] === null || isText(data[key]), `${key} is text or null`);
  need(Array.isArray(data.journey) && data.journey.length > 0, "journey lists at least one stage");
  for (const [index, step] of (data.journey ?? []).entries()) {
    need(isText(step?.stage), `journey[${index}].stage is required`);
    need(step?.detail === null || isText(step?.detail), `journey[${index}].detail is text or null`);
  }
  need(Array.isArray(data.outcome) && data.outcome.every(isText), "outcome is a list of statements");
  need(Array.isArray(data.gaps) && data.gaps.length <= MAX_GAPS, `gaps is a list of at most ${MAX_GAPS}`);
  for (const [index, gap] of (data.gaps ?? []).entries()) {
    for (const key of ["title", "happened", "fix"]) need(isText(gap?.[key]), `gaps[${index}].${key} is required`);
    const shot = gap?.evidence;
    if (shot !== null && shot !== undefined) {
      need(EVIDENCE_PATH.test(shot.thumb ?? "") && EVIDENCE_PATH.test(shot.full ?? ""), `gaps[${index}].evidence needs thumb and full under evidence/`);
      need(isText(shot.alt), `gaps[${index}].evidence.alt describes the image`);
    }
  }
  for (const key of ["proof", "video"]) need(data.links?.[key] === null || data.links?.[key] === undefined || isHttps(data.links[key]), `links.${key} is an https URL or null`);
  need(Array.isArray(data.sources ?? []), "sources is a list");
  for (const [index, source] of (data.sources ?? []).entries()) need(isText(source?.title) && isHttps(source?.url), `sources[${index}] needs a title and an https url`);
  return problems;
}

const ICON = {
  check: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8.5l3.25 3.25L13 5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  out: '<svg class="ext" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 11l6-6M6 5h5v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 3.5v9l7-4.5-7-4.5Z" fill="currentColor"/></svg>',
  chev: '<span class="chev" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
  arrow: '<svg class="source-arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 11l6-6M6 5h5v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const outLink = (href, cls, inner) => `<a${cls ? ` class="${cls}"` : ""} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}<span class="sr">, opens in a new tab</span></a>`;

/** The page's <main>, from validated content. */
export function renderMain(data) {
  const final = data.journey.at(-1);
  const reached = final && /^success/i.test(final.stage);
  const head = [
    `  <header class="task-head">`,
    `    <p class="label task-kicker"><span class="task-n">03</span><span>Docs Onboarding</span></p>`,
    `    <h1 class="task-title">${esc(data.title)}</h1>`,
    `    <p class="task-via">An onboarding run with the <strong class="nowrap">Pharos Developer Docs MCP</strong>, as evidence</p>`,
    `  </header>`,
  ];
  const context = [data.goal && ["Goal", data.goal], data.environment && ["Environment", data.environment]].filter(Boolean);
  const contextHtml = context.length
    ? [`  <dl class="context">`, ...context.map(([key, value]) => `    <div><dt>${key}</dt><dd>${esc(value)}</dd></div>`), `  </dl>`]
    : [];

  const actions = [
    data.links?.proof && outLink(data.links.proof, "btn btn-primary", `<span>View proof</span>${ICON.out}`),
    data.links?.video && outLink(data.links.video, "btn", `${ICON.play}<span>Watch video</span>`),
  ].filter(Boolean);
  const outcome = [
    `  <section class="panel outcome" aria-labelledby="outcome-h">`,
    `    <div class="beacon" aria-hidden="true"></div>`,
    `    <p class="status" data-tone="${reached ? "success" : "neutral"}"><span class="status-dot" aria-hidden="true"></span><span class="status-word" id="outcome-h">${esc(reached ? "Successful" : final.stage)}</span><span class="status-detail">final outcome</span></p>`,
    `    <ul class="checks">`,
    ...data.outcome.map((line) => `      <li>${ICON.check}<span>${esc(line)}</span></li>`),
    `    </ul>`,
    ...(actions.length ? [`    <p class="outcome-actions">${actions.join("")}</p>`] : []),
    `  </section>`,
  ];

  const journey = [
    `  <section class="section" aria-labelledby="journey-h">`,
    `    <h2 class="section-title" id="journey-h">Journey</h2>`,
    `    <ol class="journey">`,
    ...data.journey.map((step, index) =>
      `      <li class="step" data-stage="${esc(step.stage.toLowerCase())}"><span class="step-mark" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span><span class="step-name">${esc(step.stage)}</span>${step.detail ? `<span class="step-detail">${esc(step.detail)}</span>` : ""}</li>`,
    ),
    `    </ol>`,
    `  </section>`,
  ];

  const gaps = data.gaps.length
    ? [
        `  <section class="section" aria-labelledby="gaps-h">`,
        `    <div class="section-head"><h2 class="section-title" id="gaps-h">Gaps</h2><p class="section-meta">${data.gaps.length === 1 ? "The strongest one" : `The ${data.gaps.length} strongest`}</p></div>`,
        `    <ol class="gaps">`,
        ...data.gaps.map((gap, index) => {
          const shot = gap.evidence
            ? `<a class="shot" href="${esc(gap.evidence.full)}" data-evidence data-alt="${esc(gap.evidence.alt)}"><img src="${esc(gap.evidence.thumb)}" alt="" width="160" height="100" loading="lazy" decoding="async"><span class="shot-word">View evidence</span><span class="sr">: ${esc(gap.evidence.alt)}</span></a>`
            : "";
          return `      <li class="gap"><div class="gap-text"><h3 class="gap-title"><span class="gap-n">${index + 1}</span>${esc(gap.title)}</h3><p class="gap-happened">${esc(gap.happened)}</p><p class="gap-fix"><span class="gap-label">Suggested fix</span>${esc(gap.fix)}</p></div>${shot}</li>`;
        }),
        `    </ol>`,
        `  </section>`,
      ]
    : [];

  const sources = data.sources ?? [];
  const proofLinks = [
    data.links?.proof && { title: "Proof", url: data.links.proof },
    data.links?.video && { title: "Video", url: data.links.video },
    ...sources,
  ].filter(Boolean);
  const proof = [
    `  <details class="disclosure" id="proof">`,
    `    <summary><h2 class="disclosure-title" id="proof-h">Proof &amp; sources</h2>${ICON.chev}</summary>`,
    `    <div class="disclosure-body">`,
    `      <p class="prose">This page is built from <code>evidence.json</code> in this task's folder. Every statement on it comes from the submitted evidence; nothing is read live.</p>`,
    ...(proofLinks.length
      ? [`      <ul class="sources" aria-labelledby="proof-h">`, ...proofLinks.map((link) => `        <li>${outLink(link.url, "", `<span class="source-title">${esc(link.title)}</span><span class="source-meta">${esc(new URL(link.url).host)}</span>${ICON.arrow}`)}</li>`), `      </ul>`]
      : []),
    `      <ul class="sources">`,
    `        <li>${outLink("https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/03-docs-mcp-onboarding", "", `<span class="source-title">Source</span><span class="source-meta">Rzbyte/pharos-season-of-ai</span>${ICON.arrow}`)}</li>`,
    `      </ul>`,
    `    </div>`,
    `  </details>`,
  ];

  const dialog = data.gaps.some((gap) => gap.evidence)
    ? [`  <dialog class="viewer" id="viewer" aria-label="Evidence"><form method="dialog"><button class="btn viewer-close" type="submit">Close</button></form><img id="viewer-img" alt=""></dialog>`]
    : [];

  return [`<main id="main" class="rail page" data-task="03">`, ...head, ...contextHtml, "", ...outcome, "", ...journey, ...(gaps.length ? ["", ...gaps] : []), "", ...proof, ...dialog, `</main>`].join("\n");
}

/** The whole page. */
export function renderPage(data) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>03 · Docs Onboarding · Pharos Agent Lab</title>
<meta name="description" content="Pharos Agent Lab, task 03: onboarding with the Pharos Developer Docs MCP, from the first attempt to a working Atlantic RPC call, with the gaps on the way.">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0B0B0B" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#EFF1F2" media="(prefers-color-scheme: light)">
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%3E%3Crect%20width='16'%20height='16'%20rx='3'%20fill='%230113B7'/%3E%3Crect%20x='3'%20y='7'%20width='10'%20height='2'%20fill='%23FFFFFF'/%3E%3C/svg%3E">
<script src="/assets/theme.js"></script>
<link rel="preload" href="/assets/fonts/Geist-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/lab.css">
<link rel="stylesheet" href="/assets/evidence.css">
<script type="module" src="/assets/evidence.js"></script>
</head>
<body>
<a class="skip" href="#main">Skip to the evidence</a>

<!-- shell:header 03 -->
<!-- /shell:header -->

${renderMain(data)}

<!-- shell:footer 03 -->
<!-- /shell:footer -->
</body>
</html>
`;
}

async function main(check) {
  const data = JSON.parse(await readFile(new URL("evidence.json", ROOT), "utf8"));
  const problems = validate(data);
  for (const gap of data.gaps ?? []) {
    for (const path of gap.evidence ? [gap.evidence.thumb, gap.evidence.full] : []) {
      await access(new URL(`public/${path}`, ROOT)).catch(() => problems.push(`missing image public/${path}`));
    }
  }
  if (problems.length) {
    process.stderr.write(`evidence.json:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  const target = new URL("public/index.html", ROOT);
  const current = await readFile(target, "utf8").catch(() => "");
  // The shell markers are filled by shared/ui/sync.mjs; keep what is between them.
  const shell = (page, part) => page.match(new RegExp(`<!-- shell:${part} 03 -->[\\s\\S]*?<!-- /shell:${part} -->`))?.[0];
  let page = renderPage(data);
  for (const part of ["header", "footer"]) {
    const kept = shell(current, part);
    if (kept) page = page.replace(shell(page, part), kept);
  }
  if (check) {
    if (page !== current) {
      process.stderr.write("public/index.html is out of date: run npm run build\n");
      process.exitCode = 1;
    }
    return;
  }
  await writeFile(target, page);
  process.stdout.write("Wrote public/index.html\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.includes("--check"));
