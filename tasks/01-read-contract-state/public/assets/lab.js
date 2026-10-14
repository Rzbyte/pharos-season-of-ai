// Agent Arena Lab: helpers shared by every task page. Plain ES module, no dependencies.
// Every DOM write goes through textContent or createElement; nothing here parses HTML.
// The pure functions at the top never touch the DOM, so tests can import this file in Node.

/** "20179779" -> "20,179,779". Works on digit strings of any length, without number conversion. */
export function groupDigits(digits) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "18,212,174.034793 USDC" -> { major: "18,212,174", minor: ".034793", unit: "USDC" }. */
export function splitAmount(text) {
  const [amount = "", ...unit] = String(text).trim().split(/\s+/);
  const dot = amount.indexOf(".");
  return {
    major: dot === -1 ? amount : amount.slice(0, dot),
    minor: dot === -1 ? "" : amount.slice(dot),
    unit: unit.join(" "),
  };
}

/**
 * Where a hex value may break: an address only at its middle ("0x" + 20 digits, then 20), a
 * transaction hash only at its quarters ("0x" + 16 digits, then 16, 16, 16). Rejoined, the parts
 * are the exact value. null for anything else, which is then shown as plain text.
 */
export function hexParts(value) {
  const text = String(value);
  if (!/^0x[0-9a-fA-F]+$/.test(text)) return null;
  const digits = text.length - 2;
  const count = digits === 40 ? 2 : digits === 64 ? 4 : 0;
  if (!count) return null;
  const size = digits / count;
  return Array.from({ length: count }, (_, index) => (index === 0 ? "0x" : "") + text.slice(2 + index * size, 2 + (index + 1) * size));
}

/** The block explorer's page for each kind of value, and the only form that value may take. */
const EXPLORER_FORMS = new Map([["address", /^0x[0-9a-fA-F]{40}$/], ["tx", /^0x[0-9a-fA-F]{64}$/], ["block", /^(?:0|[1-9]\d*)$/]]);

/**
 * A block explorer link for one value: the base, then "/address/", "/tx/" or "/block/" and the
 * value; otherwise null. Only a well-formed value (an address of 40 hex digits, a transaction hash
 * of 64, a block number in decimal digits) on an https base with nothing after its host becomes a
 * link, so malformed input is never linked.
 */
export function explorerUrl(base, kind, value) {
  const text = String(value ?? "");
  const form = EXPLORER_FORMS.get(kind);
  if (!form || !form.test(text)) return null;
  let url;
  try {
    url = new URL(String(base ?? ""));
  } catch {
    return null;
  }
  const bare = url.protocol === "https:" && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash;
  return bare ? `${url.origin}/${kind}/${text}` : null;
}

/** "20175330" -> "0x133d9e2", the form the MCP eth_call requests carried. */
export function toHexBlock(digits) {
  return /^\d+$/.test(String(digits)) ? `0x${BigInt(digits).toString(16)}` : "";
}

/** Local 24-hour "HH:MM:SS" for an ISO timestamp, the same in every locale; "" if it does not parse. */
export function clockTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

/** 640 -> "640 ms", 2140 -> "2.1 s". */
export function duration(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * A new read, or an earlier one served again: { cached, detail }. The edge marks its own copies
 * (x-vercel-cache HIT or STALE, and an Age in seconds); a read whose fetchedAt is the one already
 * on screen is the same read, whatever the headers say. `headers` is a fetch Headers object.
 */
export function snapshotSource(headers, fetchedAt, shownFetchedAt) {
  const edge = (headers.get("x-vercel-cache") ?? "").toUpperCase();
  const age = Number.parseInt(headers.get("age") ?? "", 10);
  const aged = Number.isFinite(age) && age > 0;
  const repeat = shownFetchedAt !== undefined && shownFetchedAt === fetchedAt;
  if (!repeat && !aged && edge !== "HIT" && edge !== "STALE") return { cached: false, detail: "" };
  return { cached: true, detail: aged ? `${age} s old` : repeat ? "same read as before" : "served from the edge cache" };
}

export function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ── DOM ─────────────────────────────────────────────────────────────

/** Set the text of one element, or of every element matching a selector. */
export function setText(target, text) {
  const elements = typeof target === "string" ? document.querySelectorAll(target) : [target];
  for (const element of elements) element.textContent = text;
}

/** Page state, read by the CSS from <body data-state>: "reading", "fresh", "cached" or "error". */
export function setState(state) {
  document.body.dataset.state = state;
}

/** Replay the settle animation on a value that just changed. */
export function settle(element) {
  if (reducedMotion()) return;
  element.classList.remove("settle");
  void element.offsetWidth;
  element.classList.add("settle");
}

/** Shrink a single-line display value until it fits its own box, so it can never overflow. */
export function fitText(element) {
  element.style.fontSize = "";
  const available = element.clientWidth;
  const needed = element.scrollWidth;
  if (available > 0 && needed > available) {
    const size = parseFloat(getComputedStyle(element).fontSize);
    element.style.fontSize = `${Math.floor(size * (available / needed) * 0.99 * 10) / 10}px`;
  }
}

/**
 * Fit a figure (a number and its unit) on one line by shrinking it. Below `min` px the unit may
 * wrap to the next line instead, and only the number is fitted, so a figure never overflows.
 */
export function fitFigure(figure, number, min) {
  figure.classList.remove("wrap");
  fitText(figure);
  if (parseFloat(getComputedStyle(figure).fontSize) >= min) return;
  figure.classList.add("wrap");
  figure.style.fontSize = `${min}px`;
  const needed = number.getBoundingClientRect().width;
  const available = figure.clientWidth;
  if (needed > available) figure.style.fontSize = `${Math.floor(min * (available / needed) * 0.99 * 10) / 10}px`;
}

/**
 * Render an address or hash as one continuous value: its exact characters, with nothing between
 * them but <wbr> break points at its middle or quarters (hexParts). lab.css then lets it run on one
 * line or split into equal lines, so a wrapped value never strands a fragment. A copy of the text,
 * by hand or by Copy, is the exact value.
 */
export function renderHex(element, value) {
  const parts = hexParts(value);
  if (!parts) {
    element.textContent = String(value);
    return;
  }
  const nodes = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(document.createElement("wbr"));
    const span = document.createElement("span");
    span.textContent = part;
    nodes.push(span);
  });
  element.replaceChildren(...nodes);
}

