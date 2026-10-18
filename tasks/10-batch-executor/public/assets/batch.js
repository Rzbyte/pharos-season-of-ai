// Task 10 page: the Batch Executor. A batch, one action a line (with an optional sender, and whether
// sends to one address are merged), goes to GET /api/agent?task=10&batch=…, which plans it on Pharos
// Mainnet through the hosted Chain MCP: sends merged, the batch shown to be independent or refused, each
// transaction dry-run at one block with the reads they share made once, one nonce sequence and one fee
// quote, and what that saved, counted. The page sends nothing. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, el, group, renderChecks, setStatus, short } from "./agent.js";
import { linkExplorer, renderTaskNav, wireCopy } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "10", LAB);

/** Sample addresses: the agent's example recipient (Tasks 05, 08, 11, 17), a sample address from Task 23, and a made-up spender. */
const RECIPIENT = "0xB2749BD12f19C24a2244176658F3dF3e48e79553";
const STAFF = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const SPENDER = "0x3333333333333333333333333333333333333333";
const BATCH = `send 25 USDC to ${RECIPIENT} # rent
send 10 USDC to ${STAFF} # payroll
send 5 USDC to ${RECIPIENT} # utilities
send 0.01 PROS to ${STAFF} # gas money`;
const EXAMPLES = Object.freeze({
  example: BATCH,
  big: `send 25 USDC to ${RECIPIENT} # rent\nsend 5,000,000 USDC to ${STAFF} # more than it holds\nsend 0.01 PROS to ${STAFF}`,
  order: `approve 100 USDC for ${SPENDER}\nrevoke USDC for ${SPENDER}`,
});
const MAX = 4000;
const MAX_ACTIONS = 6;
const VERBS = new Set(["send", "transfer", "pay", "approve", "revoke", "wrap"]);
const HINT = { batch: $("h-batch").textContent, from: $("h-from").textContent };
const VERDICTS = Object.freeze({
  ready: ["success", "Ready", "independent, not sent"],
  partial: ["warning", "Partly ready", "some left out"],
  "would-fail": ["error", "Would fail", "every action reverts"],
  dependent: ["warning", "Not a batch", "their order matters"],
  short: ["warning", "Short", "the sender holds too little"],
  sent: ["success", "Sent", "back to back"],
  "partly-sent": ["error", "Partly sent", "see below"],
});
const STATES = Object.freeze({ planned: "In the plan", "left-out": "Left out", dependent: "Not independent" });
const DRY = Object.freeze({ "would-succeed": "would succeed", "would-revert": "would revert", "cannot-pay": "cannot pay its gas" });
const SENT = Object.freeze({ success: "sent, succeeded", reverted: "sent, reverted", pending: "sent, not yet in a block", refused: "refused by the node" });
const SOURCE = Object.freeze({ "One sender": "the batch", "Alone at the block": "Chain MCP · eth_call", Allowances: "the batch" });

