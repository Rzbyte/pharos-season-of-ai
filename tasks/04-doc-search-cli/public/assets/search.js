// Task 04 page: docs search, on the same search as the pharos-docs CLI.
//
// Every question goes to this site's GET /api/search, which runs the CLI's own search() and canonical
// provider, the Pharos Developer Docs MCP (askQuestion), and returns the same result (schema
// pharos-docs-result/1). Nothing here answers on its own: the page only lays that result out. Every
// value is written as text, never HTML.
//
// States, on <body data-state>: idle (nothing asked yet), searching, answer, no-answer, error, and
// note (a version, history or option message).
//
// The page is a workspace (body.app in lab.css): it is exactly the screen's height, the question box
// stays at the bottom, and only the thread scrolls. The thread keeps the last MAX_TURNS questions;
// older ones are removed, so it stays bounded. A new question is brought to the top of the thread, so
// its answer is read from its first line. New clears the thread. How it answers is beside the thread
// with room; on a smaller screen About opens the same content in a sheet.
import { createHistory, parseCommand, REASONS } from "./command.js";
import { ICON, reducedMotion, renderTaskNav, svgIcon } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

const $ = (id) => document.getElementById(id);
const API = $("main").dataset.api;
const thread = $("thread");
const scroller = $("scroll");
const input = $("q");
const go = $("go");
const sheet = $("about-sheet");
const about = $("about-content");
const history = createHistory();
const MAX_TURNS = 6;
const STATE = { answered: "answer", no_answer: "no-answer", error: "error" };
/**
 * What a screen reader hears when a search ends: one short line in #announce. The thread itself is not
 * a live region, so an answer or its JSON is read only when the reader goes to it.
 */
const OUTCOME = {
  answered: (result) => `Answer found, ${result.sources?.length ?? 0} ${result.sources?.length === 1 ? "source" : "sources"}.`,
  no_answer: () => "No good answer found.",
  error: (result) => `Search failed. ${result.error?.message ?? ""}`.trim(),
};
let busy = false;

renderTaskNav(TASKS, "04", LAB);
// The lab's links: the footer is not shown on this page, so About carries a copy of its line.
const foot = document.querySelector(".foot .foot-inner");
if (foot) about.append(Object.assign(foot.cloneNode(true), { className: "about-foot" }));
$("about-open").addEventListener("click", () => openAbout());
$("about-close").addEventListener("click", () => sheet.close());
// A tap on the backdrop (the dialog itself, outside its content) closes the sheet.
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) sheet.close();
});
// Back beside the thread when the sheet closes, so there is only ever one copy of About. The dialog
// itself returns focus to where it was before it opened. A screen that gains the room for About beside
// the thread closes the sheet.
sheet.addEventListener("close", () => $("about").append(about));
matchMedia("(min-width: 1000px)").addEventListener("change", (event) => {
  if (event.matches && sheet.open) sheet.close();
});
$("clear").addEventListener("click", () => {
  clear();
  input.focus();
});

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
  if (command.kind === "clear") return clear();
  if (command.kind === "help") {
    $("cli").open = true;
    openAbout();
    return $("cli").querySelector("summary").focus();
  }
  if (command.kind === "version" || command.kind === "history" || command.kind === "error") {
    // The history before this command, not the command itself.
    const items = history.list().slice(0, -1);
    const text = command.kind === "version" ? "pharos-docs 1.0.0" : command.kind === "history" ? (items.length ? items.join("\n") : "No questions yet.") : command.message;
    const turn = addTurn(line.trim());
    turn.removeAttribute("aria-busy");
    turn.append(el("p", command.kind === "error" ? "turn-note turn-note-error" : "turn-note", text));
    announce(text);
    setState("note");
    return reveal(turn);
  }

  const turn = addTurn(command.question, command.json);
  const pending = turn.appendChild(el("p", "status"));
  pending.dataset.tone = "active";
  pending.append(el("span", "status-dot"), el("span", "status-word", "Searching"), el("span", "status-detail", "docs.pharos.xyz"));
  pending.firstChild.setAttribute("aria-hidden", "true");
  setBusy(true);
  setState("searching");
  reveal(turn);
  // On a touch screen the keyboard goes, so the answer has the screen; Ask again brings it back.
  if (matchMedia("(pointer: coarse)").matches) input.blur();

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
    announce(`Search failed. ${problem}`);
  } else {
    if (command.json) turn.append(el("pre", "json", JSON.stringify(result, null, 2)));
    else render(turn, result, command.question);
    setState(STATE[result.status] ?? "error");
    announce(OUTCOME[result.status] ? OUTCOME[result.status](result) : "Search failed.");
  }
  setBusy(false);
  // The answer is read from the question down: bring the question back if it has left the view.
  if (turn.getBoundingClientRect().top < scroller.getBoundingClientRect().top) reveal(turn);
}

