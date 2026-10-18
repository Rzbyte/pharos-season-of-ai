// Task 19 page: the Invoice-to-Payment Agent. An invoice or a payment link (with an optional payer and your
// payees) goes to GET /api/agent?task=19&invoice=…, which reads it with every figure checked, checks the
// payee against your payees and the payer's last 2,000 blocks of the token, and prepares the payment on
// Pharos Mainnet through the hosted Chain MCP: the dry run, the transaction to sign, the Skill Engine's
// cast send and the EIP-681 link. Nothing is signed or sent. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, amountText, el, group, gwei, setStatus, units } from "./agent.js";
import { renderTaskNav, svgIcon, wireCopy } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "19", LAB);

/** The example payee: the agent's example recipient (Tasks 05, 08, 11, 17), here a sample studio. */
const STUDIO = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const PAYEES = `Example Studio = ${STUDIO}`;
const INVOICE = `Invoice: INV-1042
From: Example Studio
Bill to: Example Shop
Issued: 2026-10-15
Terms: Net 30

Design work (10 h)        15.00 USDC
Hosting, October           5.00 USDC

Subtotal: 20 USDC
Total: 20 USDC
Amount due: 20 USDC

Pay to: ${STUDIO}
Network: Pharos Mainnet`;
const EXAMPLES = Object.freeze({
  invoice: INVOICE,
  link: `ethereum:0xC879C018dB60520F4355C26eD1a6D572cdAC1815@1672/transfer?address=${STUDIO}&uint256=5e6`,
  wrong: INVOICE.replace("Total: 20 USDC", "Total: 25 USDC"),
  // The studio's address with its middle swapped out: what a doctored invoice or address poisoning gives.
  changed: INVOICE.replace(`Pay to: ${STUDIO}`, "Pay to: 0xb274000000000000000000000000000000009553"),
});
const MAX = 2000;
const HINT = { invoice: $("h-invoice").textContent, from: $("h-from").textContent, payees: $("h-payees").textContent };
const NATIVE = "PROS";
const VERDICTS = Object.freeze({
  ready: ["success", "Ready", "dry-run, not sent"],
  "check-first": ["warning", "Check first", "held, not sent"],
  short: ["warning", "Short", "the payer holds too little"],
  "would-fail": ["error", "Would fail", "in the dry run"],
  sent: ["success", "Sent", "and checked"],
  "not-sent": ["error", "Not sent", "see below"],
});
const MARKS = Object.freeze({ ok: "M3.5 8.5l3 3 6-7", warn: "M8 4.25v4.5M8 11.5v.25", fail: "M4.5 4.5l7 7M11.5 4.5l-7 7", info: "M8 7.25v4.5M8 4.5v.25" });
const SAYS = Object.freeze({ ok: "fine", warn: "check this first", fail: "fails", info: "for information" });
const DRY = Object.freeze({ "would-succeed": "Would succeed", "would-revert": "Would revert", "cannot-pay": "Cannot pay its gas" });
const BOOK = Object.freeze({
  matches: (b) => `${b.name}, as in your payees`,
  listed: (b) => `${b.name} in your payees`,
  "other-name": (b) => `${b.name} in your payees, not the invoice's name`,
  differs: (b) => `not the address your payees give ${b.name}`,
  new: () => "not in your payees",
});
const COPY_ICON = "M5.75 5.75h6.5v6.5h-6.5zM3.75 10.25v-6.5h6.5";
const COPIED_ICON = "M3.5 8.5l3 3 6-7";

/** What to prepare first: the invoice, payer and payees in the address bar, else the example. */
function initialRequest() {
  const query = new URLSearchParams(location.search);
  const invoice = query.get("invoice")?.trim();
  const from = query.get("from")?.trim();
  const payees = query.get("payees");
  return { invoice: invoice && invoice.length <= MAX ? invoice : EXAMPLES.invoice, payees: payees ?? PAYEES, ...(from && ADDRESS.test(from) ? { from } : {}) };
}

const money = (amount, asset) => `${amountText(amount)} ${asset}`;

/** A command with a Copy button (or, where the clipboard is refused, the command selected). */
function copyable(text, label) {
  const box = el("div", "copyable");
  const pre = el("pre", "cmd");
  pre.append(el("code", "", text));
  const copy = el("button", "action copy");
  copy.type = "button";
  copy.dataset.copy = "idle";
  const icons = el("span", "swap");
  icons.append(svgIcon(COPY_ICON), svgIcon(COPIED_ICON));
  const words = el("span", "swap");
  words.append(el("span", "", "Copy"), el("span", "", "Copied"));
  copy.append(icons, words);
  copy.setAttribute("aria-label", `Copy: ${label}`);
  wireCopy(copy, { value: () => text, shown: () => pre, live: $("copy-state"), what: "Command" });
  box.append(pre, copy);
  return box;
}

