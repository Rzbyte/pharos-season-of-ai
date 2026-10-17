// Task 05 page: the payout guardian. Evaluates once on load (the example payout, or the one in the
// address bar), and again on demand; every evaluation is GET /api/agent?task=05, which reads Pharos
// Mainnet through the hosted Chain MCP and returns the decision, the conditions and the simulated
// payout. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, el, group, gwei, queryInputs, renderChecks, setStatus, wireForm } from "./agent.js";
import { renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "05", LAB);

const EXAMPLE = Object.freeze({ payer: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", recipient: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "25", maxGasGwei: "10" });
const FIELDS = { payer: $("f-payer"), recipient: $("f-recipient"), amount: $("f-amount"), maxGasGwei: $("f-gas") };
const OPS = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "==": "=", "!=": "≠" };

/** The payout from the address bar where it is complete and well formed, else the example. */
function initialInputs() {
  const fromQuery = queryInputs(Object.keys(EXAMPLE));
  return fromQuery && Object.keys(problems(fromQuery)).length === 0 ? fromQuery : { ...EXAMPLE };
}

/** What is wrong with each input, by field; empty when the payout can be evaluated. */
function problems(inputs) {
  const out = {};
  if (!ADDRESS.test(inputs.payer)) out.payer = "Enter a 0x address of 40 hex characters.";
  if (!ADDRESS.test(inputs.recipient)) out.recipient = "Enter a 0x address of 40 hex characters.";
  else if (inputs.recipient.toLowerCase() === inputs.payer.toLowerCase()) out.recipient = "Pick a recipient other than the payer.";
  if (!/^\d+(\.\d{1,6})?$/.test(inputs.amount) || Number(inputs.amount) <= 0) out.amount = "A positive amount, up to 6 decimals.";
  else if (Number(inputs.amount) > 10_000_000) out.amount = "At most 10,000,000 USDC.";
  if (!/^\d+(\.\d{1,9})?$/.test(inputs.maxGasGwei) || Number(inputs.maxGasGwei) <= 0) out.maxGasGwei = "A positive number of gwei.";
  else if (Number(inputs.maxGasGwei) > 10_000) out.maxGasGwei = "At most 10,000 gwei.";
  return out;
}

/** The conditions as check rows: a comparison shows the value against its threshold; an equality only shows what it needed when it failed. */
function renderConditions(conditions) {
  renderChecks(
    $("checks"),
    conditions.map((condition) => {
      const numeric = ["<", "<=", ">", ">="].includes(condition.op);
      const need = numeric ? `${condition.observed === null ? "needs " : ""}${OPS[condition.op]} ${condition.threshold}` : condition.passed === true ? null : `${condition.op === "!=" ? "must not be" : "needs"} ${condition.threshold}`;
      return { id: condition.id, label: condition.label, passed: condition.passed, seen: condition.observed, need, tool: condition.tool, error: condition.error };
    }),
  );
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

function render({ result, inputs }) {
  const { decision, outcome } = result;
  const failed = result.conditions.filter((c) => c.passed === false).length;
  const unread = result.conditions.filter((c) => c.passed === null).length;
  if (outcome === "fire") setStatus("success", "Fire", `all ${decision.total} conditions hold`);
  else if (outcome === "blocked") setStatus("error", "Blocked", "the conditions hold; the payout does not");
  else setStatus("warning", "Hold", [`${decision.passed} of ${decision.total} hold`, failed ? `${failed} ${failed === 1 ? "fails" : "fail"}` : "", unread ? `${unread} unreadable` : ""].filter(Boolean).join(", "));
  const why = $("why");
  why.hidden = outcome !== "blocked";
  why.textContent = outcome === "blocked" ? `${result.action.reason} Nothing was sent.` : "";
  renderConditions(result.conditions);
  const rule = $("rule");
  rule.hidden = outcome !== "hold";
  rule.textContent = outcome === "hold" ? `Fires only when all ${decision.total} hold, so nothing was prepared or sent.` : "";
  renderAction(result, inputs);
}

const evaluate = agentRunner({ task: "05", panel: $("guard"), running: ["Evaluating", "reading Pharos Mainnet"], failed: "Not evaluated", render, onFail: () => ($("why").hidden = true) });

let current = initialInputs();

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
}

function summarize(inputs) {
  $("change-meta").textContent = `${inputs.amount} USDC · gas cap ${inputs.maxGasGwei} gwei`;
}

fill(current);
summarize(current);

wireForm({
  form: $("payout"),
  fields: FIELDS,
  problems,
  result: { heading: $("decision-h"), panel: $("guard") },
  submit(inputs) {
    current = inputs;
    summarize(current);
    history.replaceState(null, "", `?${new URLSearchParams(current)}`);
    evaluate(current);
  },
});

$("reset").addEventListener("click", () => fill(EXAMPLE));

evaluate(current);
