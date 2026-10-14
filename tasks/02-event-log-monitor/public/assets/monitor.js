// Task 02 page: a live monitor of Circle USDC Transfer events on Pharos Mainnet.
//
// The browser only ever calls this site's own GET /api/events, which reads Pharos server-side
// through Chain MCP. Every few seconds it asks for the current window, keeps the last checked block
// and the keys of the events it has shown (feed.js), and adds only events it has not shown before.
// Every value is written as text.
//
// States, on <body data-state>: "starting" (first check), "monitoring", "paused" (Stop, or the tab is
// in the background) and "error" (the last check failed; the next one is already scheduled).
import { applyWindow, createFeed, shortHex } from "./feed.js";
import { clockTime, groupDigits, linkExplorer, renderHex, renderTaskContext, reducedMotion, setText, settle } from "./lab.js";
import { TASKS } from "./tasks.js";

const $ = (id) => document.getElementById(id);
const main = $("main");
const panel = $("monitor");
const API = main.dataset.api;
const INTERVAL_MS = Number(main.dataset.interval) * 1000;
const STATUS = {
  starting: ["Starting", "active"],
  monitoring: ["Monitoring", "active"],
  paused: ["Paused", "neutral"],
  error: ["Check failed", "error"],
};

const feed = createFeed();
/** Stopped with the Stop button; only Start resumes. A hidden tab pauses without this. */
let stopped = false;
let running = false;
let first = true;
let timer;
let inFlight;

renderTaskContext(TASKS, main.dataset.task, { counter: $("task-count"), previous: $("nav-previous"), next: $("nav-next") });
renderHex($("address"), $("address-sr").textContent.trim());
linkExplorer($("contract-explorer"), "address", $("address-sr").textContent.trim(), "contract address");
setText($("interval"), String(INTERVAL_MS / 1000));
$("start").addEventListener("click", () => {
  stopped = false;
  start();
  $("stop").focus();
});
$("stop").addEventListener("click", () => {
  stopped = true;
  pause("Start monitoring to resume");
  $("start").focus();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (running) pause("tab in the background, resumes when you return");
  } else if (!stopped) {
    start();
  }
});
for (const link of document.querySelectorAll('a[href="#proof"]')) link.addEventListener("click", () => void ($("proof").open = true));
start();

function start() {
  if (running || document.hidden) return;
  running = true;
  setControls();
  report(feed.lastChecked === null ? "starting" : "monitoring", feed.lastChecked === null ? "first check through Pharos Chain MCP" : `checking every ${INTERVAL_MS / 1000} s`);
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
    report("error", `next try in ${INTERVAL_MS / 1000} s`, `${problem} The last checked block is kept, so nothing is skipped.`);
  } else {
    try {
      render(data, applyWindow(feed, data, { first }));
      first = false;
      report("monitoring", `checking every ${INTERVAL_MS / 1000} s`);
    } catch {
      report("error", `next try in ${INTERVAL_MS / 1000} s`, "The events endpoint sent an answer this page could not read.");
    }
  }
  timer = setTimeout(check, INTERVAL_MS);
}

function render(data, change) {
  if (change.stale) return;
  const block = $("last-block");
  setText(block, groupDigits(feed.lastChecked));
  settle(block);
  setText($("window"), `${groupDigits(data.fromBlock)}–${groupDigits(data.toBlock)}`);
  setText($("checked-at"), clockTime(data.fetchedAt) || "—");
  setText($("count-new"), groupDigits(String(feed.newSinceStart)));
  setText($("count-detail"), `since monitoring started${feed.shown > feed.newSinceStart ? `, ${groupDigits(String(feed.shown - feed.newSinceStart))} initial` : ""}`);

  const gap = $("gap-note");
  if (change.gap) {
    gap.textContent = `Blocks ${groupDigits(change.gap.from)}–${groupDigits(change.gap.to)} were not checked while the monitor was paused.`;
    gap.hidden = false;
  } else if (!change.stale) {
    gap.hidden = true;
  }

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

  renderFeed(change);
}

/**
 * Two lists from the one feed: "New events" holds only events found after monitoring started;
 * "Initial events" (collapsed) holds those already in the first check. Only display changes here:
 * dedup, the cursor and the feed limit are feed.js's, as before.
 */
function renderFeed(change) {
  const lists = { fresh: $("feed"), initial: $("initial-feed") };
  // Only new events are inserted, newest first; shown ones are never re-rendered or moved.
  for (const fresh of [true, false]) {
    const list = fresh ? lists.fresh : lists.initial;
    list.prepend(...[...change.added].filter((item) => item.fresh === fresh).reverse().map(eventNode));
    const kept = feed.items.filter((item) => item.fresh === fresh).length;
    while (list.children.length > kept) list.lastElementChild.remove();
  }
  for (const item of change.retracted) {
    const node = document.querySelector(`#events [data-key="${CSS.escape(item.key)}"]`);
    if (node) markRemoved(node);
  }
  const newCount = feed.newSinceStart;
  const initialCount = feed.shown - feed.newSinceStart;
  setText($("new-count"), groupDigits(String(newCount)));
  setText($("initial-count"), `${groupDigits(String(initialCount))} found when monitoring started`);
  $("initial").hidden = initialCount === 0;
  $("feed-empty").hidden = lists.fresh.children.length > 0;
  const fresh = change.added.filter((item) => item.fresh);
  if (fresh.length > 0) {
    setText($("feed-live"), fresh.length === 1 ? `New ${fresh[0].type}: ${fresh[0].summary}` : `${fresh.length} new Transfer events`);
  }
}

function eventNode(item) {
  const node = $("event-template").content.firstElementChild.cloneNode(true);
  node.dataset.key = item.key;
  node.dataset.kind = item.type;
  if (item.fresh) {
    node.dataset.fresh = "";
    if (!reducedMotion()) node.classList.add("arrive");
  }
  const part = (name) => node.querySelector(`.${name}`);
  setText(part("event-kind"), item.type);
  setText(part("event-num"), item.amount.formatted);
  setText(part("event-unit"), item.amount.symbol);
  setText(part("event-badge"), item.fresh ? "New" : "");
  setText(part("event-from"), shortHex(item.from));
  part("event-from").title = item.from;
  setText(part("event-to"), shortHex(item.to));
  part("event-to").title = item.to;
  setText(part("event-block"), groupDigits(item.blockNumber));
  setText(part("event-log"), String(item.logIndex));
  setText(part("event-hash"), shortHex(item.transactionHash));
  part("event-hash").title = item.transactionHash;
  linkExplorer(node.querySelector(".event-tx .action"), "tx", item.transactionHash, `transaction ${shortHex(item.transactionHash)}`);
  if (item.retracted) markRemoved(node);
  return node;
}

function markRemoved(node) {
  node.dataset.removed = "";
  setText(node.querySelector(".event-badge"), "Removed");
}

function setControls() {
  $("start").disabled = running;
  $("stop").disabled = !running;
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
