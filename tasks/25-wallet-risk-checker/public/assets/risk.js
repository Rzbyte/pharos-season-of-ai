// Task 25 page: the wallet risk checker. Checks once on load (Task 08's example transfer, or the
// transaction in the address bar), and again on demand; every check is GET /api/agent?task=25, which reads
// the counterparty's history on Pharos Mainnet through the hosted Chain MCP and returns each signal with
// its source, the risk level and the verdict. Nothing is signed or sent. Everything is set as text, never
// as markup.
import { $, addressLink, ADDRESS, agentRunner, amountText, describeRequest, el, group, queryInputs, setStatus, short, wireForm } from "./agent.js";
import { renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "25", LAB);

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

/**
 * The lookalike example copies the address the example sender moved USDC with most in the latest check's
 * blocks; until a check finds one, 0x1F35…c85C, which traded with it in Task 02's live proof.
 */
let partner = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
/** Made up: an address's first and last four characters around zeros, the way address poisoning copies one. */
const lookalikeOf = (address) => `0x${address.slice(2, 6)}${"0".repeat(32)}${address.slice(-4)}`.toLowerCase();
/** An unused address, as the spender of an unlimited approval. */
const UNUSED = "0x3333333333333333333333333333333333333333";
const VERDICTS = Object.freeze({ "do-not-send": ["error", "Do not send"], "check-first": ["warning", "Check first"], "looks-fine": ["success", "Looks fine"] });

function renderSignals(signals) {
  $("signals-box").hidden = false;
  const counted = signals.filter((s) => s.severity !== "info").length;
  $("signals-meta").textContent = signals.length ? `${counted} to weigh${signals.length > counted ? `, ${signals.length - counted} for information` : ""}` : "";
  $("signals-empty").hidden = signals.length > 0;
  $("signals").replaceChildren(
    ...signals.map((s) => {
      const row = el("li", "signal");
      row.dataset.severity = s.severity;
      row.append(el("span", "signal-level", s.severity), el("span", "signal-title", s.title), el("span", "signal-tool", s.tool), el("span", "signal-detail", s.detail));
      return row;
    }),
  );
}

function fact(label, ...value) {
  const row = el("div");
  const dd = el("dd");
  dd.append(...value);
  row.append(el("dt", "", label), dd);
  return row;
}

function renderCounterparty(result) {
  const c = result.counterparty;
  const h = result.history;
  $("who-box").hidden = false;
  const code = c.code === "none" ? "None: a wallet" : c.code === "delegated" ? ["Delegated to ", addressLink(c.delegate, "the contract it runs")] : `A contract${c.token ? `, the ${c.token} token` : ""}`;
  $("who").replaceChildren(
    fact("Address", addressLink(c.address, `the ${result.transaction.role}`)),
    fact("Role", `The ${result.transaction.role}`),
    fact("Code", ...[code].flat()),
    fact("Sent", c.nonce === "0" ? "No transaction yet" : `${group(c.nonce)} ${c.nonce === "1" ? "transaction" : "transactions"}`),
    fact("Holds", c.balanceShown),
    ...(h ? [fact("History", `${h.withSender} ${h.token} ${h.withSender === 1 ? "transfer" : "transfers"} with the sender in blocks ${group(h.from)}–${group(h.to)}${h.zeroValue ? `, and ${h.zeroValue} of nothing` : ""}`)] : []),
  );
}

/** The verdict, and in a few words the reason for it: the top signal's title, which the list below explains. */
function render({ result, inputs }) {
  const [tone, word] = VERDICTS[result.verdict];
  const top = result.verdict === "looks-fine" ? null : result.signals.find((s) => s.severity !== "info");
  setStatus(tone, word, top ? top.title.charAt(0).toLowerCase() + top.title.slice(1) : "nothing suspicious found");
  const tx = $("tx");
  tx.hidden = false;
  tx.replaceChildren(...describeRequest(inputs));
  renderSignals(result.signals);
  renderCounterparty(result);
  const busiest = result.history?.partners[0]?.address;
  if (busiest && result.transaction.from.toLowerCase() === EXAMPLE.from.toLowerCase()) {
    partner = busiest;
    $("ex-lookalike").textContent = `A made-up lookalike of ${short(partner)}`;
  }
}

const check = agentRunner({ task: "25", panel: $("check"), running: ["Checking", "reading Pharos Mainnet"], failed: "Not checked", render });

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
  adapt();
}

function summarize(inputs) {
  $("change-meta").textContent = `${inputs.action === "approve" ? "Approve" : "Transfer"} ${amountText(inputs.amount)} ${inputs.asset}`;
}

let current = initialInputs();
fill(current);
summarize(current);

function run(inputs) {
  current = inputs;
  fill(current);
  summarize(current);
  history.replaceState(null, "", `?${new URLSearchParams(current)}`);
  check(current);
}

wireForm({ form: $("settings"), fields: FIELDS, problems, result: { heading: $("risk-h"), panel: $("check") }, submit: run });
FIELDS.action.addEventListener("change", adapt);
FIELDS.asset.addEventListener("change", adapt);
$("reset").addEventListener("click", () => fill(EXAMPLE));
$("ex-lookalike").addEventListener("click", () => run({ ...EXAMPLE, to: lookalikeOf(partner) }));
$("ex-approval").addEventListener("click", () => run({ ...EXAMPLE, action: "approve", to: UNUSED, amount: "max" }));

check(current);
