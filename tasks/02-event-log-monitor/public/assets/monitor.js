// Task 02 page: a monitor of Circle USDC Transfer events on Pharos Mainnet.
//
// The browser only ever calls this site's own GET /api/events, which reads Pharos server-side
// through Chain MCP. Every few seconds it asks for the current window, keeps the last checked block
// and the keys of the events it has shown (feed.js), and adds only events it has not shown before.
// Every value is written as text.
//
// States, on <body data-state>: "starting" (first check), "monitoring", "paused" (Stop, or the tab is
// in the background) and "error" (the last check failed; the next one is already scheduled).
//
// What is shown, and how much of it:
// - "Latest events": events found after monitoring started, five per page, newest page first
//   (← Newer · 1 / N · Older →). The full session (up to feed.js's FEED_LIMIT) stays in memory; only
//   one page of five is in the DOM, so the page never grows. On page 1, new events appear at the top.
//   On an older page the reader's place is kept: new events are counted in a "3 new events" notice
//   with View latest, and the pages are counted without them until then.
// - "New": the events added by the most recent successful check. The next successful check
//   replaces that set, even when it adds nothing, so "New" always means "found by the last check".
//   The newest event also carries "Latest" and how long ago it was found.
// - "Initial history": events already in the first window. Collapsed and not rendered until opened;
//   then five per page, with its own pager.
import { applyWindow, createFeed, shortHex } from "./feed.js";
import { clockTime, groupDigits, linkExplorer, pageOf, reducedMotion, renderTaskNav, setText, settle } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

const $ = (id) => document.getElementById(id);
const main = $("main");
const panel = $("monitor");
const API = main.dataset.api;
const INTERVAL_MS = Number(main.dataset.interval) * 1000;
const EVERY = `${Number(main.dataset.interval)} s`;
/** Events per page, in both lists. */
const PAGE_SIZE = 5;
const STATUS = {
  starting: ["Starting", "active"],
  monitoring: ["Monitoring", "active"],
  paused: ["Paused", "neutral"],
  error: ["Check failed", "error"],
};

const feed = createFeed();
/** Stopped with the button; only Start resumes. A hidden tab pauses without this. */
let stopped = false;
let running = false;
let first = true;
let timer;
let inFlight;
/** When the last successful check finished, when monitoring started, and the first window's size. */
let checkedAt = null;
let startedAt = null;
let initialBlocks = null;
/** Keys added by the most recent successful check: the only events marked New. */
let latestBatch = new Set();
/**
 * The reader's place. `page` counts from the newest page (1). `pending` is how many session events
 * arrived while the reader was on an older page: they are left out of the page count until View
 * latest (or going back to page 1), so the page on screen never shifts under the reader.
 */
const view = { page: 1, pending: 0, initialOpen: false, initialPage: 1 };

renderTaskNav(TASKS, main.dataset.task, LAB);
const CONTRACT = $("address").textContent.trim();
setText($("address"), shortHex(CONTRACT));
linkExplorer($("contract-explorer"), "address", CONTRACT, "Circle USDC contract");

$("toggle").addEventListener("click", () => {
  if (stopped) {
    stopped = false;
    start();
  } else {
    stopped = true;
    pause("checks stopped");
  }
});
$("session-newer").addEventListener("click", () => turn("session", -1));
$("session-older").addEventListener("click", () => turn("session", 1));
$("session-latest").addEventListener("click", () => {
  view.pending = 0;
  view.page = 1;
  renderLists();
  $("session-h").focus();
});
$("initial-toggle").addEventListener("click", () => {
  view.initialOpen = !view.initialOpen;
  view.initialPage = 1;
  renderLists();
});
$("initial-newer").addEventListener("click", () => turn("initial", -1));
$("initial-older").addEventListener("click", () => turn("initial", 1));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (running) pause("tab hidden, resumes when you return");
  } else if (!stopped) {
    start();
  }
});
setInterval(tick, 1000);
start();

