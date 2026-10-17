// Task 29, Doc-Grounded Builder Agent: how to do something on Pharos, answered from the official docs,
// then prepared (and, on Atlantic with a key, done) through Chain MCP and the Pharos Skill Engine.
//
//   1. The action the question asks for, read from its words: sending the native token or an official
//      token, approving a spender, wrapping the native token, or reading a balance. Its values come from
//      the question, the run's inputs over them, and the example's under them (Pharos Mainnet only).
//   2. The docs: askQuestion through the Developer Docs MCP. An answer the docs do not cover, or with no
//      page behind it, is not acted on: the agent prepares nothing the docs do not answer.
//   3. Grounding: the pieces of the action against the docs. The chain ID and RPC URL (the Skill
//      Engine's networks.json), the token's address (its tokens.json) and the function to call, each set
//      beside what the answer says, or the pages it cites (read for a token's address, at most two).
//   4. Prepared through Chain MCP at one block: Task 08's dry run (the state it changes, eth_call from
//      the sender, estimate_gas and the fee, the outcome). A balance is read there instead. With a key,
//      on Atlantic only, the dry-run transaction is signed locally and sent with send_raw_transaction.
//   5. The Skill Engine's way: the cast commands its references give for the action, filled in, and its
//      gas arithmetic on the agent's own estimate. The agent runs none of them.
import { maxUint256 } from "viem";
import { decodeCall, encodeCall, ERC20 } from "../core/abi.js";
import { formatAmount, parseAmount } from "../core/amounts.js";
import type { Address, Chain } from "../core/chain.js";
import { DOCS_ORIGIN, DocsToolError, type DocsTools } from "../core/docs-mcp.js";
import { AgentError, errorMessage } from "../core/errors.js";
import type { Signer } from "../core/execute.js";
import { notCovered, readable, splitAnswer, type DocsSource } from "../docs/answer.js";
import type { Intent } from "../dryrun/intent.js";
import { runDryRun, type DryRun, type DryRunOptions } from "../dryrun/run.js";
import { describeAction, parseAction, type Action, type ActionInputs, type Origin } from "./action.js";
import { groundFunction, groundNetwork, groundToken, type DocsText, type Grounding } from "./ground.js";
import { skillFee, skillPlan, type SkillPlan } from "./skill.js";

