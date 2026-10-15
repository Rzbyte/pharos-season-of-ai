// Pharos Agent Lab: the task manifest every page reads (the shell's task navigation and the lab index).
//
// Metadata only. A task is "built" (it has a page and committed proof) or "planned" (nothing yet).
// Each built task is its own deployment, so its link is that deployment's address, kept here in one
// place: DEPLOYMENTS. An address that is not filled in yet is null, and then nothing links to it; the
// task is still listed, as text. Nothing can ever link to a page that does not exist.

/** Where each deployment lives. Fill in a production URL once it is known; null means "not linked". */
export const DEPLOYMENTS = Object.freeze({
  lab: null,
  "01": null,
  "02": null,
  "03": null,
  "04": null,
});

export const LAB = Object.freeze({ name: "Pharos Agent Lab", short: "Agent Lab", home: DEPLOYMENTS.lab, total: 28 });

const task = (n, title, { verb = null, purpose = null, status = "planned", tool = null, official = title } = {}) =>
  Object.freeze({ n, title, official, verb, purpose, status, tool, href: status === "built" ? (DEPLOYMENTS[n] ?? null) : null });

export const TASKS = Object.freeze([
  task("01", "Contract State", { official: "Read Contract State", verb: "Read", tool: "Chain MCP", status: "built", purpose: "A contract's state at one block, and any address or transaction on demand." }),
  task("02", "Event Monitor", { official: "Event / Log Monitor", verb: "Watch", tool: "Chain MCP", status: "built", purpose: "Transfer events as they land, each shown once." }),
  task("03", "Docs Onboarding", { official: "Docs MCP Onboarding", verb: "Audit", tool: "Docs MCP", status: "built", purpose: "From the docs to a working Atlantic RPC call, with the gaps on the way." }),
  task("04", "Docs Search", { official: "Doc-Search CLI", verb: "Query", tool: "Developer Docs", status: "built", purpose: "Answers from the official Pharos docs, with sources, or no answer." }),
  task("05", "Threshold Guardian"),
  task("06", "Saga Executor"),
  task("07", "Arbitrage Scanner"),
  task("08", "Dry-Run Executor"),
  task("09", "Trend Watcher"),
  task("10", "Batch Executor"),
  task("11", "Policy Gatekeeper"),
  task("12", "Skill + Chain MCP Flow"),
  task("13", "Docs MCP + Chain MCP Agent"),
  task("14", "Portfolio Assistant"),
  task("15", "Yield Optimizer"),
  task("16", "Liquidation Watchdog"),
  task("17", "Natural-Language Payment Agent"),
  task("18", "Recurring Payment Agent"),
  task("19", "Invoice-to-Payment Agent"),
  task("20", "On-Chain Alert Bot"),
  task("21", "Whale-Watching Agent"),
  task("22", "Gas Fee Optimizer"),
  task("23", "Wallet Risk Checker"),
  task("24", "Audit-Log Agent"),
  task("25", "dApp Support Agent"),
  task("26", "Weekly Digest Agent"),
  task("27", "Doc-Grounded Builder Agent"),
  task("28", "Multi-Protocol Aggregator", { tool: "Composition" }),
]);

export const BUILT = TASKS.filter((entry) => entry.status === "built").length;