/** Scroll the thread (not the page) so `turn` starts at the top of it. */
function reveal(turn) {
  const top = scroller.scrollTop + turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
  scroller.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? "auto" : "smooth" });
}

/** Empty the thread: back to the start, with the examples. */
function clear() {
  thread.replaceChildren();
  thread.hidden = true;
  $("clear").hidden = true;
  scroller.scrollTop = 0;
  setState("idle");
}

/** About in the sheet, on a screen without room for it beside the thread. */
function openAbout() {
  if (getComputedStyle($("about")).display !== "none") return;
  $("sheet-body").append(about);
  if (!sheet.open) sheet.showModal();
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
  $("clear").hidden = false;
  while (thread.children.length > MAX_TURNS) thread.firstElementChild.remove();
  return turn;
}

/** Answer and sources; or the no-answer, with nearby pages; or the error. Then the run's meta and its JSON. */
function render(turn, result, question) {
  if (result.status === "answered") {
    const titles = new Set((Array.isArray(result.sources) ? result.sources : []).map((source) => String(source?.title ?? "")));
    turn.append(answer(result.answer ?? "", titles));
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
 * The answer text as the docs gave it: blocks split at blank lines, "- " lines as a list, other lines
 * kept with their line breaks (so code stays line by line). Only a several-page answer has headings:
 * its parts open with "<page title>:", where the title is one of the answer's own sources.
 */
function answer(text, titles) {
  const root = el("div", "answer");
  for (const block of String(text).split(/\n{2,}/)) {
    const lines = block.split("\n");
    let start = 0;
    if (titles.size > 1 && lines.length > 1 && lines[0].endsWith(":") && titles.has(lines[0].slice(0, -1))) {
      root.append(el("p", "answer-from", lines[0].slice(0, -1)));
      start = 1;
    }
    let list = null;
    let prose = [];
    const flush = () => {
      if (prose.length) root.append(el("p", "answer-text", prose.join("\n")));
      prose = [];
    };
    for (const line of lines.slice(start)) {
      if (/^- /.test(line)) {
        flush();
        list ??= root.appendChild(el("ul"));
        list.append(el("li", "", line.slice(2)));
      } else if (line.trim()) {
        list = null;
        prose.push(line);
      }
    }
    flush();
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
    if (official) row.append(svgIcon(ICON.out, "source-arrow"), el("span", "sr", ", opens in a new tab"));
    const item = el("li");
    item.append(row);
    list.append(item);
  }
  return list;
}

/** "2 pages asked · 3 requests · 1.2 s", and the result as JSON behind a toggle. */
function metaLine(result) {
  const line = el("div", "turn-meta");
  const meta = result.meta;
  if (meta) {
    const requests = `${meta.requests} ${meta.requests === 1 ? "request" : "requests"}`;
    const seconds = `${(meta.elapsedMs / 1000).toFixed(1)} s`;
    if (meta.transport === "docs-mcp") line.append(el("span", "", `Developer Docs MCP (askQuestion) · ${requests} · ${seconds}`));
    else {
      const pages = meta.pagesConsulted?.length ?? 0;
      line.append(el("span", "", `${pages} docs ${pages === 1 ? "page" : "pages"} asked · ${requests} · ${seconds}`));
    }
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

function announce(text) {
  $("announce").textContent = text;
}
