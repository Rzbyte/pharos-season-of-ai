// Task 27 page: the support agent. A transaction hash, asked in the box, goes to GET
// /api/agent?task=27&hash=…, which explains through the hosted Chain MCP why the transaction failed (or
// that it did not); a transaction described in the address bar (as Task 08 takes it) is explained as if
// sent now. Every finding comes with the tool it came from. Nothing is signed or sent. Everything is set
// as text, never as markup.
import { $, addressLink, agentRunner, el, group, queryInputs, setStatus } from "./agent.js";
import { linkExplorer, renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "27", LAB);

/** A real USDC transfer on Pharos Mainnet, from Task 02's live proof: 600 USDC in block 20,250,972. */
const REAL = "0x968810950de8d8fa80d17a9e1d03b72e8806a0d11d89579459bceaee45ce510c";
/** A transfer of more than the example sender holds, described, not sent. */
const FAILING = Object.freeze({ action: "transfer", asset: "USDC", from: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", to: "0xB2749BD12f19C24a2244176658F3dF3e48e79553", amount: "5000000" });
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WORDS = Object.freeze({ revert: "it reverted", "out-of-gas": "it ran out of gas", "earlier-in-block": "something earlier in its block", "cannot-pay": "it cannot pay for gas" });

/** What to explain first: a hash or a description from the address bar, else the failing example. */
function initialRequest() {
  const hash = new URLSearchParams(location.search).get("hash")?.trim();
  if (hash && HASH.test(hash)) return { hash };
  return queryInputs(Object.keys(FAILING)) ?? { ...FAILING };
}

function renderFindings(findings) {
  $("findings-box").hidden = false;
  $("findings").replaceChildren(
    ...findings.map((f) => {
      const row = el("li", "finding");
      row.dataset.tone = f.tone;
      row.append(el("span", "finding-check", f.check), el("span", "finding-seen", f.seen), el("span", "finding-tool", f.tool));
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

function renderFacts(result) {
  const t = result.transaction;
  $("facts-box").hidden = !t;
  if (!t) return;
  const rows = [];
  if (t.hash) {
    const link = el("a", "short", `${t.hash.slice(0, 10)}…${t.hash.slice(-8)}`);
    link.title = t.hash;
    linkExplorer(link, "tx", t.hash, "the transaction");
    rows.push(fact("Hash", link.hidden ? el("span", "short", t.hash.slice(0, 18)) : link));
  } else rows.push(fact("Sent", "No: described, and dry-run at the newest block"));
  rows.push(fact("From", addressLink(t.from, "the sender")));
  if (t.to) rows.push(fact("To", addressLink(t.to, "the target")));
  if (result.receipt) {
    rows.push(fact("Gas", `${group(result.receipt.gasUsed)} used of ${group(t.gasLimit)}`));
    if (result.receipt.feeShown) rows.push(fact("Fee", result.receipt.feeShown));
  }
  if (t.nonce !== null) rows.push(fact("Nonce", group(t.nonce)));
  $("facts").replaceChildren(...rows);
}

function render({ result }) {
  const word = WORDS[result.cause?.kind] ?? "";
  switch (result.status) {
    case "failed":
      setStatus("error", "Failed", word);
      break;
    case "would-fail":
      setStatus("warning", "Would fail", word);
      break;
    case "succeeded":
      setStatus("success", "Succeeded", "it did not fail");
      break;
    case "would-succeed":
      setStatus("success", "Would succeed", "if sent now");
      break;
    case "pending":
      setStatus("neutral", "Pending", "in no block yet");
      break;
    default:
      setStatus("neutral", "Not found", "on Pharos Mainnet");
  }
  const tx = $("tx");
  tx.hidden = !result.transaction;
  tx.textContent = result.transaction ? `${result.request.kind === "hash" ? "" : "Described, not sent: "}${result.transaction.summary}` : "";
  const why = $("why");
  why.hidden = false;
  why.dataset.tone = result.status === "failed" ? "error" : result.status === "would-fail" ? "warning" : "";
  why.textContent = result.cause ? result.cause.text : result.headline;
  const fix = $("fix");
  fix.hidden = !result.fix;
  fix.textContent = result.fix ? `What to do: ${result.fix}` : "";
  renderFindings(result.findings);
  renderFacts(result);
}

const ask = agentRunner({ task: "27", panel: $("answer"), running: ["Explaining", "reading Pharos Mainnet"], failed: "Not explained", render, onFail: () => ($("why").hidden = $("fix").hidden = true) });

function explain(request) {
  history.replaceState(null, "", `?${new URLSearchParams(request)}`);
  $("f-hash").value = request.hash ?? "";
  ask(request);
}

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("f-hash");
  const hint = $("h-hash");
  const hash = input.value.trim();
  const ok = HASH.test(hash);
  input.setAttribute("aria-invalid", String(!ok));
  hint.classList.toggle("invalid", !ok);
  hint.textContent = ok ? "A Pharos Mainnet transaction, 0x and 64 hex characters." : "That is not a transaction hash: 0x and 64 hex characters.";
  if (!ok) {
    input.focus();
    return;
  }
  explain({ hash });
  $("answer-h").focus({ preventScroll: true });
});

$("ex-failing").addEventListener("click", () => explain({ ...FAILING }));
$("ex-real").addEventListener("click", () => explain({ hash: REAL }));

const first = initialRequest();
$("f-hash").value = first.hash ?? "";
ask(first);
