// Task 11 page: the gatekeeper. Checks once on load (the example request, or the one in the address bar),
// and again on demand; every check is GET /api/agent?task=11, which reads Pharos Mainnet through the
// hosted Chain MCP and returns every rule of the treasury policy, the decision and the request's dry run.
// Nothing is signed or sent. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, amountText, describeRequest, el, group, queryInputs, renderChecks, setStatus, units, wireForm } from "./agent.js";
import { renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "11", LAB);

/** PROS and the official Pharos Mainnet tokens with their decimals, as agent/src/core/networks.ts has them (a test keeps the two equal). */
const ASSETS = Object.freeze({ PROS: 18, WPROS: 18, USDC: 6, LINK: 18, WETH: 18 });
const NATIVE = "PROS";
const EXAMPLE = Object.freeze({ action: "transfer", asset: "USDC", from: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", to: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "25", hoursFrom: "06:00", hoursTo: "22:00" });
const FIELDS = { action: $("f-action"), asset: $("f-asset"), from: $("f-from"), to: $("f-to"), amount: $("f-amount"), hoursFrom: $("f-hours-from"), hoursTo: $("f-hours-to") };

/** "HH:MM" from 00:00 to 24:00 as minutes, or NaN. */
const minutes = (time) => {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[2]) > 59 || Number(match[1]) > 24 || (match[1] === "24" && match[2] !== "00")) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
};

/** What is wrong with each input, by field; empty when the request can be checked. */
function problems(inputs) {
  const out = {};
  const approve = inputs.action === "approve";
  if (inputs.action !== "transfer" && !approve) out.action = "Pick transfer or approve.";
  if (!Object.hasOwn(ASSETS, inputs.asset) || (approve && inputs.asset === NATIVE)) out.asset = "Pick an asset from the list.";
  if (!ADDRESS.test(inputs.from)) out.from = "Enter a 0x address of 40 hex characters.";
  if (!ADDRESS.test(inputs.to)) out.to = "Enter a 0x address of 40 hex characters.";
  const places = ASSETS[inputs.asset] ?? 18;
  if (!(approve && inputs.amount === "max")) {
    if (!new RegExp(`^\\d+(\\.\\d{1,${places}})?$`).test(inputs.amount) || !/[1-9]/.test(inputs.amount)) out.amount = `A positive amount, up to ${places} decimals${approve ? ", or max" : ""}.`;
    else if (Number(inputs.amount) > 1e12) out.amount = "At most 1,000,000,000,000.";
  }
  if (Number.isNaN(minutes(inputs.hoursFrom))) out.hoursFrom = "A time like 06:00.";
  if (Number.isNaN(minutes(inputs.hoursTo))) out.hoursTo = "A time like 22:00 (24:00 ends the day).";
  else if (minutes(inputs.hoursTo) === minutes(inputs.hoursFrom)) out.hoursTo = "Different from the start.";
  return out;
}

/** The request from the address bar where it is complete and well formed, else the example. */
function initialInputs() {
  const fromQuery = queryInputs(Object.keys(EXAMPLE));
  return fromQuery && Object.keys(problems(fromQuery)).length === 0 ? fromQuery : { ...EXAMPLE };
}

/** Labels and hints follow the action and the asset; an approval cannot be of PROS. */
function adapt() {
  const approve = FIELDS.action.value === "approve";
  FIELDS.asset.querySelector(`option[value="${NATIVE}"]`).disabled = approve;
  if (approve && FIELDS.asset.value === NATIVE) FIELDS.asset.value = "USDC";
  const asset = FIELDS.asset.value;
  $("l-to").textContent = approve ? "Spender" : "Recipient";
  $("l-amount").textContent = `Amount, ${asset}`;
  const hints = { to: approve ? `May then move the sender's ${asset}.` : `Receives the ${asset}.`, amount: `Up to ${ASSETS[asset]} decimals${approve ? ", or max for unlimited" : ""}.` };
  for (const [key, text] of Object.entries(hints)) {
    const hint = $(`h-${key}`);
    hint.dataset.hint = text;
    if (!hint.classList.contains("invalid")) hint.textContent = text;
  }
}

const bare = (limit) => limit.replace(/^≤ /, "");
/** What a rule could not read, by kind (only rules that read the chain can be unreadable). */
const UNREAD = { "max-in-window": "the sender's transfers", "time-window": "the block's time", "max-gas-price": "the gas price", simulates: "the dry run" };

