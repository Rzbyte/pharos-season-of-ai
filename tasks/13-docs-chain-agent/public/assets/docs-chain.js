// Task 13 page: the Docs MCP + Chain MCP agent. A question about a Pharos contract, asked in the box, goes
// to GET /api/agent?task=13&q=…, which asks the Pharos Developer Docs MCP, finds the contract's address
// and functions in its answer and the pages it cites, then reads and calls them on Pharos Mainnet through
// the hosted Chain MCP. The page shows the docs' answer with its pages, what the chain says of each
// address, and every step with its source. Nothing is signed or sent. Everything is set as text, never
// as markup.
import { $, addressLink, agentRunner, el, renderChecks, setStatus } from "./agent.js";
import { renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "13", LAB);

const EXAMPLES = Object.freeze({
  usdc: "What is the USDC token address on Pharos Mainnet?",
  wpros: "What is the WPROS token address on Pharos Mainnet?",
});
const MAX = 300;
const HINT = "About a Pharos contract: its address, a function, what it returns. Read on Pharos Mainnet.";
const DOCS = "https://docs.pharos.xyz";
const NETWORKS = Object.freeze({ "pharos-mainnet": "Pharos Mainnet", "atlantic-testnet": "Atlantic Testnet" });
/** Each verdict's tone, word and detail; a confirmed or other-network detail depends on the readings. */
const VERDICTS = Object.freeze({
  confirmed: ["success", "Confirmed"],
  mismatch: ["warning", "Mismatch", "the chain says otherwise"],
  "no-contract": ["warning", "No contract", "where the docs say"],
  "other-network": ["neutral", "Another network"],
  "nothing-to-call": ["neutral", "Nothing to call", "the docs gave no address"],
  "no-answer": ["neutral", "Not in the docs", "nothing called on chain"],
});
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const path = (url) => (url.startsWith(`${DOCS}/`) ? url.slice(DOCS.length) : url);

/** What to ask first: a question from the address bar, else the USDC example. */
function initialQuestion() {
  const q = new URLSearchParams(location.search).get("q")?.replace(/\s+/g, " ").trim();
  return q && q.length <= MAX ? q : EXAMPLES.usdc;
}