/**
 * A Copy button for a technical value. It copies `value()`; if the clipboard is refused, it selects
 * the value on screen (`shown()`) instead, ready for a copy by hand. Its word and icon change in
 * place (each pair shares one cell in lab.css), so nothing moves. `live` says the outcome to screen
 * readers.
 */
export function wireCopy(button, { value, shown, live, what }) {
  let timer;
  button.addEventListener("click", async () => {
    let state = "copied";
    try {
      await navigator.clipboard.writeText(value());
    } catch {
      state = "selected";
      const target = shown?.();
      if (target) getSelection()?.selectAllChildren(target);
    }
    button.dataset.copy = state;
    if (live) setText(live, state === "copied" ? `${what} copied` : `${what} selected, ready to copy`);
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.dataset.copy = "idle";
      if (live) setText(live, "");
    }, reducedMotion() ? 2400 : 1600);
  });
}

/**
 * Point an explorer link at one value, on the explorer whose address the page sets in one place,
 * <meta name="explorer" content>. In the page the link is a hidden placeholder <a> with no href,
 * reading "View in Explorer": no explorer's name, since the configured one may redirect to another.
 * Once explorerUrl makes a valid link, it opens in a new tab with no handle on this page and no
 * referrer, and its accessible name is its visible words, then what it shows and that it opens a new
 * tab. Otherwise it goes back to a hidden placeholder.
 */
export function linkExplorer(link, kind, value, what) {
  const explorer = document.querySelector('meta[name="explorer"]');
  const href = explorerUrl(explorer?.content, kind, value);
  if (href) {
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${link.textContent.trim()}: ${what}, opens in a new tab`);
  } else {
    for (const name of ["href", "target", "rel", "aria-label"]) link.removeAttribute(name);
  }
  link.hidden = !href;
}

/**
 * Fill the shell counter ("01 / 28") and the previous/next context from the manifest.
 * Only a task with status "available" and a path becomes a link; planned tasks are plain text.
 */
export function renderTaskContext(tasks, current, { counter, previous, next } = {}) {
  const index = tasks.findIndex((task) => task.n === current);
  if (index === -1) return;
  if (counter) {
    const n = document.createElement("b");
    n.textContent = current;
    counter.replaceChildren(n, ` / ${String(tasks.length).padStart(2, "0")}`);
  }
  for (const [element, task, label] of [[previous, tasks[index - 1], "Previous"], [next, tasks[index + 1], "Next"]]) {
    if (!element) continue;
    if (!task) {
      element.hidden = true;
      continue;
    }
    const caption = Object.assign(document.createElement("span"), { className: "lab", textContent: label });
    const n = Object.assign(document.createElement("span"), { className: "num", textContent: task.n });
    const linked = task.status === "available" && typeof task.path === "string";
    const title = Object.assign(document.createElement(linked ? "a" : "span"), { className: "t", textContent: task.title });
    if (linked) title.href = task.path;
    const tag = Object.assign(document.createElement("span"), { className: `tag tag-${task.status}`, textContent: task.status === "available" ? "Available" : "Planned" });
    element.replaceChildren(caption, n, title, tag);
    element.hidden = false;
  }
}
