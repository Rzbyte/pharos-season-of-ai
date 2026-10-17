// Task 22 page: the alert bot. Its memory (the last block it scanned, which conditions held) and its
// alerts are kept in this browser, one store per set of settings. Each run sends the memory to
// GET /api/agent?task=22, which scans USDC's Transfer logs after that block through the hosted Chain
// MCP, reads the conditions at the newest block, and returns the new alerts and the memory to keep.
// Runs on load, on "Check now", and every 15 s while that is on. Nothing is signed or sent. Everything
// is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, amountText, el, group, queryInputs, setStatus, short, wireForm } from "./agent.js";
import { linkExplorer, renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "22", LAB);

const EXAMPLE = Object.freeze({ min: "500", holder: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", low: "100" });
const FIELDS = { min: $("f-min"), low: $("f-low"), holder: $("f-holder") };
/** The most alerts kept in this browser, newest first. */
const FEED = 50;
const AUTO_MS = 15_000;
const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;
const KIND = { transfer: "Transfer", triggered: "Started", resolved: "Stopped" };
const TITLE = document.title;

/** What is wrong with each setting, by field; empty when the bot can run. */
function problems(inputs) {
  const out = {};
  if (!AMOUNT.test(inputs.min)) out.min = "An amount of USDC, up to 6 decimals.";
  if (!AMOUNT.test(inputs.low)) out.low = "An amount of USDC, up to 6 decimals.";
  if (!ADDRESS.test(inputs.holder)) out.holder = "Enter a 0x address of 40 hex characters.";
  return out;
}

/** The settings from the address bar where they are complete and well formed, else the example. */
function initialInputs() {
  const fromQuery = queryInputs(Object.keys(EXAMPLE));
  return fromQuery && Object.keys(problems(fromQuery)).length === 0 ? fromQuery : { ...EXAMPLE };
}

// The store, per set of settings: in localStorage where the browser allows it, else for this visit only.
const memory = new Map();
let lasting = true;
const storeKey = (inputs) => `pharos-agent-lab:22:${inputs.holder.toLowerCase()}:${inputs.min}:${inputs.low}`;
const EMPTY = Object.freeze({ cursor: null, states: {}, feed: [] });

function loadStore(inputs) {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(inputs)) ?? "null");
    if (saved && Array.isArray(saved.feed)) return { cursor: saved.cursor ?? null, states: saved.states ?? {}, feed: saved.feed };
  } catch {
    lasting = false;
  }
  return memory.get(storeKey(inputs)) ?? EMPTY;
}

function saveStore(inputs, store) {
  memory.set(storeKey(inputs), store);
  try {
    localStorage.setItem(storeKey(inputs), JSON.stringify(store));
  } catch {
    lasting = false;
  }
}

function forgetStore(inputs) {
  memory.delete(storeKey(inputs));
  try {
    localStorage.removeItem(storeKey(inputs));
  } catch {
    lasting = false;
  }
}

let current = initialInputs();

/** One run's query: the settings, the last block scanned and which conditions held. */
function query() {
  const store = loadStore(current);
  const states = Object.entries(store.states).map(([id, holds]) => `${id}:${holds ? 1 : 0}`).join(",");
  return { ...current, ...(store.cursor ? { cursor: store.cursor } : {}), ...(states ? { states } : {}) };
}

// A run that alerts while the tab is in the background puts the count in the tab's title until it is seen.
let unseen = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  unseen = 0;
  document.title = TITLE;
});

function alertRow(alert, fresh) {
  const row = el("li", "alert");
  row.dataset.kind = alert.kind;
  row.dataset.new = String(fresh);
  const head = el("span", "alert-head");
  head.append(el("span", "alert-kind", KIND[alert.kind] ?? alert.kind), el("span", "alert-label", alert.label));
  const body = el("span", "alert-body");
  const t = alert.transfer;
  if (t) body.append(`${t.shown} from `, addressLink(t.from, "the sender"), " to ", addressLink(t.to, "the recipient"));
  else body.append(`${alert.kind === "resolved" ? "No longer holds" : "Holds now"}: ${alert.observed}`);
  const meta = el("span", "alert-meta", `Block ${group(alert.block)}`);
  if (t) {
    const link = el("a", "alert-tx", "transaction");
    linkExplorer(link, "tx", t.tx, "the transfer");
    if (!link.hidden) meta.append(" · ", link);
  }
  row.append(head, body, meta);
  return row;
}

function renderFeed(feed, fresh) {
  $("feed-box").hidden = false;
  $("feed-meta").textContent = feed.length ? `${feed.length} kept ${lasting ? "in this browser" : "for this visit"}` : "";
  $("feed").replaceChildren(...feed.map((alert) => alertRow(alert, fresh.has(alert.id))));
  $("feed-empty").hidden = feed.length > 0;
  $("feed-empty").textContent = feed.length ? "" : "None yet. New alerts appear here as they happen, newest first.";
}