function start() {
  if (running || document.hidden) return;
  running = true;
  setControls();
  report(feed.lastChecked === null ? "starting" : "monitoring", feed.lastChecked === null ? "first check" : `checks every ${EVERY}`);
  check();
}

function pause(reason) {
  running = false;
  clearTimeout(timer);
  inFlight?.abort();
  setControls();
  report("paused", reason);
}

/** One check; the next is scheduled only after this one is done, so checks never overlap. */
async function check() {
  if (!running) return;
  const controller = new AbortController();
  inFlight = controller;
  panel.setAttribute("aria-busy", "true");
  let data = null;
  let problem = null;
  try {
    // no-store: the browser must not answer from its own cache; the edge shares answers between viewers.
    const response = await fetch(API, { headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal });
    data = await response.json().catch(() => null);
    if (data?.ok !== true) {
      problem = data?.error ? [data.error.message, data.error.hint].filter(Boolean).join(" ") : `The events endpoint answered HTTP ${response.status}.`;
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    problem = "Could not reach the events endpoint.";
  } finally {
    if (inFlight === controller) inFlight = undefined;
    panel.removeAttribute("aria-busy");
  }
  if (!running) return;

  if (problem) {
    report("error", `retrying in ${EVERY}`, `${problem} The last checked block is kept, so nothing is skipped.`);
  } else {
    try {
      const change = applyWindow(feed, data, { first });
      // The feed has taken this window, so later events are session events even if drawing fails.
      first = false;
      render(data, change);
      report("monitoring", `checks every ${EVERY}`);
    } catch {
      report("error", `retrying in ${EVERY}`, "The events endpoint sent an answer this page could not read.");
    }
  }
  timer = setTimeout(check, INTERVAL_MS);
}

function render(data, change) {
  if (change.stale) return;
  const now = Date.now();
  checkedAt = now;
  if (startedAt === null) {
    startedAt = now;
    initialBlocks = BigInt(data.toBlock) - BigInt(data.fromBlock) + 1n;
  }
  const block = $("last-block");
  setText(block, groupDigits(feed.lastChecked));
  settle(block);

  const gap = $("gap-note");
  gap.hidden = !change.gap;
  if (change.gap) gap.textContent = `Blocks ${groupDigits(change.gap.from)}–${groupDigits(change.gap.to)} were not checked while the monitor was paused.`;

  // "New" is what this check found; the previous check's events lose it now.
  const fresh = change.added.filter((item) => item.fresh);
  latestBatch = new Set(fresh.map((item) => item.key));
  // When it was found, kept on the item itself, so it goes when feed.js lets the item go.
  for (const item of fresh) item.foundAt = now;
  // On an older page the reader stays put; the new events wait behind View latest.
  if (view.page > 1 || view.pending > 0) view.pending += fresh.length;

  // Proof details: the exact get_logs arguments of this answer.
  const args = data.getLogs;
  if (args) {
    setText($("t-address"), args.address);
    setText($("t-topics"), `[${args.topics.join(", ")}]`);
    setText($("t-from"), `${args.fromBlock} (${groupDigits(data.fromBlock)})`);
    setText($("t-to"), `${args.toBlock} (${groupDigits(data.toBlock)})`);
    setText($("proof-blocks"), groupDigits(String(BigInt(data.toBlock) - BigInt(data.fromBlock) + 1n)));
  }
  if (data.server) setText($("t-server"), data.server);
  setText($("proof-calls"), String(data.toolCalls?.total ?? "—"));
  setText($("proof-dups"), groupDigits(String(feed.duplicates)));

  renderLists();
  tick();
  if (fresh.length > 0) {
    setText($("feed-live"), fresh.length === 1 ? `New ${fresh[0].type}: ${fresh[0].summary}` : `${fresh.length} new Transfer events`);
  }
}

/** One step through a list's pages (-1 newer, +1 older). Page 1 of the session is always the latest. */
function turn(list, step) {
  const button = $(`${list}-${step < 0 ? "newer" : "older"}`);
  if (button.getAttribute("aria-disabled") === "true") return;
  if (list === "session") {
    view.page += step;
    if (view.page <= 1) {
      view.page = 1;
      view.pending = 0;
    }
  } else {
    view.initialPage += step;
  }
  renderLists();
}

/**
 * A list's pager: hidden with one page, ends marked unavailable (still focusable). The position is a
 * live region, so it is written only when it changes: a check that changes nothing says nothing.
 */
function renderPager(list, { page, pages }) {
  const pager = $(`${list}-pager`);
  if (pages <= 1) keepFocus(pager, $(list === "session" ? "session-h" : "initial-toggle"));
  pager.hidden = pages <= 1;
  $(`${list}-newer`).setAttribute("aria-disabled", String(page <= 1));
  $(`${list}-older`).setAttribute("aria-disabled", String(page >= pages));
  const position = $(`${list}-pos`);
  if (position.dataset.at === `${page}/${pages}`) return;
  position.dataset.at = `${page}/${pages}`;
  position.replaceChildren(Object.assign(document.createElement("span"), { className: "sr", textContent: "Page " }), `${page} / ${pages}`);
}

/** Before `region` is hidden, move focus out of it to `fallback`, so a keyboard reader never loses it. */
function keepFocus(region, fallback) {
  if (region.contains(document.activeElement)) fallback.focus();
}

/** Render one page of each list, reusing the nodes already on screen. */
function renderLists() {
  const session = feed.items.filter((item) => item.fresh);
  const initial = feed.items.filter((item) => !item.fresh);
  const sessionTotal = feed.newSinceStart;
  const initialTotal = feed.shown - feed.newSinceStart;

  // Latest events: one page of five, counted without the events waiting behind View latest.
  view.pending = Math.min(view.pending, session.length);
  const pinned = session.slice(view.pending);
  const at = pageOf(pinned.length, PAGE_SIZE, view.page);
  view.page = at.page;
  fill($("feed"), pinned.slice(at.start, at.end), at.page === 1 && view.pending === 0);
  renderPager("session", at);
  const since = startedAt === null ? "" : clockTime(new Date(startedAt).toISOString());
  setText(
    $("session-count"),
    sessionTotal === 0
      ? since ? `None yet · since ${since}` : "No events detected yet"
      : `${groupDigits(String(sessionTotal))} detected since ${since}` +
          (session.length < sessionTotal ? `; the oldest ${groupDigits(String(sessionTotal - session.length))} are no longer kept in this tab` : ""),
  );
  $("feed-empty").hidden = session.length > 0;
  $("session-new").hidden = view.pending === 0;
  setText($("session-new-count"), `${groupDigits(String(view.pending))} new ${view.pending === 1 ? "event" : "events"}`);

  // Initial history: nothing rendered until it is opened, then one page of five.
  $("initial").hidden = startedAt === null || initialTotal === 0;
  setText(
    $("initial-count"),
    `${groupDigits(String(initialTotal))} ${initialTotal === 1 ? "event" : "events"} · ${groupDigits(String(initialBlocks ?? 0n))} blocks before start` +
      (initial.length < initialTotal ? ` · ${initial.length === 0 ? "none" : groupDigits(String(initial.length))} kept` : ""),
  );
  if (initial.length === 0) view.initialOpen = false;
  if (!view.initialOpen) keepFocus($("initial-body"), $("initial-toggle"));
  const toggle = $("initial-toggle");
  toggle.setAttribute("aria-disabled", String(initial.length === 0));
  toggle.setAttribute("aria-expanded", String(view.initialOpen));
  $("initial-body").hidden = !view.initialOpen;
  const old = pageOf(initial.length, PAGE_SIZE, view.initialPage);
  view.initialPage = old.page;
  fill($("initial-feed"), view.initialOpen ? initial.slice(old.start, old.end) : [], false);
  renderPager("initial", old);
}

/**
 * Make `list` hold exactly the nodes for `items`, in order. Existing nodes are reused and stay where
 * they are: new ones are inserted before them and the tail is trimmed, so a focused link inside the
 * list keeps focus when events arrive.
 */
function fill(list, items, latestFirst) {
  const existing = new Map([...list.children].map((node) => [node.dataset.key, node]));
  items.forEach((item, index) => {
    const node = existing.get(item.key) ?? eventNode(item);
    state(node, item, latestFirst && index === 0);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
  });
  while (list.children.length > items.length) list.lastElementChild.remove();
}

function eventNode(item) {
  const node = $("event-template").content.firstElementChild.cloneNode(true);
  node.dataset.key = item.key;
  node.dataset.kind = item.type;
  const part = (name) => node.querySelector(`.${name}`);
  setText(part("event-kind"), item.type);
  setText(part("event-num"), item.amount.formatted);
  setText(part("event-unit"), item.amount.symbol);

  // From → to; a Mint only has a recipient and a Burn only a sender worth naming.
  const path = part("event-path");
  const address = (value) => Object.assign(document.createElement("span"), { className: "event-address", textContent: shortHex(value), title: value });
  const word = (text) => Object.assign(document.createElement("span"), { className: "event-dir", textContent: text });
  if (item.type === "Mint") path.replaceChildren(word("to "), address(item.to));
  else if (item.type === "Burn") path.replaceChildren(word("from "), address(item.from));
  else {
    const arrow = Object.assign(document.createElement("span"), { className: "event-arrow", textContent: " → " });
    arrow.setAttribute("aria-hidden", "true");
    path.replaceChildren(address(item.from), arrow, Object.assign(document.createElement("span"), { className: "sr", textContent: " to " }), address(item.to));
  }

  const block = part("event-block");
  block.replaceChildren(`Block ${groupDigits(item.blockNumber)}`, Object.assign(document.createElement("span"), { className: "event-log", textContent: ` · log ${item.logIndex}` }));
  linkExplorer(part("event-link"), "tx", item.transactionHash, `transaction ${shortHex(item.transactionHash)}`);
  if (item.fresh && latestBatch.has(item.key) && !reducedMotion()) {
    node.classList.add("arrive");
    node.addEventListener("animationend", () => node.classList.remove("arrive"), { once: true });
  }
  return node;
}

/** The parts of a card that change after it is drawn: New, Latest, Removed. */
function state(node, item, latest) {
  const isNew = item.fresh && latestBatch.has(item.key) && !item.retracted;
  node.toggleAttribute("data-new", isNew);
  node.toggleAttribute("data-latest", latest);
  node.toggleAttribute("data-removed", item.retracted);
  setText(node.querySelector(".event-badge"), item.retracted ? "Removed" : isNew ? "New" : "");
  node.querySelector(".event-eyebrow").hidden = !latest;
}

/** Relative times: when the last check finished, and when the latest event was found. */
function tick() {
  if (document.hidden) return;
  setText($("checked-ago"), checkedAt === null ? "—" : ago(checkedAt));
  const latest = $("feed").firstElementChild;
  if (latest) {
    const at = feed.items.find((item) => item.key === latest.dataset.key)?.foundAt;
    setText(latest.querySelector(".event-found"), at === undefined ? "" : `found ${ago(at)}`);
  }
}

function ago(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

function setControls() {
  const toggle = $("toggle");
  toggle.dataset.action = stopped ? "start" : "stop";
  toggle.classList.toggle("btn-primary", stopped);
  setText(toggle, stopped ? "Start monitoring" : "Stop monitoring");
}

function report(state, detail, note = "") {
  const [word, tone] = STATUS[state];
  document.body.dataset.state = state;
  const status = $("status");
  status.dataset.tone = tone;
  setText($("status-word"), word);
  setText($("status-detail"), detail);
  const box = $("status-note");
  box.textContent = note;
  box.hidden = !note;
}
