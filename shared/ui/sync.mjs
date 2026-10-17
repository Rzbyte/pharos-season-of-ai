#!/usr/bin/env node
// Copy the shared UI into every deployment, and stamp the shared header and footer into each page.
//
//   node shared/ui/sync.mjs           write the copies
//   node shared/ui/sync.mjs --check   change nothing; exit 1 and list every copy that differs
//
// Each task is deployed on its own (its folder is the deployment root), so it cannot load files from
// outside its folder at runtime. shared/ui/ is the one source; every deployment ships an exact copy
// in public/assets/, and each page carries the shell markup between
//   <!-- shell:header NN -->  ...  <!-- /shell:header -->   and   <!-- shell:footer NN --> ... <!-- /shell:footer -->
// where NN is the task number ("lab" for the landing page, which has no task navigation).
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED = dirname(fileURLToPath(import.meta.url));
const REPO = join(SHARED, "..", "..");
export const TARGETS = [
  "lab/public",
  "tasks/01-read-contract-state/public",
  "tasks/02-event-log-monitor/public",
  "tasks/03-docs-mcp-onboarding/public",
  "tasks/04-doc-search-cli/public",
  "tasks/05-threshold-guardian/public",
  "tasks/08-dry-run-executor/public",
  "tasks/09-trend-watcher/public",
  "tasks/11-policy-gatekeeper/public",
  "tasks/13-docs-chain-agent/public",
  "tasks/17-natural-language-payment/public",
  "tasks/22-on-chain-alert-bot/public",
  "tasks/23-whale-watching-agent/public",
  "tasks/24-gas-fee-optimizer/public",
  "tasks/25-wallet-risk-checker/public",
  "tasks/26-audit-log-agent/public",
  "tasks/27-dapp-support-agent/public",
  "tasks/28-weekly-digest-agent/public",
  "tasks/29-doc-grounded-builder/public",
];
export const ASSETS = ["lab.css", "lab.js", "theme.js", "tasks.js"];
/** The agent pages (Task 05 onward) also share the run layer: agent.js and agent.css. */
export const AGENT_TARGETS = TARGETS.filter((target) => Number(target.match(/^tasks\/(\d{2})-/)?.[1] ?? 0) >= 5);
export const AGENT_ASSETS = ["agent.css", "agent.js"];

/** The header or footer for one page: task number filled in; no task navigation on the landing page. */
export function shellPart(template, n) {
  let html = template.replaceAll("{{n}}", n);
  if (n === "lab") {
    html = html.replace(/\n\s*<nav class="shell-tasks"[\s\S]*?<\/nav>/, "");
  }
  return html.trim();
}

/** A page with its shell markers refilled from the templates. Throws if a page has no markers. */
export function stampShell(page, templates) {
  let found = 0;
  const out = page.replace(/<!-- shell:(header|footer) (\w+) -->[\s\S]*?<!-- \/shell:\1 -->/g, (_, part, n) => {
    found += 1;
    return `<!-- shell:${part} ${n} -->\n${shellPart(templates[part], n)}\n<!-- /shell:${part} -->`;
  });
  if (found !== 2) throw new Error(`expected a shell:header and a shell:footer marker, found ${found}`);
  return out;
}

async function run(check) {
  const templates = { header: await readFile(join(SHARED, "header.html"), "utf8"), footer: await readFile(join(SHARED, "footer.html"), "utf8") };
  const fonts = (await readdir(join(SHARED, "fonts"))).sort();
  const drift = [];
  for (const target of TARGETS) {
    const root = join(REPO, target);
    const names = [...ASSETS, ...(AGENT_TARGETS.includes(target) ? AGENT_ASSETS : [])];
    const files = [...names.map((name) => [join(SHARED, name), join(root, "assets", name)]), ...fonts.map((name) => [join(SHARED, "fonts", name), join(root, "assets", "fonts", name)])];
    for (const [from, to] of files) {
      const want = await readFile(from);
      const have = await readFile(to).catch(() => null);
      if (have && have.equals(want)) continue;
      drift.push(to);
      if (!check) {
        await mkdir(dirname(to), { recursive: true });
        await writeFile(to, want);
      }
    }
    const pagePath = join(root, "index.html");
    const page = await readFile(pagePath, "utf8").catch(() => null);
    if (page === null) {
      drift.push(`${pagePath} (missing)`);
      continue;
    }
    let stamped;
    try {
      stamped = stampShell(page, templates);
    } catch (error) {
      drift.push(`${pagePath} (${error.message})`);
      continue;
    }
    if (stamped !== page) {
      drift.push(pagePath);
      if (!check) await writeFile(pagePath, stamped);
    }
  }
  const rel = (path) => path.replace(`${REPO}/`, "");
  if (check) {
    if (drift.length) {
      process.stderr.write(`Shared UI out of sync (run node shared/ui/sync.mjs):\n${drift.map((p) => `  ${rel(p)}`).join("\n")}\n`);
      process.exitCode = 1;
    } else process.stdout.write("Shared UI in sync.\n");
  } else process.stdout.write(drift.length ? `Updated:\n${drift.map((p) => `  ${rel(p)}`).join("\n")}\n` : "Already in sync.\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run(process.argv.includes("--check"));