function ruleRow(rule, scanned) {
  const row = el("li", "rule");
  const state = rule.kind === "transfer" ? (rule.matches ? "alerting" : "clear") : rule.state === "holds" ? "alerting" : rule.state === "clear" ? "clear" : "unknown";
  row.dataset.state = state;
  row.dataset.id = rule.id;
  const chip = rule.kind === "transfer" ? (rule.matches ? `${rule.matches} new` : "none new") : rule.state === "holds" ? "holds" : rule.state === "clear" ? "clear" : "unreadable";
  const evidence = el("span", "rule-evidence");
  const seen = rule.kind === "transfer" ? (scanned ? `blocks ${group(scanned.from)}–${group(scanned.to)}` : "no new blocks") : rule.observed;
  if (seen) evidence.append(el("span", "rule-seen", seen));
  evidence.append(el("span", "rule-tool", rule.tool));
  if (rule.error) evidence.append(el("span", "rule-error", rule.error));
  row.append(el("span", "rule-label", rule.label), el("span", "rule-state", chip), evidence);
  return row;
}

function render({ result, inputs }) {
  const before = loadStore(inputs);
  const known = new Set(before.feed.map((alert) => alert.id));
  const added = result.alerts.filter((alert) => !known.has(alert.id));
  // Newest first: this run's alerts (oldest first in the answer) on top of the kept ones.
  const feed = [...added].reverse().concat(before.feed).slice(0, FEED);
  saveStore(inputs, { cursor: result.store.cursor, states: result.store.states, feed });

  const holding = result.rules.filter((rule) => rule.state === "holds").length;
  const held = holding ? `; ${holding} ${holding === 1 ? "condition holds" : "conditions hold"}` : "";
  if (added.length) setStatus("warning", "Alert", `${added.length} new${held}`);
  else setStatus("neutral", "Watching", `no new alerts${held}`);
  if (added.length && document.hidden) {
    unseen += added.length;
    document.title = `(${unseen}) ${TITLE}`;
  }

  const scan = $("scan");
  scan.hidden = false;
  const size = /^0+(\.0+)?$/.test(inputs.min) ? "" : ` of ${amountText(inputs.min)} or more`;
  scan.textContent = result.scanned ? `Blocks ${group(result.scanned.from)}–${group(result.scanned.to)} scanned for USDC transfers${size}.` : "No new blocks since the last check.";
  const gap = [];
  if (result.skipped) gap.push(`Too far behind: blocks ${group(result.skipped.from)}–${group(result.skipped.to)} were not scanned; a run scans at most the newest 2,000.`);
  if (result.truncated) gap.push(`${group(result.truncated)} more matching ${result.truncated === 1 ? "transfer was" : "transfers were"} not reported: one run reports at most 100.`);
  $("gap").hidden = gap.length === 0;
  $("gap").textContent = gap.join(" ");

  renderFeed(feed, new Set(added.map((alert) => alert.id)));
  $("rules-box").hidden = false;
  $("rules").replaceChildren(...result.rules.map((rule) => ruleRow(rule, result.scanned)));
}

const check = agentRunner({ task: "22", panel: $("watch"), running: ["Checking", "reading Pharos Mainnet"], failed: "Not checked", render, onFail: () => ($("gap").hidden = true) });

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
}

function summarize(inputs) {
  $("change-meta").textContent = `${amountText(inputs.min)} USDC · ${short(inputs.holder)} below ${amountText(inputs.low)}`;
}

fill(current);
summarize(current);

wireForm({
  form: $("settings"),
  fields: FIELDS,
  problems,
  result: { heading: $("alerts-h"), panel: $("watch") },
  submit(inputs) {
    current = inputs;
    summarize(current);
    history.replaceState(null, "", `?${new URLSearchParams(current)}`);
    check(query);
  },
});

$("reset").addEventListener("click", () => fill(EXAMPLE));

$("forget").addEventListener("click", () => {
  forgetStore(current);
  check(query);
});

// Check every 15 s while on. Each run scans only the blocks after the last, so none is missed between.
let timer = null;
$("auto").addEventListener("click", () => {
  const on = $("auto").getAttribute("aria-pressed") !== "true";
  $("auto").setAttribute("aria-pressed", String(on));
  $("auto").textContent = on ? "Stop checking every 15 s" : "Check every 15 s";
  clearInterval(timer);
  timer = on ? setInterval(() => $("watch").getAttribute("aria-busy") !== "true" && check(query), AUTO_MS) : null;
});

check(query);