/** What to plan first: the batch, sender and merging in the address bar, else the example. */
function initialRequest() {
  const query = new URLSearchParams(location.search);
  const batch = query.get("batch")?.trim();
  const from = query.get("from")?.trim();
  return { batch: batch && batch.length <= MAX ? batch : EXAMPLES.example, ...(from && ADDRESS.test(from) ? { from } : {}), ...(query.get("merge") === "0" ? { merge: "0" } : {}) };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lineWords = (lines) => (lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.slice(0, -1).join(", ")} and ${lines.at(-1)}`);
const nonces = (txs) => (txs.length === 1 ? `nonce ${txs[0].nonce}` : `nonces ${txs[0].nonce} to ${txs.at(-1).nonce}`);

/** The page's explorer is Pharos Mainnet's: a run on another network is shown, never linked there. */
let linked = true;
const plain = (text, title) => Object.assign(el("span", "short", text), { title });
const addr = (address, what) => (linked ? addressLink(address, what) : plain(short(address), address));

function txLink(hash) {
  const shown = `${hash.slice(0, 10)}…${hash.slice(-8)}`;
  if (!linked) return plain(shown, hash);
  const link = el("a", "short", shown);
  link.title = hash;
  linkExplorer(link, "tx", hash, "the transaction");
  return link.hidden ? plain(shown, hash) : link;
}

/** A row of a description list: the term, then the value and a line under it. */
function row(term, value, sub) {
  const box = el("div");
  const dd = el("dd");
  dd.append(...[value].flat());
  if (sub) dd.append(el("span", "sub", sub));
  box.append(el("dt", "", term), dd);
  return box;
}

function renderPlan(r) {
  const planned = r.txs.filter((t) => t.tx);
  $("plan-meta").textContent = r.txs.length ? `${plural(r.txs.length, "transaction")} for ${plural(r.actions.length, "line")}${planned.length ? `, ${nonces(planned.map((t) => t.tx))}` : ""}` : `${plural(r.actions.length, "line")}, not planned`;
  // A batch refused before any dry run shows its lines as read.
  if (!r.txs.length) {
    $("txs").replaceChildren(
      ...r.actions.map((a) => {
        const item = el("li", "item");
        item.dataset.state = "dependent";
        const head = el("p", "item-head");
        // Addresses shortened, as everywhere on the page; the line as written is in the title.
        const words = el("span", "item-name", a.words.replace(/0x[0-9a-fA-F]{40}/g, (address) => short(address)));
        words.title = a.words;
        head.append(el("span", "item-n", String(a.line)), " ", words);
        item.append(head);
        if (a.note) item.append(el("p", "item-meta", a.note));
        return item;
      }),
    );
    return;
  }
  $("txs").replaceChildren(
    ...r.txs.map((t) => {
      const item = el("li", "item");
      item.dataset.state = t.submission ? (t.submission.status === "success" ? "sent" : "failed") : t.state;
      const head = el("p", "item-head");
      head.append(el("span", "item-n", String(t.n)), " ", el("span", "item-name", t.summary), " ", el("span", "item-lines", lineWords(t.lines)), " ", el("span", "item-status", t.submission ? SENT[t.submission.status] : STATES[t.state]));
      const facts = [DRY[t.dryRun.verdict]];
      if (t.dryRun.gas) facts.push(`${group(t.dryRun.gas.gas)} gas`);
      if (t.tx) facts.push(`nonce ${t.tx.nonce}`);
      if (t.notes.length) facts.push(t.notes.join("; "));
      const meta = el("p", "item-meta", facts.join(" · "));
      item.append(head, meta);
      if (t.submission?.txHash) {
        const sent = el("p", "item-meta");
        sent.append(t.submission.blockNumber ? `in block ${group(t.submission.blockNumber)}, ` : "", txLink(t.submission.txHash));
        item.append(sent);
      }
      const why = t.submission?.error ?? t.reason;
      if (why) {
        const note = el("p", "note", why);
        note.dataset.tone = t.state === "dependent" ? "warning" : "error";
        item.append(note);
      }
      return item;
    }),
  );
}

function renderChecksOf(r) {
  renderChecks(
    $("checks"),
    r.independence.map((c, k) => ({ id: `check-${k}`, label: c.what, passed: c.ok, seen: null, note: c.detail, tool: SOURCE[c.what] ?? `Chain MCP · eth_call · get_balance @ ${group(r.block.number)}` })),
  );
}

function renderSavings(r) {
  const s = r.savings;
  const rows = [];
  if (r.txs.length) rows.push(row("Calls", `${s.calls} Chain MCP calls`, `its ${plural(r.txs.length, "dry run")}, one by one, ask ${s.oneByOne}`));
  if (r.fees) {
    const planned = r.txs.filter((t) => t.tx);
    rows.push(row("Transactions", `${s.transactions} for ${plural(s.lines, "line")}`, [s.merged ? `${s.merged} fewer by merging` : "", s.leftOut ? `${s.leftOut} left out` : ""].filter(Boolean).join(", ") || "one for each line"));
    rows.push(row("Fees", "one quote for all", `${r.fees.shown}; about ${r.fees.expectedShown}, at most ${r.fees.maxShown}`));
    rows.push(r.execution?.blocks ? row("Sending", `${r.execution.sent} back to back`, r.execution.blocks.span === 1 ? `all in block ${group(r.execution.blocks.first)}; one by one they take at least ${r.execution.sent} blocks` : `in ${r.execution.blocks.span} blocks; one by one they take at least ${r.execution.sent}`) : row("Sending", "back to back", `${nonces(planned.map((t) => t.tx))} in one sequence, the receipts awaited together: the CLI does this on Atlantic`));
  }
  $("savings-box").hidden = !rows.length;
  $("savings").replaceChildren(...rows);
}

function renderCompare(r) {
  const list = r.execution?.comparisons ?? [];
  $("compare-box").hidden = !list.length;
  renderChecks($("compare"), list.map((c, k) => ({ id: `compare-${k}`, label: c.what, passed: c.match, seen: `actual ${c.actual}`, need: `predicted ${c.predicted}`, tool: "Chain MCP · get_balance · eth_call" })));
}

function renderSign(r) {
  const txs = r.txs.map((t) => t.tx).filter(Boolean);
  const show = txs.length > 0 && !r.execution && (r.verdict === "ready" || r.verdict === "partial");
  $("sign-box").hidden = !show;
  if (!show) return;
  $("sign-meta").textContent = `${txs.length === 1 ? "One EIP-1559 transaction" : `${txs.length} EIP-1559 transactions`} for chain ${r.network.chainId}, ${nonces(txs)}, with the dry run's gas limits and one fee cap. Sign them in order from ${r.sender.address}; independent, they can be sent without waiting between.`;
  $("sign-json").textContent = JSON.stringify(txs, null, 2);
}

