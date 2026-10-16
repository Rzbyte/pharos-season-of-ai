// Task 05 page: the payout guardian. Evaluates once on load (the example payout, or the one in the
// address bar), and again on demand; every evaluation is GET /api/agent?task=05, which reads Pharos
// Mainnet through the hosted Chain MCP and returns the decision, the conditions and the simulated
// payout. Everything is set as text, never as markup.
import { clockTime, linkExplorer, renderTaskNav, svgIcon, wireToggle } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "05", LAB);

const $ = (id) => document.getElementById(id);
const main = $("main");
const API = main.dataset.api;
const EXAMPLE = Object.freeze({ payer: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", recipient: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "25", maxGasGwei: "10" });
const FIELDS = { payer: $("f-payer"), recipient: $("f-recipient"), amount: $("f-amount"), maxGasGwei: $("f-gas") };
const HINTS = { payer: $("h-payer"), recipient: $("h-recipient"), amount: $("h-amount"), maxGasGwei: $("h-gas") };
const HINT_TEXT = Object.fromEntries(Object.entries(HINTS).map(([key, el]) => [key, el.textContent]));
const MARK = { pass: "M3.5 8.5l3 3 6-7", fail: "M4.5 4.5l7 7M11.5 4.5l-7 7", unknown: "M4 8h8" };
const SAYS = { pass: "holds", fail: "fails", unknown: "could not be read" };
const OPS = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "==": "=", "!=": "≠" };

const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text === undefined ? {} : { textContent: text });
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const group = (digits) => String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The payout from the address bar where it is complete and well formed, else the example. */
function initialInputs() {
  const query = new URLSearchParams(location.search);
  const fromQuery = Object.fromEntries(Object.keys(EXAMPLE).map((key) => [key, (query.get(key) ?? "").trim()]));
  return Object.values(fromQuery).every(Boolean) && Object.keys(problems(fromQuery)).length === 0 ? fromQuery : { ...EXAMPLE };
}

/** What is wrong with each input, by field; empty when the payout can be evaluated. */
function problems(inputs) {
  const out = {};
  const address = /^0x[0-9a-fA-F]{40}$/;
  if (!address.test(inputs.payer)) out.payer = "Enter a 0x address of 40 hex characters.";
  if (!address.test(inputs.recipient)) out.recipient = "Enter a 0x address of 40 hex characters.";
  else if (inputs.recipient.toLowerCase() === inputs.payer.toLowerCase()) out.recipient = "Pick a recipient other than the payer.";
  if (!/^\d+(\.\d{1,6})?$/.test(inputs.amount) || Number(inputs.amount) <= 0) out.amount = "A positive amount, up to 6 decimals.";
  else if (Number(inputs.amount) > 10_000_000) out.amount = "At most 10,000,000 USDC.";
  if (!/^\d+(\.\d{1,9})?$/.test(inputs.maxGasGwei) || Number(inputs.maxGasGwei) <= 0) out.maxGasGwei = "A positive number of gwei.";
  else if (Number(inputs.maxGasGwei) > 10_000) out.maxGasGwei = "At most 10,000 gwei.";
  return out;
}

function setStatus(tone, word, detail) {
  $("status").dataset.tone = tone;
  $("status-word").textContent = word;
  $("status-detail").textContent = detail;
}

function setBusy(busy) {
  $("guard").setAttribute("aria-busy", String(busy));
  $("again").setAttribute("aria-disabled", String(busy));
}

function addressLink(address, what) {
  const link = el("a", "short", short(address));
  link.title = address;
  linkExplorer(link, "address", address, what);
  if (link.hidden) {
    const text = el("span", "short", short(address));
    text.title = address;
    return text;
  }
  return link;
}

