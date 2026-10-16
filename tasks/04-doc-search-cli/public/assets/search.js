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
// stays at the bottom, and the thread scrolls. Each question is a turn: a heading band with the
// question and its outcome ("5 sources", "No answer", "Failed"), and the result under it. Asking again
// folds the earlier turns to their bands, so the thread reads as a list of questions; a tap on a band
// opens its result again. The thread keeps the last MAX_TURNS questions. How it answers is beside the
// thread with room; on a smaller screen About opens the same content in a sheet.
import { createHistory, parseCommand, REASONS } from "./command.js";
import { ICON, reducedMotion, renderTaskNav, svgIcon, wireCopy } from "./lab.js";
import { answerBlocks, docsSection, isOfficial, sourcesShown } from "./search-answer.js";
import { LAB, TASKS } from "./tasks.js";

const $ = (id) => document.getElementById(id);
const API = $("main").dataset.api;
const thread = $("thread");
const scroller = $("scroll");
const input = $("q");
const go = $("go");
const sheet = $("about-sheet");
const about = $("about-content");
const live = $("announce");
const history = createHistory();
const MAX_TURNS = 6;
const STATE = { answered: "answer", no_answer: "no-answer", error: "error" };
/**
 * What a screen reader hears when a search ends: one short line in #announce. The thread itself is not
 * a live region, so an answer or its JSON is read only when the reader goes to it.
 */
const OUTCOME = {
  answered: (result) => `Answer found, ${plural(result.sources?.length ?? 0, "source")}.`,
  no_answer: () => "No good answer found.",
  error: (result) => `Search failed. ${result.error?.message ?? ""}`.trim(),
};
let busy = false;
let turns = 0;

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
for (const suggestion of document.querySelectorAll(".suggestion")) {
  suggestion.addEventListener("click", () => {
    input.value = suggestion.dataset.q;
    submit(suggestion.dataset.q);
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
    body(turn).append(el("p", command.kind === "error" ? "turn-note turn-note-error" : "turn-note", text));
    announce(text);
    setState("note");
    return reveal(turn);
  }

  const turn = addTurn(command.question, command.json);
  const waiting = pending(turn);
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
  waiting.stop();
  // New cleared the thread while this was asked: the result has nowhere to go, and the page stays at
  // its start.
  if (!turn.isConnected) return setBusy(false);
  // If the reader is still at this question, its result is brought into view; if they went to read
  // something else meanwhile, the thread stays where they are.
  const watching = inView(turn.querySelector(".turn-toggle"));
  turn.removeAttribute("aria-busy");
  if (problem) {
    failed(turn, problem, command.question);
    setState("error");
    announce(`Search failed. ${problem}`);
  } else {
    if (command.json) {
      body(turn).append(el("pre", "json", JSON.stringify(result, null, 2)));
      outcome(turn, result);
    } else render(turn, result, command.question);
    setState(STATE[result.status] ?? "error");
    announce(OUTCOME[result.status] ? OUTCOME[result.status](result) : "Search failed.");
  }
  setBusy(false);
  if (watching) reveal(turn);
}

/**
 * The wait, said: the outcome slot reads "Searching", and the result area how long it has been. The
 * Developer Docs MCP composes its answer, which takes seconds. Returns { stop }.
 */
function pending(turn) {
  const started = Date.now();
  const line = el("p", "status");
  line.dataset.tone = "active";
  const seconds = el("span", "status-detail", "0 s");
  line.append(el("span", "status-dot pulse"), el("span", "status-word", "Asking the Developer Docs MCP"), seconds);
  line.firstChild.setAttribute("aria-hidden", "true");
  const box = el("div", "pending");
  box.append(line, el("p", "pending-note", "An answer can take 10 to 20 seconds."));
  body(turn).append(box);
  tag(turn, "Searching", "active");
  const timer = setInterval(() => (seconds.textContent = `${Math.round((Date.now() - started) / 1000)} s`), 1000);
  return {
    stop() {
      clearInterval(timer);
      box.remove();
    },
  };
}

/** Scroll the thread (not the page) so `turn` starts at its top, as far as the thread goes. */
function reveal(turn) {
  const top = scroller.scrollTop + turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
  scroller.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? "auto" : "smooth" });
}

