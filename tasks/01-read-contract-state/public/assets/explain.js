// "Explain this result": a plain-language explanation of the Inspector's latest result, only when the
// visitor asks for it.
//
// Independent of the Inspector: it only listens for the "inspect:result" event inspector.js sends once
// a result is on screen, so nothing here can break an inspection, and an inspection never asks for an
// explanation by itself. One button for the whole result, shown only for a result (a full or partial
// one, not "not found" or an error); the explanation is written under it, as text. The Inspector's
// values stay the source of truth: POST /api/explain explains them and reads nothing else.
import { explainPayload } from "./explain-input.js";
import { setText } from "./lab.js";

const $ = (id) => document.getElementById(id);
const inspector = $("inspector");
const API = inspector.dataset.explainApi;
const box = $("explain");
const button = $("explain-submit");
const note = $("explain-note");
const body = $("explain-body");
const text = $("explain-text");
const meta = $("explain-meta");
const live = $("explain-state");
/** Longer than the server's own limit for one explanation, so its answer, not this, ends a slow one. */
const CLIENT_TIMEOUT_MS = 30_000;
const SOURCE_NOTE = "Written by an AI model from the result above. The result above is the source of truth.";

let request = null; // what to send for the result on screen, or null when it cannot be explained
let explained = false;
let busy = false;
let round = 0; // a new result starts a new round, so a late answer for the old one is dropped

inspector.addEventListener("inspect:result", (event) => {
  round += 1;
  request = explainPayload(event.detail);
  explained = false;
  setBusy(false);
  note.hidden = true;
  body.hidden = true;
  text.replaceChildren();
  setText(live, "");
  box.hidden = request === null;
});

button.addEventListener("click", () => void explain());

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
  } finally {
    clearTimeout(timer);
  }
  // A newer result replaced this one while it was being explained: this answer is not for it.
  if (mine !== round) return;
  setBusy(false);

  if (data?.ok === true && render(data)) {
    explained = true;
    setText(live, "Explanation ready, below the button.");
    return;
  }
  const reason = typeof data?.error?.message === "string" ? data.error.message : response ? `The explanation service answered HTTP ${response.status}.` : "The explanation service could not be reached.";
  setText(note, `${reason} The inspection result above is unchanged.`);
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

/** Headings, paragraphs and lists, each written as text. False if the answer has nothing to show. */
function render(data) {
  const sections = Array.isArray(data.explanation?.sections) ? data.explanation.sections : [];
  const nodes = [];
  for (const section of sections) {
    if (typeof section?.heading === "string") nodes.push(element("h4", "explain-h", section.heading));
    for (const block of Array.isArray(section?.blocks) ? section.blocks : []) {
      if (block?.kind === "list" && Array.isArray(block.items)) {
        const list = element("ul", "explain-list");
        for (const item of block.items) list.append(element("li", "", String(item)));
        nodes.push(list);
      } else if (typeof block?.text === "string") {
        nodes.push(element("p", "", block.text));
      }
    }
  }
  if (nodes.length === 0) return false;
  text.replaceChildren(...nodes);
  setText(meta, data.cached === true ? `${SOURCE_NOTE} Reused from an earlier explanation of this same result.` : SOURCE_NOTE);
  body.hidden = false;
  return true;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