/** A docs page, linked: only ever a page of the official docs (the agent keeps no other source). */
function pageLink(url, title) {
  if (!url.startsWith(`${DOCS}/`)) return el("span", "cite-link", title ?? url);
  const link = el("a", "cite-link", title ?? path(url));
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.append(el("span", "sr", ", opens in a new tab"));
  return link;
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

/** What the chain says of one address, as check rows: its code, the functions the docs give, its name. */
function checks(r) {
  if (!r.read) return [{ id: "network", label: "Not read", passed: null, seen: `the docs place it on ${NETWORKS[r.network] ?? r.network}`, tool: "this page reads Pharos Mainnet" }];
  const rows = [{ id: "code", label: "Code", passed: r.code !== "none", seen: r.code === "none" ? "none: no contract here" : r.code === "delegated" ? "an account delegated to a contract (EIP-7702)" : "a contract", tool: "get_code" }];
  for (const call of r.calls.filter((c) => c.from === "docs")) rows.push({ id: `fn-${call.name}`, label: `${call.name}()`, passed: call.ok, seen: call.ok ? call.value : null, need: `returns ${call.returns}, as the docs say`, tool: "eth_call", error: call.ok ? null : `It did not answer: ${call.error}.` });
  const t = r.token;
  if (t) rows.push({ id: "name", label: "Its name on chain", passed: r.agrees !== false, seen: t.name && t.name !== t.symbol ? `${t.symbol} · ${t.name}` : t.symbol, need: r.agrees === false ? `the docs say "${r.label}"` : null, tool: "eth_call", note: r.agrees === null ? "The docs' name for it has no symbol to compare." : null });
  if (r.skillEngine) rows.push({ id: "skill", label: "Skill Engine token list", passed: r.skillEngineAgrees !== false, seen: `lists it as ${r.skillEngine}`, tool: "tokens.json", note: r.skillEngineAgrees === null ? "Nothing on chain to compare it with." : null });
  return rows;
}

function renderReadings(result) {
  $("readings-box").hidden = !result.readings.length;
  $("readings").replaceChildren(
    ...result.readings.map((r) => {
      const card = el("article", "reading");
      const head = el("p", "reading-head");
      head.append(addressLink(r.address, "the contract"), el("span", "reading-label", `"${r.label}"`));
      const where = el("p", "reading-where");
      where.append(r.onPage ? "On " : "In the docs' answer only, on none of the pages it cites", ...(r.onPage ? [pageLink(r.onPage, result.docs.sources.find((s) => s.url === r.onPage)?.title ?? null)] : []), r.network ? ` · ${NETWORKS[r.network] ?? r.network}` : "");
      const list = el("ul", "checks");
      renderChecks(list, checks(r));
      card.append(head, where, list);
      if (r.token && (r.token.decimals !== null || r.token.totalSupplyShown)) {
        const facts = el("dl", "rows facts");
        const fact = (label, value) => {
          const row = el("div");
          row.append(el("dt", "", label), el("dd", "", value));
          return row;
        };
        if (r.token.decimals !== null) facts.append(fact("Decimals", String(r.token.decimals)));
        if (r.token.totalSupplyShown) facts.append(fact("Total supply", `${r.token.totalSupplyShown} ${r.token.symbol}`));
        card.append(facts);
      }
      return card;
    }),
  );
}

/** Every step but the verdict (the note above says it), each with its source. */
function renderTrail(steps) {
  const shown = steps.filter((step) => step.source !== "the verdict");
  $("trail-box").hidden = !shown.length;
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
  const [tone, word, detail] = VERDICTS[result.verdict];
  const first = result.readings[0];
  setStatus(tone, word, detail ?? (result.verdict === "confirmed" ? (first?.agrees ? "the chain agrees with the docs" : "a contract where the docs say") : `the docs place it on ${NETWORKS[first?.network] ?? "another network"}`));
  $("asked").hidden = false;
  $("asked").textContent = `Asked: ${result.question}`;
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = tone === "warning" ? "warning" : "";
  why.textContent = result.headline;
  renderDocs(result);
  renderReadings(result);
  renderTrail(result.steps);
  renderDocsCalls(docsCalls ?? []);
  // The shared runner counts calls as one number; this answer has two kinds.
  $("pin-calls").textContent = `${result.toolCalls.chain} ${result.toolCalls.chain === 1 ? "call" : "calls"}`;
}

const ask = agentRunner({
  task: "13",
  panel: $("answer"),
  running: ["Asking", "the docs, then the chain"],
  failed: "Not answered",
  render,
  onFail: () => {
    for (const id of ["asked", "why", "docs-box", "trail-box"]) $(id).hidden = true;
  },
});

function askAbout(q) {
  history.replaceState(null, "", `?${new URLSearchParams({ q })}`);
  $("f-q").value = q;
  ask({ q });
}

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("f-q");
  const hint = $("h-q");
  const q = input.value.replace(/\s+/g, " ").trim();
  const problem = !q ? "Ask a question first: about a Pharos contract, its address or a function." : q.length > MAX ? `A question is at most ${MAX} characters.` : null;
  input.setAttribute("aria-invalid", String(Boolean(problem)));
  hint.classList.toggle("invalid", Boolean(problem));
  hint.textContent = problem ?? HINT;
  if (problem) {
    input.focus();
    return;
  }
  askAbout(q);
  $("answer-h").focus({ preventScroll: true });
});

$("ex-usdc").addEventListener("click", () => askAbout(EXAMPLES.usdc));
$("ex-wpros").addEventListener("click", () => askAbout(EXAMPLES.wpros));

const first = initialQuestion();
$("f-q").value = first;
ask({ q: first });
