// Task 24 page: the gas fee optimizer. The fee observations are kept in this browser, shared by every
// transaction timed here (the fee is the chain's, not the transaction's); each run sends the newest 12 to
// GET /api/agent?task=24, which adds the newest block's through the hosted Chain MCP, dry-runs the
// transaction there, and decides: send now, or wait for the target. Runs on load, on "Check now", and
// every 30 s while that is on. Nothing is signed or sent. Everything is set as text, never as markup.
import { $, ADDRESS, agentRunner, amountText, describeRequest, el, group, gwei, queryInputs, setStatus, wireForm } from "./agent.js";
import { clockTime, renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "24", LAB);

const EXAMPLE = Object.freeze({ asset: "USDC", amount: "25", from: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", to: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", percentile: "25" });
const FIELDS = { asset: $("f-asset"), amount: $("f-amount"), from: $("f-from"), to: $("f-to"), percentile: $("f-percentile") };
/** The most earlier observations one run sends (the API's window). */
const SERIES = 12;
const AUTO_MS = 30_000;
const DECIMALS = Object.freeze({ PROS: 18, WPROS: 18, USDC: 6, LINK: 18, WETH: 18 });
const TARGETS = Object.freeze({ 10: "Lowest 10%", 25: "Lowest 25%", 50: "Lowest half", 75: "Lowest 75%" });
const STORE = "pharos-agent-lab:24";

/** What is wrong with each setting, by field; empty when the transaction can be timed. */
function problems(inputs) {
  const out = {};
  const decimals = DECIMALS[inputs.asset];
  if (decimals === undefined) out.asset = "Pick an asset.";
  const fraction = inputs.amount.split(".")[1] ?? "";
  if (!/^\d{1,12}(\.\d+)?$/.test(inputs.amount)) out.amount = "An amount like 25 or 0.5.";
  else if (decimals !== undefined && fraction.length > decimals) out.amount = `At most ${decimals} decimals for ${inputs.asset}.`;
  if (!ADDRESS.test(inputs.from)) out.from = "Enter a 0x address of 40 hex characters.";
  if (!ADDRESS.test(inputs.to)) out.to = "Enter a 0x address of 40 hex characters.";
  if (!(inputs.percentile in TARGETS)) out.percentile = "Pick a target.";
  return out;
}

/** The settings from the address bar where they are complete and well formed, else the example. */
function initialInputs() {
  const fromQuery = queryInputs(Object.keys(EXAMPLE));
  return fromQuery && Object.keys(problems(fromQuery)).length === 0 ? fromQuery : { ...EXAMPLE };
}

// One store: the observations, and since when the transaction it was last timed for has been waiting.
let memory = null;
let lasting = true;
const settingsKey = (inputs) => [inputs.asset, inputs.amount, inputs.from.toLowerCase(), inputs.to.toLowerCase(), inputs.percentile].join(":");

function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (saved && Array.isArray(saved.observations)) return { observations: saved.observations, waitingSince: saved.waitingSince ?? null, for: saved.for ?? null };
  } catch {
    lasting = false;
  }
  return memory ?? { observations: [], waitingSince: null, for: null };
}

function saveStore(store) {
  memory = store;
  try {
    localStorage.setItem(STORE, JSON.stringify(store));
  } catch {
    lasting = false;
  }
}

function forgetStore() {
  memory = null;
  try {
    localStorage.removeItem(STORE);
  } catch {
    lasting = false;
  }
}

let current = initialInputs();

/** One run's query: the transaction, the target, the kept observations, and how long it has waited. */
function query() {
  const store = loadStore();
  const series = store.observations
    .slice(-SERIES)
    .map((o) => `${o.block}:${o.fee}:${o.gasUsed}:${o.gasLimit}:${Math.floor(Date.parse(o.timestamp) / 1000)}:${o.source === "base-fee" ? "b" : "g"}`)
    .join(",");
  const waiting = store.for === settingsKey(current) ? store.waitingSince : null;
  return { action: "transfer", ...current, ...(series ? { series } : {}), ...(waiting ? { waitingSince: waiting } : {}) };
}

