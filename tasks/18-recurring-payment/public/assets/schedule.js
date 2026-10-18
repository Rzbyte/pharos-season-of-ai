// Task 18 page: the Recurring Payment Agent. A schedule of repeating payments (with an optional first day
// and payer) goes to GET /api/agent?task=18&schedule=…, which works out what fell due by the block's day
// since the first of the month (or the day given), takes the oldest, and prepares them on Pharos Mainnet
// through the hosted Chain MCP: each dry-run, the totals, the transactions to sign in nonce order. The
// page keeps nothing between runs and sends nothing. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, amountText, el, group, gwei, setStatus, units } from "./agent.js";
import { renderTaskNav, svgIcon, wireCopy } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "18", LAB);

/** Sample payees: the agent's example recipient (Tasks 05, 08, 11, 17, 19) and a sample address from Task 23. */
const LANDLORD = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const STAFF = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const SCHEDULE = `Rent: 25 USDC to ${LANDLORD}, monthly on the 1st
Payroll: 10 USDC to ${STAFF}, monthly on the 15th
Design tool: 2 USDC to ${LANDLORD}, weekly on Monday`;
const EXAMPLES = Object.freeze({
  household: SCHEDULE,
  subscriptions: `Streaming: 3 USDC to ${LANDLORD}, monthly on the 10th\nNews: 1 USDC to ${STAFF}, weekly on Friday\nDomain: 12 USDC to ${LANDLORD}, yearly on March 1`,
  daily: `Allowance: 0.5 USDC to ${STAFF}, daily`,
});
const MAX = 3000;
const HINT = { schedule: $("h-schedule").textContent, since: $("h-since").textContent, from: $("h-from").textContent };
const NATIVE = "PROS";
const VERDICTS = Object.freeze({
  ready: ["success", "Ready", "dry-run, not sent"],
  "nothing-due": ["success", "Nothing due", "today"],
  short: ["warning", "Short", "the payer holds too little"],
  "would-fail": ["error", "Would fail", "in the dry run"],
  sent: ["success", "Sent", "and recorded"],
  "partly-sent": ["error", "Partly sent", "see below"],
});
const SINCE = Object.freeze({ month: "the first of this month", input: "the day given", today: "today", store: "the store's start" });
const COPY_ICON = "M5.75 5.75h6.5v6.5h-6.5zM3.75 10.25v-6.5h6.5";
const COPIED_ICON = "M3.5 8.5l3 3 6-7";
const DRY = Object.freeze({ "would-succeed": "Would succeed", "would-revert": "Would revert", "cannot-pay": "Cannot pay its gas" });

/** What to prepare first: the schedule, first day and payer in the address bar, else the example. */
function initialRequest() {
  const query = new URLSearchParams(location.search);
  const schedule = query.get("schedule")?.trim();
  const since = query.get("since")?.trim();
  const from = query.get("from")?.trim();
  return { schedule: schedule && schedule.length <= MAX ? schedule : EXAMPLES.household, ...(since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? { since } : {}), ...(from && ADDRESS.test(from) ? { from } : {}) };
}

const money = (amount, asset) => `${amountText(amount)} ${asset}`;
const late = (days) => (days === 0 ? "due today" : `${days} ${days === 1 ? "day" : "days"} late`);

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

