// Task 17 page: the Natural-Language Payment Agent. A payment request in plain words (with an optional
// sender and an address book) goes to GET /api/agent?task=17&request=…, which reads it into payments,
// dry-runs each on Pharos Mainnet through the hosted Chain MCP at one block, checks the totals against
// what the sender holds, and returns the transactions to sign in nonce order with the Skill Engine's cast
// commands. Nothing is signed or sent. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, el, group, gwei, setStatus, units } from "./agent.js";
import { renderTaskNav, svgIcon, wireCopy } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "17", LAB);

/** The example address book: the agent's example recipient (Tasks 05, 08, 11) and a sample address from Task 23. */
const CONTACTS = "alice = 0xB2749BD12f19C24a2244176658F3dF3e48e79553\nbob = 0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const EXAMPLES = Object.freeze({
  two: "Pay alice 25 USDC and send 0.01 PROS to bob for lunch",
  split: "Split 30 USDC between alice and bob for dinner",
  each: "Send 5 USDC each to alice and bob",
});
const MAX = 500;
const HINT = { request: $("h-request").textContent, from: $("h-from").textContent, contacts: $("h-contacts").textContent };
const NATIVE = "PROS";
const VERDICTS = Object.freeze({
  ready: ["success", "Ready", "dry-run, not sent"],
  short: ["warning", "Short", "the sender holds too little"],
  "would-fail": ["error", "Would fail", "in the dry run"],
  sent: ["success", "Sent", "and checked"],
  "partly-sent": ["error", "Partly sent", "see below"],
});
const COPY_ICON = "M5.75 5.75h6.5v6.5h-6.5zM3.75 10.25v-6.5h6.5";
const COPIED_ICON = "M3.5 8.5l3 3 6-7";
const DRY = Object.freeze({ "would-succeed": "Would succeed", "would-revert": "Would revert", "cannot-pay": "Cannot pay its gas" });

/** What to prepare first: the request, sender and address book in the address bar, else the example. */
function initialRequest() {
  const query = new URLSearchParams(location.search);
  const request = query.get("request")?.trim();
  const from = query.get("from")?.trim();
  const contacts = query.get("contacts");
  return { request: request && request.length <= MAX ? request : EXAMPLES.two, contacts: contacts ?? CONTACTS, ...(from && ADDRESS.test(from) ? { from } : {}) };
}

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

function renderPayments(flow) {
  $("sender").replaceChildren("from ", addressLink(flow.sender.address, "the sender"), ` · ${{ input: "given", request: "the request's", example: "the example's" }[flow.sender.from]}`);
  $("payments").replaceChildren(
    ...flow.payments.map((p) => {
      const item = el("li", "payment");
      item.dataset.state = p.dryRun.verdict === "would-succeed" ? "ok" : "fail";
      const head = el("p", "payment-head");
      head.append(el("span", "payment-amount", `${p.amount.replace(/^\d+/, (whole) => group(whole))} ${p.asset}`), " to ", ...(p.to.name ? [el("span", "payment-name", p.to.name), " "] : []), addressLink(p.to.address, p.to.name ?? "the recipient"));
      const meta = el("p", "payment-meta");
      const facts = [DRY[p.dryRun.verdict]];
      if (p.dryRun.gas) facts.push(`${group(p.dryRun.gas.gas)} gas, about ${units(p.dryRun.gas.expectedCost, 18, 8)} ${NATIVE} at ${gwei(p.dryRun.gas.expectedFeePerGas)}`);
      if (p.tx) facts.push(`nonce ${p.tx.nonce}`);
      if (p.share) facts.push(p.share === "each" ? "each" : "a share of the split");
      meta.textContent = facts.join(" · ");
      item.append(head, meta);
      if (p.memo) item.append(el("p", "payment-memo", `For ${p.memo}. Kept here: a transfer carries no note on chain.`));
      if (p.dryRun.reason) {
        const why = el("p", "note", p.dryRun.reason);
        why.dataset.tone = "error";
        item.append(why);
      }
      item.append(copyable(p.command, `payment ${p.n}'s cast send`));
      return item;
    }),
  );
}

