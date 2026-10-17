// Pharos Agent Lab: the task manifest every page reads (the shell's task navigation and the lab index).
//
// Metadata only, one entry per task of the official map (30 tasks), in its order. A task is "built" (it
// has a page and committed proof) or "planned" (nothing yet).
//
// The canonical site is one domain: the lab at "/", every task at "/tasks/NN" (route below). Tasks 01
// and 02 also still have their earlier standalone deployments (LEGACY); a page served from one of those
// cannot reach "/tasks/NN" on its own domain, so only there does the navigation fall back to these
// addresses. A planned task has no route and nothing links to it.

/** The canonical route of a task on the unified site. */
export const route = (n) => `/tasks/${n}`;

/** The earlier standalone deployments, kept as fallbacks. Never the canonical navigation. */
export const LEGACY = Object.freeze({
  "01": "https://pharos-task-01.vercel.app",
  "02": "https://pharos-task-02.vercel.app",
});

export const LAB = Object.freeze({ name: "Pharos Agent Lab", short: "Agent Lab", home: "/", total: 30 });

const task = (n, title, { verb = null, purpose = null, status = "planned", tool = null, official = title } = {}) =>
  Object.freeze({ n, title, official, verb, purpose, status, tool, href: status === "built" ? route(n) : null, legacy: status === "built" ? (LEGACY[n] ?? null) : null });

export const TASKS = Object.freeze([
  task("01", "Contract State", { official: "Read Contract State", verb: "Read", tool: "Chain MCP", status: "built", purpose: "A contract's state at one block, and any address or transaction on demand." }),
  task("02", "Event Monitor", { official: "Event / Log Monitor", verb: "Watch", tool: "Chain MCP", status: "built", purpose: "Transfer events as they land, each shown once." }),
  task("03", "Docs Onboarding", { official: "Docs MCP Onboarding", verb: "Audit", tool: "Docs MCP", status: "built", purpose: "From the docs to a working Atlantic RPC call, with the gaps on the way." }),
  task("04", "Docs Search", { official: "Doc-Search CLI", verb: "Query", tool: "Developer Docs", status: "built", purpose: "Answers from the official Pharos docs, with sources, or no answer." }),
  task("05", "Threshold Guardian", { verb: "Guard", tool: "Chain MCP", status: "built", purpose: "A payout that fires only when every on-chain condition holds at one block." }),
  task("06", "Saga Executor"),
  task("07", "Arbitrage Scanner"),
  task("08", "Dry-Run Executor", { verb: "Simulate", tool: "Chain MCP", status: "built", purpose: "What a transaction would do and cost, simulated at one block before anything is sent." }),
  task("09", "Trend Watcher", { verb: "Track", tool: "Chain MCP", status: "built", purpose: "One balance observed run after run, acting once when the observations show a trend." }),
  task("10", "Batch Executor"),
  task("11", "Policy Gatekeeper", { verb: "Gate", tool: "Chain MCP", status: "built", purpose: "A payment checked against a written policy at one block: limits, allowlists, hours." }),
  task("12", "Skill + Chain MCP Flow"),
  task("13", "Docs MCP + Chain MCP Agent", { verb: "Ask", tool: "Docs + Chain MCP", status: "built", purpose: "A question answered from the official docs, then checked and called on chain." }),
  task("14", "Portfolio Assistant"),
  task("15", "Yield Optimizer"),
  task("16", "Liquidation Watchdog"),
  task("17", "Natural-Language Payment Agent"),
  task("18", "Recurring Payment Agent"),
  task("19", "Invoice-to-Payment Agent"),
  // 20 and 21 are the two x402 tasks the official map inserted here; the tasks that were 20 to 28 are now
  // 22 to 30.
  task("20", "X402 Paywalled API"),
  task("21", "X402 Agent Buyer"),
  task("22", "On-Chain Alert Bot", { verb: "Alert", tool: "Chain MCP", status: "built", purpose: "Large transfers and on-chain conditions watched run after run, each alerted once." }),
  task("23", "Whale-Watching Agent", { verb: "Track", tool: "Chain MCP", status: "built", purpose: "Chosen addresses followed run after run: holdings, changes and the significant moves." }),
  task("24", "Gas Fee Optimizer", { verb: "Time", tool: "Chain MCP", status: "built", purpose: "The fee watched block by block, and one transaction sent now or held for a cheaper one." }),
  task("25", "Wallet Risk Checker", { verb: "Vet", tool: "Chain MCP", status: "built", purpose: "The address a transaction goes to, checked first: its history, lookalikes, risky approvals." }),
  task("26", "Audit-Log Agent", { verb: "Report", tool: "Chain MCP", status: "built", purpose: "What an address did over a period: read from the chain, written as plain sentences." }),
  task("27", "dApp Support Agent", { verb: "Explain", tool: "Chain MCP", status: "built", purpose: "Why a transaction failed, on request: the revert decoded, each finding with its source." }),
  task("28", "Weekly Digest Agent", { verb: "Digest", tool: "Chain MCP", status: "built", purpose: "A token's or a wallet's activity period by period, each against the one before." }),
  task("29", "Doc-Grounded Builder Agent"),
  task("30", "Multi-Protocol Aggregator", { tool: "Composition" }),
]);

export const BUILT = TASKS.filter((entry) => entry.status === "built").length;