function renderDue(r) {
  $("payer").replaceChildren("from ", addressLink(r.payer.address, "the payer"), ` · ${{ input: "given", store: "the store's", example: "the example's" }[r.payer.from]}`);
  $("payments").replaceChildren(
    ...r.payments.map((p, k) => {
      const owed = r.owed.find((o) => o.id === r.due[k]);
      const item = el("li", "payment");
      item.dataset.state = p.dryRun.verdict === "would-succeed" ? "ok" : "fail";
      const head = el("p", "payment-head");
      head.append(el("span", "payment-name", p.to.name), " ", el("span", "payment-due", `${owed.date} · ${late(owed.late)}`));
      const what = el("p", "payment-what");
      what.append(el("span", "payment-amount", money(p.amount, p.asset)), " to ", addressLink(p.to.address, p.to.name));
      const facts = [DRY[p.dryRun.verdict]];
      if (p.dryRun.gas) facts.push(`${group(p.dryRun.gas.gas)} gas, about ${units(p.dryRun.gas.expectedCost, 18, 8)} ${NATIVE} at ${gwei(p.dryRun.gas.expectedFeePerGas)}`);
      if (p.tx) facts.push(`nonce ${p.tx.nonce}`);
      item.append(head, what, el("p", "payment-meta", facts.join(" · ")));
      if (p.dryRun.reason) {
        const why = el("p", "note", p.dryRun.reason);
        why.dataset.tone = "error";
        item.append(why);
      }
      // Folded: with several payments due, the list stays one line of facts each.
      const fold = el("details", "cmd-fold");
      const summary = el("summary", "cmd-summary");
      summary.append(el("span", "", "cast send"), svgIcon("M4 6l4 4 4-4", "cmd-chev"));
      fold.append(summary, copyable(p.command, `${p.to.name} of ${owed.date}: its cast send`));
      item.append(fold);
      return item;
    }),
  );
  const nothing = $("nothing");
  nothing.hidden = r.payments.length > 0;
  nothing.textContent = r.payments.length ? "" : `Nothing fell due from ${r.since} to ${r.today}.`;
  const waiting = $("waiting");
  waiting.hidden = !r.later;
  waiting.textContent = r.later ? `${r.later} more ${r.later === 1 ? "is" : "are"} owed and ${r.later === 1 ? "waits" : "wait"} for the next run: a run takes the oldest, at most 3 of one payment and 6 in all here.` : "";
}

function renderTotals(r) {
  $("totals-box").hidden = !r.totals.length;
  $("totals").replaceChildren(
    ...r.totals.map((t) => {
      const item = el("li", "total");
      item.dataset.state = t.covered ? "ok" : "short";
      const mark = el("span", "total-mark");
      mark.setAttribute("aria-hidden", "true");
      mark.append(svgIcon(t.covered ? "M3.5 8.5l3 3 6-7" : "M4.5 4.5l7 7M11.5 4.5l-7 7"));
      const main = el("span", "total-main");
      const label = el("span", "total-label", t.asset);
      label.append(el("span", "sr", t.covered ? ": enough." : ": not enough."));
      main.append(label, el("span", "total-figures", `${t.raw === "0" ? "Gas only" : `${t.shown} in all`}${t.token === null && r.fees ? `, and up to ${r.fees.maxShown} of gas` : ""}. Holds ${t.holdsShown}${t.covered ? "." : `: ${t.needsShown} needed.`}`));
      item.append(mark, main);
      return item;
    }),
  );
}

function renderItems(r) {
  $("items-n").textContent = `${r.items.length} ${r.items.length === 1 ? "payment" : "payments"}`;
  $("items").replaceChildren(
    ...r.items.map((i) => {
      const item = el("li", "item");
      const head = el("p", "item-head");
      head.append(el("span", "item-name", i.name), " ", el("span", "item-amount", money(i.amount, i.asset)), " ", el("span", "item-every", i.every));
      const meta = el("p", "item-meta");
      meta.append(`to `, addressLink(i.to, i.name), ` · ${i.owed ? `${i.owed} owed` : "nothing owed"} · ${i.next ? `next ${i.next}` : "ended"}${i.from ? ` · from ${i.from}` : ""}${i.until ? ` · until ${i.until}` : ""}`);
      item.append(head, meta);
      return item;
    }),
  );
}

