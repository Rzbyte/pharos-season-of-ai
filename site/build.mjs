#!/usr/bin/env node
// The unified site: one static tree from the builds that already exist, for one Vercel project.
//
//   /            the lab landing      (lab/public)
//   /tasks/NN    a task page          (tasks/NN-*/public/index.html)
//   /assets/*    every page's assets  (merged: shared files are identical copies, task files have
//                                      distinct names, and the pages already load /assets/... by
//                                      absolute path, so they work at any depth unchanged)
//   /evidence/*  Task 03's evidence images, when there are any
//   /api/*       the root api/ folder: one-line re-exports of each task's own handler
//
// Nothing here changes a task: pages, scripts and handlers are copied or re-exported as they are.
// Any collision (two different files at one path, two handlers with one name) stops the build.
//
//   node site/build.mjs            assemble site/public (task dist/ folders must already be built)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every built task's folder, by number. A new task is one line here, and is served at /tasks/NN. */
export const TASK_DIRS = Object.freeze({
  "01": "tasks/01-read-contract-state",
  "02": "tasks/02-event-log-monitor",
  "03": "tasks/03-docs-mcp-onboarding",
  "04": "tasks/04-doc-search-cli",
  "05": "tasks/05-threshold-guardian",
  "08": "tasks/08-dry-run-executor",
  "09": "tasks/09-trend-watcher",
  "11": "tasks/11-policy-gatekeeper",
  "22": "tasks/22-on-chain-alert-bot",
  "23": "tasks/23-whale-watching-agent",
  "24": "tasks/24-gas-fee-optimizer",
  "27": "tasks/27-dapp-support-agent",
});

/**
 * The agent (agent/): the runtime behind Tasks 05 onward, compiled once, with one API function for all of
 * them (agent/api/agent.js, served at /api/agent?task=NN).
 */
export const AGENT_DIR = "agent";

/** Tasks whose API handlers import their compiled core from dist/ (built by `npm run build` there). */
const COMPILED = ["01", "02", "04"];

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (entry.name !== ".gitkeep") out.push(path);
  }
  return out;
}

/** Copy `from` to `to`; the same path twice is fine only with the same bytes. */
async function place(from, to, placed) {
  const bytes = await readFile(from);
  const earlier = placed.get(to);
  if (earlier) {
    if (!earlier.bytes.equals(bytes)) throw new Error(`collision: ${relative(REPO, to)} differs between ${earlier.from} and ${relative(REPO, from)}`);
    return;
  }
  placed.set(to, { from: relative(REPO, from), bytes });
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, bytes);
}

/** The API files of each task, and the root adapters that expose them. Throws on a duplicate name or a missing adapter. */
export async function apiMap() {
  const map = new Map();
  for (const [n, dir] of [...Object.entries(TASK_DIRS), ["agent", AGENT_DIR]]) {
    const api = join(REPO, dir, "api");
    if (!existsSync(api)) continue;
    for (const name of (await readdir(api)).filter((file) => file.endsWith(".js"))) {
      if (map.has(name)) throw new Error(`api collision: /api/${name.replace(/\.js$/, "")} is in both ${map.get(name).dir} and ${dir}`);
      map.set(name, { n, dir, target: `${dir}/api/${name}` });
    }
  }
  const adapters = (await readdir(join(REPO, "api"))).filter((file) => file.endsWith(".js"));
  for (const name of adapters) if (!map.has(name)) throw new Error(`api/${name} re-exports no task handler`);
  for (const [name, { target }] of map) {
    const text = await readFile(join(REPO, "api", name), "utf8").catch(() => "");
    if (!text.includes(`export { default } from "../${target}";`)) throw new Error(`api/${name} must re-export ../${target}`);
  }
  return map;
}

export async function assemble({ out = join(REPO, "site", "public") } = {}) {
  // The committed pages must be current: the shared UI in sync, the generated pages up to date.
  for (const args of [["shared/ui/sync.mjs", "--check"], ["lab/build.mjs", "--check"], ["tasks/03-docs-mcp-onboarding/build.mjs", "--check"]]) {
    execFileSync(process.execPath, [join(REPO, args[0]), ...args.slice(1)], { stdio: "inherit" });
  }
  for (const dir of [...COMPILED.map((n) => TASK_DIRS[n]), AGENT_DIR]) {
    if (!existsSync(join(REPO, dir, "dist", "src"))) throw new Error(`${dir}/dist is missing: run npm run build there first`);
  }
  const apis = await apiMap();

  await rm(out, { recursive: true, force: true });
  const placed = new Map();
  const pages = { "/": "lab/public/index.html" };
  for (const file of await files(join(REPO, "lab", "public"))) await place(file, join(out, relative(join(REPO, "lab", "public"), file)), placed);
  for (const [n, dir] of Object.entries(TASK_DIRS)) {
    const pub = join(REPO, dir, "public");
    await place(join(pub, "index.html"), join(out, "tasks", n, "index.html"), placed);
    pages[`/tasks/${n}`] = `${dir}/public/index.html`;
    for (const file of await files(join(pub, "assets"))) await place(file, join(out, "assets", relative(join(pub, "assets"), file)), placed);
    if (existsSync(join(pub, "evidence"))) {
      for (const file of await files(join(pub, "evidence"))) await place(file, join(out, "evidence", relative(join(pub, "evidence"), file)), placed);
    }
  }
  return { out, pages, assets: [...placed.keys()].filter((path) => path.includes(`${join(out, "assets")}`)).map((path) => `/${relative(out, path)}`), apis };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { out, pages, assets, apis } = await assemble();
  process.stdout.write(`Assembled ${relative(REPO, out)}: ${Object.keys(pages).join(", ")}; ${assets.length} assets; /api/${[...apis.keys()].map((name) => name.replace(/\.js$/, "")).join(", /api/")}\n`);
}
