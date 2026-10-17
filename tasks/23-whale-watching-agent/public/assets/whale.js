// Task 23 page: the whale watcher. What it saw last (the block it scanned to, each address's holdings
// and nonce) and the significant moves are kept in this browser, one store per set of settings. Each
// run sends what it saw to GET /api/agent?task=23, which reads every address at the newest block and
// scans USDC's Transfer logs since then through the hosted Chain MCP, and returns the significant moves,
// a report per address and what to keep. Runs on load, on "Check now", and every 30 s while that is on.
// Nothing is signed or sent. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, amountText, el, group, queryInputs, setStatus, short, wireForm } from "./agent.js";
import { linkExplorer, renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "23", LAB);

const SAMPLE = ["0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", "0x936564245B69f5a293b42cbd752E0eE3bb68b470", "0x1F3546a29EeC2102c8d52E21a45114124014c85C", "0x0018b46177c611fc1EfBca63c845c2a69045E28D"];
const EXAMPLE = Object.freeze({ addresses: SAMPLE.join(","), min: "250", native: "100" });
const FIELDS = { addresses: $("f-addresses"), min: $("f-min"), native: $("f-native") };
/** The most addresses one run tracks (the API's limit), and the most moves kept in this browser. */
const MAX_ADDRESSES = 5;
const FEED = 50;
const AUTO_MS = 30_000;
const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;
const TITLE = document.title;

/** The addresses as typed: one per line (commas and spaces work too). */
const listOf = (text) => text.split(/[\s,]+/).filter(Boolean);

/** What is wrong with each setting, by field; empty when the watcher can run. */
function problems(inputs) {
  const out = {};
  const listed = listOf(inputs.addresses);
  if (listed.length === 0 || listed.length > MAX_ADDRESSES) out.addresses = `Enter 1 to ${MAX_ADDRESSES} addresses, one per line.`;
  else if (listed.some((a) => !ADDRESS.test(a))) out.addresses = `${listed.find((a) => !ADDRESS.test(a)).slice(0, 44)} is not a 0x address of 40 hex characters.`;
  else if (new Set(listed.map((a) => a.toLowerCase())).size !== listed.length) out.addresses = "An address is listed twice.";
  if (!AMOUNT.test(inputs.min)) out.min = "An amount of USDC, up to 6 decimals.";
  if (!AMOUNT.test(inputs.native)) out.native = "An amount of PROS, up to 6 decimals.";
  return out;
}

/** Settings as the API takes them: the addresses comma-separated. */
const normalize = (inputs) => ({ ...inputs, addresses: listOf(inputs.addresses).join(",") });

/** The settings from the address bar where they are complete and well formed, else the example. */
function initialInputs() {
  const fromQuery = queryInputs(Object.keys(EXAMPLE));
  return fromQuery && Object.keys(problems(fromQuery)).length === 0 ? normalize(fromQuery) : { ...EXAMPLE };
}

// The store, per set of settings: in localStorage where the browser allows it, else for this visit only.
const memory = new Map();
let lasting = true;
const storeKey = (inputs) => `pharos-agent-lab:23:${listOf(inputs.addresses).map((a) => a.toLowerCase()).sort().join(",")}:${inputs.min}:${inputs.native}`;
const EMPTY = Object.freeze({ cursor: null, snapshots: {}, feed: [] });

function loadStore(inputs) {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(inputs)) ?? "null");
    if (saved && Array.isArray(saved.feed) && saved.snapshots && typeof saved.snapshots === "object") return { cursor: saved.cursor ?? null, snapshots: saved.snapshots, feed: saved.feed };
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

/** One run's query: the settings, and what the watcher saw last, when it has seen anything. */
function query() {
  const { cursor, snapshots } = loadStore(current);
  return { ...current, ...(cursor ? { store: JSON.stringify({ cursor, snapshots }) } : {}) };
}

// A run that finds something while the tab is in the background puts the count in the tab's title.
let unseen = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  unseen = 0;
  document.title = TITLE;
});

/** A tracked address by its label (the short address when it has none), linked to the explorer, the full address on hover. */
function who(address, label) {
  const link = addressLink(address, label);
  if (label && label !== short(address)) {
    link.textContent = label;
    link.className = "who";
  }
  return link;
}

function moveRow(move, fresh) {
  const row = el("li", "move");
  row.dataset.kind = move.kind;
  row.dataset.dir = move.direction;
  row.dataset.new = String(fresh);
  const head = el("span", "move-head");
  const kind = move.kind === "native" ? (move.direction === "in" ? "PROS in" : "PROS out") : move.direction === "out" ? "Sent" : "Received";
  head.append(el("span", "move-kind", kind), who(move.address, move.label));
  const body = el("span", "move-body");
  if (move.kind === "transfer") {
    body.append(`${move.shown} ${move.direction === "out" ? "to" : "from"} `, move.counterpartyLabel ? who(move.counterparty, move.counterpartyLabel) : addressLink(move.counterparty, move.direction === "out" ? "the recipient" : "the sender"));
  } else {
    body.append(`Balance ${move.direction === "in" ? "rose" : "fell"} by ${move.shown}`);
  }
  const meta = el("span", "move-meta", `Block ${group(move.block)}`);
  if (move.tx) {
    const link = el("a", "move-tx", "transaction");
    linkExplorer(link, "tx", move.tx, "the transfer");
    if (!link.hidden) meta.append(" · ", link);
  } else meta.append(" · since the last check");
  row.append(head, body, meta);
  return row;
}

