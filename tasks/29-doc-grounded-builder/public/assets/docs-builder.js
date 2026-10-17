// Task 29 page: the Doc-Grounded Builder Agent. A how-to question, asked in the box (with an optional
// address), goes to GET /api/agent?task=29&q=…, which asks the Pharos Developer Docs MCP, reads the action
// the question asks for, sets its pieces beside the Pharos Skill Engine's, dry-runs it on Pharos Mainnet
// through the hosted Chain MCP (or reads a balance), and writes the Skill Engine's cast commands for it.
// The page shows each part with its source. Nothing is signed or sent. Everything is set as text, never
// as markup.
import { $, addressLink, ADDRESS, agentRunner, el, group, gwei, setStatus, units } from "./agent.js";
import { renderTaskNav, svgIcon, wireCopy } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "29", LAB);

const EXAMPLES = Object.freeze({
  send: "How do I send USDC to another wallet on Pharos Mainnet?",
  approve: "How do I approve a spender to use my USDC?",
  wrap: "How do I wrap 0.5 PROS into WPROS?",
  balance: "How do I check my USDC balance?",
});
const MAX = 300;
const HINT = { q: $("h-q").textContent, from: $("h-from").textContent };
const DOCS = "https://docs.pharos.xyz";
const SKILL_ENGINE = "https://github.com/PharosNetwork/pharos-skill-engine";
const NATIVE = "PROS";
/** Each verdict's tone, word and detail. A ready one whose docs differ from the Skill Engine is a warning. */
const VERDICTS = Object.freeze({
  ready: ["success", "Ready", "dry-run, not sent"],
  "would-fail": ["error", "Would fail", "in the dry run"],
  sent: ["success", "Sent", "and checked"],
  read: ["success", "Read", "on Pharos Mainnet"],
  "not-prepared": ["neutral", "Not prepared", "the docs answered"],
  "no-answer": ["neutral", "Not in the docs", "nothing prepared"],
});
const ORIGIN = Object.freeze({ question: "from the question", input: "given", example: "the example's" });
const COPY_ICON = "M5.75 5.75h6.5v6.5h-6.5zM3.75 10.25v-6.5h6.5";
const COPIED_ICON = "M3.5 8.5l3 3 6-7";
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const path = (url) => (url.startsWith(`${DOCS}/`) ? url.slice(DOCS.length) : url);

/** What to ask first: a question (and an address) from the address bar, else the send example. */
function initialRequest() {
  const query = new URLSearchParams(location.search);
  const q = query.get("q")?.replace(/\s+/g, " ").trim();
  const from = query.get("from")?.trim();
  return { q: q && q.length <= MAX ? q : EXAMPLES.send, ...(from && ADDRESS.test(from) ? { from } : {}) };
}

