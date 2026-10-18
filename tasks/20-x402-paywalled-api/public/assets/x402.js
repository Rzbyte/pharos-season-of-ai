// Task 20 page: the X402 Paywalled API. A price (with an optional client's cap and recipient) goes to
// GET /api/agent?task=20&price=…, which runs the three parties of an x402 payment on Pharos Mainnet
// through the hosted Chain MCP: the paid endpoint's 402 terms for GET /data, the authorization a client
// signs for them with a key made for the request (it holds nothing), and the facilitator's verify,
// simulated on chain. Nothing is settled from here, so the data stays locked. Everything is set as
// text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, el, group, setStatus, short } from "./agent.js";
import { clockTime, linkExplorer, renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "20", LAB);

const EXAMPLES = Object.freeze({ one: { price: "0.001" }, capped: { price: "0.01", cap: "0.001" }, dear: { price: "0.25" } });
const AMOUNT = /^\d+(\.\d{1,6})?$/;
const MAX_PRICE = 1_000_000;
const HINT = { price: $("h-price").textContent, cap: $("h-cap").textContent, to: $("h-to").textContent };
const VERDICTS = Object.freeze({
  paid: ["success", "Paid", "the data released"],
  refused: ["warning", "Refused", "at verify, the data locked"],
  "not-paid": ["warning", "Not paid", "the client did not sign"],
  "not-settled": ["error", "Not settled", "the data locked"],
});
const REASONS = Object.freeze({ "the payer does not hold the amount": "the payer holds too little" });

/** What to ask first: the price, cap and recipient in the address bar, else the example. */
function initialRequest() {
  const query = new URLSearchParams(location.search);
  const price = query.get("price")?.trim();
  const cap = query.get("cap")?.trim();
  const to = query.get("to")?.trim();
  return { price: price && AMOUNT.test(price) ? price : EXAMPLES.one.price, ...(cap && AMOUNT.test(cap) ? { cap } : {}), ...(to && ADDRESS.test(to) ? { to } : {}) };
}

