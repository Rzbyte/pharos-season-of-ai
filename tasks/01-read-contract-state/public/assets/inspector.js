// Pharos Inspector: inspect another Pharos object, an address or a transaction hash. An address comes
// back as a contract (it has code: its ERC-20 values), a wallet-like address (no code: its native
// balance and nonce), or, when the code check failed, an address whose type is not determined.
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
// A full result is "Complete", never "Success", so it is not mistaken for a transaction's own status.
const WORD = { inspecting: "Inspecting", success: "Complete", partial: "Partial", "not-found": "Not found", error: "Error" };
// Green only for a full result, amber for a partial one, red for an error; not found is neutral.
const TONE = { inspecting: "active", success: "success", partial: "warning", "not-found": "neutral", error: "error" };
const KIND = { address: "Address", contract: "Contract", "wallet-like": "Wallet-like address", transaction: "Transaction" };
const DETECTED = { address: "address", transaction: "transaction hash" };
/** What the code check found. A no-code address is "wallet-like": no code proves nothing about who controls it. */
const ADDRESS_TYPE = { contract: ["Contract", "Contract code at this block"], "wallet-like": ["Wallet-like address", "No contract code at this block"] };
const TX_STATUS = { success: "Success", failed: "Failed (reverted)", pending: "Pending" };
/** A transaction status that needs attention says so in its words and its tone; success takes none. */
const TX_TONE = { failed: "error", pending: "warning" };
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
  if (value === "") setText(detected, "Accepts an address (42 characters) or a transaction hash (66).");
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
      // No ERC-20 value at all, or an address whose type is not determined: a partial result.
      report(data.status === "none" || data.status === "undetermined" ? "partial" : data.status, `${KIND[data.kind]} · read ${clockTime(data.fetchedAt)}`);
      announce(data);
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

/**
 * Tell the rest of the page that a new result is on screen ("Explain this result" listens). It gets a
 * copy, and nothing a listener does can reach this inspection: a listener's error stays its own.
 */
function announce(data) {
  try {
    root.dispatchEvent(new CustomEvent("inspect:result", { detail: JSON.parse(JSON.stringify(data)) }));
  } catch {
    // Not part of the inspection.
  }
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
  const blocks = data.kind === "transaction" ? transactionBlocks(data) : addressBlocks(data);
  const notes = [...(data.message ? [data.message] : []), ...(data.notes ?? []), ...(data.warnings ?? [])].map((text) => element("p", "inspect-message", text));
  result.replaceChildren(...blocks, ...notes);
  result.hidden = false;
}

/** Any address: what it is and at which block, then what was read for that type. */
function addressBlocks(data) {
  const summary = rows("rows pairs", [
    ["Address", data.address, { hex: true, copy: "address", explorer: "address" }],
    ["Address type", ADDRESS_TYPE[data.kind] ?? [{ unavailable: true, text: "Could not be determined" }, data.reason]],
    ["Block", [groupDigits(data.blockNumber), networkName(data.network)]],
  ]);
  if (data.kind === "contract") return [summary, contractState(data)];
  if (data.kind === "wallet-like") return [summary, walletState(data)];
  return [summary];
}

function contractState(data) {
  // Not one standard value: one row says so, instead of four "Unavailable" rows that look broken.
  if (data.status === "none") return rows("rows", [["ERC-20 metadata", [{ unavailable: true, text: "Not available" }]]]);
  const { name, symbol, decimals, totalSupply } = data.state;
  return rows("rows keys-code pairs", [
    ["name", name.ok ? name.value : missing(name)],
    ["symbol", symbol.ok ? symbol.value : missing(symbol)],
    ["decimals", decimals.ok ? String(decimals.value) : missing(decimals)],
    ["totalSupply", totalSupply.ok ? supplyText(totalSupply) : missing(totalSupply)],
  ]);
}

/** A wallet-like address: its native balance (PROS, not a token) and how many transactions it has sent. */
function walletState(data) {
  const { balance, nonce } = data.state;
  return rows("rows pairs", [
    ["Native balance", balance.ok ? balance.display : missing(balance)],
    ["Transactions sent", nonce.ok ? [groupDigits(nonce.value), "account nonce"] : missing(nonce)],
  ]);
}

