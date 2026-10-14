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

/** An address in groups of four for reading ("0xC879", "C018", ...); null if it is not an address. */
export function chunkAddress(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) return null;
  const groups = address.slice(2).match(/.{4}/g);
  return [`0x${groups[0]}`, ...groups.slice(1)];
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

export function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ── DOM ─────────────────────────────────────────────────────────────

/** Set the text of one element, or of every element matching a selector. */
export function setText(target, text) {
  const elements = typeof target === "string" ? document.querySelectorAll(target) : [target];
  for (const element of elements) element.textContent = text;
}

/** Page state, read by the CSS from <body data-state>: "reading", "live" or "error". */
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

/** Render an address as inline groups with break points between them and no added characters. */
export function renderAddress(element, address) {
  const groups = chunkAddress(address);
  if (!groups) {
    element.textContent = address;
    return;
  }
  const parts = [];
  groups.forEach((group, index) => {
    if (index > 0) parts.push(document.createElement("wbr"));
    const span = document.createElement("span");
    span.textContent = group;
    parts.push(span);
  });
  element.replaceChildren(...parts);
}

/**
 * Fill the shell counter ("01 / 28") and the previous/next context from the manifest.
 * Only a task with status "live" and a path becomes a link; planned tasks are plain text.
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
    const linked = task.status === "live" && typeof task.path === "string";
    const title = Object.assign(document.createElement(linked ? "a" : "span"), { className: "t", textContent: task.title });
    if (linked) title.href = task.path;
    const tag = Object.assign(document.createElement("span"), { className: `tag tag-${task.status}`, textContent: task.status === "live" ? "Live" : "Planned" });
    element.replaceChildren(caption, n, title, tag);
    element.hidden = false;
  }
}