function fact(term, ...value) {
  const row = el("div", "fact");
  const dd = el("dd", "fact-value");
  dd.append(...value);
  row.append(el("dt", "fact-term", term), dd);
  return row;
}

/** The payee's address: short where your payees know it, in full where it calls for a check (a lookalike looks the same short). */
function payeeLink(r, what) {
  const link = addressLink(r.payee.address, what);
  if (!known(r)) link.textContent = r.payee.address;
  return link;
}

/** The name your payees give the payee's address, if they give it one: never the name the invoice claims. */
const known = (r) => (["matches", "listed", "other-name"].includes(r.payee.book.status) ? r.payee.book.name : null);

function renderFacts(r) {
  const inv = r.invoice;
  const rows = [fact("Amount due", el("span", "fact-amount", money(inv.due.amount, inv.asset)))];
  const payee = el("span", "fact-payee");
  payee.append(payeeLink(r, "the payee"), el("span", `fact-book${r.payee.book.status === "matches" || r.payee.book.status === "listed" ? "" : " is-off"}`, BOOK[r.payee.book.status](r.payee.book)));
  rows.push(fact("Pay to", payee));
  if (r.due.date) rows.push(fact("Due", `${r.due.date} · ${r.due.words}${inv.dueFrom === "terms" ? ` (${inv.terms} from ${inv.issued})` : ""}`));
  else rows.push(fact("Due", "No due date given"));
  if (inv.issued && inv.dueFrom !== "terms") rows.push(fact("Issued", inv.issued));
  rows.push(fact("Network", inv.network ?? (inv.link?.chainId ? `Chain ${inv.link.chainId}, from its link` : "Not named: read as Pharos Mainnet")));
  if (inv.lines.length) {
    const list = el("ol", "lines");
    for (const line of inv.lines) {
      const item = el("li", "line");
      item.append(el("span", "line-text", line.text), el("span", "line-amount", money(line.amount, inv.asset)));
      list.append(item);
    }
    rows.push(fact(inv.lines.length === 1 ? "Line" : "Lines", list));
  }
  const figures = [["Subtotal", inv.figures.subtotal], ["Discount", inv.figures.discount], ["Tax", inv.figures.tax], ["Total", inv.figures.total], ["Paid", inv.figures.paid]].filter(([, m]) => m);
  if (figures.length) rows.push(fact("Figures", figures.map(([name, m]) => `${name} ${money(m.amount, inv.asset)}`).join(" · ")));
  if (inv.link) rows.push(fact("Payment link", el("code", "fact-link", inv.link.uri)));
  if (inv.note) rows.push(fact("Note", inv.note));
  $("facts").replaceChildren(...rows);
  $("unread-box").hidden = !inv.notRead.length;
  $("unread-n").textContent = `${inv.notRead.length} ${inv.notRead.length === 1 ? "line" : "lines"}`;
  $("unread").replaceChildren(...inv.notRead.map((line) => el("li", "", line)));
}

function renderChecks(r) {
  $("checks").replaceChildren(
    ...r.checks.map((c) => {
      const item = el("li", "check");
      item.dataset.state = c.state;
      item.dataset.id = c.id;
      const mark = el("span", "check-mark");
      mark.setAttribute("aria-hidden", "true");
      mark.append(svgIcon(MARKS[c.state]));
      const label = el("span", "check-label", c.title);
      label.append(el("span", "sr", `: ${SAYS[c.state]}.`));
      const evidence = el("span", "check-evidence");
      evidence.append(el("span", "check-note", c.detail), el("span", "check-tool", c.source));
      const body = el("span", "check-main");
      body.append(label, evidence);
      item.append(mark, body);
      return item;
    }),
  );
}

function renderPayment(r) {
  const p = r.payment;
  $("payer").replaceChildren("from ", addressLink(r.payer.address, "the payer"), ` · ${{ input: "given", invoice: "the invoice's bill-to", example: "the example's" }[r.payer.from]}`);
  const card = $("payment");
  card.dataset.state = p.dryRun.verdict === "would-succeed" ? "ok" : "fail";
  const head = el("p", "payment-head");
  head.append(el("span", "payment-amount", money(p.amount, p.asset)), " to ", ...(known(r) ? [el("span", "payment-name", known(r)), " "] : []), payeeLink(r, known(r) ?? "the payee"));
  const facts = [DRY[p.dryRun.verdict]];
  if (p.dryRun.gas) facts.push(`${group(p.dryRun.gas.gas)} gas, about ${units(p.dryRun.gas.expectedCost, 18, 8)} ${NATIVE} at ${gwei(p.dryRun.gas.expectedFeePerGas)}`);
  if (p.tx) facts.push(`nonce ${p.tx.nonce}`);
  const parts = [head, el("p", "payment-meta", facts.join(" · "))];
  if (p.memo) parts.push(el("p", "payment-memo", `For ${p.memo}. Kept here: a transfer carries no note on chain.`));
  if (p.dryRun.reason) {
    const why = el("p", "note", p.dryRun.reason);
    why.dataset.tone = "error";
    parts.push(why);
  }
  parts.push(copyable(p.command, "the payment's cast send"));
  card.replaceChildren(...parts);
}

