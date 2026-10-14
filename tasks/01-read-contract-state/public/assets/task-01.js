// Task 01 page: an on-chain snapshot of the Circle USDC Contract on Pharos Mainnet.
//
// The browser only ever calls this site's own GET /api/state, the frozen Task 01 function that
// reads Pharos server-side through Chain MCP. Every value is written as text. The last good
// snapshot stays on screen while a new one is read (READING) and after a failed read (ERROR).
//
// FRESH or CACHED: /api/state lets the edge keep a good read for up to a minute
// (s-maxage=15, stale-while-revalidate=45), so a response can be an earlier read served again.
// The page says which. CACHED when the edge reports its own copy (x-vercel-cache HIT or STALE,
// or an Age), or when the read is the one already on screen; FRESH otherwise.
import { clockTime, duration, fitFigure, groupDigits, renderAddress, renderTaskContext, reducedMotion, setState, setText, settle, snapshotSource, splitAmount, toHexBlock } from "./lab.js";
import { TASKS } from "./tasks.js";

const $ = (id) => document.getElementById(id);
const main = $("main");
const panel = $("snapshot");
const API = main.dataset.api;
const STATUS_WORD = { reading: "Reading", fresh: "Fresh snapshot", cached: "Cached snapshot", error: "Read failed" };
const TONE = { reading: "active", fresh: "success", cached: "neutral", error: "error" };
const FIGURE_MIN_PX = 22;

let last = null;
let busy = false;
let fitQueued = false;
let copyTimer;

renderTaskContext(TASKS, main.dataset.task, { counter: $("task-count"), previous: $("nav-previous"), next: $("nav-next") });
renderAddress($("address"), $("address-sr").textContent.trim());
for (const button of document.querySelectorAll("[data-refresh]")) button.addEventListener("click", measure);
$("copy").addEventListener("click", copyAddress);
// A link to the proof opens it, so it never lands on a closed section.
for (const link of document.querySelectorAll('a[href="#proof"]')) link.addEventListener("click", () => void ($("proof").open = true));
addEventListener("resize", fitSupply);
// The fit is measured in the real faces, so measure again whenever webfonts finish loading.
document.fonts?.addEventListener?.("loadingdone", fitSupply);
document.fonts?.ready.then(fitSupply);
measure();

/** FRESH or CACHED -> READING -> FRESH or CACHED, or ERROR with the last good snapshot kept. */
async function measure() {
  if (busy) return;
  busy = true;
  setBusy(true);
  report("reading", last ? "taking a new snapshot" : "through Pharos Chain MCP");

  let response;
  let data = null;
  try {
    // no-store: Refresh must reach the server, never the browser's stale-while-revalidate copy.
    response = await fetch(API, { headers: { accept: "application/json" }, cache: "no-store" });
    data = await response.json().catch(() => null);
  } catch {
    // The request itself failed; reported below as an error with no data.
  }

  const fail = (problem) => report("error", last ? "showing the last good snapshot" : "no snapshot yet", problem);
  if (data?.ok === true) {
    try {
      const served = snapshotSource(response.headers, data.fetchedAt, last?.fetchedAt);
      render(data);
      last = data;
      main.dataset.measured = "";
      report(served.cached ? "cached" : "fresh", served.detail);
    } catch {
      // Never left stuck in READING: a report this page cannot use is an error like any other.
      fail("The state endpoint sent a report this page could not read.");
    }
  } else {
    fail(
      data?.error
        ? [data.error.message, data.error.hint].filter(Boolean).join(" ")
        : response ? `The state endpoint answered HTTP ${response.status}.` : "Could not reach the state endpoint.",
    );
  }
  setBusy(false);
  busy = false;
}

