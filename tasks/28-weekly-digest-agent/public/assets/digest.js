// Task 28 page: the digest agent. Makes a digest on load (USDC over the last 3 hours and the hour so far,
// or what the address bar asks for), and again on demand; every digest is GET /api/agent?task=28, which
// reads a token's or a wallet's logs on Pharos Mainnet through the hosted Chain MCP and writes each hour as
// sentences, against the hour before. Nothing is signed or sent. Everything is set as text, never as markup.
import { $, addressLink, ADDRESS, agentRunner, el, group, setStatus, short, wireForm } from "./agent.js";
import { renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "28", LAB);

/** The official Pharos Mainnet tokens, as agent/src/core/networks.ts has them (a test keeps the two equal). */
const TOKENS = Object.freeze(["WPROS", "USDC", "LINK", "WETH"]);
const EXAMPLE = Object.freeze({ subject: "USDC", hours: "3", wallet: "" });
/** The address that moved the most USDC in Task 02's live proof. */
const WALLET = "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647";
const FIELDS = { subject: $("f-subject"), hours: $("f-hours"), wallet: $("f-wallet") };
const plural = (n, one, many = `${one}s`) => `${group(n)} ${n === 1 ? one : many}`;

/** What is wrong with each input, by field; empty when the digest can be made. */
function problems(v) {
  const out = {};
  if (![...TOKENS, "wallet"].includes(v.subject)) out.subject = "Pick a token or a wallet.";
  if (!/^[1-5]$/.test(v.hours)) out.hours = "Pick 1 to 5 hours.";
  if (v.subject === "wallet" && !ADDRESS.test(v.wallet)) out.wallet = "Enter a 0x address of 40 hex characters.";
  return out;
}

const queryOf = (v) => ({ subject: v.subject === "wallet" ? v.wallet : v.subject, hours: v.hours });

/** The digest the address bar asks for, where it is complete and well formed; else the example. */
function initialInputs() {
  const query = new URLSearchParams(location.search);
  const subject = (query.get("subject") ?? "").trim();
  const wallet = ADDRESS.test(subject);
  const inputs = { subject: wallet ? "wallet" : subject.toUpperCase(), hours: (query.get("hours") ?? "").trim(), wallet: wallet ? subject : "" };
  return Object.keys(problems(inputs)).length === 0 ? inputs : { ...EXAMPLE };
}

/** The wallet's address shows only for a wallet. */
function adapt() {
  $("wallet-field").hidden = FIELDS.subject.value !== "wallet";
}

const summaryOf = (v) => `${v.subject === "wallet" ? (ADDRESS.test(v.wallet) ? short(v.wallet) : "A wallet") : v.subject}, ${v.hours === "1" ? "1 hour" : `${v.hours} hours`}`;

/** The status: the last complete hour against the one before. */
function status(result) {
  const last = result.digests.at(-1);
  if (!last) return setStatus("neutral", "No hour", "has ended yet");
  if (!last.figures.transfers) return setStatus("neutral", "Quiet", "nothing moved in the last hour");
  const change = last.change?.transfers ?? null;
  if (change === null) return setStatus("success", "Digest", `${plural(last.figures.transfers, "transfer")} in the last hour`);
  if (change > 0) return setStatus("success", "Busier", `${group(change)}% more transfers than the hour before`);
  if (change < 0) return setStatus("success", "Quieter", `${group(-change)}% fewer transfers than the hour before`);
  setStatus("success", "Steady", "as many transfers as the hour before");
}

/** Newest first: the hour so far, then each complete hour, its first sentence as its lead. */
function renderPeriods(result) {
  $("periods-box").hidden = false;
  $("periods-meta").replaceChildren(result.subject.kind === "wallet" ? addressLink(result.subject.address, "the wallet") : result.subject.label);
  const periods = [...(result.current ? [result.current] : []), ...[...result.digests].reverse()];
  $("periods").replaceChildren(
    ...periods.map((d) => {
      const row = el("li", "period");
      row.dataset.open = String(!d.complete);
      const [lead, ...rest] = d.sentences;
      row.append(el("p", "period-lead", lead), ...rest.map((line) => el("p", "period-line", line)));
      if (d.blocks) row.append(el("p", "period-meta", `Blocks ${group(d.blocks.from)}–${group(d.blocks.to)}`));
      return row;
    }),
  );
  const cut = $("cut");
  cut.hidden = !result.cut;
  cut.textContent = result.cut ? `The oldest ${result.cut === 1 ? "hour" : `${result.cut} hours`} asked for did not fit in the blocks one request reads, and ${result.cut === 1 ? "is" : "are"} left out.` : "";
}

/** Transfers an hour, oldest first, as bars against the busiest. */
function renderSide(result) {
  $("side-box").hidden = false;
  const periods = [...result.digests, ...(result.current ? [result.current] : [])];
  const most = Math.max(1, ...periods.map((d) => d.figures.transfers));
  $("bars").replaceChildren(
    ...periods.map((d) => {
      const row = el("li", "bar");
      row.dataset.open = String(!d.complete);
      const fill = el("span", "bar-fill");
      fill.style.width = `${(100 * d.figures.transfers) / most}%`;
      const track = el("span", "bar-track");
      track.append(fill);
      row.append(el("span", "bar-label", `${d.start.slice(11, 16)}${d.complete ? "" : " so far"}`), track, el("span", "bar-n", group(d.figures.transfers)));
      return row;
    }),
  );
  const rows = [];
  const fact = (label, value) => {
    const row = el("div");
    row.append(el("dt", "", label), el("dd", "", value));
    return row;
  };
  if (result.now.supplyShown !== null) rows.push(fact("Total supply", `${result.now.supplyShown} ${result.subject.label}`));
  else if (result.now.holdings.length) rows.push(...result.now.holdings.map((h) => fact(h.symbol, h.shown)));
  else rows.push(fact("Holds", "No PROS or official token"));
  $("now").replaceChildren(...rows);
}

function render({ result }) {
  status(result);
  renderPeriods(result);
  renderSide(result);
}

const digest = agentRunner({ task: "28", panel: $("digest"), running: ["Reading", "Pharos Mainnet"], failed: "No digest", render });

function fill(inputs) {
  for (const [key, input] of Object.entries(FIELDS)) input.value = inputs[key];
  adapt();
}

let current = initialInputs();
fill(current);
$("change-meta").textContent = summaryOf(current);

function run(inputs) {
  current = inputs;
  fill(current);
  $("change-meta").textContent = summaryOf(current);
  history.replaceState(null, "", `?${new URLSearchParams(queryOf(current))}`);
  digest(queryOf(current));
}

wireForm({ form: $("settings"), fields: FIELDS, problems, result: { heading: $("digest-h"), panel: $("digest") }, submit: run });
FIELDS.subject.addEventListener("change", adapt);
$("reset").addEventListener("click", () => fill(EXAMPLE));
$("ex-wpros").addEventListener("click", () => run({ ...current, subject: "WPROS", wallet: "" }));
$("ex-wallet").addEventListener("click", () => run({ ...current, subject: "wallet", wallet: WALLET }));

digest(queryOf(current));