function renderFees(result) {
  const { window, observed, block, stats, target } = result;
  const fresh = new Set(observed.map((o) => o.block));
  const max = BigInt(stats.max) > 0n ? BigInt(stats.max) : 1n;
  $("fees-box").hidden = false;
  $("fees-meta").textContent = `${window.length} kept ${lasting ? "in this browser" : "for this visit"}`;
  $("fee-range").textContent = stats.steady
    ? `Steady at ${stats.shown.min} across the ${window.length}. Target ${target.shown}.`
    : `Lowest ${stats.shown.min} · median ${stats.shown.median} · highest ${stats.shown.max}. Target ${target.shown}: ${target.how}.`;
  $("fees").replaceChildren(
    ...window
      .map((o) => {
        const row = el("li", "fee");
        row.dataset.below = String(BigInt(o.fee) <= BigInt(target.fee));
        const when = el("span", "fee-when", `Block ${group(o.block)}`);
        const time = el("span", "fee-time", clockTime(o.timestamp));
        time.title = o.timestamp;
        when.append(" · ", time);
        if (o.block === block.number) when.append(el("span", "fee-tag", "now"));
        else if (fresh.has(o.block)) when.append(el("span", "fee-tag", "read now"));
        const bar = el("span", "fee-bar");
        bar.setAttribute("aria-hidden", "true");
        const fill = el("span");
        fill.style.width = `${Math.max(2, Number((BigInt(o.fee) * 1000n) / max) / 10)}%`;
        bar.append(fill);
        row.append(when, bar, el("span", "fee-value", gwei(o.fee)));
        return row;
      })
      .reverse(),
  );
}

function renderCosts(result) {
  const { costs, settings, fee, target } = result;
  $("cost-box").hidden = false;
  $("c-target").textContent = `${target.shown}, ${target.how}`;
  $("c-settings").textContent = settings ? `maxFeePerGas ${settings.shown.maxFeePerGas} · maxPriorityFeePerGas ${settings.shown.maxPriorityFeePerGas}` : "None: it is not to be sent.";
  $("c-now").textContent = costs ? `${costs.shown.now}, at ${fee.shown.now} plus a ${fee.shown.tip} priority fee` : "Not priced: the dry run did not succeed.";
  $("c-target-cost").textContent = costs ? `${costs.shown.atTarget}${BigInt(costs.saving) > 0n ? `, ${costs.shown.saving} less` : ""}` : "—";
  $("c-max").textContent = costs ? `${costs.shown.cappedMax} with this cap, against ${costs.shown.standardMax} with the usual one` : "—";
  $("c-sent").replaceChildren("No. The hosted Chain MCP is read-only; the CLI sends it on Atlantic with ", el("span", "nowrap", "--execute"), ".");
}

function render({ result, inputs }) {
  saveStore({ observations: result.store.observations, waitingSince: result.store.waitingSince, for: settingsKey(inputs) });
  const { decision, fee, target, stats } = result;
  if (decision === "send") setStatus("success", "Send now", stats.steady ? `the fee has held at ${fee.shown.now}` : `${fee.shown.now}, at or under ${target.shown}`);
  else if (decision === "wait") setStatus("warning", "Wait", `${fee.shown.now}, over ${target.shown}`);
  else setStatus("error", "Not sendable", result.dryRun.verdict === "cannot-pay" ? "it cannot pay its fee" : "it would revert");
  const tx = $("tx");
  tx.hidden = false;
  tx.replaceChildren(...describeRequest({ action: "transfer", asset: inputs.asset, from: inputs.from, to: inputs.to, amount: inputs.amount }));
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = decision === "wait" ? "warning" : decision === "blocked" ? "error" : "";
  why.textContent = result.reason;
  renderFees(result);
  renderCosts(result);
}

const check = agentRunner({ task: "24", panel: $("gas"), running: ["Checking", "reading Pharos Mainnet"], failed: "Not checked", render, onFail: () => ($("why").hidden = true) });

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
}

function summarize(inputs) {
  $("change-meta").textContent = `${amountText(inputs.amount)} ${inputs.asset} · ${TARGETS[inputs.percentile].toLowerCase()}`;
}

fill(current);
summarize(current);

wireForm({
  form: $("settings"),
  fields: FIELDS,
  problems,
  result: { heading: $("gas-h"), panel: $("gas") },
  submit(inputs) {
    current = inputs;
    summarize(current);
    history.replaceState(null, "", `?${new URLSearchParams(current)}`);
    check(query);
  },
});

$("reset").addEventListener("click", () => fill(EXAMPLE));

$("forget").addEventListener("click", () => {
  forgetStore();
  check(query);
});

// Check every 30 s while on: each run adds the newest block's fee and decides again.
let timer = null;
$("auto").addEventListener("click", () => {
  const on = $("auto").getAttribute("aria-pressed") !== "true";
  $("auto").setAttribute("aria-pressed", String(on));
  $("auto").textContent = on ? "Stop checking every 30 s" : "Check every 30 s";
  clearInterval(timer);
  timer = on ? setInterval(() => $("gas").getAttribute("aria-busy") !== "true" && check(query), AUTO_MS) : null;
});

check(query);
