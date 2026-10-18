// Task 21 page: the X402 Agent Buyer. A job (a planned transfer to check before it is sent) and a budget
// go to GET /api/agent?task=21&…, which runs the buyer against Task 20's x402 API on Pharos Mainnet: the
// prices asked, the plan within the budget, the first purchase signed with a key made for the request
// (which holds nothing, so the API's facilitator refuses it on chain), and the job's outcome. Nothing
// settles from here. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, el, group, setStatus, short } from "./agent.js";
import { linkExplorer, renderTaskNav, wireCopy } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "21", LAB);

/** The example: Task 08's transfer (the example sender to the example recipient), with 0.01 USDC to spend. */
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const EXAMPLE = Object.freeze({ amount: "25", asset: "USDC", to: RECIPIENT, budget: "0.01" });
const EXAMPLES = Object.freeze({ example: EXAMPLE, check: { ...EXAMPLE, budget: "0.006" }, short: { ...EXAMPLE, budget: "0.001" } });
const ASSETS = Object.freeze(["USDC", "PROS", "WPROS", "WETH", "LINK"]);
const AMOUNT = /^\d+(\.\d+)?$/;
const BUDGET = /^\d+(\.\d{1,6})?$/;
const MAX_BUDGET = 1_000_000;
const HINT = { amount: $("h-amount").textContent, to: $("h-to").textContent, from: $("h-from").textContent, budget: $("h-budget").textContent };
const VERDICTS = Object.freeze({
  ready: ["success", "Ready", "to sign"],
  "do-not-send": ["error", "Do not send", "what it bought says so"],
  "check-first": ["warning", "Check first", "what it bought says so"],
  "would-fail": ["error", "Would fail", "the dry run says so"],
  "not-done": ["warning", "Not done", "see why below"],
});
const STATUS = Object.freeze({ bought: "Bought", refused: "Refused", "not-needed": "Not needed", "over-budget": "Not bought", unpriced: "Not bought" });
const RISK = Object.freeze({ "looks-fine": "Looks fine", "check-first": "Check first", "do-not-send": "Do not send" });
const DRY = Object.freeze({ "would-succeed": "Would succeed", "would-revert": "Would revert", "cannot-pay": "Cannot pay its gas" });

/** What to run first: the job in the address bar, else the example. */
function initialRequest() {
  const query = new URLSearchParams(location.search);
  const get = (key) => query.get(key)?.trim() ?? "";
  const asset = get("asset");
  return {
    amount: AMOUNT.test(get("amount")) ? get("amount") : EXAMPLE.amount,
    asset: ASSETS.includes(asset) ? asset : EXAMPLE.asset,
    to: ADDRESS.test(get("to")) ? get("to") : EXAMPLE.to,
    ...(ADDRESS.test(get("from")) ? { from: get("from") } : {}),
    budget: BUDGET.test(get("budget")) ? get("budget") : EXAMPLE.budget,
  };
}

const plain = (text, title) => Object.assign(el("span", "short", text), { title });
/** The page's explorer is Pharos Mainnet's: a run on another network is shown, never linked there. */
let linked = true;
const addr = (address, what) => (linked ? addressLink(address, what) : plain(short(address), address));
const hexShort = (hex) => (hex.length > 22 ? `${hex.slice(0, 10)}…${hex.slice(-8)}` : hex);

function txLink(hash) {
  if (!linked) return plain(hexShort(hash), hash);
  const link = el("a", "short", hexShort(hash));
  link.title = hash;
  linkExplorer(link, "tx", hash, "the settlement");
  return link.hidden ? plain(hexShort(hash), hash) : link;
}

/** A row of a description list: the term, then the value (text or nodes) and a line under it. */
function row(term, value, sub, tone) {
  const box = el("div");
  const dd = el("dd");
  dd.append(...[value].flat());
  if (tone) dd.dataset.tone = tone;
  if (sub) dd.append(el("span", "sub", sub));
  box.append(el("dt", "", term), dd);
  return box;
}