/** Whether an element is at least partly inside the thread's visible area. */
function inView(element) {
  const box = element.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return box.bottom > view.top && box.top < view.bottom;
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

/**
 * One question in the thread, newest last: its band (the turn's heading, which folds the turn) and the
 * area its result goes in. The turns before it fold to their bands; the oldest goes when there are more
 * than MAX_TURNS.
 */
function addTurn(question, json = false) {
  for (const earlier of thread.children) fold(earlier, false);
  const id = `turn-${++turns}`;
  const turn = el("article", "turn");
  turn.setAttribute("aria-busy", "true");
  turn.setAttribute("aria-labelledby", `${id}-q`);
  const toggle = el("button", "turn-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "true");
  toggle.setAttribute("aria-controls", `${id}-body`);
  const asked = el("span", "turn-q");
  asked.id = `${id}-q`;
  asked.append(el("span", "sr", "You asked: "), document.createTextNode(question));
  if (json) asked.append(el("span", "turn-flag", " --json"));
  const chevron = el("span", "chev");
  chevron.append(svgIcon(ICON.down));
  toggle.append(asked, el("span", "turn-tag"), chevron);
  toggle.addEventListener("click", () => fold(turn, toggle.getAttribute("aria-expanded") !== "true"));
  const heading = el("h2", "turn-head");
  heading.append(toggle);
  const area = el("div", "turn-body");
  area.id = `${id}-body`;
  turn.append(heading, area);
  thread.append(turn);
  thread.hidden = false;
  $("clear").hidden = false;
  while (thread.children.length > MAX_TURNS) thread.firstElementChild.remove();
  return turn;
}

/** Open or fold a turn: its result shows, or only its band. */
function fold(turn, open) {
  turn.querySelector(".turn-toggle")?.setAttribute("aria-expanded", String(open));
  body(turn).hidden = !open;
}

const body = (turn) => turn.querySelector(".turn-body");

/** The outcome on a turn's band: "5 sources", "No answer", "Failed", "Searching". */
function tag(turn, text, tone) {
  const slot = turn.querySelector(".turn-tag");
  slot.textContent = text;
  if (tone) slot.dataset.tone = tone;
  else delete slot.dataset.tone;
}

/** A result's outcome on its band. */
function outcome(turn, result) {
  if (result.status === "answered") tag(turn, plural(Array.isArray(result.sources) ? result.sources.length : 0, "source"), "answer");
  else if (result.status === "no_answer") tag(turn, "No answer", "neutral");
  else tag(turn, "Failed", "error");
}

/** Answer and sources; or the no-answer, with nearby pages; or the error. Then the run's meta and its JSON. */
function render(turn, result, question) {
  const area = body(turn);
  if (result.status === "answered") {
    const sources = Array.isArray(result.sources) ? result.sources : [];
    area.append(answer(result.answer ?? ""));
    if (sources.length) area.append(sourceList(turn, "Sources", sources));
  } else if (result.status === "no_answer") {
    const block = el("div", "state-block");
    block.append(el("p", "state-title", "No good answer found."), el("p", "state-text", REASONS[result.reason] ?? "I couldn't verify this in the Pharos Developer Docs."));
    area.append(block);
    if (Array.isArray(result.suggestions) && result.suggestions.length) area.append(sourceList(turn, "Nearby in the docs", result.suggestions));
  } else {
    return failed(turn, result.error?.message ?? "The search failed.", question);
  }
  outcome(turn, result);
  area.append(metaLine(turn, result));
}

function failed(turn, message, question) {
  const block = el("div", "state-block");
  block.dataset.tone = "error";
  block.append(el("p", "state-title", "Search failed."), el("p", "state-text", message), retry("Try again", question));
  body(turn).append(block);
  tag(turn, "Failed", "error");
}

/** A button that puts the question back in the box, and the caret with it. */
function retry(words, question) {
  const button = el("button", "action retry", words);
  button.type = "button";
  button.addEventListener("click", () => {
    input.value = question;
    input.focus();
  });
  return button;
}

/**
 * The answer text as the docs gave it, set by its structure (search-answer.js): paragraphs, items,
 * numbered steps with any code that belongs to them, and code blocks with a Copy button. The gate
 * shortens a long answer and marks it with "…"; then the page says so.
 */
function answer(text) {
  const root = el("div", "answer");
  for (const block of answerBlocks(text)) {
    if (block.kind === "p") root.append(el("p", "", block.text));
    else if (block.kind === "list") {
      const list = el("ul", "answer-list");
      for (const item of block.items) list.append(el("li", "", item));
      root.append(list);
    } else if (block.kind === "steps") {
      const steps = el("ol", "answer-steps");
      for (const item of block.items) {
        const step = el("li", "answer-step");
        const content = el("div", "answer-step-body");
        content.append(el("p", "", item.text));
        for (const code of item.code) content.append(codeBlock(code));
        step.append(el("span", "answer-step-n", `${item.n}.`), content);
        steps.append(step);
      }
      root.append(steps);
    } else root.append(codeBlock(block.text));
  }
  if (String(text).trimEnd().endsWith("…")) root.append(el("p", "answer-cut", "Answer shortened. Read on in the sources below."));
  return root;
}

/** Two sheets (copy), and a tick once copied. */
const COPY_ICON = "M5.75 5.75h6.5v6.5h-6.5zM3.75 10.25v-6.5h6.5";
const COPIED_ICON = "M3.5 8.5l3 3 6-7";

/**
 * Code as written, with a Copy button in its corner (or, where the clipboard is not allowed, the code
 * selected for copying). "Code copied" is said in #announce.
 */
function codeBlock(text) {
  const wrap = el("div", "code-block");
  const pre = el("pre", "answer-code");
  pre.append(el("code", "", text));
  const copy = el("button", "action copy code-copy");
  copy.type = "button";
  copy.dataset.copy = "idle";
  copy.title = "Copy code";
  copy.setAttribute("aria-label", "Copy code");
  const icons = el("span", "swap");
  icons.append(svgIcon(COPY_ICON), svgIcon(COPIED_ICON));
  copy.append(icons);
  wireCopy(copy, { value: () => text, shown: () => pre, live, what: "Code" });
  wrap.append(pre, copy);
  return wrap;
}

/**
 * Sources (or nearby pages): a count, then numbered rows, title and where the page sits in the docs,
 * the full address on the link. The first three are listed; when two or more wait, "Show N more" lists
 * them in place, and moves to the first of them. Every source stays in the list and in the JSON.
 */
function sourceList(turn, label, sources) {
  const section = el("section", "src");
  section.setAttribute("aria-label", label);
  const official = sources.every((source) => isOfficial(source?.url));
  const head = el("p", "src-head");
  head.append(el("span", "label", label), el("span", "src-count", `${plural(sources.length, "page")}${official ? " · docs.pharos.xyz" : ""}`));
  const list = el("ol", "src-list");
  list.id = `${body(turn).id}-${label === "Sources" ? "sources" : "nearby"}`;
  const shown = sourcesShown(sources.length);
  sources.forEach((source, index) => {
    const item = el("li");
    item.append(sourceRow(source, index + 1));
    item.hidden = index >= shown;
    list.append(item);
  });
  section.append(head, list);
  const waiting = sources.length - shown;
  if (waiting > 0) {
    const more = el("button", "src-more");
    more.type = "button";
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-controls", list.id);
    const words = el("span", "", `Show ${waiting} more`);
    more.append(words, svgIcon(ICON.down));
    more.addEventListener("click", () => {
      const open = more.getAttribute("aria-expanded") !== "true";
      more.setAttribute("aria-expanded", String(open));
      words.textContent = open ? "Show fewer" : `Show ${waiting} more`;
      [...list.children].forEach((item, index) => (item.hidden = !open && index >= shown));
      if (open) list.children[shown]?.querySelector("a, .src-row")?.focus();
    });
    section.append(more);
  }
  return section;
}

/** One source: its number, title and docs section; a link only for an https docs.pharos.xyz page. */
function sourceRow(source, n) {
  const url = String(source?.url ?? "");
  const official = isOfficial(url);
  const row = el(official ? "a" : "span", official ? "src-row" : "src-row src-text");
  if (official) {
    row.href = url;
    row.target = "_blank";
    row.rel = "noopener noreferrer";
    row.title = url;
  }
  const number = el("span", "src-n", String(n));
  number.setAttribute("aria-hidden", "true");
  const main = el("span", "src-main");
  main.append(el("span", "src-title", String(source?.title ?? "")), el("span", "src-where", official ? docsSection(url) || "docs.pharos.xyz" : url));
  row.append(number, main);
  if (official) row.append(svgIcon(ICON.out, "src-arrow"), el("span", "sr", ", opens in a new tab"));
  return row;
}

/** "Developer Docs MCP (askQuestion) · 2 requests · 11.4 s", and the result as JSON behind a toggle. */
function metaLine(turn, result) {
  const line = el("div", "turn-meta");
  const meta = result.meta;
  if (meta) {
    // Each part stays whole when the line wraps.
    const parts = [meta.transport === "docs-mcp" ? "Developer Docs MCP (askQuestion)" : `${plural(meta.pagesConsulted?.length ?? 0, "docs page")} asked`, plural(meta.requests, "request"), `${(meta.elapsedMs / 1000).toFixed(1)} s`];
    const run = el("span", "turn-run");
    parts.forEach((part, index) => run.append(...(index ? [" · "] : []), el("span", "", part)));
    line.append(run);
  }
  const toggle = el("button", "btn-quiet json-toggle", "JSON");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", `${body(turn).id}-json`);
  let pre = null;
  toggle.addEventListener("click", () => {
    // Built on first open, so a closed toggle costs no DOM.
    if (!pre) {
      pre = el("pre", "json", JSON.stringify(result, null, 2));
      pre.id = `${body(turn).id}-json`;
      line.after(pre);
    }
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    pre.hidden = !open;
  });
  line.append(toggle);
  return line;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function setBusy(value) {
  busy = value;
  go.setAttribute("aria-disabled", String(value));
}

function setState(state) {
  document.body.dataset.state = state;
}

function announce(text) {
  live.textContent = text;
}
