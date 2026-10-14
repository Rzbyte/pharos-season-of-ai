// "Explain this result": a short, plain-language explanation of the Inspector's latest result, only
// when the visitor asks for it.
//
// Independent of the Inspector: it only listens for the "inspect:result" event inspector.js sends once
// a result is on screen, so nothing here can break an inspection, and an inspection never asks for an
// explanation by itself. One button for the whole result, shown only for a result (a full or partial
// one, not "not found" or an error). The explanation is a few short paragraphs under it; any further
// details stay folded away until "Show details". Everything is written as text. The Inspector's values
// stay the source of truth: POST /api/explain explains them and reads nothing else.
import { explainPayload } from "./explain-input.js";
import { setText } from "./lab.js";

const $ = (id) => document.getElementById(id);
const inspector = $("inspector");
const API = inspector.dataset.explainApi;
const box = $("explain");
const button = $("explain-submit");
const hint = $("explain-hint");
const note = $("explain-note");
const body = $("explain-body");
const text = $("explain-text");
const more = $("explain-more");
const details = $("explain-details");
const live = $("explain-state");
/** Longer than the server's own limit for one explanation, so its answer, not this, ends a slow one. */
const CLIENT_TIMEOUT_MS = 30_000;

let request = null; // what to send for the result on screen, or null when it cannot be explained
let explained = false;
let busy = false;
let round = 0; // a new result starts a new round, so a late answer for the old one is dropped

inspector.addEventListener("inspect:result", (event) => {
  // Keyboard focus in the old explanation would be lost when it is hidden: it moves to what stays.
  const focused = box.contains(document.activeElement) ? document.activeElement : null;
  round += 1;
  request = explainPayload(event.detail);
  explained = false;
  setBusy(false);
  note.hidden = true;
  body.hidden = true;
  hint.hidden = false;
  text.replaceChildren();
  details.replaceChildren();
  showDetails(false);
  more.hidden = true;
  setText(live, "");
  box.hidden = request === null;
  if (focused?.closest("[hidden]")) (box.hidden ? $("inspect-input") : button).focus();
});

button.addEventListener("click", () => void explain());
more.addEventListener("click", () => showDetails(more.getAttribute("aria-expanded") !== "true"));

/** READY -> EXPLAINING -> the explanation below, or an error note with the result left as it is. */
async function explain() {
  if (request === null || busy) return;
  // Already explained: the same result has nothing new to say, so no second request.
  if (explained) return void body.scrollIntoView({ block: "nearest" });
  const mine = round;
  setBusy(true);
  note.hidden = true;
  setText(live, "Explaining the result.");

  let response;
  let data = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    response = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
      signal: controller.signal,
    });
    data = await response.json().catch(() => null);
  } catch {
    // The request failed or timed out; reported below with no data.
  }
  clearTimeout(timer);
  // A newer result replaced this one while it was being explained: this answer is not for it.
  if (mine !== round) return;
  setBusy(false);

  if (data?.ok === true && render(data.explanation)) {
    explained = true;
    setText(live, "Explanation ready, below the button.");
    return;
  }
  const reason = typeof data?.error?.message === "string" ? data.error.message : response ? `The explanation service answered HTTP ${response.status}.` : "The explanation service could not be reached.";
  setText(note, `${reason} The inspection result is unchanged.`);
  note.hidden = false;
  setText(live, reason);
}

/**
 * The button waits while explaining: it keeps focus (aria-disabled) and reads "Explaining…", both
 * words in one cell (lab.css), so it keeps its size.
 */
function setBusy(on) {
  busy = on;
  button.setAttribute("aria-disabled", String(on));
  box.setAttribute("aria-busy", String(on));
}

/** Show or fold away the details; the button says which it will do next. */
function showDetails(open) {
  more.setAttribute("aria-expanded", String(open));
  setText(more, open ? "Hide details" : "Show details");
  details.hidden = !open;
}

/** The summary as paragraphs, the details as a folded list, each written as text. False if there is nothing to show. */
function render(explanation) {
  const paragraphs = (Array.isArray(explanation?.summary) ? explanation.summary : []).filter((part) => typeof part === "string" && part !== "");
  if (paragraphs.length === 0) return false;
  const points = (Array.isArray(explanation.details) ? explanation.details : []).filter((part) => typeof part === "string" && part !== "");
  text.replaceChildren(...paragraphs.map((part) => element("p", part)));
  details.replaceChildren(...points.map((part) => element("li", part)));
  showDetails(false);
  more.hidden = points.length === 0;
  hint.hidden = true;
  body.hidden = false;
  return true;
}

function element(tag, content) {
  const node = document.createElement(tag);
  node.textContent = content;
  return node;
}