/** Base units of USDC (6 decimals) in USDC, trailing zeros cut: "0.001". */
const usdc = (raw) => {
  const value = BigInt(raw);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${group((value / 1_000_000n).toString())}${fraction ? `.${fraction}` : ""} USDC`;
};
const hexShort = (hex) => (hex.length > 22 ? `${hex.slice(0, 10)}…${hex.slice(-8)}` : hex);

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

/** The page's explorer is Pharos Mainnet's: a result from another network is shown, never linked there. */
let linked = true;
const plain = (text, title) => Object.assign(el("span", "short", text), { title });
const addr = (address, what) => (linked ? addressLink(address, what) : plain(short(address), address));

/** A transaction hash linked to the explorer where the page names one. */
function txLink(hash) {
  if (!linked) return plain(hexShort(hash), hash);
  const link = el("a", "short", hexShort(hash));
  link.title = hash;
  linkExplorer(link, "tx", hash, "the settlement");
  return link.hidden ? plain(hexShort(hash), hash) : link;
}

/** One stage of the exchange: its party, what happened, and its facts. */
function stage(state, party, title, rows, note) {
  const item = el("li", "stage");
  item.dataset.state = state;
  const head = el("p", "stage-head");
  head.append(el("span", "stage-party", party), " ", el("span", "stage-title", title));
  item.append(head);
  if (rows.length) {
    const list = el("dl", "rows");
    list.append(...rows);
    item.append(list);
  }
  if (note) item.append(note);
  return item;
}

function renderStages(r) {
  const accepted = r.required?.accepts?.[0];
  const auth = r.payment?.payload?.authorization;
  const signature = r.payment?.payload?.signature;
  const stages = [];
  // 1. The endpoint's terms.
  stages.push(
    accepted
      ? stage("ok", "Endpoint", "402 Payment Required", [
          row("Asks", usdc(accepted.amount), `${group(accepted.amount)} base units, for ${r.endpoint.method} ${r.endpoint.path}`),
          row("To", addr(accepted.payTo, "who is paid")),
          row("In", addr(accepted.asset, "the asset"), `EIP-712: ${accepted.extra?.name ?? "no name()"}, ${accepted.extra?.version ? `version ${accepted.extra.version}` : "no version()"}`),
          row("By", `${accepted.scheme} on ${accepted.network}`, `an authorization valid for ${accepted.maxTimeoutSeconds} s`),
        ])
      : stage("fail", "Endpoint", "No terms answered", []),
  );
  // 2. The client's authorization.
  if (auth) {
    stages.push(
      stage("ok", "Client", "Signed an EIP-3009 authorization", [
        row("From", addr(auth.from, "the payer"), r.payer.key === "new" ? "a key made for this request, holding nothing" : "the payer's key"),
        row("Pays", usdc(auth.value), `to ${short(auth.to)}, at most ${r.cap.shown} a request`),
        row("Valid", `until ${clockTime(new Date(Number(auth.validBefore) * 1000).toISOString())}`, `nonce ${hexShort(auth.nonce)}`),
        row("Signed", hexShort(signature ?? "")),
      ]),
    );
  } else {
    const why = el("p", "note", `Did not pay: ${r.reason}.`);
    why.dataset.tone = "warning";
    stages.push(stage("fail", "Client", "Did not sign", [], why));
  }
  // 3. The facilitator.
  if (r.verify) {
    const rows = [row("Verify", r.verify.isValid ? "Valid: the signature checks, and the transfer succeeds when simulated on chain" : `Refused: ${r.reason}`, r.verify.isValid ? null : r.verify.invalidReason, r.verify.isValid ? null : "warning")];
    if (r.settle) rows.push(row("Settle", r.settle.success ? txLink(r.settle.transaction) : `Not settled: ${r.reason}`, r.settlement ? `block ${group(r.settlement.block)}, ${r.settlement.status}` : r.settle.errorReason ?? null, r.settle.success ? null : "error"));
    else rows.push(row("Settle", r.facilitator.settles ? "Not reached: refused at verify" : "Not reached: it holds no key here", r.facilitator.settles ? null : "the hosted Chain MCP is read-only"));
    stages.push(stage(r.verify.isValid ? (r.settle?.success ? "ok" : "fail") : "fail", "Facilitator", r.verify.isValid ? (r.settle?.success ? "Verified and settled" : "Verified, not settled") : "Refused the payment", rows));
  } else {
    stages.push(stage("skip", "Facilitator", "Not asked", [row("Verify", "Nothing was signed to verify")]));
  }
  // 4. The data.
  if (r.data !== null) {
    const pre = el("pre", "cmd data-json");
    pre.append(el("code", "", JSON.stringify(r.data, null, 2)));
    stages.push(stage("ok", "Client", "200 OK: the data", [], pre));
  } else {
    stages.push(stage("skip", "Data", "Locked", [row("Status", `${r.response.status}`, "released only once a payment is settled")]));
  }
  $("stages").replaceChildren(...stages);
  $("flow-meta").textContent = `${r.network.x402} · ${r.toolCalls} Chain MCP calls`;
}

function renderAsset(r) {
  const a = r.asset;
  $("asset").replaceChildren(
    row("Token", addr(a.address, "the asset"), `${a.name ?? "no name()"} (${a.symbol ?? "no symbol()"})`),
    row("Signs as", a.version ? `${a.name}, version ${a.version}` : "no version()", "the EIP-712 domain an authorization signs"),
    row("EIP-3009", a.eip3009 ? "Yes: it answers authorizationState" : "No: it does not answer authorizationState", a.eip3009 ? "the exact scheme settles by transferWithAuthorization" : "the exact scheme cannot settle in it", a.eip3009 ? null : "warning"),
    row("Decimals", String(a.decimals)),
  );
  const permit2 = $("permit2");
  permit2.hidden = !r.permit2;
  permit2.textContent = r.permit2 ? `x402's other way to settle, Permit2, needs Permit2 (${short(r.permit2.permit2)}) and x402's proxy (${short(r.permit2.proxy)}) deployed: ${r.permit2.permit2Code ? "Permit2 has code" : "Permit2 has no code"} on ${r.network.name}, ${r.permit2.proxyCode ? "the proxy has code" : "the proxy has none"}.` : "";
}

/** Open beside the exchange where there is room for it; on a phone, folded under it until asked for. */
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
  setStatus(tone, word, result.verdict === "refused" ? `${REASONS[result.reason] ?? result.reason}, the data locked` : detail);
  $("asked").hidden = false;
  $("asked").replaceChildren(`GET ${result.endpoint.path} at ${result.endpoint.price.shown} a request, paid to `, addr(result.payTo, "who is paid"), `; the client pays at most ${result.cap.shown}`);
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = tone === "success" ? "" : tone;
  why.textContent = result.headline;
  $("flow-box").hidden = false;
  // Said of this page's runs, which only verify; a run that settled (the CLI's, on Atlantic) is not one.
  $("limits").hidden = result.facilitator.settles;
  renderStages(result);
  renderAsset(result);
  renderTrail(result.steps);
}

const request = agentRunner({
  task: "20",
  panel: $("answer"),
  running: ["Requesting", "asking GET /data"],
  failed: "Not run",
  render,
  onFail: () => {
    for (const id of ["asked", "why", "flow-box", "trail-box"]) $(id).hidden = true;
  },
});

function ask(values) {
  history.replaceState(null, "", `?${new URLSearchParams(values)}`);
  $("f-price").value = values.price;
  $("f-cap").value = values.cap ?? "";
  $("f-to").value = values.to ?? "";
  request(values);
}

const amountProblem = (value, what) => (!AMOUNT.test(value) ? `${what} is a number of USDC with at most 6 decimals, like 0.001.` : Number(value) === 0 ? `${what} must be more than zero.` : Number(value) > MAX_PRICE ? `${what} is at most ${group(MAX_PRICE)} USDC here.` : null);

/** Each field as typed, marked at its field when wrong. */
function problems(values) {
  return {
    price: !values.price ? "Give a price first, like 0.001." : amountProblem(values.price, "A price"),
    cap: values.cap ? amountProblem(values.cap, "A cap") : null,
    to: values.to && !ADDRESS.test(values.to) ? "Enter a 0x address of 40 hex characters, or leave it empty." : null,
  };
}

const KEYS = ["price", "cap", "to"];

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = Object.fromEntries(KEYS.map((key) => [key, $(`f-${key}`).value.trim()]));
  const wrong = problems(values);
  for (const key of KEYS) {
    const input = $(`f-${key}`);
    const hint = $(`h-${key}`);
    input.setAttribute("aria-invalid", String(Boolean(wrong[key])));
    hint.classList.toggle("invalid", Boolean(wrong[key]));
    hint.textContent = wrong[key] ?? HINT[key];
  }
  const first = KEYS.find((key) => wrong[key]);
  if (first) {
    $(`f-${first}`).focus();
    return;
  }
  ask({ price: values.price, ...(values.cap ? { cap: values.cap } : {}), ...(values.to ? { to: values.to } : {}) });
  $("answer-h").focus({ preventScroll: true });
});

for (const [key, example] of Object.entries(EXAMPLES)) {
  $(`ex-${key}`).addEventListener("click", () => {
    const to = $("f-to").value.trim();
    ask({ ...example, ...(to && ADDRESS.test(to) ? { to } : {}) });
  });
}

const first = initialRequest();
$("f-price").value = first.price;
$("f-cap").value = first.cap ?? "";
$("f-to").value = first.to ?? "";
request(first);