function renderSign(r) {
  const txs = r.payments.map((p) => p.tx).filter(Boolean);
  const ready = r.verdict === "ready" && txs.length === r.payments.length && txs.length > 0;
  $("sign-box").hidden = !ready;
  if (!ready) return;
  $("sign-meta").textContent = `${txs.length === 1 ? "One EIP-1559 transaction" : `${txs.length} EIP-1559 transactions`} for chain ${r.network.chainId}, nonces ${txs[0].nonce}${txs.length > 1 ? ` to ${txs.at(-1).nonce}` : ""}, with the dry run's gas limits and fee caps. Sign them in order, from ${r.payer.address}.`;
  $("sign-json").textContent = JSON.stringify(txs, null, 2);
}

/** Open beside the payments where there is room for it; on a phone, folded under them until asked for. */
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
  setStatus(tone, word, result.verdict === "ready" ? `${result.payments.length === 1 ? "one payment" : `${result.payments.length} payments`}, dry-run, not sent` : result.verdict === "nothing-due" ? `on ${result.today}` : detail);
  $("asked").hidden = false;
  $("asked").textContent = `${result.items.length === 1 ? "One payment" : `${result.items.length} payments`}, due since ${result.since} (${SINCE[result.sinceFrom]}) to ${result.today}`;
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = tone === "success" ? "" : tone;
  why.textContent = result.headline;
  $("due-box").hidden = false;
  renderDue(result);
  renderTotals(result);
  renderItems(result);
  renderSign(result);
  renderTrail(result.steps);
}

const prepare = agentRunner({
  task: "18",
  panel: $("answer"),
  running: ["Preparing", "reading the schedule"],
  failed: "Not prepared",
  render,
  onFail: () => {
    for (const id of ["asked", "why", "due-box", "trail-box"]) $(id).hidden = true;
  },
});

function ask(request) {
  history.replaceState(null, "", `?${new URLSearchParams(request)}`);
  $("f-schedule").value = request.schedule;
  $("f-since").value = request.since ?? "";
  $("f-from").value = request.from ?? "";
  prepare(request);
}

/** Each field as typed, marked at its field when wrong. */
function problems(values) {
  return {
    schedule: !values.schedule ? "Write a schedule first: one payment a line." : values.schedule.length > MAX ? `A schedule is at most ${group(MAX)} characters.` : values.schedule.split("\n").some((line) => line.trim() && !line.trim().startsWith("#") && !line.includes(":")) ? 'Each line starts with a name and a colon: "Rent: 25 USDC to 0x…, monthly on the 1st".' : null,
    since: values.since && !/^\d{4}-\d{2}-\d{2}$/.test(values.since) ? "A day as YYYY-MM-DD, or leave it empty." : null,
    from: values.from && !ADDRESS.test(values.from) ? "Enter a 0x address of 40 hex characters, or leave it empty." : null,
  };
}

const KEYS = ["schedule", "since", "from"];

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = { schedule: $("f-schedule").value.trim(), since: $("f-since").value.trim(), from: $("f-from").value.trim() };
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
  ask({ schedule: values.schedule, ...(values.since ? { since: values.since } : {}), ...(values.from ? { from: values.from } : {}) });
  $("answer-h").focus({ preventScroll: true });
});

// A schedule has many lines: Enter starts a new one, and Ctrl+Enter (or Cmd+Enter) prepares it.
$("f-schedule").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    $("ask").requestSubmit();
  }
});

for (const [key, schedule] of Object.entries(EXAMPLES)) {
  $(`ex-${key}`).addEventListener("click", () => {
    const since = $("f-since").value.trim();
    const from = $("f-from").value.trim();
    ask({ schedule, ...(since ? { since } : {}), ...(from && ADDRESS.test(from) ? { from } : {}) });
  });
}

wireCopy($("sign-copy"), { value: () => $("sign-json").textContent, shown: () => $("sign-json"), live: $("copy-state"), what: "Transactions" });

const first = initialRequest();
$("f-schedule").value = first.schedule;
$("f-since").value = first.since ?? "";
$("f-from").value = first.from ?? "";
prepare(first);
