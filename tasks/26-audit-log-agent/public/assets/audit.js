// Task 26 page: the audit-log agent. Makes a report on load (the example address over the last hour, or
// what the address bar asks for), and again on demand; every report is GET /api/agent?task=26, which reads
// what the address did over the period on Pharos Mainnet through the hosted Chain MCP and writes it as
// sentences, with the balances and the timeline behind them. Nothing is signed or sent. Everything is set
// as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, el, group, setStatus, wireForm } from "./agent.js";
import { linkExplorer, renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "26", LAB);

/** The address that moved the most USDC in Task 02's live proof; the second example sent the most. */
const EXAMPLE = Object.freeze({ address: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", period: "1", since: "", until: "" });
const OTHER = "0x936564245B69f5a293b42cbd752E0eE3bb68b470";
const FIELDS = { address: $("f-address"), period: $("f-period"), since: $("f-since"), until: $("f-until") };
/** What a datetime-local input gives: a time with no zone, which the agent reads as UTC. */
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const PERIODS = Object.freeze({ 1: "The last hour", 6: "The last 6 hours" });
/** Timeline rows shown before "Show all". */
const SHOWN = 10;

/** What is wrong with each input, by field; empty when the report can be made. */
function problems(v) {
  const out = {};
  if (!ADDRESS.test(v.address)) out.address = "Enter a 0x address of 40 hex characters.";
  if (!["1", "6", "time"].includes(v.period)) out.period = "Pick a period.";
  if (v.period === "time") {
    if (!LOCAL.test(v.since)) out.since = "A date and time, in UTC.";
    if (v.until && !LOCAL.test(v.until)) out.until = "A date and time, in UTC, or empty for now.";
    else if (v.until && LOCAL.test(v.since) && v.until <= v.since) out.until = "After the start.";
  }
  return out;
}

/** The API's query for the inputs. */
const queryOf = (v) => ({ address: v.address, ...(v.period === "time" ? { since: v.since, ...(v.until ? { until: v.until } : {}) } : { hours: v.period }) });

/** The report the address bar asks for, where it is complete and well formed; else the example. */
function initialInputs() {
  const query = new URLSearchParams(location.search);
  const since = (query.get("since") ?? "").trim();
  const inputs = { address: (query.get("address") ?? "").trim(), period: since ? "time" : (query.get("hours") ?? "").trim(), since, until: (query.get("until") ?? "").trim() };
  return Object.keys(problems(inputs)).length === 0 ? inputs : { ...EXAMPLE };
}

/** The two times show only for a period between two times. */
function adapt() {
  const between = FIELDS.period.value === "time";
  $("since-field").hidden = !between;
  $("until-field").hidden = !between;
}

const summaryOf = (v) => (v.period === "time" ? `${v.since.replace("T", " ")} to ${v.until ? v.until.replace("T", " ") : "now"} UTC` : PERIODS[v.period]);
const plural = (n, one, many = `${one}s`) => `${group(n)} ${n === 1 ? one : many}`;

/** The status: quiet, active with its counts, or flagged with what needs a look. */
function status(result) {
  const flags = [];
  if (result.zeroValue.count) flags.push(plural(result.zeroValue.count, "transfer") + " of nothing");
  if (result.approvals.some((a) => a.shown === "unlimited")) flags.push("an unlimited approval");
  if (result.tokens.some((t) => t.unexplained !== null && t.unexplained !== "0")) flags.push("a balance the logs do not explain");
  if (result.quiet) return setStatus("neutral", "Quiet", "nothing happened");
  if (flags.length) return setStatus("warning", "Flagged", flags.join(", "));
  const transfers = result.tokens.reduce((sum, t) => sum + t.in.count + t.out.count, 0);
  const counts = [result.account.code !== "contract" && result.sent ? plural(result.sent, "transaction") : "", transfers ? plural(transfers, "transfer") : "", result.approvals.length ? plural(result.approvals.length, "approval") : ""].filter(Boolean);
  setStatus("success", "Active", counts.join(", ") || "see the report");
}

function renderSaid(result) {
  $("said-box").hidden = false;
  $("said-meta").replaceChildren(addressLink(result.address, "the address"));
  const [scope, ...rest] = result.summary;
  $("said").replaceChildren(el("p", "said-scope", scope), ...rest.map((line) => el("p", "said-line", line)));
}

function balance(label, opening, closing, change) {
  const row = el("div");
  const dd = el("dd");
  if (opening === null) dd.append(`${closing} at the end`);
  else {
    dd.append(opening === closing ? closing : `${opening} → ${closing}`);
    if (change && !/^±/.test(change)) dd.append(" ", el("span", "balance-change", change));
  }
  row.append(el("dt", "", label), dd);
  return row;
}

function renderBalances(result) {
  $("balances-box").hidden = false;
  const n = result.native;
  const tokens = result.tokens.filter((t) => t.closing !== "0" || (t.opening !== null && t.opening !== "0") || t.in.count + t.out.count + t.wrapped.count + t.unwrapped.count > 0);
  $("balances").replaceChildren(balance("PROS", n.openingShown, n.closingShown, n.changeShown), ...tokens.map((t) => balance(t.symbol, t.openingShown, t.closingShown, t.changeShown)));
}

let expanded = false;
let latest = null;

function renderTimeline(result) {
  latest = result;
  const events = result.events;
  $("timeline-box").hidden = events.length === 0;
  if (!events.length) return;
  const total = events.length + result.truncated;
  $("timeline-meta").textContent = result.truncated ? `the newest ${group(events.length)} of ${group(total)}` : plural(total, "event");
  const days = result.period.from.timestamp.slice(0, 10) !== result.period.to.timestamp.slice(0, 10);
  const shown = expanded ? events : events.slice(0, SHOWN);
  $("timeline").replaceChildren(
    ...shown.map((e) => {
      const row = el("li", "event");
      row.dataset.kind = e.kind;
      // A transfer of nothing and an unlimited approval are what the status flags.
      row.dataset.flag = String((e.amount === "0" && (e.kind === "in" || e.kind === "out")) || (e.kind === "approval" && e.shown === "unlimited"));
      const tx = el("a", "event-tx", `${e.tx.slice(0, 10)}…`);
      tx.title = e.tx;
      linkExplorer(tx, "tx", e.tx, "the transaction");
      const time = `≈${days ? `${new Date(e.approxTime).toUTCString().slice(5, 11)} ` : ""}${e.approxTime.slice(11, 16)} UTC`;
      const meta = el("span", "event-meta", `${time} · block ${group(e.block)}`);
      if (!tx.hidden) meta.append(" · ", tx);
      row.append(el("span", "event-text", e.text), meta);
      return row;
    }),
  );
  const more = $("timeline-more");
  more.hidden = events.length <= SHOWN;
  more.textContent = expanded ? `Show the newest ${SHOWN}` : `Show all ${group(events.length)}`;
  more.setAttribute("aria-expanded", String(expanded));
}

function render({ result }) {
  status(result);
  renderSaid(result);
  renderBalances(result);
  expanded = false;
  renderTimeline(result);
}

const report = agentRunner({ task: "26", panel: $("report"), running: ["Reading", "Pharos Mainnet"], failed: "No report", render });

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
  adapt();
}

let current = initialInputs();
fill(current);
$("change-meta").textContent = summaryOf(current);

function run(inputs) {
  current = inputs;
  fill(current);
  $("change-meta").textContent = summaryOf(current);
  history.replaceState(null, "", `?${new URLSearchParams(queryOf(current))}`);
  report(queryOf(current));
}

wireForm({ form: $("settings"), fields: FIELDS, problems, result: { heading: $("report-h"), panel: $("report") }, submit: run });
FIELDS.period.addEventListener("change", adapt);
$("reset").addEventListener("click", () => fill(EXAMPLE));
$("ex-six").addEventListener("click", () => run({ ...current, period: "6", since: "", until: "" }));
$("ex-other").addEventListener("click", () => run({ ...current, address: OTHER }));
$("timeline-more").addEventListener("click", () => {
  expanded = !expanded;
  if (latest) renderTimeline(latest);
});

report(queryOf(current));
