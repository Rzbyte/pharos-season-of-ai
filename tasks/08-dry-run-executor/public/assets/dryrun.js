// Task 08 page: the dry run. Simulates once on load (the example transfer, or the transaction in the
// address bar), and again on demand; every run is GET /api/agent?task=08, which reads Pharos Mainnet
// through the hosted Chain MCP and returns the verdict, the predicted outcome and the cost. Nothing is
// signed or sent. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, amountText, describeRequest, el, group, gwei, queryInputs, setStatus, units, wireForm } from "./agent.js";
import { renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "08", LAB);

/** PROS and the official Pharos Mainnet tokens with their decimals, as agent/src/core/networks.ts has them (a test keeps the two equal). */
const ASSETS = Object.freeze({ PROS: 18, WPROS: 18, USDC: 6, LINK: 18, WETH: 18 });
const NATIVE = "PROS";
const EXAMPLE = Object.freeze({ action: "transfer", asset: "USDC", from: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", to: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "25" });
const FIELDS = { action: $("f-action"), asset: $("f-asset"), from: $("f-from"), to: $("f-to"), amount: $("f-amount") };

/** What is wrong with each input, by field; empty when the transaction can be dry-run. */
function problems(inputs) {
  const out = {};
  const approve = inputs.action === "approve";
  if (inputs.action !== "transfer" && !approve) out.action = "Pick transfer or approve.";
  if (!Object.hasOwn(ASSETS, inputs.asset)) out.asset = "Pick an asset from the list.";
  else if (approve && inputs.asset === NATIVE) out.asset = `Only a token can be approved, not ${NATIVE}.`;
  if (!ADDRESS.test(inputs.from)) out.from = "Enter a 0x address of 40 hex characters.";
  if (!ADDRESS.test(inputs.to)) out.to = "Enter a 0x address of 40 hex characters.";
  const places = ASSETS[inputs.asset] ?? 18;
  if (approve && inputs.amount === "max") return out;
  if (!new RegExp(`^\\d+(\\.\\d{1,${places}})?$`).test(inputs.amount) || !/[1-9]/.test(inputs.amount)) out.amount = `A positive amount, up to ${places} decimals${approve ? ", or max" : ""}.`;
  else if (Number(inputs.amount) > 1e12) out.amount = "At most 1,000,000,000,000.";
  return out;
}

/** The transaction from the address bar where it is complete and well formed, else the example. */
function initialInputs() {
  const fromQuery = queryInputs(Object.keys(EXAMPLE));
  return fromQuery && Object.keys(problems(fromQuery)).length === 0 ? fromQuery : { ...EXAMPLE };
}

/** Labels and hints follow the action and the asset; an approval cannot be of PROS. */
function adapt() {
  const approve = FIELDS.action.value === "approve";
  const pros = FIELDS.asset.querySelector(`option[value="${NATIVE}"]`);
  pros.disabled = approve;
  if (approve && FIELDS.asset.value === NATIVE) FIELDS.asset.value = "USDC";
  const asset = FIELDS.asset.value;
  $("l-to").textContent = approve ? "Spender" : "Recipient";
  $("l-amount").textContent = `Amount, ${asset}`;
  const hints = {
    from: approve ? `Owns the ${asset} and pays the gas.` : `Sends the ${asset} and pays the gas.`,
    to: approve ? `May then move the sender's ${asset}.` : `Receives the ${asset}.`,
    amount: `Up to ${ASSETS[asset]} decimals${approve ? ", or max for unlimited" : ""}.`,
  };
  for (const [key, text] of Object.entries(hints)) {
    const hint = $(`h-${key}`);
    hint.dataset.hint = text;
    if (!hint.classList.contains("invalid")) hint.textContent = text;
  }
}

function renderOutcome(result) {
  const succeeds = result.verdict === "would-succeed";
  $("outcome").hidden = false;
  $("outcome-h").textContent = succeeds ? "Outcome if sent" : "Balances at this block";
  $("changes").replaceChildren(
    ...result.outcome.map((line) => {
      const row = el("li", "change");
      const change = line.after === null ? null : BigInt(line.after) - BigInt(line.before);
      row.dataset.role = line.role;
      row.dataset.dir = change === null ? "none" : change < 0n ? "down" : change > 0n ? "up" : "same";
      const who = el("span", "change-who");
      if (line.role === "allowance") who.append("Allowance to ", addressLink(line.spender, "the spender"));
      else who.append(line.role === "sender" ? "Sender " : "Recipient ", addressLink(line.address, line.role === "sender" ? "the sender" : "the recipient"));
      // A transaction that would not go through changes nothing: each value is shown as it is.
      row.append(who, el("span", "change-delta", change === null ? line.shown.before : line.shown.change));
      if (change === null) return row;
      const span = el("span", "change-span", `${line.shown.before} → ${line.shown.after}`);
      if (line.approximate) span.append(el("span", "change-gas", "pays the gas"));
      row.append(span);
      return row;
    }),
  );
  const warnings = $("warnings");
  warnings.hidden = result.warnings.length === 0;
  warnings.replaceChildren(
    ...result.warnings.map((warning) => {
      const item = el("li", "note", warning.message);
      item.dataset.tone = "warning";
      item.dataset.code = warning.code;
      return item;
    }),
  );
}

function renderCost(result) {
  const { gas, simulation, verdict } = result;
  $("cost").hidden = false;
  const sim = $("cost-sim");
  sim.textContent = simulation.ok ? `Succeeds at block ${group(simulation.block)}${result.returns ? `, returns ${result.returns}` : ""}.` : `Reverts at block ${group(simulation.block)}.`;
  sim.dataset.tone = simulation.ok && result.returns !== "false" ? "" : "error";
  $("cost-gas").textContent = gas ? `${group(gas.gas)} estimated, ${group(gas.gasLimit)} limit` : "Not estimated: it would not go through.";
  $("cost-fee-row").hidden = !gas;
  if (gas) $("cost-fee").replaceChildren(`About ${units(gas.expectedCost, 18, 8)} ${NATIVE} at ${gwei(gas.expectedFeePerGas)}`, el("span", "sub", `At most ${units(gas.maxCost, 18, 8)} ${NATIVE}, under the ${gwei(gas.maxFeePerGas)} cap.`));
  const funds = $("cost-funds");
  funds.textContent = `Holds ${result.funds.shown.holds}${result.funds.shown.needs ? `; needs up to ${result.funds.shown.needs}` : ""}.`;
  funds.dataset.tone = verdict === "cannot-pay" ? "error" : "";
  $("cost-sent").textContent = "No. The hosted Chain MCP is read-only; the CLI submits on Atlantic and checks the receipt against the prediction.";
}

function render({ result, inputs }) {
  const { verdict, gas, warnings } = result;
  const warned = warnings.length ? `${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}` : "";
  if (verdict === "would-succeed") setStatus("success", "Would succeed", [gas ? `about ${units(gas.expectedCost, 18, 8)} ${NATIVE} in gas` : "", warned].filter(Boolean).join(", "));
  else if (verdict === "would-revert") setStatus("error", "Would revert", "in simulation");
  else setStatus("error", "Can't pay", `the sender is short of ${NATIVE}`);
  const tx = $("tx");
  tx.hidden = false;
  tx.replaceChildren(...describeRequest(inputs));
  const why = $("why");
  why.hidden = verdict === "would-succeed";
  why.textContent = verdict === "would-succeed" ? "" : `${result.reason} Nothing was sent.`;
  renderOutcome(result);
  renderCost(result);
}

const simulate = agentRunner({ task: "08", panel: $("run"), running: ["Simulating", "reading Pharos Mainnet"], failed: "Not simulated", render, onFail: () => ($("why").hidden = true) });

let current = initialInputs();

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
  adapt();
}

function summarize(inputs) {
  $("change-meta").textContent = `${inputs.action === "approve" ? "Approve" : "Transfer"} · ${amountText(inputs.amount)} ${inputs.asset}`;
}

fill(current);
summarize(current);
FIELDS.action.addEventListener("change", adapt);
FIELDS.asset.addEventListener("change", adapt);

wireForm({
  form: $("tx-form"),
  fields: FIELDS,
  problems,
  result: { heading: $("verdict-h"), panel: $("run") },
  submit(inputs) {
    current = inputs;
    summarize(current);
    history.replaceState(null, "", `?${new URLSearchParams(current)}`);
    simulate(current);
  },
});

$("reset").addEventListener("click", () => fill(EXAMPLE));

simulate(current);