function renderChecks(conditions) {
  const list = $("checks");
  list.replaceChildren(
    ...conditions.map((condition) => {
      const state = condition.passed === true ? "pass" : condition.passed === false ? "fail" : "unknown";
      const row = el("li", "check");
      row.dataset.state = state;
      row.dataset.id = condition.id;
      const mark = el("span", "check-mark");
      mark.setAttribute("aria-hidden", "true");
      mark.append(svgIcon(MARK[state]));
      const body = el("span", "check-main");
      const label = el("span", "check-label", condition.label);
      label.append(el("span", "sr", `: ${SAYS[state]}.`));
      const evidence = el("span", "check-evidence");
      // A comparison shows the value against its threshold; an equality only shows what it needed when it failed.
      const numeric = ["<", "<=", ">", ">="].includes(condition.op);
      if (condition.observed !== null) evidence.append(el("span", "check-seen", condition.observed));
      if (numeric) evidence.append(el("span", "check-need", `${condition.observed === null ? "needs " : ""}${OPS[condition.op]} ${condition.threshold}`));
      else if (state !== "pass") evidence.append(el("span", "check-need", `${condition.op === "!=" ? "must not be" : "needs"} ${condition.threshold}`));
      evidence.append(el("span", "check-tool", condition.tool));
      if (condition.error) evidence.append(el("span", "check-error", condition.error));
      body.append(label, evidence);
      row.append(mark, body);
      return row;
    }),
  );
}

/** Wei as gwei, exactly, to at most 4 decimals: "1.2 gwei". */
function gwei(wei) {
  const value = BigInt(wei);
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").slice(0, 4).replace(/0+$/, "");
  return `${group(whole.toString())}${fraction ? `.${fraction}` : ""} gwei`;
}

function renderAction(result, inputs) {
  const action = result.action;
  $("act").hidden = !action;
  if (!action) return;
  const amount = /^Transfer (\S+ \S+)/.exec(action.summary)?.[1] ?? `${inputs.amount} USDC`;
  $("act-what").replaceChildren(`${amount} from `, addressLink(inputs.payer, "the payer"), " to ", addressLink(inputs.recipient, "the recipient"));
  const sim = $("act-sim");
  sim.textContent = action.simulation.ok ? `Returns true at block ${group(action.simulation.block)}.` : action.reason ?? "The simulation failed.";
  sim.dataset.tone = action.simulation.ok ? "" : "error";
  const gas = $("act-gas");
  if (action.gas) gas.replaceChildren(`${group(action.gas)} gas at ${gwei(action.gasPrice)} = ${action.cost.display}`, el("span", "sub", `The payer holds ${action.payerBalance.display}.`));
  else gas.textContent = "Not estimated: the simulation failed.";
  const sent = $("act-sent");
  sent.textContent = action.status === "ready" ? "No. The hosted Chain MCP is read-only; the CLI executes on Atlantic after re-reading every condition." : `No. ${action.simulation.ok ? action.reason : "A payout that fails in simulation is never sent."}`;
  sent.dataset.tone = action.status === "ready" ? "" : "error";
}

function describeCall(call) {
  const parts = [];
  const args = call.args ?? {};
  const tx = args.transaction;
  if (tx) {
    if (tx.from) parts.push(`from ${short(tx.from)}`);
    parts.push(`to ${short(tx.to)}`);
    if (tx.data) parts.push(`data ${tx.data.length > 18 ? `${tx.data.slice(0, 10)}…` : tx.data}`);
  }
  if (args.address) parts.push(short(args.address));
  if (typeof args.block === "string") parts.push(/^0x[0-9a-f]+$/i.test(args.block) ? `@ ${group(BigInt(args.block).toString())}` : `@ ${args.block}`);
  return parts.join(" ");
}

function renderCalls(calls) {
  $("calls").replaceChildren(
    ...calls.map((call) => {
      const item = el("li");
      const body = el("span", "call-body");
      body.append(el("span", "call-tool", call.tool), ` ${describeCall(call)}`);
      if (!call.ok) body.append(el("span", "call-failed", " (error)"));
      item.append(body);
      return item;
    }),
  );
}