function renderTotals(flow) {
  const rows = flow.totals.map((t) => {
    const item = el("li", "total");
    item.dataset.state = t.covered ? "ok" : "short";
    const mark = el("span", "total-mark");
    mark.setAttribute("aria-hidden", "true");
    mark.append(svgIcon(t.covered ? "M3.5 8.5l3 3 6-7" : "M4.5 4.5l7 7M11.5 4.5l-7 7"));
    const main = el("span", "total-main");
    const label = el("span", "total-label", t.asset);
    label.append(el("span", "sr", t.covered ? ": enough." : ": not enough."));
    main.append(label, el("span", "total-figures", `${t.raw === "0" ? "Gas only" : `${t.shown} in all`}${t.token === null && flow.fees ? `, and up to ${flow.fees.maxShown} of gas` : ""}. Holds ${t.holdsShown}${t.covered ? "." : `: ${t.needsShown} needed.`}`));
    item.append(mark, main);
    return item;
  });
  $("totals").replaceChildren(...rows);
}

function renderSign(flow) {
  const txs = flow.payments.map((p) => p.tx).filter(Boolean);
  const ready = flow.verdict === "ready" && txs.length === flow.payments.length;
  $("sign-box").hidden = !ready;
  if (!ready) return;
  $("sign-meta").textContent = `${txs.length === 1 ? "One EIP-1559 transaction" : `${txs.length} EIP-1559 transactions`} for chain ${flow.network.chainId}, nonces ${txs[0].nonce}${txs.length > 1 ? ` to ${txs.at(-1).nonce}` : ""}, with the dry run's gas limits and fee caps. Sign them in order, from ${flow.sender.address}.`;
  $("sign-json").textContent = JSON.stringify(txs, null, 2);
}

/** Open beside the flow where there is room for it; on a phone, folded under it until asked for. */
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
  setStatus(tone, word, result.verdict === "ready" ? `${result.payments.length === 1 ? "one payment" : `${result.payments.length} payments`}, dry-run, not sent` : detail);
  $("asked").hidden = false;
  $("asked").textContent = `Asked: ${result.request}`;
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = tone === "success" ? "" : tone;
  why.textContent = result.headline;
  $("flow-box").hidden = false;
  renderPayments(result);
  renderTotals(result);
  renderSign(result);
  renderTrail(result.steps);
}

const prepare = agentRunner({
  task: "17",
  panel: $("answer"),
  running: ["Preparing", "reading the request"],
  failed: "Not prepared",
  render,
  onFail: () => {
    for (const id of ["asked", "why", "flow-box", "trail-box"]) $(id).hidden = true;
  },
});

function ask(request) {
  history.replaceState(null, "", `?${new URLSearchParams(request)}`);
  $("f-request").value = request.request;
  $("f-from").value = request.from ?? "";
  $("f-contacts").value = request.contacts;
  prepare(request);
}

/** Each field as typed, marked at its field when wrong. */
function problems(values) {
  return {
    request: !values.request ? "Write a payment request first." : values.request.length > MAX ? `A request is at most ${MAX} characters.` : null,
    from: values.from && !ADDRESS.test(values.from) ? "Enter a 0x address of 40 hex characters, or leave it empty." : null,
    contacts: values.contacts.split(/\n|,/).some((line) => line.trim() && !/^\s*[A-Za-z][\w-]{0,31}\s*[=:]\s*0x[0-9a-fA-F]{40}\s*$/.test(line)) ? "Each line reads name = 0x… (40 hex characters)." : null,
  };
}

const KEYS = ["request", "from", "contacts"];

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = { request: $("f-request").value.trim(), from: $("f-from").value.trim(), contacts: $("f-contacts").value.trim() };
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
  ask({ request: values.request, contacts: values.contacts, ...(values.from ? { from: values.from } : {}) });
  $("answer-h").focus({ preventScroll: true });
});

// Enter sends the request; Shift+Enter starts a new line in it.
$("f-request").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("ask").requestSubmit();
  }
});

for (const [key, request] of Object.entries(EXAMPLES)) {
  $(`ex-${key}`).addEventListener("click", () => {
    const from = $("f-from").value.trim();
    ask({ request, contacts: $("f-contacts").value.trim() || CONTACTS, ...(from && ADDRESS.test(from) ? { from } : {}) });
  });
}

wireCopy($("sign-copy"), { value: () => $("sign-json").textContent, shown: () => $("sign-json"), live: $("copy-state"), what: "Transactions" });

const first = initialRequest();
$("f-request").value = first.request;
$("f-from").value = first.from ?? "";
$("f-contacts").value = first.contacts;
prepare(first);
