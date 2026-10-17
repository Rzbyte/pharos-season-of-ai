// Task 09 page: the trend watcher. The observations are kept in this browser, per holder; each run sends
// them to GET /api/agent?task=09, which adds one observation read through the hosted Chain MCP, judges
// the trend over the ones made since the watcher last acted, dry-runs the top-up when it holds, and
// returns the store to keep. Runs on load, on "Observe now", and every 15 s while that is on. Nothing is
// signed or sent. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, el, group, queryInputs, setStatus, units, wireForm } from "./agent.js";
import { clockTime, renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "09", LAB);

const EXAMPLE = Object.freeze({ holder: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", trend: "falling", observations: "3", every: "10" });
/** Where the top-up comes from (the watcher preset's example treasury). */
const TREASURY = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const FIELDS = { holder: $("f-holder"), trend: $("f-trend"), observations: $("f-observations"), every: $("f-every") };
/** The most earlier observations one run sends (the API takes at most 20). */
const SERIES = 20;
const AUTO_MS = 15_000;

/** What is wrong with each setting, by field; empty when the watcher can run. */
function problems(inputs) {
  const out = {};
  if (!ADDRESS.test(inputs.holder)) out.holder = "Enter a 0x address of 40 hex characters.";
  if (!["falling", "rising"].includes(inputs.trend)) out.trend = "Pick falling or rising.";
  if (!/^[2-6]$/.test(inputs.observations)) out.observations = "Pick 2 to 6 observations.";
  if (!/^\d{1,4}$/.test(inputs.every) || Number(inputs.every) < 1 || Number(inputs.every) > 1000) out.every = "A whole number of blocks, 1 to 1,000.";
  return out;
}

/** The settings from the address bar where they are complete and well formed, else the example. */
function initialInputs() {
  const fromQuery = queryInputs(Object.keys(EXAMPLE));
  return fromQuery && Object.keys(problems(fromQuery)).length === 0 ? fromQuery : { ...EXAMPLE };
}

// The store, per holder: in localStorage where the browser allows it, else for this visit only.
const memory = new Map();
let lasting = true;
const storeKey = (holder) => `pharos-agent-lab:09:${holder.toLowerCase()}`;

function loadStore(holder) {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(holder)) ?? "null");
    if (saved && Array.isArray(saved.observations)) return { observations: saved.observations, actedAt: saved.actedAt ?? null };
  } catch {
    lasting = false;
  }
  return memory.get(storeKey(holder)) ?? { observations: [], actedAt: null };
}

function saveStore(holder, store) {
  memory.set(storeKey(holder), store);
  try {
    localStorage.setItem(storeKey(holder), JSON.stringify(store));
  } catch {
    lasting = false;
  }
}

function forgetStore(holder) {
  memory.delete(storeKey(holder));
  try {
    localStorage.removeItem(storeKey(holder));
  } catch {
    lasting = false;
  }
}

let current = initialInputs();

/** One run's query: the settings, the latest stored observations and where the watcher last acted. */
function query() {
  const store = loadStore(current.holder);
  const series = store.observations.slice(-SERIES).map((o) => `${o.block}:${o.raw}:${Math.floor(Date.parse(o.timestamp) / 1000)}`).join(",");
  return { ...current, ...(series ? { series } : {}), ...(store.actedAt ? { actedAt: store.actedAt } : {}) };
}