function renderFeed(feed, fresh) {
  $("moves-box").hidden = false;
  $("moves-meta").textContent = feed.length ? `${feed.length} kept ${lasting ? "in this browser" : "for this visit"}` : "";
  $("moves").replaceChildren(...feed.map((move) => moveRow(move, fresh.has(move.id))));
  $("moves-empty").hidden = feed.length > 0;
  $("moves-empty").textContent = feed.length ? "" : "None yet. Significant moves appear here as they happen, newest first.";
}

/** "+12.5 USDC" against the last check, "first check" the first time. */
const changeOf = (shown) => el("span", "whale-change", shown ?? "first check");

function whaleRow(report) {
  const row = el("li", "whale");
  row.dataset.significant = String(report.significant > 0);
  const head = el("span", "whale-head");
  head.append(who(report.address, report.label));
  if (report.contract) head.append(el("span", "whale-tag", "contract"));
  if (report.significant) head.append(el("span", "whale-tag whale-moved", report.significant === 1 ? "1 move" : `${report.significant} moves`));
  const lines = el("span", "whale-lines");
  for (const t of report.tokens) {
    const line = el("span", "whale-line");
    line.append(el("span", "whale-amount", t.shown), changeOf(t.changeShown));
    lines.append(line);
  }
  const native = el("span", "whale-line");
  native.append(el("span", "whale-amount", report.native.shown), changeOf(report.native.changeShown));
  lines.append(native);
  const usdc = report.tokens[0];
  const parts = [];
  if (usdc) parts.push(`${usdc.in.count} in, ${usdc.out.count} out this run`);
  if (report.sent !== null) parts.push(`${report.sent} ${report.sent === 1 ? "transaction" : "transactions"} sent`);
  row.append(head, lines, el("span", "whale-activity", parts.join(" · ")));
  return row;
}

function render({ result, inputs }) {
  const before = loadStore(inputs);
  const known = new Set(before.feed.map((move) => move.id));
  const added = result.events.filter((move) => !known.has(move.id));
  // Newest first: this run's moves (oldest first in the answer) on top of the kept ones.
  const feed = [...added].reverse().concat(before.feed).slice(0, FEED);
  saveStore(inputs, { cursor: result.store.cursor, snapshots: result.store.snapshots, feed });

  const tracked = result.addresses.length;
  if (added.length) setStatus("warning", "Spotted", `${added.length} significant ${added.length === 1 ? "move" : "moves"}`);
  else setStatus("neutral", "Watching", `no significant moves; ${group(result.transfers)} ${result.transfers === 1 ? "transfer" : "transfers"}`);
  if (added.length && document.hidden) {
    unseen += added.length;
    document.title = `(${unseen}) ${TITLE}`;
  }

  const scan = $("scan");
  scan.hidden = false;
  const whose = `the ${tracked === 1 ? "tracked address" : `${tracked} tracked addresses`}`;
  scan.textContent = result.scanned ? `Blocks ${group(result.scanned.from)}–${group(result.scanned.to)} scanned: ${group(result.transfers)} USDC ${result.transfers === 1 ? "transfer" : "transfers"} by ${whose}.` : "No new blocks since the last check.";
  const gap = [];
  if (result.skipped) gap.push(`Too far behind: blocks ${group(result.skipped.from)}–${group(result.skipped.to)} were not scanned; a run scans at most the newest 2,000.`);
  if (result.truncated) gap.push(`${group(result.truncated)} more significant ${result.truncated === 1 ? "transfer was" : "transfers were"} not reported: one run reports at most 100.`);
  $("gap").hidden = gap.length === 0;
  $("gap").textContent = gap.join(" ");

  renderFeed(feed, new Set(added.map((move) => move.id)));
  $("tracked-box").hidden = false;
  $("tracked-meta").textContent = `at block ${group(result.block.number)}`;
  $("tracked").replaceChildren(...result.addresses.map(whaleRow));
}

const check = agentRunner({ task: "23", panel: $("watch"), running: ["Checking", "reading Pharos Mainnet"], failed: "Not checked", render, onFail: () => ($("gap").hidden = true) });

function fill(inputs) {
  FIELDS.addresses.value = listOf(inputs.addresses).join("\n");
  FIELDS.min.value = inputs.min;
  FIELDS.native.value = inputs.native;
}

function summarize(inputs) {
  const n = listOf(inputs.addresses).length;
  $("change-meta").textContent = `${n} ${n === 1 ? "address" : "addresses"} · ${amountText(inputs.min)} USDC · ${amountText(inputs.native)} PROS`;
}

fill(current);
summarize(current);

wireForm({
  form: $("settings"),
  fields: FIELDS,
  problems,
  result: { heading: $("moves-h"), panel: $("watch") },
  submit(inputs) {
    current = normalize(inputs);
    fill(current);
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

// Check every 30 s while on. Each run scans only the blocks after the last, so no transfer is missed between.
let timer = null;
$("auto").addEventListener("click", () => {
  const on = $("auto").getAttribute("aria-pressed") !== "true";
  $("auto").setAttribute("aria-pressed", String(on));
  $("auto").textContent = on ? "Stop checking every 30 s" : "Check every 30 s";
  clearInterval(timer);
  timer = on ? setInterval(() => $("watch").getAttribute("aria-busy") !== "true" && check(query), AUTO_MS) : null;
});

check(query);