/** Open beside the plan where there is room for it; on a phone, folded under it until asked for. */
let trailOpened = false;

function renderTrail(steps) {
  const shown = steps.filter((step) => step.source !== "the verdict");
  const box = $("trail-box");
  box.hidden = !shown.length;
  if (!trailOpened) {
    box.open = matchMedia("(min-width: 1000px)").matches;
    trailOpened = true;
  }
  $("trail-n").textContent = plural(shown.length, "step");
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
  const ready = result.txs.filter((t) => t.tx).length;
  setStatus(tone, word, result.verdict === "ready" ? `${plural(ready, "transaction")}, not sent` : result.verdict === "partial" ? `${ready} of ${result.txs.length}, not sent` : detail);
  const asked = $("asked");
  asked.hidden = false;
  const who = { input: "given", key: "the key's", example: "the example's" }[result.sender.from];
  asked.replaceChildren(`${plural(result.actions.length, "action")} from `, addr(result.sender.address, "the sender"), ` (${who})${result.merged.length ? `, ${plural(result.merged.reduce((n, m) => n + m.lines.length - 1, 0), "send")} merged` : ""}`);
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = tone === "success" ? "" : tone;
  why.textContent = result.headline;
  $("batch-box").hidden = false;
  $("limits").hidden = Boolean(result.execution);
  renderPlan(result);
  renderChecksOf(result);
  renderSavings(result);
  renderCompare(result);
  renderSign(result);
  renderTrail(result.steps);
}

const plan = agentRunner({
  task: "10",
  panel: $("answer"),
  running: ["Planning", "reading the batch"],
  failed: "Not planned",
  render,
  onFail: () => {
    for (const id of ["asked", "why", "batch-box", "trail-box"]) $(id).hidden = true;
  },
});

function ask(request) {
  history.replaceState(null, "", `?${new URLSearchParams(request)}`);
  $("f-batch").value = request.batch;
  $("f-from").value = request.from ?? "";
  $("f-merge").value = request.merge ?? "1";
  plan(request);
}

/** Each field as typed, marked at its field when wrong. The API reads every line; this catches the plain slips. */
function problems(values) {
  const lines = values.batch.split("\n").map((line, k) => [k + 1, line.trim()]).filter(([, line]) => line && !line.startsWith("#"));
  const odd = lines.find(([, line]) => !VERBS.has(line.split(/\s+/)[0].toLowerCase()));
  return {
    batch: !lines.length ? "Write a batch first: one action a line." : values.batch.length > MAX ? `A batch is at most ${group(MAX)} characters.` : lines.length > MAX_ACTIONS ? `A batch is at most ${MAX_ACTIONS} actions here (the CLI takes 10); this one has ${lines.length}.` : odd ? `Line ${odd[0]} starts with "${odd[1].split(/\s+/)[0]}": a batch takes send, approve, revoke and wrap.` : null,
    from: values.from && !ADDRESS.test(values.from) ? "Enter a 0x address of 40 hex characters, or leave it empty." : null,
  };
}

const KEYS = ["batch", "from"];

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = { batch: $("f-batch").value.trim(), from: $("f-from").value.trim(), merge: $("f-merge").value };
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
  ask({ batch: values.batch, ...(values.from ? { from: values.from } : {}), ...(values.merge === "0" ? { merge: "0" } : {}) });
  $("answer-h").focus({ preventScroll: true });
});

// A batch has many lines: Enter starts a new one, and Ctrl+Enter (or Cmd+Enter) plans it.
$("f-batch").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    $("ask").requestSubmit();
  }
});

for (const [key, batch] of Object.entries(EXAMPLES)) {
  $(`ex-${key}`).addEventListener("click", () => {
    const from = $("f-from").value.trim();
    ask({ batch, ...(from && ADDRESS.test(from) ? { from } : {}), ...($("f-merge").value === "0" ? { merge: "0" } : {}) });
  });
}

wireCopy($("sign-copy"), { value: () => $("sign-json").textContent, shown: () => $("sign-json"), live: $("copy-state"), what: "Transactions" });

const first = initialRequest();
$("f-batch").value = first.batch;
$("f-from").value = first.from ?? "";
$("f-merge").value = first.merge ?? "1";
plan(first);