/** Why a rule denies, in a few words. */
function reason(rule, role) {
  if (rule.passed === null) return `${UNREAD[rule.kind] ?? rule.label} could not be read`;
  switch (rule.kind) {
    case "asset-allowlist":
      return `${rule.observed} is not an allowed asset`;
    case "counterparty-allowlist":
      return `the ${role} is not on the allowlist`;
    case "max-per-action":
      return rule.observed.startsWith("unlimited") ? "an unlimited approval is over any limit" : `${rule.observed} is over the ${bare(rule.limit)} limit per action`;
    case "max-in-window":
      return `${rule.observed} in the window is over ${bare(rule.limit)}`;
    case "time-window":
      return `${rule.observed} is ${rule.note === "Not an allowed day." ? "not on an allowed day" : "outside the allowed hours"}`;
    case "max-gas-price":
      return `gas at ${rule.observed} is over ${bare(rule.limit)}`;
    case "simulates":
      return rule.observed === "reverts" ? "it reverts in a dry run" : "the sender cannot pay the fee";
    default:
      return rule.label;
  }
}

/** The rules as check rows: what was found and where. Each label already states its limit, so the limit is not repeated. */
function renderRules(result, role) {
  renderChecks(
    $("checks"),
    result.rules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      passed: rule.passed,
      seen: rule.observed === null ? null : ADDRESS.test(rule.observed) ? addressLink(rule.observed, `the ${role}`) : rule.observed,
      need: null,
      tool: rule.tool,
      note: rule.note,
      error: rule.error,
    })),
  );
}

/** What the request would do if sent, from its dry run at the same block. */
function renderAct(result) {
  const dry = result.dryRun;
  $("act").hidden = false;
  const sim = $("act-sim");
  const succeeds = dry?.verdict === "would-succeed";
  sim.textContent = !dry ? "Could not be read." : succeeds ? `Would succeed at block ${group(dry.block.number)}.` : dry.reason;
  sim.dataset.tone = succeeds ? "" : "error";
  $("act-moves-row").hidden = !succeeds;
  if (succeeds) {
    // The sender's PROS line is the gas (shown below), except in a PROS transfer, where it is the value and the gas.
    const lines = dry.outcome.filter((line) => !line.approximate || dry.intent.kind === "native-transfer");
    const moves = lines.map((line) => `${line.role} ${line.shown.change}${line.approximate ? " with gas" : ""}`).join(", ");
    $("act-moves").textContent = moves ? `${moves[0].toUpperCase()}${moves.slice(1)}.` : "Nothing but the gas.";
  }
  $("act-gas-row").hidden = !dry?.gas;
  if (dry?.gas) $("act-gas").replaceChildren(`About ${units(dry.gas.expectedCost, 18, 8)} ${NATIVE}`, el("span", "sub", `At most ${units(dry.gas.maxCost, 18, 8)} ${NATIVE}.`));
  $("act-sent").textContent = result.decision.allowed ? "No. The hosted Chain MCP is read-only; the CLI sends allowed requests on Atlantic." : "No. A denied request is never signed.";
}

function render({ result, inputs }) {
  const { decision } = result;
  const role = inputs.action === "approve" ? "spender" : "recipient";
  const failing = result.rules.filter((rule) => rule.passed !== true);
  const { failed, unreadable, total } = decision;
  if (decision.allowed) setStatus("success", "Allowed", `all ${total} rules hold`);
  else setStatus("error", "Denied", [failed.length ? `${failed.length} of ${total} rules ${failed.length === 1 ? "fails" : "fail"}` : "", unreadable.length ? `${unreadable.length} unreadable` : ""].filter(Boolean).join(", "));
  const tx = $("tx");
  tx.hidden = false;
  tx.replaceChildren(...describeRequest(inputs));
  const why = $("why");
  why.hidden = decision.allowed;
  const reasons = failing.map((rule) => reason(rule, role));
  why.textContent = decision.allowed ? "" : `Not allowed: ${reasons.join("; ")}. Nothing was signed.`;
  renderRules(result, role);
  renderAct(result);
}

const check = agentRunner({ task: "11", panel: $("gate"), running: ["Checking", "reading Pharos Mainnet"], failed: "Not checked", render, onFail: () => ($("why").hidden = true) });

let current = initialInputs();

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
  adapt();
}

function summarize(inputs) {
  $("change-meta").textContent = `${inputs.action === "approve" ? "Approve" : "Transfer"} · ${amountText(inputs.amount)} ${inputs.asset} · ${inputs.hoursFrom}–${inputs.hoursTo} UTC`;
}

fill(current);
summarize(current);
FIELDS.action.addEventListener("change", adapt);
FIELDS.asset.addEventListener("change", adapt);

wireForm({
  form: $("request"),
  fields: FIELDS,
  problems,
  result: { heading: $("decision-h"), panel: $("gate") },
  submit(inputs) {
    current = inputs;
    summarize(current);
    history.replaceState(null, "", `?${new URLSearchParams(current)}`);
    check(current);
  },
});

$("reset").addEventListener("click", () => fill(EXAMPLE));

check(current);
