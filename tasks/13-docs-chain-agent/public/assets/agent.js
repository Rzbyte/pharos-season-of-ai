// The agent pages (Task 05 onward) share one shape: a run of the agent (GET /api/agent?task=NN&...) that
// fills the page, a status line above it, a form that changes the run, and the proof below it: the block
// the run read, the Chain MCP calls it made and the result as JSON. This is that shared part, with the
// check rows a guardian's conditions and a gatekeeper's rules are shown as; each page renders its own
// result. It relies on these ids: status, status-word, status-detail, again, pin,
// pin-block, pin-time, pin-calls, error, calls, json-toggle and json. Everything is set as text, never as
// markup.
import { clockTime, linkExplorer, svgIcon, wireToggle } from "./lab.js";

export const $ = (id) => document.getElementById(id);
export const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text === undefined ? {} : { textContent: text });
export const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const group = (digits) => String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * A raw integer amount in a unit of `decimals`, cut (never rounded) to at most `places` decimals and
 * grouped: "1,234.5". A tiny amount that is not zero reads "<0.0001", never "0" (as the agent's CLI does).
 */
export function units(raw, decimals, places = 6) {
  const value = BigInt(raw);
  const size = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const fraction = (size % scale).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  const shown = `${group((size / scale).toString())}${fraction ? `.${fraction}` : ""}`;
  const sign = value < 0n ? "-" : "";
  return shown === "0" && size !== 0n ? `${sign}<0.${"0".repeat(Math.max(0, places - 1))}1` : `${sign}${shown}`;
}

/** Wei as gwei, to at most 4 decimals: "1.2 gwei". */
export const gwei = (wei) => `${units(wei, 9, 4)} gwei`;

/** A shortened address, linked to the explorer where the page names one; the full address on hover. */
export function addressLink(address, what) {
  const link = el("a", "short", short(address));
  link.title = address;
  linkExplorer(link, "address", address, what);
  if (!link.hidden) return link;
  const text = el("span", "short", short(address));
  text.title = address;
  return text;
}

export function setStatus(tone, word, detail) {
  $("status").dataset.tone = tone;
  $("status-word").textContent = word;
  $("status-detail").textContent = detail;
}

const MARK = { pass: "M3.5 8.5l3 3 6-7", fail: "M4.5 4.5l7 7M11.5 4.5l-7 7", unknown: "M4 8h8" };
const SAYS = { pass: "holds", fail: "fails", unknown: "could not be read" };

/**
 * Rows of checks into `list`: a mark, the label, then what was seen against what is needed, the source
 * (a Chain MCP tool), a note and any error. Each row is { id, label, passed (true, false, or null when
 * it could not be read), seen (text or a node), need, tool, note, error }.
 */
export function renderChecks(list, rows) {
  list.replaceChildren(
    ...rows.map((row) => {
      const state = row.passed === true ? "pass" : row.passed === false ? "fail" : "unknown";
      const item = el("li", "check");
      item.dataset.state = state;
      item.dataset.id = row.id;
      const mark = el("span", "check-mark");
      mark.setAttribute("aria-hidden", "true");
      mark.append(svgIcon(MARK[state]));
      const label = el("span", "check-label", row.label);
      label.append(el("span", "sr", `: ${SAYS[state]}.`));
      const evidence = el("span", "check-evidence");
      if (row.seen !== null && row.seen !== undefined) {
        const seen = el("span", "check-seen");
        seen.append(row.seen);
        evidence.append(seen);
      }
      if (row.need) evidence.append(el("span", "check-need", row.need));
      evidence.append(el("span", "check-tool", row.tool));
      if (row.note) evidence.append(el("span", "check-note", row.note));
      if (row.error) evidence.append(el("span", "check-error", row.error));
      const body = el("span", "check-main");
      body.append(label, evidence);
      item.append(mark, body);
      return item;
    }),
  );
}

/** One Chain MCP call, after its tool name: the call's target, sender and data, and the block or blocks it names. */
export function describeCall(call) {
  const parts = [];
  const args = call.args ?? {};
  const tx = args.transaction;
  if (tx) {
    if (tx.from) parts.push(`from ${short(tx.from)}`);
    parts.push(`to ${short(tx.to)}`);
    if (tx.data) parts.push(`data ${tx.data.length > 18 ? `${tx.data.slice(0, 10)}…` : tx.data}`);
    if (tx.value && !/^0x0*$/i.test(tx.value)) parts.push("with value");
  }
  if (args.address) parts.push(short(args.address));
  if (typeof args.block === "string") parts.push(/^0x[0-9a-f]+$/i.test(args.block) ? `@ ${group(BigInt(args.block).toString())}` : `@ ${args.block}`);
  // A get_logs page: the blocks it covers.
  const number = (tag) => (/^0x[0-9a-f]+$/i.test(tag) ? group(BigInt(tag).toString()) : tag);
  if (typeof args.fromBlock === "string" && typeof args.toBlock === "string") parts.push(`blocks ${number(args.fromBlock)}–${number(args.toBlock)}`);
  return parts.join(" ");
}

function renderCalls(calls) {
  $("calls").replaceChildren(
    ...calls.map((call) => {
      const item = el("li");
      const body = el("span", "call-body");
      body.append(el("span", "call-tool", call.tool), ` ${describeCall(call)}`);
      if (!call.ok) body.append(el("span", "call-failed", " (error)"));
      item.append(body);
      return item;
    }),
  );
}

/**
 * The page's runner. `run(params)` asks the agent, one run at a time (a newer run aborts the older), with
 * the panel marked busy and "again" disabled meanwhile; "again" repeats the last run. `params` is the
 * query, or a function that makes it when the run starts (for a page whose query changes between runs). An answer that holds
 * a result shows its block, calls and JSON, then goes to `render(body)`; anything else shows the error
 * note, with the API's own message where it gave one, and calls `onFail()`. An answer the API lets be
 * shared for a few seconds may sit in the browser's cache, which may show it again while it asks behind
 * it; "again" means read again, so it never takes the browser's copy without asking.
 */
export function agentRunner({ task, panel, running, failed, render, onFail }) {
  const api = $("main").dataset.api;
  const again = $("again");
  let inFlight = null;
  let last = null;
  const busy = (on) => {
    panel.setAttribute("aria-busy", String(on));
    again.setAttribute("aria-disabled", String(on));
  };
  const fail = (message) => {
    setStatus("error", failed, "see below");
    const note = $("error");
    note.textContent = message;
    note.hidden = false;
    onFail?.();
  };
  const show = (body) => {
    const { result } = body;
    // A result about no block (a transaction the network does not know, or still pending) pins none.
    $("pin").hidden = !result.block;
    if (result.block) {
      $("pin-block").textContent = group(result.block.number);
      $("pin-time").textContent = clockTime(result.block.timestamp);
      $("pin-time").title = result.block.timestamp;
    }
    $("pin-calls").textContent = `${result.toolCalls} calls`;
    $("error").hidden = true;
    renderCalls(body.calls);
    $("json").textContent = JSON.stringify(body, null, 2);
    render(body);
  };
  async function run(params, { fresh = false } = {}) {
    last = params;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    busy(true);
    setStatus("active", ...running);
    try {
      const query = typeof params === "function" ? params() : params;
      const response = await fetch(`${api}?${new URLSearchParams({ task, ...query })}`, { headers: { accept: "application/json" }, cache: fresh ? "no-cache" : "default", signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (controller !== inFlight) return;
      if (!response.ok || !body?.result) fail(body?.error ? [body.error.message, body.error.hint].filter(Boolean).join(" ") : `The agent answered HTTP ${response.status}.`);
      else show(body);
    } catch (error) {
      if (error?.name === "AbortError") return;
      fail("Could not reach the agent. Check the connection and try again.");
    } finally {
      if (controller === inFlight) {
        inFlight = null;
        busy(false);
      }
    }
  }
  again.addEventListener("click", () => {
    if (again.getAttribute("aria-disabled") !== "true" && last) run(last, { fresh: true });
  });
  wireToggle($("json-toggle"), (open) => ($("json-toggle").textContent = open ? "Hide the JSON" : "Show the result as JSON"));
  return run;
}

/**
 * The form that changes the run. On submit every field's value (trimmed) goes to `problems(values)`, which
 * returns a message per field that is wrong: each shows in place of its field's hint, and the first takes
 * the focus. With none, `submit(values)` runs, and the page's result comes back into view. A hint's own
 * text is its `data-hint` where the page sets one (a hint that changes with another field), else its
 * text when wired. A field with no hint (a select) is only marked invalid.
 */
export function wireForm({ form, fields, problems, submit, result }) {
  const hint = (input) => (input.hasAttribute("aria-describedby") ? $(input.getAttribute("aria-describedby")) : null);
  for (const note of Object.values(fields).map(hint)) if (note) note.dataset.hint ??= note.textContent;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value.trim()]));
    const wrong = problems(values);
    for (const [key, input] of Object.entries(fields)) {
      input.setAttribute("aria-invalid", String(Boolean(wrong[key])));
      const note = hint(input);
      if (!note) continue;
      note.textContent = wrong[key] ?? note.dataset.hint;
      note.classList.toggle("invalid", Boolean(wrong[key]));
    }
    const first = Object.keys(fields).find((key) => wrong[key]);
    if (first) {
      fields[first].focus();
      return;
    }
    submit(values);
    result.heading.focus({ preventScroll: true });
    result.panel.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
}

/** An amount as typed, its whole part grouped; "max" is an unlimited approval. */
export const amountText = (amount) => (amount === "max" ? "unlimited" : amount.replace(/^\d+/, (whole) => group(whole)));

/** A transfer or approval request (action, asset, from, to, amount) in words, its addresses linked. */
export function describeRequest(inputs) {
  if (inputs.action === "approve") return ["Approve ", addressLink(inputs.to, "the spender"), ` to spend ${amountText(inputs.amount)} ${inputs.asset} of `, addressLink(inputs.from, "the sender")];
  return [`Send ${amountText(inputs.amount)} ${inputs.asset} from `, addressLink(inputs.from, "the sender"), " to ", addressLink(inputs.to, "the recipient")];
}

/** Inputs from the address bar, where every key is present; null otherwise. */
export function queryInputs(keys) {
  const query = new URLSearchParams(location.search);
  const values = Object.fromEntries(keys.map((key) => [key, (query.get(key) ?? "").trim()]));
  return Object.values(values).every(Boolean) ? values : null;
}