/** A link that leaves the site: a new tab, no opener, and it says so. */
function outLink(href, text, className = "cite-link") {
  const link = el("a", className, text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.append(el("span", "sr", ", opens in a new tab"));
  return link;
}

/** A docs page, linked: only ever a page of the official docs. */
const pageLink = (url, title) => (url.startsWith(`${DOCS}/`) ? outLink(url, title ?? path(url)) : el("span", "cite-link", title ?? url));
const titleOf = (result, url) => result.docs.sources.find((s) => s.url === url)?.title ?? null;

function row(label, ...value) {
  const item = el("div");
  const dd = el("dd");
  dd.append(...value);
  item.append(el("dt", "", label), dd);
  return item;
}

function renderDocs(result) {
  const { docs } = result;
  $("docs-box").hidden = docs.status !== "answered";
  if (docs.status !== "answered") return;
  $("docs-answer").textContent = docs.answer;
  $("cited").replaceChildren(
    ...docs.sources.map((source) => {
      const item = el("li", "cite");
      item.append(pageLink(source.url, source.title));
      if (docs.pages.includes(source.url)) item.append(el("span", "cite-read", "read"));
      return item;
    }),
  );
}

/** The action in words, then each value with where it came from. */
function renderAction(result) {
  const a = result.action;
  $("action-box").hidden = !a;
  if (!a) return;
  const read = a.kind === "balance";
  $("action-h").textContent = read ? "What it reads" : "What it prepares";
  $("action-summary").textContent = a.summary;
  const asset = a.token?.symbol ?? NATIVE;
  const role = read ? "Address" : a.kind === "erc20-approve" ? "Owner" : "Sender";
  const rows = [row(role, addressLink(a.account.value, `the ${role.toLowerCase()}`), el("span", "sub", ORIGIN[a.account.from]))];
  if (a.counterparty) rows.push(row(a.kind === "erc20-approve" ? "Spender" : "Recipient", addressLink(a.counterparty.value, a.kind === "erc20-approve" ? "the spender" : "the recipient"), el("span", "sub", ORIGIN[a.counterparty.from])));
  if (a.amount) rows.push(row("Amount", `${a.amount.value === "max" ? "unlimited" : a.amount.value.replace(/^\d+/, (whole) => group(whole))} ${a.kind === "wrap" ? NATIVE : asset}`, el("span", "sub", ORIGIN[a.amount.from])));
  if (a.token) rows.push(row("Token", `${a.token.symbol} `, addressLink(a.token.address, a.token.symbol), el("span", "sub", "the Skill Engine's token list")));
  $("action-rows").replaceChildren(...rows);
}

const AGREES = Object.freeze({ true: ["same", "M3.5 8.5l3 3 6-7", "agrees"], false: ["differs", "M4.5 4.5l7 7M11.5 4.5l-7 7", "differs"], null: ["unsaid", "M4 8h8", "not in the docs read"] });

/** Each piece the action uses (from the Skill Engine, or the standard), beside what the docs say of it. */
function renderGround(result) {
  $("ground-box").hidden = !result.grounding.length;
  $("ground").replaceChildren(
    ...result.grounding.map((g) => {
      const [state, icon, said] = AGREES[String(g.agrees)];
      const item = el("li", "ground-row");
      item.dataset.state = state;
      const mark = el("span", "ground-mark");
      mark.setAttribute("aria-hidden", "true");
      mark.append(svgIcon(icon));
      const main = el("span", "ground-main");
      const label = el("span", "ground-label", g.label);
      label.append(el("span", "sr", `: ${said}.`));
      const uses = el("span", "ground-uses");
      uses.append(g.id === "token" ? addressLink(g.uses, g.label) : g.uses, el("span", "ground-from", g.usesFrom));
      const docs = el("span", "ground-docs");
      if (g.docs === null) docs.append("The docs read do not give it.");
      else {
        const place = g.docsWhere === "the answer" ? "The docs' answer" : pageLink(g.docsWhere, titleOf(result, g.docsWhere));
        const value = g.id === "token" ? addressLink(g.docs, "the docs' address") : g.docs;
        docs.append(place, ...(g.agrees === true ? [" gives the same."] : g.agrees === false ? [" gives ", value, " instead."] : [" gives only ", value, "."]));
      }
      main.append(label, uses, docs);
      item.append(mark, main);
      return item;
    }),
  );
}

/** The dry run (Task 08's): whether it goes through, the gas and fee, the funds, and the balances it changes. */
function renderDry(result) {
  const run = result.prepared;
  const read = result.read;
  $("dry-box").hidden = !run && !read;
  if (!run && !read) return;
  const at = group(result.block.number);
  if (read) {
    $("dry-h").textContent = `Read at block ${at}`;
    $("dry-rows").replaceChildren(row("Holds", read.shown, el("span", "sub", read.token ? "eth_call balanceOf" : "get_balance")));
    $("outcome").replaceChildren();
    $("warnings").hidden = true;
    return;
  }
  $("dry-h").textContent = `Dry run at block ${at}`;
  const rows = [row("Simulated", run.simulation.ok ? `Succeeds${run.returns ? `, returns ${run.returns}` : ""}` : `Reverts: ${run.simulation.reason}`, el("span", "sub", "eth_call"))];
  if (run.gas) {
    rows.push(row("Gas", `${group(run.gas.gas)} estimated, ${group(run.gas.gasLimit)} limit`, el("span", "sub", "estimate_gas")));
    rows.push(row("Fee", `About ${units(run.gas.expectedCost, 18, 8)} ${NATIVE} at ${gwei(run.gas.expectedFeePerGas)}`, el("span", "sub", `At most ${units(run.gas.maxCost, 18, 8)} ${NATIVE}, under the ${gwei(run.gas.maxFeePerGas)} cap.`)));
  }
  rows.push(row("Funds", `Holds ${run.funds.shown.holds}${run.funds.shown.needs ? `; needs up to ${run.funds.shown.needs}` : ""}`, el("span", "sub", "get_balance")));
  if (!run.submission) rows.push(row("Sent", "No: the hosted Chain MCP is read-only; the CLI sends on Atlantic with a key."));
  $("dry-rows").replaceChildren(...rows);
  $("outcome").replaceChildren(
    ...run.outcome.map((line) => {
      const item = el("li", "change");
      const who = el("span", "change-who");
      who.append(line.role === "allowance" ? "Allowance to " : line.role === "sender" ? "Sender " : "Recipient ", addressLink(line.role === "allowance" ? line.spender : line.address, line.role === "allowance" ? "the spender" : `the ${line.role}`), ` · ${line.asset}`);
      item.append(who, el("span", "change-span", line.after === null ? line.shown.before : `${line.shown.before} → ${line.shown.after}${line.approximate ? ", after gas" : ""}`));
      return item;
    }),
  );
  const warnings = $("warnings");
  warnings.hidden = !run.warnings.length;
  warnings.replaceChildren(
    ...run.warnings.map((w) => {
      const item = el("li", "note", w.message);
      item.dataset.tone = "warning";
      return item;
    }),
  );
}

/** A command as the Skill Engine writes it, with a Copy button (or, where the clipboard is refused, selected). */
function command(c, commit) {
  const box = el("div", "skill-cmd");
  const head = el("p", "skill-label", `${c.label} `);
  head.append(outLink(`${SKILL_ENGINE}/blob/${commit}/${c.reference}`, c.reference, "skill-ref"));
  const pre = el("pre", "cmd");
  pre.append(el("code", "", c.command));
  const copy = el("button", "action copy");
  copy.type = "button";
  copy.dataset.copy = "idle";
  const words = el("span", "swap");
  words.append(el("span", "", "Copy"), el("span", "", "Copied"));
  const icons = el("span", "swap");
  icons.append(svgIcon(COPY_ICON), svgIcon(COPIED_ICON));
  copy.append(icons, words);
  copy.setAttribute("aria-label", `Copy: ${c.label}`);
  wireCopy(copy, { value: () => c.command, shown: () => pre, live: $("copy-state"), what: "Command" });
  box.append(head, pre, copy);
  return box;
}

function renderSkill(result) {
  const s = result.skillEngine;
  $("skill-box").hidden = !s;
  if (!s) return;
  $("skill-meta").replaceChildren(`For ${s.network.name} (chain ${s.network.chainId}), from `, outLink(`${SKILL_ENGINE}/tree/${s.commit}`, `pharos-skill-engine ${s.commit.slice(0, 7)}`, "skill-ref"), `. ${result.action?.kind === "balance" ? "It reads" : "With your key in $PRIVATE_KEY, as the Skill Engine advises, it sends"}; this page runs none of them.`);
  $("skill-commands").replaceChildren(...s.commands.map((c) => command(c, s.commit)));
  const fee = $("skill-fee");
  fee.hidden = !s.fee;
  if (s.fee) fee.textContent = `By its gas rule: a ${group(s.fee.gasLimit)} gas limit (the ${group(s.fee.gas)} estimate × 1.2, rounded up), at ${gwei(s.fee.gasPrice)}, is ${s.fee.costShown}.`;
}

/** Open beside the answer where there is room for it; on a phone, folded under it until asked for. */
let trailOpened = false;

/** Every step but the verdict (the note above says it), each with its source. */
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

function renderDocsCalls(calls) {
  $("docs-calls-n").textContent = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;
  $("docs-calls").replaceChildren(
    ...calls.map((call) => {
      const item = el("li");
      const body = el("span", "call-body");
      body.append(el("span", "call-tool", call.tool), ` ${call.tool === "getPage" ? path(String(call.args.url ?? "")) : `"${clip(String(call.args.question ?? call.args.query ?? ""), 80)}"`}`);
      if (!call.ok) body.append(el("span", "call-failed", " (error)"));
      item.append(body);
      return item;
    }),
  );
}

function render({ result, docsCalls }) {
  const differ = result.grounding.filter((g) => g.agrees === false).length;
  const [tone, word, detail] = VERDICTS[result.verdict];
  if (result.verdict === "ready" && differ) setStatus("warning", word, `the docs differ on ${differ === 1 ? "one point" : `${differ} points`}`);
  else setStatus(tone, word, detail);
  $("asked").hidden = false;
  $("asked").textContent = `Asked: ${result.question}`;
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = result.verdict === "would-fail" ? "error" : differ ? "warning" : "";
  why.textContent = result.headline;
  renderDocs(result);
  renderAction(result);
  renderGround(result);
  renderDry(result);
  renderSkill(result);
  renderTrail(result.steps);
  renderDocsCalls(docsCalls ?? []);
  // The shared runner counts calls as one number; this answer has two kinds.
  $("pin-calls").textContent = `${result.toolCalls.chain} ${result.toolCalls.chain === 1 ? "call" : "calls"}`;
}

const ask = agentRunner({
  task: "29",
  panel: $("answer"),
  running: ["Asking", "the docs, then preparing it"],
  failed: "Not answered",
  render,
  onFail: () => {
    for (const id of ["asked", "why", "docs-box", "trail-box"]) $(id).hidden = true;
  },
});

function askAbout(request) {
  history.replaceState(null, "", `?${new URLSearchParams(request)}`);
  $("f-q").value = request.q;
  $("f-from").value = request.from ?? "";
  ask(request);
}

/** The question and the address as typed, each marked at its field when wrong. */
function problems(q, from) {
  return {
    q: !q ? "Ask a question first: how to send, approve, wrap, or a balance." : q.length > MAX ? `A question is at most ${MAX} characters.` : null,
    from: from && !ADDRESS.test(from) ? "Enter a 0x address of 40 hex characters, or leave it empty." : null,
  };
}

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const q = $("f-q").value.replace(/\s+/g, " ").trim();
  const from = $("f-from").value.trim();
  const wrong = problems(q, from);
  for (const key of ["q", "from"]) {
    const input = $(`f-${key}`);
    const hint = $(`h-${key}`);
    input.setAttribute("aria-invalid", String(Boolean(wrong[key])));
    hint.classList.toggle("invalid", Boolean(wrong[key]));
    hint.textContent = wrong[key] ?? HINT[key];
  }
  const first = ["q", "from"].find((key) => wrong[key]);
  if (first) {
    $(`f-${first}`).focus();
    return;
  }
  askAbout({ q, ...(from ? { from } : {}) });
  $("answer-h").focus({ preventScroll: true });
});

for (const [key, q] of Object.entries(EXAMPLES)) {
  $(`ex-${key}`).addEventListener("click", () => {
    const from = $("f-from").value.trim();
    askAbout({ q, ...(from && ADDRESS.test(from) ? { from } : {}) });
  });
}

const first = initialRequest();
$("f-q").value = first.q;
$("f-from").value = first.from ?? "";
ask(first);
