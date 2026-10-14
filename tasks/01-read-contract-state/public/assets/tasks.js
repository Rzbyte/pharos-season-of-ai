// Agent Arena Lab task manifest. Metadata only: Task 01 is the one page that exists.
// status: "available" (a page and a committed proof exist) or "planned" (nothing built yet).
// path is set only for available tasks, so nothing can ever link to a page that does not exist.
// tool is filled in only where it is already known; null means not stated yet.

const task = (n, title, tool = null, status = "planned", path = null) => Object.freeze({ n, title, tool, status, path });

export const TASKS = Object.freeze([
  task("01", "Read Contract State", "Chain MCP", "available", "/"),
  task("02", "Event / Log Monitor", "Chain MCP"),
  task("03", "Docs MCP Onboarding", "Docs MCP"),
  task("04", "Doc-Search CLI", "Docs MCP"),
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
  task("28", "Multi-Protocol Aggregator", "Composition"),
]);
