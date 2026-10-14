// Pharos Inspector: inspect another Pharos object, a contract address or a transaction hash.
//
// Independent of the Task 01 page script: its own state (data-inspect-state on #inspector, never on
// <body>), its own elements, and its own endpoint, GET /api/inspect, which reads Pharos server-side
// through Chain MCP. Input is checked here only for quick feedback; the server applies the same
// rule. Everything from the API is written as text. A failed inspection keeps the last good result
// on screen with an error note; a new result replaces it only once it has arrived.
import { classifyInput } from "./inspect-input.js";
import { clockTime, groupDigits, linkExplorer, renderHex, setText, wireCopy } from "./lab.js";

const $ = (id) => document.getElementById(id);
const root = $("inspector");
const API = root.dataset.inspectApi;
const panel = $("inspect-panel");
const input = $("inspect-input");
const submit = $("inspect-submit");
const example = $("inspect-example");
const detected = $("inspect-detected");
const note = $("inspect-note");
const result = $("inspect-result");
const CLIENT_TIMEOUT_MS = 55_000;
const EXAMPLE_ADDRESS = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const WORD = { inspecting: "Inspecting", success: "Success", partial: "Partial", "not-found": "Not found", error: "Error" };
// Green only for a full result, amber for a partial one, red for an error; not found is neutral.
const TONE = { inspecting: "active", success: "success", partial: "warning", "not-found": "neutral", error: "error" };
const KIND = { contract: "Contract", transaction: "Transaction" };
const DETECTED = { contract: "contract address", transaction: "transaction hash" };
const TX_STATUS = { success: "Success", failed: "Failed (reverted)", pending: "Pending" };
// Not found is an answer, not a failure: what to check next.
const NOT_FOUND_NEXT = "Check that the hash is complete and from Pharos Mainnet, not a testnet. A transaction sent moments ago can take a few seconds to appear: inspect it again then.";

let busy = false;
let shown = null;

input.addEventListener("input", describeInput);
$("inspect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run();
});
example.addEventListener("click", () => {
  if (busy) return;
  input.value = EXAMPLE_ADDRESS;
  describeInput();
  void run();
});
describeInput();

/** As the visitor types: what the input is, or how far it is from being one. Never a request. */
function describeInput() {
  const value = input.value.trim();
  const check = classifyInput(value);
  const typing = /^0x[0-9a-fA-F]*$/.test(value) && value.length < 66;
  input.removeAttribute("aria-invalid");
  detected.classList.remove("invalid");
  if (value === "") setText(detected, "Accepts a contract address (42 characters) or a transaction hash (66).");
  else if (check.ok) setText(detected, `Detected: ${DETECTED[check.kind]}`);
  else if (typing) setText(detected, `${value.length - 2} hex characters so far: 40 for an address, 64 for a transaction hash.`);
  else setText(detected, check.message);
}

/** IDLE or a result -> INSPECTING -> SUCCESS, PARTIAL, NOT FOUND, or ERROR keeping the last result. */
async function run() {
  if (busy) return;
  const check = classifyInput(input.value);
  if (!check.ok) {
    // Never sent: malformed input stays on this page.
    input.setAttribute("aria-invalid", "true");
    detected.classList.add("invalid");
    setText(detected, check.message);
    input.focus();
    return;
  }
  busy = true;
  setBusy(true);
  report("inspecting", `${KIND[check.kind]} ${shortHex(check.value)}`);

  let response;
  let data = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    response = await fetch(`${API}?q=${encodeURIComponent(check.value)}`, { headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal });
    data = await response.json().catch(() => null);
  } catch {
    // The request itself failed or timed out; reported below with no data.
  } finally {
    clearTimeout(timer);
  }

  if (data?.ok === true) {
    try {
      render(data);
      shown = data;
      report(data.status === "none" ? "partial" : data.status, `${KIND[data.kind]} · read ${clockTime(data.fetchedAt)}`);
    } catch {
      fail("The inspector sent a result this page could not read.");
    }
  } else {
    fail(
      data?.error?.message
        ? [data.error.message, data.error.hint].filter(Boolean).join(" ")
        : `${response ? `The inspector answered HTTP ${response.status}.` : "Could not reach the inspector, or it did not answer in time."} Try again in a moment.`,
    );
  }
  setBusy(false);
  busy = false;
}

function fail(reason) {
  report("error", shown ? "showing the previous result" : "nothing inspected yet");
  setText(note, shown ? `${reason} The previous result (${KIND[shown.kind]} ${shortHex(subjectOf(shown))}) is still shown.` : reason);
  note.hidden = false;
}

function report(state, detail) {
  root.dataset.inspectState = state;
  const status = $("inspect-status");
  status.dataset.tone = TONE[state];
  setText($("inspect-word"), WORD[state]);
  setText($("inspect-detail"), detail);
  status.hidden = false;
  if (state !== "error") note.hidden = true;
}

/**
 * While inspecting, the panel is busy and its buttons wait; they keep focus (aria-disabled). The
 * button then reads "Inspecting…": both words share one cell in lab.css, so it keeps its size.
 */
function setBusy(on) {
  panel.setAttribute("aria-busy", String(on));
  submit.setAttribute("aria-disabled", String(on));
  example.setAttribute("aria-disabled", String(on));
}

// ---------------------------------------------------------------------------
// Rendering: rows of text, built with createElement and textContent only.

