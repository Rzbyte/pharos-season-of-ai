// Task 04 page: the browser terminal for pharos-docs.
//
// Every question goes to this site's GET /api/search, which runs the same search code as the CLI
// against docs.pharos.xyz, and comes back as the same result (schema pharos-docs-result/1). Nothing
// here answers on its own. Every value is written as text (textContent), never as HTML.
import { createHistory, echo, parseCommand, REASONS } from "./command.js";

const $ = (id) => document.getElementById(id);
const API = $("main").dataset.api;
const log = $("log");
const input = $("cmd");
const run = $("run");
const terminal = $("terminal");
const history = createHistory();
/** Entries kept in the log; older ones are removed so the page stays a fixed size. */
const MAX_ENTRIES = 20;
let busy = false;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

$("prompt").addEventListener("submit", (event) => {
  event.preventDefault();
  submit(input.value);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const line = event.key === "ArrowUp" ? history.up() : history.down();
    if (line !== null) {
      event.preventDefault();
      input.value = line;
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
    }
  } else if (event.key === "Escape") {
    input.value = "";
  } else if (event.key === "l" && event.ctrlKey) {
    event.preventDefault();
    clear();
  }
});
for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    input.value = chip.dataset.q;
    submit(chip.dataset.q);
    input.focus();
  });
}
// Tapping the log puts the caret back in the command line, unless the reader is selecting text or following a link.
log.addEventListener("click", (event) => {
  if (!event.target.closest("a") && !getSelection()?.toString()) input.focus({ preventScroll: true });
});

async function submit(line) {
  if (busy) return;
  const command = parseCommand(line);
  if (command.kind === "empty") return;
  history.push(line.trim());
  input.value = "";
  if (command.kind === "clear") return clear();

  const entry = add(command.kind === "ask" ? echo(command) : line.trim());
  if (command.kind === "help") return entry.append(helpBlock());
  if (command.kind === "version") return entry.append(el("p", "out-note", "pharos-docs 1.0.0"));
  if (command.kind === "history") {
    const items = history.list();
    return entry.append(el("p", "out-note", items.length ? items.map((item, i) => `${String(i + 1).padStart(2, " ")}  ${item}`).join("\n") : "No history yet."));
  }
  if (command.kind === "error") return entry.append(el("p", "out-error", `Error: ${command.message}`));

  setBusy(true);
  const pending = entry.appendChild(el("p", "out-pending", "Asking docs.pharos.xyz…"));
  let result = null;
  let problem = null;
  try {
    const response = await fetch(`${API}?q=${encodeURIComponent(command.question)}`, { headers: { accept: "application/json" } });
    result = await response.json().catch(() => null);
    if (!result || typeof result !== "object") problem = `The search endpoint answered HTTP ${response.status} without a result.`;
  } catch {
    problem = "Could not reach the search endpoint. Check your connection and try again.";
  }
  pending.remove();
  if (problem) entry.append(el("p", "out-error", `Error: ${problem}`));
  else if (command.json) entry.append(el("pre", "out-json", JSON.stringify(result, null, 2)));
  else render(entry, result);
  setBusy(false);
  entry.scrollIntoView({ block: "nearest" });
}

/** The same layout as the CLI's text output: Answer and Sources, or the no-answer message. */
function render(entry, result) {
  if (result.status === "answered") {
    entry.append(el("h3", "out-h", "Answer"), el("p", "out-answer", result.answer ?? ""), el("h3", "out-h", "Sources"), sourceList(result.sources));
  } else if (result.status === "no_answer") {
    entry.append(el("p", "out-none", "No good answer found in the Pharos Developer Docs."));
    if (result.reason && REASONS[result.reason]) entry.append(el("p", "out-note", REASONS[result.reason]));
    if (Array.isArray(result.suggestions) && result.suggestions.length > 0) entry.append(el("h3", "out-h", "Nearby documented topics"), sourceList(result.suggestions));
    entry.append(el("p", "out-note", "Try rephrasing the question, or open one of the pages above."));
  } else {
    entry.append(el("p", "out-error", `Error: ${result.error?.message ?? "the search failed."}`));
  }
  const meta = result.meta;
  if (meta) {
    const pages = meta.pagesConsulted?.length ?? 0;
    entry.append(el("p", "out-meta", `${pages} docs ${pages === 1 ? "page" : "pages"} asked · ${meta.requests} HTTPS ${meta.requests === 1 ? "request" : "requests"} to docs.pharos.xyz · ${(meta.elapsedMs / 1000).toFixed(1)} s`));
  }
}

/** Numbered source links. Only https docs.pharos.xyz URLs become links; anything else stays text. */
function sourceList(sources) {
  const list = el("ol", "sources");
  (Array.isArray(sources) ? sources : []).forEach((source, index) => {
    const item = el("li");
    item.append(el("span", "n", String(index + 1).padStart(2, "0")));
    const official = isOfficial(source?.url);
    const link = el(official ? "a" : "span");
    if (official) {
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    link.append(el("span", "t", String(source?.title ?? "")), el("span", "u", String(source?.url ?? "")));
    if (official) link.append(el("span", "sr", ", opens in a new tab"));
    item.append(link);
    list.append(item);
  });
  return list;
}

function isOfficial(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "docs.pharos.xyz" && !parsed.port && !parsed.username;
  } catch {
    return false;
  }
}

function helpBlock() {
  const rows = [
    ['pharos-docs "question"', "Ask the Pharos Developer Docs. The command name and quotes are optional."],
    ['pharos-docs "question" --json', "The same result as JSON (schema pharos-docs-result/1)."],
    ["help", "These commands."],
    ["clear", "Empty the terminal (Ctrl+L)."],
    ["history", "Commands you ran here; ↑ and ↓ recall them."],
  ];
  const dl = el("dl", "help");
  for (const [term, text] of rows) {
    const row = el("div");
    row.append(el("dt", "", term), el("dd", "", text));
    dl.append(row);
  }
  return dl;
}

function add(commandLine) {
  const entry = el("div", "entry arrive");
  const cmd = el("p", "cmd");
  cmd.append(el("span", "ps", "$ "), document.createTextNode(commandLine));
  entry.append(cmd);
  log.append(entry);
  while (log.children.length > MAX_ENTRIES) log.firstElementChild.remove();
  return entry;
}

function clear() {
  log.replaceChildren();
}

function setBusy(value) {
  busy = value;
  run.disabled = value;
  terminal.setAttribute("aria-busy", String(value));
  $("term-state").textContent = value ? "Asking docs.pharos.xyz" : "Ready";
}