export interface HowToResult {
  schema: "pharos-agent/how-to/1";
  question: string;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  docsMcp: { where: string };
  block: { number: string; hash: string; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  docs: { status: "answered" | "no_answer"; answer: string | null; sources: DocsSource[]; pages: string[] };
  action: (Action & { summary: string }) | null;
  /** Why nothing was prepared, when nothing was. */
  reason: string | null;
  grounding: Grounding[];
  /** Task 08's dry run of the transaction, with its submission when one was sent. */
  prepared: DryRun | null;
  /** A balance read, for a balance question. */
  read: { holder: Address; asset: string; token: Address | null; raw: string; decimals: number; shown: string } | null;
  skillEngine: SkillPlan | null;
  verdict: "ready" | "would-fail" | "sent" | "read" | "not-prepared" | "no-answer";
  headline: string;
  /** How it got there, in order, each with its source: a docs tool or page, the Skill Engine, or a Chain MCP tool. */
  steps: { source: string; text: string }[];
  toolCalls: { docs: number; chain: number };
}

export interface HowToOptions {
  docs: DocsTools;
  chain: Chain;
  inputs?: ActionInputs;
  /** Read the chain at this block instead of the newest. */
  block?: bigint;
  /** Atlantic only: send what the dry run prepared, signed by this key (its address must be the sender). */
  signer?: Signer;
  wait?: DryRunOptions["wait"];
  now?: () => Date;
}

const GOAL = "Do this on Pharos: the steps, the contract and function to call, and the network to use.";
const MAX_PAGES = 2;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const lower = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** The transaction an action is: Task 08's intent. A wrap is the wrapped token's payable deposit(). */
function intentOf(action: Action): Intent {
  const from = action.account.value;
  const amount = action.amount!.value;
  switch (action.kind) {
    case "native-transfer":
      return { kind: "native-transfer", from, to: action.counterparty!.value, amount };
    case "erc20-transfer":
      return { kind: "erc20-transfer", token: action.token!.address, from, to: action.counterparty!.value, amount };
    case "erc20-approve":
      return { kind: "erc20-approve", token: action.token!.address, from, spender: action.counterparty!.value, amount };
    case "wrap":
      return { kind: "call", from, to: action.token!.address, signature: "deposit() payable", args: [], value: amount };
    case "balance":
      throw new Error("a balance is read, not sent");
  }
}

/** The function an action calls, and what it is by, for grounding; none for a native transfer or balance. */
function functionOf(action: Action): { signature: string; standard: string } | null {
  if (action.kind === "erc20-transfer") return { signature: "transfer(address,uint256)", standard: "the ERC-20 standard" };
  if (action.kind === "erc20-approve") return { signature: "approve(address,uint256)", standard: "the ERC-20 standard" };
  if (action.kind === "wrap") return { signature: "deposit()", standard: "the Skill Engine's call with value" };
  if (action.kind === "balance" && action.token) return { signature: "balanceOf(address)", standard: "the ERC-20 standard" };
  return null;
}

/** Which of the action's values came from where, in a sentence. */
function originsOf(action: Action): string {
  const role = { account: action.kind === "balance" ? "the address" : action.kind === "erc20-approve" ? "the owner" : "the sender", counterparty: action.kind === "erc20-approve" ? "the spender" : "the recipient", amount: "the amount" };
  const values: [keyof typeof role, { from: Origin } | null][] = [["account", action.account], ["counterparty", action.counterparty], ["amount", action.amount]];
  const from = (origin: Origin) => values.filter(([, p]) => p?.from === origin).map(([k]) => role[k]);
  const parts: string[] = [];
  const say = (names: string[], what: string) => names.length && parts.push(`${list(names)} ${names.length === 1 ? "is" : "are"} ${what}`);
  say(from("question"), "the question's");
  say(from("input"), "given");
  say(from("example"), "the example's");
  return parts.length ? `${sentence(parts.join("; "))}.` : "";
}

export async function howTo(question: string, options: HowToOptions): Promise<HowToResult> {
  const { docs, chain } = options;
  const net = chain.network;
  // The action and its inputs are checked before any call: a bad input is refused with nothing asked.
  const parsed = parseAction(question, options.inputs ?? {}, net);
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  await chain.expectChain();
  const head = await chain.block(options.block ?? (await chain.blockNumber()));
  const source = options.block === undefined ? ("latest" as const) : ("requested" as const);
  const steps: HowToResult["steps"] = [];

  // 1. The docs.
  const text = await docs.call("askQuestion", { question, goal: GOAL });
  const { body, sources } = splitAnswer(text);
  const covered = body.length > 0 && !notCovered(body);
  const answered = covered && sources.length > 0;
  steps.push({ source: "Developer Docs MCP · askQuestion", text: answered ? `The docs answered, citing ${sources.length === 1 ? "one page" : `${sources.length} pages`}: ${sources.slice(0, 3).map((s) => s.title ?? s.url).join(", ")}.` : covered ? "The docs answered without citing a page, so the answer is not acted on." : "The docs do not cover this question." });

  const pages: string[] = [];
  const result = (fields: Pick<HowToResult, "action" | "reason" | "grounding" | "prepared" | "read" | "skillEngine" | "verdict" | "headline">): HowToResult => ({
    schema: "pharos-agent/how-to/1",
    question,
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    docsMcp: { where: docs.where },
    block: { number: head.number.toString(), hash: head.hash, timestamp: new Date(Number(head.timestamp) * 1000).toISOString(), source },
    evaluatedAt,
    docs: { status: answered ? "answered" : "no_answer", answer: answered ? clip(readable(body), 1200) : null, sources: sources.slice(0, 5), pages },
    ...fields,
    steps,
    toolCalls: { docs: docs.calls, chain: chain.mcp.toolCalls },
  });
  const nothing = { grounding: [], prepared: null, read: null, skillEngine: null };
  if (!answered) return result({ action: null, reason: null, ...nothing, verdict: "no-answer", headline: covered ? "The docs answered without citing a page, so nothing was prepared." : "The docs do not cover this question, so nothing was prepared." });
  if (!parsed.action) {
    steps.push({ source: "the question", text: parsed.reason });
    return result({ action: null, reason: parsed.reason, ...nothing, verdict: "not-prepared", headline: `The docs answered. ${parsed.reason}` });
  }

  // 2. The action, from the question.
  const action = parsed.action;
  const summary = describeAction(action, net);
  steps.push({ source: "the question", text: `It asks to ${lower(summary)} on ${net.name}. ${originsOf(action)}`.trim() });

  // 3. Grounding: the answer, and for a token's address the pages it cites, likeliest first.
  const texts: DocsText[] = [{ where: "the answer", text: body }];
  const titleOf = (url: string) => sources.find((s) => s.url === url)?.title ?? url.replace(DOCS_ORIGIN, "");
  const token = action.token;
  if (token && groundToken(net, token, texts).docs === null) {
    const rank = (s: DocsSource) => (new RegExp(`\\b${token.symbol}\\b`, "i").test(`${s.title ?? ""} ${s.url}`) ? 2 : 0) + (/regist|token|contract|address/i.test(`${s.title ?? ""} ${s.url}`) ? 1 : 0);
    for (const s of [...sources].sort((x, y) => rank(y) - rank(x)).slice(0, MAX_PAGES)) {
      const tool = `Developer Docs MCP · getPage ${s.url.replace(DOCS_ORIGIN, "")}`;
      let markdown: string;
      try {
        markdown = await docs.call("getPage", { url: s.url });
      } catch (error) {
        if (!(error instanceof DocsToolError)) throw error;
        steps.push({ source: tool, text: `Could not read "${titleOf(s.url)}": ${error.message}` });
        continue;
      }
      pages.push(s.url);
      texts.push({ where: s.url, text: markdown });
      const found = groundToken(net, token, texts).docs !== null;
      steps.push({ source: tool, text: `Read "${titleOf(s.url)}": ${found ? `it gives an address for ${token.symbol}` : `no address for ${token.symbol}`}.` });
      if (found) break;
    }
  }
  const fn = functionOf(action);
  const grounding = [...groundNetwork(net, texts), ...(token ? [groundToken(net, token, texts)] : []), ...(fn ? [groundFunction(fn.signature, fn.standard, texts)] : [])];
  const docsPlace = (where: string | null) => (where === "the answer" ? "the docs' answer" : where ? `"${titleOf(where)}"` : "the docs");
  for (const g of grounding) {
    const what = `${g.label} ${g.id === "token" ? short(g.uses) : g.uses} (${g.usesFrom})`;
    const text = g.agrees === true ? `${what}: ${docsPlace(g.docsWhere)} gives the same.` : g.agrees === false ? `${what}: ${docsPlace(g.docsWhere)} gives ${g.docs} instead.` : g.docs !== null ? `${what}: ${docsPlace(g.docsWhere)} gives only ${g.docs}.` : `${what}: the docs read do not give it.`;
    steps.push({ source: `${g.usesFrom} · ${g.docsWhere === null ? "the docs" : g.docsWhere === "the answer" ? "the docs' answer" : `docs page ${g.docsWhere.replace(DOCS_ORIGIN, "")}`}`, text });
  }
  const differ = grounding.filter((g) => g.agrees === false);

  // 4. The chain, at one block.
  let prepared: DryRun | null = null;
  let read: HowToResult["read"] = null;
  const at = head.number;
  if (action.kind === "balance") {
    const holder = action.account.value;
    if (!token) {
      const raw = await chain.balance(holder, at);
      read = { holder, asset: net.nativeSymbol, token: null, raw: raw.toString(), decimals: 18, shown: `${formatAmount(raw, 18, 8)} ${net.nativeSymbol}` };
      steps.push({ source: "Chain MCP · get_balance", text: `${short(holder)} holds ${read.shown} at block ${at.toLocaleString("en-US")}.` });
    } else {
      let decimals: number;
      let raw: bigint;
      try {
        decimals = Number(decodeCall(ERC20.decimals, await chain.call({ to: token.address, data: encodeCall(ERC20.decimals, []) }, at)) as bigint);
        raw = decodeCall(ERC20.balanceOf, await chain.call({ to: token.address, data: encodeCall(ERC20.balanceOf, [holder]) }, at)) as bigint;
      } catch (error) {
        if (error instanceof AgentError && error.kind === "mcp_connection") throw error;
        throw new AgentError("mcp_tool", `${token.symbol} at ${token.address} did not answer like an ERC-20 token on ${net.name}: ${errorMessage(error).split("\n")[0]}`);
      }
      if (decimals !== token.decimals) throw new AgentError("mcp_tool", `${token.symbol} reports ${decimals} decimals; the Skill Engine's token list says ${token.decimals}.`);
      read = { holder, asset: token.symbol, token: token.address, raw: raw.toString(), decimals, shown: `${formatAmount(raw, decimals, decimals === 18 ? 8 : 6)} ${token.symbol}` };
      steps.push({ source: "Chain MCP · eth_call", text: `balanceOf(${short(holder)}) is ${read.shown} at block ${at.toLocaleString("en-US")} (decimals() ${decimals}, as the Skill Engine lists).` });
    }
  } else {
    prepared = await runDryRun(intentOf(action), { chain, at: { header: head, source }, signer: options.signer, wait: options.wait });
    steps.push({ source: "Chain MCP · eth_call · estimate_gas", text: `Dry run at block ${at.toLocaleString("en-US")}: ${prepared.headline}` });
    const sub = prepared.submission;
    if (sub) steps.push({ source: "Chain MCP · send_raw_transaction", text: `Signed here and sent: ${sub.txHash}, ${sub.status === "pending" ? "not yet in a block" : `${sub.status} in block ${Number(sub.blockNumber).toLocaleString("en-US")}`}${sub.status === "success" ? `; the receipt ${sub.matched ? "matches" : "does not match"} the prediction` : ""}.` });
  }

  // 5. The Skill Engine's way.
  const raw = token && action.amount && action.kind !== "wrap" && action.kind !== "balance" ? (action.amount.value === "max" ? maxUint256 : parseAmount(action.amount.value, token.decimals)) : null;
  const gas = prepared?.gas ?? null;
  const skillEngine = skillPlan(action, raw, net, gas ? skillFee(BigInt(gas.gas), BigInt(gas.gasPrice), net) : null);
  steps.push({ source: `Skill Engine · ${skillEngine.commands.at(-1)!.reference.split("#")[0]}`, text: `${action.kind === "balance" ? "Its cast command" : "Its cast commands to estimate and send it"}, from the Skill Engine's templates for ${skillEngine.network.name}${skillEngine.fee ? `; by its rule (the estimate × 1.2, rounded up) the gas limit is ${Number(skillEngine.fee.gasLimit).toLocaleString("en-US")} and the fee ${skillEngine.fee.costShown}` : ""}. The agent runs none of them.` });

  // The verdict.
  const sub = prepared?.submission ?? null;
  const verdict: HowToResult["verdict"] = read ? "read" : sub ? "sent" : prepared?.verdict === "would-succeed" ? "ready" : "would-fail";
  const noun = (g: Grounding) => (g.id === "chain-id" ? "chain ID" : g.id === "rpc" ? "RPC URL" : g.id === "token" ? `${token!.symbol} address` : "function");
  const caution = differ.length ? ` The docs give another ${list(differ.map(noun))} than the Skill Engine: check before sending.` : "";
  const notSent = net.id === "pharos-mainnet" ? "Nothing was sent: the hosted Chain MCP is read-only." : "Nothing was sent.";
  const headline = (() => {
    if (read) return `${short(read.holder)} holds ${read.shown} on ${net.name} at block ${at.toLocaleString("en-US")}.${caution}`;
    if (sub) return `${summary}: sent, ${sub.txHash.slice(0, 10)}…, ${sub.status === "pending" ? "not yet in a block" : sub.status}.${caution}`;
    if (prepared!.verdict === "would-succeed") return `${summary}: ready. The dry run at block ${at.toLocaleString("en-US")} succeeds, for about ${formatAmount(BigInt(prepared!.gas!.expectedCost), 18, 8)} ${net.nativeSymbol} in gas. ${notSent}${caution}`;
    return `${summary} would not go through: ${lower(prepared!.reason ?? "it fails.")} ${notSent}${caution}`;
  })();
  steps.push({ source: "the verdict", text: headline });
  return result({ action: { ...action, summary }, reason: null, grounding, prepared, read, skillEngine, verdict, headline });
}