function render(data) {
  const blocks = data.kind === "contract" ? contractBlocks(data) : transactionBlocks(data);
  const notes = [...(data.message ? [data.message] : []), ...(data.notes ?? []), ...(data.warnings ?? [])].map((text) => element("p", "inspect-message", text));
  result.replaceChildren(...blocks, ...notes);
  result.hidden = false;
}

function contractBlocks(data) {
  const summary = rows("rows", [
    ["Address", data.address, { hex: true, copy: "address", explorer: "address" }],
    ["Block", groupDigits(data.blockNumber)],
    ["Network", networkName(data.network)],
  ]);
  const { name, symbol, decimals, totalSupply } = data.state;
  const state = rows("rows keys-code", [
    ["name", name.ok ? name.value : missing(name)],
    ["symbol", symbol.ok ? symbol.value : missing(symbol)],
    ["decimals", decimals.ok ? String(decimals.value) : missing(decimals)],
    ["totalSupply", totalSupply.ok ? supplyText(totalSupply) : missing(totalSupply)],
  ]);
  return [summary, element("p", "label inspect-caption", "State"), state];
}

function transactionBlocks(data) {
  // Not found: no explorer link, since nothing was found to show there; the next step instead.
  if (data.status === "not-found" || !data.transaction) {
    return [rows("rows", [["Hash", data.hash, { hex: true, copy: "transaction hash" }], ["Result", "Not found through Pharos Chain MCP"]]), element("p", "inspect-message", NOT_FOUND_NEXT)];
  }
  const tx = data.transaction;
  const created = tx.contractCreation;
  const entries = [
    ["Hash", tx.hash, { hex: true, copy: "transaction hash", explorer: "tx" }],
    tx.status && ["Status", TX_STATUS[tx.status] ?? tx.status],
    tx.blockNumber && ["Block", groupDigits(tx.blockNumber)],
    tx.from && ["From", tx.from, { hex: true }],
    tx.to && ["To", tx.to, { hex: true }],
    created && (created.address ? ["To", ["Contract creation", created.address], { hex: true }] : ["To", "Contract creation"]),
    tx.value && ["Value", tx.value.display],
    tx.gasLimit && ["Gas limit", groupDigits(tx.gasLimit)],
    tx.gasUsed && ["Gas used", groupDigits(tx.gasUsed)],
    tx.logs !== null && tx.logs !== undefined && ["Logs", String(tx.logs)],
    ["Network", networkName(data.network)],
  ];
  return [rows("rows", entries.filter(Boolean))];
}

/**
 * A ruled list of key/value rows. A value is text, or [text, secondary line]; with { hex: true }
 * the value (or the secondary line) is an address or hash, shown whole (renderHex); with { copy }
 * its actions follow it: Copy, and View on the explorer with { explorer }.
 */
function rows(className, entries) {
  const list = element("dl", className);
  for (const [key, value, options = {}] of entries) {
    const row = element("div", options.hex ? "hex-row" : "");
    const dd = element("dd");
    if (Array.isArray(value)) {
      const [main, sub] = value;
      if (main.unavailable) dd.classList.add("unavailable");
      dd.append(element("span", "", main.unavailable ? main.text : main));
      dd.append(options.hex ? hexValue(sub, "hex-sub") : element("span", "sub", sub));
    } else if (options.hex) {
      dd.append(...(options.copy ? withActions(value, options) : [hexValue(value)]));
    } else {
      dd.append(value);
    }
    row.append(element("dt", "", key), dd);
    list.append(row);
  }
  return list;
}

/** An "Unavailable" value with its reason on a second line, as [main, sub]. */
function missing(entry) {
  return [{ unavailable: true, text: "Unavailable" }, entry.reason];
}

function supplyText(supply) {
  if (supply.display) return supply.display;
  return [supply.raw, "raw value: decimals() was unavailable, so it is not converted"];
}

function networkName(network) {
  if (!network) return "Not confirmed";
  return network.name ?? `Chain ID ${network.chainId}`;
}

/**
 * The value, then its actions in one row under it: Copy, and View on the explorer when `explorer`
 * names the explorer page for it ("address" or "tx"). The explorer link is made only from the
 * well-formed value (linkExplorer); otherwise it is left out.
 */
function withActions(hex, { copy: what, explorer }) {
  const cell = hexValue(hex);
  // The page's own actions, from its <template>: static markup, never data.
  const actions = $("actions-template").content.firstElementChild.cloneNode(true);
  const button = actions.querySelector(".copy");
  const link = actions.querySelector("a");
  setText(button.querySelector(".copy-what"), ` ${what}`);
  wireCopy(button, { value: () => hex, shown: () => cell.firstElementChild, live: $("inspect-copy-state"), what: what[0].toUpperCase() + what.slice(1) });
  if (explorer) linkExplorer(link, explorer, hex, what);
  if (link.hidden) link.remove();
  return [cell, actions];
}

/** An address or hash as one continuous value; lab.css decides where it may break. */
function hexValue(hex, extra = "") {
  const cell = element("div", ["hex-cell", extra].filter(Boolean).join(" "));
  const value = element("span", hex.length === 66 ? "hex hex-hash" : "hex");
  renderHex(value, hex);
  cell.append(value);
  return cell;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function subjectOf(data) {
  return data.kind === "contract" ? data.address : data.hash;
}

/** "0xC879…1815": enough to recognise, short enough for one status line. */
function shortHex(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