function render(body) {
  const { result, inputs, calls } = body;
  const { decision, outcome } = result;
  const failed = result.conditions.filter((c) => c.passed === false).length;
  const unread = result.conditions.filter((c) => c.passed === null).length;
  if (outcome === "fire") setStatus("success", "Fire", `all ${decision.total} conditions hold`);
  else if (outcome === "blocked") setStatus("error", "Blocked", "the conditions hold; the payout does not");
  else setStatus("warning", "Hold", [`${decision.passed} of ${decision.total} hold`, failed ? `${failed} ${failed === 1 ? "fails" : "fail"}` : "", unread ? `${unread} unreadable` : ""].filter(Boolean).join(", "));
  $("pin").hidden = false;
  $("pin-block").textContent = group(result.block.number);
  $("pin-time").textContent = clockTime(result.block.timestamp);
  $("pin-time").title = result.block.timestamp;
  $("pin-calls").textContent = `${result.toolCalls} calls`;
  const why = $("why");
  why.hidden = outcome !== "blocked";
  why.textContent = outcome === "blocked" ? `${result.action.reason} Nothing was sent.` : "";
  renderChecks(result.conditions);
  const rule = $("rule");
  rule.hidden = outcome !== "hold";
  rule.textContent = outcome === "hold" ? `Fires only when all ${decision.total} hold, so nothing was prepared or sent.` : "";
  renderAction(result, inputs);
  renderCalls(calls);
  $("json").textContent = JSON.stringify(body, null, 2);
  $("error").hidden = true;
}

function showError(message) {
  setStatus("error", "Not evaluated", "see below");
  $("why").hidden = true;
  const note = $("error");
  note.textContent = message;
  note.hidden = false;
}

let inFlight = null;

async function evaluate(inputs) {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  setBusy(true);
  setStatus("active", "Evaluating", "reading Pharos Mainnet");
  try {
    const response = await fetch(`${API}?${new URLSearchParams({ task: "05", ...inputs })}`, { headers: { accept: "application/json" }, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (controller !== inFlight) return;
    if (!response.ok || !body?.result) showError(body?.error ? [body.error.message, body.error.hint].filter(Boolean).join(" ") : `The guardian answered HTTP ${response.status}.`);
    else render(body);
  } catch (error) {
    if (error?.name === "AbortError") return;
    showError("Could not reach the guardian. Check the connection and try again.");
  } finally {
    if (controller === inFlight) {
      inFlight = null;
      setBusy(false);
    }
  }
}

let current = initialInputs();

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
}

function summarize(inputs) {
  $("change-meta").textContent = `${inputs.amount} USDC · gas cap ${inputs.maxGasGwei} gwei`;
}

fill(current);
summarize(current);

$("payout").addEventListener("submit", (event) => {
  event.preventDefault();
  const inputs = Object.fromEntries(Object.entries(FIELDS).map(([key, input]) => [key, input.value.trim()]));
  const wrong = problems(inputs);
  for (const [key, input] of Object.entries(FIELDS)) {
    input.setAttribute("aria-invalid", String(Boolean(wrong[key])));
    HINTS[key].textContent = wrong[key] ?? HINT_TEXT[key];
    HINTS[key].classList.toggle("invalid", Boolean(wrong[key]));
  }
  const first = Object.keys(FIELDS).find((key) => wrong[key]);
  if (first) {
    FIELDS[first].focus();
    return;
  }
  current = inputs;
  summarize(current);
  history.replaceState(null, "", `?${new URLSearchParams(current)}`);
  evaluate(current);
  $("decision-h").focus({ preventScroll: true });
  $("guard").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});

$("reset").addEventListener("click", () => fill(EXAMPLE));

$("again").addEventListener("click", () => {
  if ($("again").getAttribute("aria-disabled") === "true") return;
  evaluate(current);
});

wireToggle($("json-toggle"), (open) => ($("json-toggle").textContent = open ? "Hide the JSON" : "Show the result as JSON"));

evaluate(current);