function renderHistory(result) {
  const { observations, actedAt } = result.store;
  const { decimals, unit } = result.observing;
  const shown = (raw) => `${units(raw, decimals, decimals === 18 ? 8 : 6)} ${unit}`;
  const judged = new Set(result.trend.window.map((p) => p.block));
  $("history").hidden = false;
  $("history-meta").textContent = `${observations.length} kept ${lasting ? "in this browser" : "for this visit"}`;
  $("obs-key").textContent = judged.size ? `Marked: the ${judged.size === 1 ? "one" : judged.size} the trend was judged on${actedAt ? "; dimmed: before the last action" : ""}.` : "";
  $("observations").replaceChildren(
    ...observations
      .map((o, i) => {
        const row = el("li", "obs");
        row.dataset.window = String(judged.has(o.block));
        row.dataset.counted = String(actedAt === null || BigInt(o.block) > BigInt(actedAt));
        const when = el("span", "obs-when", `Block ${group(o.block)}`);
        const time = el("span", "obs-time", clockTime(o.timestamp));
        time.title = o.timestamp;
        when.append(" · ", time);
        if (o.block === actedAt) when.append(el("span", "obs-tag", "acted"));
        const before = i > 0 ? BigInt(observations[i - 1].raw) : null;
        const delta = before === null ? null : BigInt(o.raw) - before;
        const change = el("span", "obs-change", delta === null ? "first" : delta === 0n ? "no change" : `${delta > 0n ? "+" : "−"}${shown(delta < 0n ? -delta : delta)}`);
        if (delta !== null && delta !== 0n) change.dataset.dir = delta > 0n ? "up" : "down";
        row.append(when, el("span", "obs-value", shown(o.raw)), change);
        return row;
      })
      .reverse(),
  );
}

function renderAct(result) {
  $("act").hidden = false;
  $("act-when").textContent = `${result.trend.label}.`;
  $("act-does").replaceChildren("Prepares a 100 USDC top-up from ", addressLink(TREASURY, "the example treasury"), " and simulates it.");
  const run = $("act-run");
  run.textContent = result.action ? result.action.headline : result.skipped ? "Nothing new was recorded, so nothing was judged new." : `Waits: ${result.trend.detail}.`;
  run.dataset.tone = result.action && result.action.verdict !== "would-succeed" ? "error" : "";
  $("act-sent").replaceChildren("No. The hosted Chain MCP is read-only; the CLI sends the action on Atlantic with ", el("span", "nowrap", "--execute"), ".");
}

function render({ result, inputs }) {
  saveStore(inputs.holder, { observations: result.store.observations, actedAt: result.store.actedAt });
  const { trend } = result;
  if (result.outcome === "watching") setStatus("neutral", "Watching", trend.detail);
  else setStatus("warning", "Fired", `${trend.label.toLowerCase()}`);
  const tx = $("tx");
  tx.hidden = false;
  tx.replaceChildren("USDC held by ", addressLink(inputs.holder, "the holder"), result.observation ? `: ${result.observation.shown}` : "");
  const why = $("why");
  why.hidden = result.outcome === "watching";
  why.textContent = result.outcome === "watching" ? "" : `${trend.label}: ${trend.detail}. The watcher acted once; the next trend counts only observations after this block. Nothing was sent.`;
  const skipped = $("skipped");
  skipped.hidden = !result.skipped;
  skipped.textContent = result.skipped ? `Nothing recorded: ${result.skipped}` : "";
  renderHistory(result);
  renderAct(result);
}

const observe = agentRunner({ task: "09", panel: $("watch"), running: ["Observing", "reading Pharos Mainnet"], failed: "Not observed", render, onFail: () => ($("why").hidden = $("skipped").hidden = true) });

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
}

function summarize(inputs) {
  $("change-meta").textContent = `${inputs.trend === "falling" ? "Falling" : "Rising"} · ${inputs.observations} observations · every ${group(inputs.every)} ${inputs.every === "1" ? "block" : "blocks"}`;
}

fill(current);
summarize(current);

wireForm({
  form: $("settings"),
  fields: FIELDS,
  problems,
  result: { heading: $("trend-h"), panel: $("watch") },
  submit(inputs) {
    current = inputs;
    summarize(current);
    history.replaceState(null, "", `?${new URLSearchParams(current)}`);
    observe(query);
  },
});

$("reset").addEventListener("click", () => fill(EXAMPLE));

$("forget").addEventListener("click", () => {
  forgetStore(current.holder);
  observe(query);
});

// Observe every 15 s while on; a run sooner than the watcher's block spacing records nothing.
let timer = null;
$("auto").addEventListener("click", () => {
  const on = $("auto").getAttribute("aria-pressed") !== "true";
  $("auto").setAttribute("aria-pressed", String(on));
  $("auto").textContent = on ? "Stop observing every 15 s" : "Observe every 15 s";
  clearInterval(timer);
  timer = on ? setInterval(() => $("watch").getAttribute("aria-busy") !== "true" && observe(query), AUTO_MS) : null;
});

observe(query);
