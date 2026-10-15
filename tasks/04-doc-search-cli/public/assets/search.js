// Task 04 page: docs search, on the same search as the pharos-docs CLI.
//
// Every question goes to this site's GET /api/search, which runs the CLI's own search() and provider
// against docs.pharos.xyz and returns the same result (schema pharos-docs-result/1). Nothing here
// answers on its own: the page only lays that result out. Every value is written as text, never HTML.
//
// States, on <body data-state>: idle (nothing asked yet), searching, answer, no-answer, error.
// The thread keeps the last MAX_TURNS questions; older ones are removed, so the page stays bounded.
import { createHistory, parseCommand, REASONS } from "./command.js";
import { renderTaskNav, wireToggle } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

const $ = (id) => document.getElementById(id);
const API = $("main").dataset.api;
const thread = $("thread");
const input = $("q");
const go = $("go");
const history = createHistory();
const MAX_TURNS = 6;
const STATE = { answered: "answer", no_answer: "no-answer", error: "error" };
let busy = false;

renderTaskNav(TASKS, "04", LAB);
wireToggle($("cli-toggle"));

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  submit(input.value);
});
input.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  const line = event.key === "ArrowUp" ? history.up() : history.down();
  if (line === null) return;
  event.preventDefault();
  input.value = line;
});
for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    input.value = chip.dataset.q;
    submit(chip.dataset.q);
  });
}

async function submit(line) {
  if (busy) return;
  const command = parseCommand(line);
  if (command.kind === "empty") return;
  history.push(line.trim());
  input.value = "";
  if (command.kind === "clear") {
    thread.replaceChildren();
    thread.hidden = true;
    return setState("idle");
  }
  if (command.kind === "help") {
    if ($("cli-toggle").getAttribute("aria-expanded") !== "true") $("cli-toggle").click();
    return $("cli-toggle").focus();
  }
  if (command.kind === "version" || command.kind === "history" || command.kind === "error") {
    const items = history.list();
    const text = command.kind === "version" ? "pharos-docs 1.0.0" : command.kind === "history" ? (items.length ? items.join("\n") : "No questions yet.") : command.message;
    const turn = addTurn(line.trim());
    turn.removeAttribute("aria-busy");
    turn.append(el("p", command.kind === "error" ? "turn-note turn-note-error" : "turn-note", text));
    return;
  }

  const turn = addTurn(command.question, command.json);
  const pending = turn.appendChild(el("p", "status"));
  pending.dataset.tone = "active";
  pending.append(el("span", "status-dot"), el("span", "status-word", "Searching"), el("span", "status-detail", "docs.pharos.xyz"));
  pending.firstChild.setAttribute("aria-hidden", "true");
  setBusy(true);
  setState("searching");

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
  turn.removeAttribute("aria-busy");
  if (problem) {
    failed(turn, problem, command.question);
    setState("error");
  } else {
    if (command.json) turn.append(el("pre", "json", JSON.stringify(result, null, 2)));
    else render(turn, result, command.question);
    setState(STATE[result.status] ?? "error");
  }
  setBusy(false);
  turn.scrollIntoView({ block: "nearest" });
}

/** One question in the thread, newest last; the oldest goes when there are more than MAX_TURNS. */
function addTurn(question, json = false) {
  const turn = el("article", "turn");
  turn.setAttribute("aria-busy", "true");
  const asked = el("p", "turn-q");
  asked.append(el("span", "sr", "You asked: "), document.createTextNode(question));
  if (json) asked.append(el("span", "turn-flag", "--json"));
  turn.append(asked);
  thread.append(turn);
  thread.hidden = false;
  while (thread.children.length > MAX_TURNS) thread.firstElementChild.remove();
  return turn;
}

