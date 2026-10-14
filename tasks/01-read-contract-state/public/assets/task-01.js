// Task 01 page: a live measurement of the Circle USDC Contract on Pharos Mainnet.
//
// The browser only ever calls this site's own GET /api/state, the frozen Task 01 function that
// reads Pharos server-side through Chain MCP. Every value is written as text. The last good
// measurement stays on screen while a new one is taken (READING) and after a failed one (ERROR).
import { clockTime, duration, fitFigure, groupDigits, renderAddress, renderTaskContext, reducedMotion, setState, setText, settle, splitAmount, toHexBlock } from "./lab.js";
import { TASKS } from "./tasks.js";

const $ = (id) => document.getElementById(id);
const main = $("main");
const API = main.dataset.api;
const STATUS_WORD = { reading: "Reading", live: "Live", error: "Error" };
const FIGURE_MIN_PX = 22;

let last = null;
let busy = false;
let fitQueued = false;
let copyTimer;

renderTaskContext(TASKS, main.dataset.task, { counter: $("task-count"), previous: $("nav-previous"), next: $("nav-next") });
renderAddress($("address"), $("address-sr").textContent.trim());
for (const button of document.querySelectorAll("[data-refresh]")) button.addEventListener("click", measure);
$("copy").addEventListener("click", copyAddress);
addEventListener("resize", fitSupply);
// The fit is measured in the real faces, so measure again whenever webfonts finish loading.
document.fonts?.addEventListener?.("loadingdone", fitSupply);
document.fonts?.ready.then(fitSupply);
showBarWhenReadoutLeaves();
measure();

/** LIVE -> READING -> LIVE, or ERROR with the last good measurement kept. */
async function measure() {
  if (busy) return;
  busy = true;
  setButtons(true);
  const lastRead = last ? clockTime(last.fetchedAt) : "";
  report("reading", last ? `last read ${lastRead}` : "calling Pharos Chain MCP", lastRead);

  let response;
  let data = null;
  try {
    // no-store: Refresh must reach the server, never the browser's stale-while-revalidate copy.
    response = await fetch(API, { headers: { accept: "application/json" }, cache: "no-store" });
    data = await response.json().catch(() => null);
  } catch {
    // The request itself failed; reported below as an error with no data.
  }

  const fail = (problem) => report("error", last ? `last good read ${lastRead}` : "no data yet", lastRead, problem);
  if (data?.ok === true) {
    try {
      // The server caches a good read briefly, so a quick Refresh can return the same one. Say so.
      const repeat = last?.fetchedAt === data.fetchedAt;
      render(data);
      last = data;
      main.dataset.measured = "";
      const read = clockTime(data.fetchedAt);
      report("live", `${repeat ? "cached read" : "read"} ${read}`, read);
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
  setButtons(false);
  busy = false;
}

function render(data) {
  const { contract, network, values, source } = data;
  const supply = splitAmount(data.display?.totalSupply ?? `${values.totalSupply.formatted} ${values.symbol}`);
  const block = groupDigits(data.blockNumber);
  const changed = !last || last.blockNumber !== data.blockNumber || last.values.totalSupply.raw !== values.totalSupply.raw;
  const calls = source.toolCalls;
  const retries = calls - 6;

  // First screen: what contract, what state, which block.
  setText($("subject"), contract.label);
  // The decimal point keeps the whole number's size, so it reads clearly; only the digits after it are smaller.
  setText($("supply-major"), supply.major + supply.minor.slice(0, 1));
  setText($("supply-minor"), supply.minor.slice(1));
  setText($("supply-unit"), supply.unit);
  setText($("block"), block);
  setText("[data-block]", `#${block}`);
  setText($("network"), network?.name ?? "Not confirmed");
  setText("[data-chain]", network ? String(network.chainId) : "not confirmed");
  const warnings = $("warnings");
  setText(warnings, data.warnings.join(" "));
  warnings.hidden = data.warnings.length === 0;

  // The four contract reads and the address.
  setText($("v-name"), values.name);
  setText($("v-symbol"), values.symbol);
  setText($("v-decimals"), String(values.decimals));
  setText($("v-supply"), `${supply.major}${supply.minor}`);
  setText($("v-raw"), `raw ${values.totalSupply.raw}`);
  renderAddress($("address"), contract.address);
  setText($("address-sr"), contract.address);
  setText($("proof-calls"), String(calls));
  setText($("proof-calls-sub"), retries > 0 ? `includes ${retries} same-block retr${retries === 1 ? "y" : "ies"}` : "2 context + 4 contract reads");

  // Technical details: the "how", collapsed by default.
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

/**
 * One state for the whole page: the hero's status line, the phone status bar, and the error
 * note. `time` is always the time of the read on screen.
 */
function report(state, detail, time, problem = "") {
  setState(state);
  setText("[data-status-word]", STATUS_WORD[state]);
  setText("[data-status-detail]", detail);
  setText("[data-status-time]", time);
  const note = $("status-note");
  setText(note, problem);
  note.hidden = !problem;
}

function setButtons(disabled) {
  for (const button of document.querySelectorAll("[data-refresh]")) button.disabled = disabled;
}

/** Keep the supply on one line, as large as its box allows, on any screen and with any value. */
function fitSupply() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitFigure($("supply"), $("supply").firstElementChild, FIGURE_MIN_PX);
  });
}

/** Phones: show the slim status bar only while the readout's own Refresh is out of view. */
function showBarWhenReadoutLeaves() {
  if (typeof IntersectionObserver !== "function") return;
  new IntersectionObserver(([entry]) => {
    document.body.dataset.bar = entry.isIntersecting ? "" : "show";
  }).observe(document.querySelector(".readout-head"));
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
