// Pharos Inspector: inspect another Pharos object, a contract address or a transaction hash.
//
// Independent of the Task 01 page script: its own state (data-inspect-state on #inspector, never on
// <body>), its own elements, and its own endpoint, GET /api/inspect, which reads Pharos server-side
// through Chain MCP. Input is checked here only for quick feedback; the server applies the same
// rule. Everything from the API is written as text. A failed inspection keeps the last good result
// on screen with an error note; a new result replaces it only once it has arrived.
import { classifyInput } from "./inspect-input.js";
import { clockTime, groupDigits, reducedMotion, setText } from "./lab.js";

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
const TX_STATUS = { success: "Success", failed: "Failed (reverted)", pending: "Pending" };

let busy = false;
let shown = null;
let copyTimer;

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
  if (value === "") setText(detected, "Detected: nothing yet");
  else if (check.ok) setText(detected, `Detected: ${KIND[check.kind]}`);
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
        : response ? `The inspector answered HTTP ${response.status}.` : "Could not reach the inspector, or it did not answer in time.",
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

/** While inspecting, the panel is busy and its buttons wait; they keep focus (aria-disabled). */
function setBusy(on) {
  panel.setAttribute("aria-busy", String(on));
  submit.setAttribute("aria-disabled", String(on));
  example.setAttribute("aria-disabled", String(on));
  setText(submit, on ? "Inspecting" : "Inspect");
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
    ["Address", data.address, { hex: true, copy: "address" }],
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
  if (data.status === "not-found" || !data.transaction) {
    return [rows("rows", [["Hash", data.hash, { hex: true, copy: "hash" }], ["Result", "Not found through Pharos Chain MCP"]])];
  }
  const tx = data.transaction;
  const created = tx.contractCreation;
  const entries = [
    ["Hash", tx.hash, { hex: true, copy: "hash" }],
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
 * the value (or the secondary line) is an address or hash, set in groups of four.
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
      dd.append(hexValue(value));
    } else {
      dd.append(value);
    }
    if (options.copy) dd.append(copyButton(options.copy, Array.isArray(value) ? value[1] : value));
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

function copyButton(what, value) {
  const button = element("button", "btn-quiet copy", `Copy ${what}`);
  button.type = "button";
  button.addEventListener("click", async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch {
      // Clipboard access can be refused; the value stays selectable.
    }
    setText(button, copied ? "Copied" : "Select to copy");
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setText(button, `Copy ${what}`), reducedMotion() ? 2400 : 1600);
  });
  return button;
}

/** An address or hash as a block of groups; lab.css keeps every line to whole, equal runs. */
function hexValue(hex, extra = "") {
  const cell = element("div", ["hex-cell", extra].filter(Boolean).join(" "));
  const value = element("span", ["hex", hex.length === 66 ? "hex-hash" : hex.length === 42 ? "hex-address" : ""].filter(Boolean).join(" "));
  appendGrouped(value, hex);
  cell.append(value);
  return cell;
}

/** Hex in groups of four with break points between them, like the address above; the text is unchanged. */
function appendGrouped(parent, hex) {
  const groups = hex.slice(2).match(/.{1,4}/g) ?? [];
  groups.forEach((group, index) => {
    if (index > 0) parent.append(document.createElement("wbr"));
    parent.append(element("span", "group", index === 0 ? `0x${group}` : group));
  });
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