/** Answer and sources; or the no-answer, with nearby pages; or the error. Then the run's meta and its JSON. */
function render(turn, result, question) {
  if (result.status === "answered") {
    turn.append(answer(result.answer ?? ""));
    if (Array.isArray(result.sources) && result.sources.length) turn.append(el("h3", "label turn-label", "Sources"), sourceRows(result.sources));
  } else if (result.status === "no_answer") {
    const block = el("div", "state-block");
    block.append(el("p", "state-title", "No good answer found."), el("p", "state-text", "I couldn't verify this in the Pharos Developer Docs."));
    if (result.reason && REASONS[result.reason]) block.append(el("p", "state-reason", REASONS[result.reason]));
    block.append(retry("Try another question", ""));
    turn.append(block);
    if (Array.isArray(result.suggestions) && result.suggestions.length) turn.append(el("h3", "label turn-label", "Nearby documented pages"), sourceRows(result.suggestions));
  } else {
    return failed(turn, result.error?.message ?? "The search failed.", question);
  }
  turn.append(metaLine(result));
}

function failed(turn, message, question) {
  const block = el("div", "state-block");
  block.dataset.tone = "error";
  block.append(el("p", "state-title", "Search failed."), el("p", "state-text", message), retry("Try again", question));
  turn.append(block);
}

/** A button that puts a question back in the box (empty for "another"), and the caret with it. */
function retry(words, question) {
  const button = el("button", "btn retry", words);
  button.type = "button";
  button.addEventListener("click", () => {
    input.value = question;
    input.focus();
  });
  return button;
}

/**
 * The answer text as the docs gave it: blocks split at blank lines, "- " lines as a list, and the
 * "Page title:" line that opens each page's part of a several-page answer as a small heading.
 */
function answer(text) {
  const root = el("div", "answer");
  for (const block of String(text).split(/\n{2,}/)) {
    const lines = block.split("\n");
    let start = 0;
    if (lines.length > 1 && /^[^\s-][^:]{0,80}:$/.test(lines[0])) {
      root.append(el("p", "answer-from", lines[0].slice(0, -1)));
      start = 1;
    }
    let list = null;
    for (const line of lines.slice(start)) {
      if (/^- /.test(line)) {
        list ??= root.appendChild(el("ul"));
        list.append(el("li", "", line.slice(2)));
      } else if (line.trim()) {
        list = null;
        root.append(el("p", "", line));
      }
    }
  }
  return root;
}

/** Source rows: title, then the page's address. Only https docs.pharos.xyz pages become links. */
function sourceRows(sources) {
  const list = el("ul", "sources");
  for (const source of sources) {
    const official = isOfficial(source?.url);
    const row = el(official ? "a" : "span", official ? "" : "source-text");
    if (official) {
      row.href = source.url;
      row.target = "_blank";
      row.rel = "noopener noreferrer";
    }
    const where = official ? new URL(source.url) : null;
    row.append(el("span", "source-title", String(source?.title ?? "")), el("span", "source-meta", where ? `${where.host}${where.pathname}` : String(source?.url ?? "")));
    if (official) {
      row.append(arrow(), el("span", "sr", ", opens in a new tab"));
    }
    const item = el("li");
    item.append(row);
    list.append(item);
  }
  return list;
}

function arrow() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "source-arrow");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  for (const [name, value] of Object.entries({ d: "M5 11l6-6M6 5h5v5", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" })) path.setAttribute(name, value);
  svg.append(path);
  return svg;
}

/** "2 pages asked · 3 requests · 1.2 s", and the result as JSON behind a toggle. */
function metaLine(result) {
  const line = el("div", "turn-meta");
  const meta = result.meta;
  if (meta) {
    const pages = meta.pagesConsulted?.length ?? 0;
    line.append(el("span", "", `${pages} docs ${pages === 1 ? "page" : "pages"} asked · ${meta.requests} ${meta.requests === 1 ? "request" : "requests"} · ${(meta.elapsedMs / 1000).toFixed(1)} s`));
  }
  const toggle = el("button", "btn-quiet json-toggle", "JSON");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  let pre = null;
  toggle.addEventListener("click", () => {
    // Built on first open, so a closed toggle costs no DOM.
    if (!pre) {
      pre = el("pre", "json", JSON.stringify(result, null, 2));
      line.after(pre);
    }
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    pre.hidden = !open;
  });
  line.append(toggle);
  return line;
}

function isOfficial(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "docs.pharos.xyz" && !parsed.port && !parsed.username;
  } catch {
    return false;
  }
}

function setBusy(value) {
  busy = value;
  go.setAttribute("aria-disabled", String(value));
}

function setState(state) {
  document.body.dataset.state = state;
}