function renderSign(r) {
  const tx = r.payment.tx;
  const ready = r.verdict === "ready" && Boolean(tx);
  $("sign-box").hidden = !ready;
  if (!ready) return;
  $("sign-meta").textContent = `One EIP-1559 transaction for chain ${r.network.chainId}, nonce ${tx.nonce}, with the dry run's gas limit and fee caps. Sign it from ${r.payer.address}.`;
  $("sign-json").textContent = JSON.stringify(tx, null, 2);
  $("link").textContent = r.link;
}

/** Open beside the payment where there is room for it; on a phone, folded under it until asked for. */
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
  const [tone, word, detail] = VERDICTS[result.verdict];
  setStatus(tone, word, detail);
  const inv = result.invoice;
  $("asked").hidden = false;
  $("asked").textContent = inv.number || inv.issuer ? `Invoice${inv.number ? ` ${inv.number}` : ""}${inv.issuer ? ` from ${inv.issuer}` : ""}${inv.billTo ? `, billed to ${inv.billTo}` : ""}` : inv.link ? "A payment link" : "An invoice";
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = tone === "success" ? "" : tone;
  why.textContent = result.headline;
  $("pay-box").hidden = false;
  renderFacts(result);
  renderChecks(result);
  renderPayment(result);
  renderSign(result);
  renderTrail(result.steps);
}

const prepare = agentRunner({
  task: "19",
  panel: $("answer"),
  running: ["Preparing", "reading the invoice"],
  failed: "Not prepared",
  render,
  onFail: () => {
    for (const id of ["asked", "why", "pay-box", "trail-box"]) $(id).hidden = true;
  },
});

function ask(request) {
  history.replaceState(null, "", `?${new URLSearchParams(request)}`);
  $("f-invoice").value = request.invoice;
  $("f-from").value = request.from ?? "";
  $("f-payees").value = request.payees;
  prepare(request);
}

/** Each field as typed, marked at its field when wrong. */
function problems(values) {
  return {
    invoice: !values.invoice ? "Paste an invoice first, or a payment link." : values.invoice.length > MAX ? `An invoice is at most ${group(MAX)} characters here; the CLI reads longer ones.` : null,
    from: values.from && !ADDRESS.test(values.from) ? "Enter a 0x address of 40 hex characters, or leave it empty." : null,
    payees: values.payees.split(/\n|;/).some((line) => line.trim() && !/^\s*[^=:]*[A-Za-z][^=:]*?\s*[=:]?\s*0x[0-9a-fA-F]{40}\s*$/.test(line)) ? "Each line reads Name = 0x… (40 hex characters)." : null,
  };
}

const KEYS = ["invoice", "from", "payees"];

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = { invoice: $("f-invoice").value.trim(), from: $("f-from").value.trim(), payees: $("f-payees").value.trim() };
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
  ask({ invoice: values.invoice, payees: values.payees, ...(values.from ? { from: values.from } : {}) });
  $("answer-h").focus({ preventScroll: true });
});

// An invoice has many lines: Enter starts a new one, and Ctrl+Enter (or Cmd+Enter) prepares it.
$("f-invoice").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    $("ask").requestSubmit();
  }
});

for (const [key, invoice] of Object.entries(EXAMPLES)) {
  $(`ex-${key}`).addEventListener("click", () => {
    const from = $("f-from").value.trim();
    ask({ invoice, payees: $("f-payees").value.trim() || PAYEES, ...(from && ADDRESS.test(from) ? { from } : {}) });
  });
}

wireCopy($("sign-copy"), { value: () => $("sign-json").textContent, shown: () => $("sign-json"), live: $("copy-state"), what: "Transaction" });
wireCopy($("link-copy"), { value: () => $("link").textContent, shown: () => $("link"), live: $("copy-state"), what: "Payment link" });

const first = initialRequest();
$("f-invoice").value = first.invoice;
$("f-from").value = first.from ?? "";
$("f-payees").value = first.payees;
prepare(first);