function transactionBlocks(data) {
  // Not found: no explorer link, since nothing was found to show there; the next step instead.
  if (data.status === "not-found" || !data.transaction) {
    return [rows("rows", [["Hash", data.hash, { hex: true, copy: "transaction hash" }], ["Result", "Not found through Pharos Chain MCP"]]), element("p", "inspect-message", NOT_FOUND_NEXT)];
  }
  const tx = data.transaction;
  const created = tx.contractCreation;
  const facts = [
    tx.status && ["Status", TX_STATUS[tx.status] ?? tx.status, { tone: TX_TONE[tx.status] }],
    // The network goes with the block; a transaction in no block yet still shows its network.
    tx.blockNumber ? ["Block", [groupDigits(tx.blockNumber), networkName(data.network)]] : ["Network", networkName(data.network)],
    tx.from && ["From", tx.from, { hex: true }],
    tx.to && ["To", tx.to, { hex: true }],
    created && (created.address ? ["To", ["Contract creation", created.address], { hex: true }] : ["To", "Contract creation"]),
    tx.value && ["Value", tx.value.display],
    gas(tx),
    tx.logs !== null && tx.logs !== undefined && ["Logs", String(tx.logs)],
  ];
  return [rows("rows", [["Hash", tx.hash, { hex: true, copy: "transaction hash", explorer: "tx" }]]), rows("rows pairs", facts.filter(Boolean))];
}

/** Gas in one row: what the transaction used, and the limit its sender set. */
function gas(tx) {
  const used = tx.gasUsed ? `${groupDigits(tx.gasUsed)} used` : null;
  const limit = tx.gasLimit ? `limit ${groupDigits(tx.gasLimit)}` : null;
  if (used && limit) return ["Gas", [used, limit]];
  return used || limit ? ["Gas", used ?? limit] : null;
}

/**
 * A ruled list of key/value rows. A value is text, or [text] or [text, secondary line]; with { hex: true }
 * the value (or the secondary line) is an address or hash, shown whole (renderHex); with { copy }
 * its actions follow it: Copy, and View in Explorer with { explorer }.
 */
function rows(className, entries) {
  const list = element("dl", className);
  const wide = wideRows(entries);
  entries.forEach(([key, value, options = {}], index) => {
    const row = element("div", [options.hex ? "hex-row" : "", wide.has(index) ? "wide" : ""].filter(Boolean).join(" "));
    const dd = element("dd");
    if (options.tone) dd.dataset.tone = options.tone;
    if (Array.isArray(value)) {
      const [main, sub] = value;
      if (main.unavailable) dd.classList.add("unavailable");
      dd.append(element("span", "", main.unavailable ? main.text : main));
      if (sub !== undefined) {
        // Two values, read aloud with a pause between them ("20,384,350, Pharos Mainnet"); shown as two lines.
        dd.append(element("span", "sr", ", "));
        dd.append(options.hex ? hexValue(sub, "hex-sub") : element("span", "sub", sub));
      }
    } else if (options.hex) {
      dd.append(...(options.copy ? withActions(value, options) : [hexValue(value)]));
    } else {
      dd.append(value);
    }
    row.append(element("dt", "", key), dd);
    list.append(row);
  });
  return list;
}

/**
 * Where rows sit two to a line (a "pairs" list with room for it), an address or hash takes the whole
 * width, and so does the last row of a run of short ones that would otherwise sit alone.
 */
function wideRows(entries) {
  const wide = new Set();
  let run = [];
  const close = () => {
    if (run.length % 2 === 1) wide.add(run.at(-1));
    run = [];
  };
  entries.forEach(([, , options = {}], index) => {
    if (options.hex) close();
    else run.push(index);
  });
  close();
  return wide;
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
  if (!network) return "Network not confirmed";
  return network.name ?? `Chain ID ${network.chainId}`;
}

/**
 * The value, then its actions in one row under it: Copy, and View in Explorer when `explorer`
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
  return data.kind === "transaction" ? data.hash : data.address;
}

/** "0xC879…1815": enough to recognise, short enough for one status line. */
function shortHex(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