function renderPlan(r) {
  const label = { risk: "The risk check", dryrun: "The dry run" };
  $("plan").replaceChildren(
    ...r.plan.map((p) => {
      const item = el("li", "item");
      item.dataset.state = p.status;
      const head = el("p", "item-head");
      head.append(el("span", "item-name", label[p.product]), " ", el("span", "item-path", p.path), " ", el("span", "item-price", p.price ? p.price.shown : "no price"), " ", el("span", "item-status", STATUS[p.status]));
      const purchase = r.purchases.find((x) => x.product === p.product);
      const meta = el("p", "item-meta");
      if (purchase?.settlement?.transaction) meta.append("settled in ", txLink(purchase.settlement.transaction));
      else meta.append(p.note.replace(/^(bought for [^,]+|refused|not bought|not needed): ?/, "") || p.note);
      item.append(head, meta);
      return item;
    }),
  );
  $("plan-meta").textContent = `${r.purchases.filter((p) => p.status === 200).length} of ${r.plan.length} bought`;
}

function renderLedger(r) {
  const budget = BigInt(r.budget.amount);
  const signed = BigInt(r.ledger.committed.amount);
  $("meter-signed").style.width = `${budget > 0n ? Number((signed * 1000n) / budget) / 10 : 0}%`;
  $("ledger").replaceChildren(
    row("Budget", r.budget.shown, `paid by ${r.payer.key === "new" ? "a key made for this run, holding nothing" : "the buyer's key"}`),
    row("Signed for", r.ledger.committed.shown, r.purchases.filter((p) => p.payment).length ? `${r.purchases.filter((p) => p.payment).length} ${r.purchases.filter((p) => p.payment).length === 1 ? "authorization" : "authorizations"}` : "nothing signed"),
    row("Settled", r.ledger.settled.shown, r.ledger.settled.amount === "0" ? "nothing paid on chain" : null),
    row("Left", r.ledger.remaining.shown),
  );
}

function renderBought(r) {
  const risk = r.purchases.find((p) => p.product === "risk" && p.status === 200)?.data;
  const dry = r.purchases.find((p) => p.product === "dryrun" && p.status === 200)?.data;
  const rows = [];
  if (risk) rows.push(row("Risk", RISK[risk.verdict] ?? risk.verdict, risk.verdict === "looks-fine" ? "nothing suspicious found" : (r.reason ?? risk.headline), risk.verdict === "do-not-send" ? "error" : risk.verdict === "check-first" ? "warning" : null));
  if (dry) rows.push(row("Dry run", DRY[dry.verdict] ?? dry.verdict, dry.verdict === "would-succeed" && r.gas ? `about ${r.gas.shown} ${r.network.id === "atlantic-testnet" ? "PHRS" : "PROS"} of gas` : dry.reason, dry.verdict === "would-succeed" ? null : "error"));
  $("bought-box").hidden = !rows.length;
  $("bought").replaceChildren(...rows);
}

function renderSign(r) {
  $("sign-box").hidden = !r.tx;
  if (!r.tx) return;
  $("sign-meta").textContent = `One transaction for chain ${r.network.chainId}, from ${r.tx.from}, as the dry run prepared it. Sign it with the sender's wallet.`;
  $("sign-json").textContent = JSON.stringify(r.tx, null, 2);
}

/** Open beside the job where there is room for it; on a phone, folded under it until asked for. */
let trailOpened = false;

function renderTrail(steps) {
  const shown = steps.filter((step) => step.source !== "the verdict");
  const box = $("trail-box");
  box.hidden = !shown.length;
  if (!trailOpened) {
    box.open = matchMedia("(min-width: 1000px)").matches;
    trailOpened = true;
  }
  $("trail-n").textContent = `${shown.length} ${shown.length === 1 ? "step" : "steps"}`;
  $("trail").replaceChildren(
    ...shown.map((step) => {
      const item = el("li", "trail-step");
      item.append(el("span", "trail-text", step.text), el("span", "trail-source", step.source));
      return item;
    }),
  );
}