function render(data) {
  const { contract, network, values, source } = data;
  const supply = splitAmount(data.display?.totalSupply ?? `${values.totalSupply.formatted} ${values.symbol}`);
  const block = groupDigits(data.blockNumber);
  const changed = !last || last.blockNumber !== data.blockNumber || last.values.totalSupply.raw !== values.totalSupply.raw;
  const calls = source.toolCalls;
  const retries = calls - 6;

  // The snapshot: what contract, which block and when, the supply, then the other three reads.
  setText($("subject"), contract.label);
  setText($("block"), block);
  setText($("read-at"), clockTime(data.fetchedAt));
  // One continuous value: the whole number, digits and punctuation untouched, then the unit.
  setText($("supply-amount"), supply.major + supply.minor);
  setText($("supply-unit"), supply.unit);
  setText($("v-name"), values.name);
  setText($("v-symbol"), values.symbol);
  setText($("v-decimals"), String(values.decimals));
  setText($("network"), network?.name ?? "Not confirmed");
  setText("[data-chain]", network ? String(network.chainId) : "not confirmed");
  setText("[data-block]", `#${block}`);
  renderAddress($("address"), contract.address);
  setText($("address-sr"), contract.address);
  const warnings = $("warnings");
  setText(warnings, data.warnings.join(" "));
  warnings.hidden = data.warnings.length === 0;

  // Proof and technical details: the "how", collapsed by default.
  setText($("proof-calls"), String(calls));
  setText($("proof-calls-sub"), retries > 0 ? `includes ${retries} same-block retr${retries === 1 ? "y" : "ies"}` : "2 context + 4 contract reads");
  setText($("v-raw"), values.totalSupply.raw);
  setText($("t-endpoint"), source.endpoint);
  setText($("t-server"), source.server ?? "not reported");
  setText($("t-calls"), `${calls}: get_chain_info, get_block_number, eth_call ×${calls - 2}`);
  setText($("t-block"), `${data.blockNumber}, sent as ${toHexBlock(data.blockNumber)} in every eth_call`);
  setText($("t-raw"), `${values.totalSupply.raw} with ${values.decimals} decimals`);
  setText(
    $("t-label"),
    contract.labelSource === "known-address"
      ? `${contract.label}: a listed address, named only because get_chain_info returned chain ${network?.chainId} and symbol() returned ${values.symbol}`
      : `${contract.label}: built from the token's own name() and symbol()`,
  );
  setText($("t-retries"), data.retriedAtSameBlock.length ? `${data.retriedAtSameBlock.map((field) => `${field}()`).join(", ")} retried once at the same block` : "none");
  setText($("t-warnings"), data.warnings.length ? data.warnings.join(" ") : "none");
  setText($("t-elapsed"), duration(data.elapsedMs));
  setText($("t-fetched"), data.fetchedAt);
  setText($("t-client"), `${data.tool.name} ${data.tool.version}`);
  setText($("t-summary"), data.summary);

  fitSupply();
  if (changed) for (const element of [$("supply"), $("block")]) settle(element);
}

/** One state for the snapshot: the status line, its tone, and the error note. */
function report(state, detail, problem = "") {
  setState(state);
  $("status").dataset.tone = TONE[state];
  setText("[data-status-word]", STATUS_WORD[state]);
  setText("[data-status-detail]", detail);
  // Screen readers hear which snapshot is on screen with the state, not only the state.
  setText($("status-sr"), last ? `, block ${groupDigits(last.blockNumber)}, read at ${clockTime(last.fetchedAt)}` : "");
  const note = $("status-note");
  setText(note, problem);
  note.hidden = !problem;
}

/** While a read is in flight the panel is busy; Refresh keeps focus and simply waits. */
function setBusy(on) {
  panel.setAttribute("aria-busy", String(on));
  for (const button of document.querySelectorAll("[data-refresh]")) button.setAttribute("aria-disabled", String(on));
}

/** Keep the supply on one line, as large as its panel allows, on any screen and with any value. */
function fitSupply() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitFigure($("supply"), $("supply-amount"), FIGURE_MIN_PX);
  });
}

async function copyAddress() {
  const button = $("copy");
  const address = last?.contract.address ?? $("address-sr").textContent.trim();
  let copied = false;
  try {
    await navigator.clipboard.writeText(address);
    copied = true;
  } catch {
    // Clipboard access can be refused; the address text stays selectable.
  }
  setText(button, copied ? "Copied" : "Select to copy");
  setText($("copy-state"), copied ? "Address copied" : "");
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => setText(button, "Copy address"), reducedMotion() ? 2400 : 1600);
}