function render({ result }) {
  linked = result.network.id === "pharos-mainnet";
  const [tone, word, detail] = VERDICTS[result.verdict];
  setStatus(tone, word, result.verdict === "not-done" ? (result.purchases.some((p) => p.payment) ? "a payment refused" : "within the budget, nothing to buy") : detail);
  $("asked").hidden = false;
  $("asked").replaceChildren(`${result.job.summary.split(" from ")[0]} from `, addr(result.job.intent.from, "the sender"), " to ", addr(result.job.intent.to, "the recipient"), `, with ${result.budget.shown} to spend`);
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = tone === "success" ? "" : tone;
  why.textContent = result.headline;
  $("job-box").hidden = false;
  // Said of this page's runs, which cannot settle; a run that settles (the CLI's, on Atlantic) is not one.
  $("limits").hidden = Boolean(result.api.settles);
  renderPlan(result);
  renderLedger(result);
  renderBought(result);
  renderSign(result);
  renderTrail(result.steps);
}

const run = agentRunner({
  task: "21",
  panel: $("answer"),
  running: ["Working", "asking the prices"],
  failed: "Not run",
  render,
  onFail: () => {
    for (const id of ["asked", "why", "job-box", "trail-box"]) $(id).hidden = true;
  },
});

const KEYS = ["amount", "asset", "to", "from", "budget"];

function ask(values) {
  history.replaceState(null, "", `?${new URLSearchParams(values)}`);
  for (const key of KEYS) $(`f-${key}`).value = values[key] ?? "";
  run(values);
}

const budgetProblem = (value) => (!BUDGET.test(value) ? "A budget is a number of USDC with at most 6 decimals, like 0.01." : Number(value) === 0 ? "A budget must be more than zero." : Number(value) > MAX_BUDGET ? `A budget is at most ${group(MAX_BUDGET)} USDC here.` : null);

/** Each field as typed, marked at its field when wrong. */
function problems(values) {
  return {
    amount: !AMOUNT.test(values.amount) || Number(values.amount) === 0 ? "Give an amount more than zero, like 25." : null,
    to: !ADDRESS.test(values.to) ? "Enter a 0x address of 40 hex characters." : null,
    from: values.from && !ADDRESS.test(values.from) ? "Enter a 0x address of 40 hex characters, or leave it empty." : null,
    budget: budgetProblem(values.budget),
  };
}

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = Object.fromEntries(KEYS.map((key) => [key, $(`f-${key}`).value.trim()]));
  const wrong = problems(values);
  for (const key of ["amount", "to", "from", "budget"]) {
    const input = $(`f-${key}`);
    const hint = $(`h-${key}`);
    input.setAttribute("aria-invalid", String(Boolean(wrong[key])));
    hint.classList.toggle("invalid", Boolean(wrong[key]));
    hint.textContent = wrong[key] ?? HINT[key];
  }
  const first = ["amount", "to", "from", "budget"].find((key) => wrong[key]);
  if (first) {
    $(`f-${first}`).focus();
    return;
  }
  ask({ amount: values.amount, asset: values.asset, to: values.to, ...(values.from ? { from: values.from } : {}), budget: values.budget });
  $("answer-h").focus({ preventScroll: true });
});

for (const [key, example] of Object.entries(EXAMPLES)) $(`ex-${key}`).addEventListener("click", () => ask({ ...example }));

wireCopy($("sign-copy"), { value: () => $("sign-json").textContent, shown: () => $("sign-json"), live: $("copy-state"), what: "Transaction" });

const first = initialRequest();
for (const key of KEYS) $(`f-${key}`).value = first[key] ?? "";
run(first);
