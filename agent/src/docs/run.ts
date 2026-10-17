// Task 13, Docs MCP + Chain MCP Agent: a question about a Pharos contract, answered from the official
// docs, then checked and called on chain.
//
//   1. The docs: askQuestion through the Developer Docs MCP. The answer is split from its sources; an
//      answer the docs say they do not cover, or with no docs page behind it, is not acted on.
//   2. What to call: contract addresses, each with the label and network its table row or line gives it.
//      The answer is synthesized from the docs, so the pages it cites are read too (getPage, at most two)
//      until an address fits the question and is on a page: an address a page gives is taken over one only
//      the answer gives. Functions the docs write with a return type are taken too.
//   3. The chain, through Chain MCP, at one block: whether each address has code; each function the docs
//      name, called; and, where the contract answers symbol(), its name, decimals and total supply (the
//      standard ERC-20 views), to set beside what the docs call it, and beside the Skill Engine's tokens.
//   4. The verdict: the chain confirms the docs, contradicts them, or has no contract there; or the docs
//      gave nothing to call. Every step names its source: a docs page, or a Chain MCP tool.
import { decodeFunctionResult, encodeFunctionData, parseAbiItem, type AbiFunction } from "viem";
import { formatAmount } from "../core/amounts.js";
import type { Address, Chain } from "../core/chain.js";
import { DOCS_ORIGIN, DocsToolError, type DocsTools } from "../core/docs-mcp.js";
import { AgentError, errorMessage } from "../core/errors.js";
import { knownToken, NETWORKS, type NetworkId } from "../core/networks.js";
import { addressesIn, functionsIn, hits, keywords, notCovered, readable, splitAnswer, symbolsIn, type DocsAddress, type DocsFunction, type DocsSource } from "./answer.js";

export interface FunctionCall {
  name: string;
  returns: string;
  /** Named in the docs, or one of the standard ERC-20 views used to check the docs' label. */
  from: "docs" | "erc20";
  ok: boolean;
  value: string | null;
  error: string | null;
}

export interface ChainReading extends DocsAddress {
  /** A docs page this run read that has the address (where the docs themselves give it, not only the answer); null if none. */
  onPage: string | null;
  /** False where the docs place the address on another network than the one read. */
  read: boolean;
  code: "none" | "contract" | "delegated" | null;
  calls: FunctionCall[];
  token: { symbol: string; name: string | null; decimals: number | null; totalSupply: string | null; totalSupplyShown: string | null } | null;
  /** Whether the chain's own name for it (its symbol or name) is in the docs' label; null with nothing to compare. */
  agrees: boolean | null;
  /** The Pharos Skill Engine's token list: the symbol it gives this address on the docs' network, if any. */
  skillEngine: string | null;
  /** Whether that is the symbol the chain gives; null where the list has no such token or the chain gives none. */
  skillEngineAgrees: boolean | null;
}

export interface DocsChainResult {
  schema: "pharos-agent/docs-chain/1";
  question: string;
  network: { id: string; name: string; chainId: number };
  chainMcp: { where: string; server: string | null };
  docsMcp: { where: string };
  block: { number: string; hash: string; timestamp: string; source: "latest" | "requested" };
  evaluatedAt: string;
  docs: { status: "answered" | "no_answer"; answer: string | null; sources: DocsSource[]; pages: string[] };
  functions: DocsFunction[];
  readings: ChainReading[];
  verdict: "confirmed" | "mismatch" | "no-contract" | "other-network" | "nothing-to-call" | "no-answer";
  /** How it got there, in order, each with its source: a docs tool and page, or a Chain MCP tool. */
  steps: { source: string; text: string }[];
  headline: string;
  toolCalls: { docs: number; chain: number };
}

export interface DocsChainOptions {
  docs: DocsTools;
  chain: Chain;
  /** Read the chain at this block instead of the newest. */
  block?: bigint;
  now?: () => Date;
}

export const MAX_QUESTION = 300;
const GOAL = "Find the Pharos contract or function this question is about: its address, its network, and what it returns.";
const MAX_ADDRESSES = 3;
const MAX_PAGES = 2;
const MAX_FUNCTIONS = 2;
const ERC20 = [
  { name: "symbol", returns: "string" },
  { name: "name", returns: "string" },
  { name: "decimals", returns: "uint8" },
  { name: "totalSupply", returns: "uint256" },
];
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The question from untrusted input. */
export function parseQuestion(text: unknown): string {
  const question = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!question) throw new AgentError("usage", "Ask a question about a Pharos contract, like: What is the USDC token address on Pharos Mainnet?");
  if (question.length > MAX_QUESTION) throw new AgentError("usage", `A question is at most ${MAX_QUESTION} characters.`);
  return question;
}

/** The network a question is about: the one it names, else the one this run reads. */
const networkAsked = (question: string, reading: NetworkId): NetworkId => (/\b(?:atlantic|testnet)\b/i.test(question) ? "atlantic-testnet" : /\bmainnet\b/i.test(question) ? "pharos-mainnet" : reading);

/**
 * The addresses that fit the question best: by its words in their labels. A page's are taken over the
 * answer's where both fit as well (the pages are the docs; the answer is synthesized from them), and of
 * those, the ones on the network the question is about over those the docs place elsewhere. A page's
 * address with none of the question's words is never taken (a page lists many); an answer's may be, when
 * nothing fits better.
 */
function choose(words: string[], wanted: NetworkId, inAnswer: DocsAddress[], inPages: DocsAddress[]): DocsAddress[] {
  const fits = (a: DocsAddress) => (a.network === wanted ? 1 : a.network === null ? 0 : -1);
  const all = [...inPages.map((a) => ({ a, page: 1 })), ...inAnswer.map((a) => ({ a, page: 0 }))];
  const ranked = all.map((x) => ({ ...x, hits: hits(x.a.label, words) })).sort((x, y) => y.hits - x.hits || fits(y.a) - fits(x.a) || y.page - x.page);
  const best = ranked[0]?.hits ?? 0;
  let picked = best > 0 ? ranked.filter((x) => x.hits === best) : ranked.filter((x) => x.page === 0);
  if (picked.some((x) => x.page === 1)) picked = picked.filter((x) => x.page === 1);
  if (picked.some((x) => fits(x.a) >= 0)) picked = picked.filter((x) => fits(x.a) >= 0);
  const out: DocsAddress[] = [];
  for (const { a } of picked) if (!out.some((o) => o.address === a.address) && out.length < MAX_ADDRESSES) out.push(a);
  return out;
}

/** Whether a label names `text` (a symbol or a name): its words, in order, among the label's. */
function names(label: string, text: string): boolean {
  const words = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const [l, t] = [words(label), words(text)];
  return t.length > 0 && l.some((_, i) => t.every((w, j) => l[i + j] === w));
}

const what = (r: ChainReading) => (r.code === "delegated" ? "an account delegated to a contract (EIP-7702)" : "a contract");

export async function docsThenChain(question: string, options: DocsChainOptions): Promise<DocsChainResult> {
  const { docs, chain } = options;
  const net = chain.network;
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  await chain.expectChain();
  const head = await chain.block(options.block ?? (await chain.blockNumber()));
  const steps: DocsChainResult["steps"] = [];
  const page = (url: string) => `docs page ${url.replace(DOCS_ORIGIN, "")}`;

  // 1. The docs.
  const text = await docs.call("askQuestion", { question, goal: GOAL });
  const { body, sources } = splitAnswer(text);
  // An answer is acted on only with a docs page behind it, as Task 04 shows one.
  const covered = body.length > 0 && !notCovered(body);
  const answered = covered && sources.length > 0;
  steps.push({ source: "Developer Docs MCP · askQuestion", text: answered ? `The docs answered, citing ${sources.length === 1 ? "one page" : `${sources.length} pages`}: ${sources.slice(0, 3).map((s) => s.title ?? s.url).join(", ")}.` : covered ? "The docs answered without citing a page, so the answer is not acted on." : "The docs do not cover this question." });

  // 2. What to call: addresses that fit the question, from a page the answer cites where one gives them.
  const words = keywords(question);
  const wanted = networkAsked(question, net.id);
  const fitting = (list: DocsAddress[]) => list.some((a) => hits(a.label, words) > 0);
  const pages: string[] = [];
  const texts: string[] = [];
  const onPage = (address: string) => {
    const at = texts.findIndex((text) => text.includes(address.toLowerCase()));
    return at === -1 ? null : pages[at]!;
  };
  const titleOf = (url: string) => sources.find((s) => s.url === url)?.title ?? url.replace(DOCS_ORIGIN, "");
  let found: DocsAddress[] = [];
  let functions: DocsFunction[] = [];
  if (answered) {
    const inAnswer = addressesIn(body, "the answer");
    const inPages: DocsAddress[] = [];
    functions = functionsIn(body, "the answer");
    found = choose(words, wanted, inAnswer, inPages);
    // The pages that name the question's words first, then those that list contracts; at most two, and
    // none once the addresses chosen fit the question and are on a page read.
    const rank = (s: DocsSource) => (words.some((w) => `${s.title ?? ""} ${s.url}`.toLowerCase().includes(w)) ? 2 : 0) + (/regist|contract|address/i.test(`${s.title ?? ""} ${s.url}`) ? 1 : 0);
    for (const source of [...sources].sort((x, y) => rank(y) - rank(x)).slice(0, MAX_PAGES)) {
      if (fitting(found) && found.every((a) => onPage(a.address))) break;
      const tool = `Developer Docs MCP · getPage ${source.url.replace(DOCS_ORIGIN, "")}`;
      let markdown: string;
      try {
        markdown = await docs.call("getPage", { url: source.url });
      } catch (error) {
        if (!(error instanceof DocsToolError)) throw error;
        steps.push({ source: tool, text: `Could not read "${titleOf(source.url)}": ${error.message}` });
        continue;
      }
      pages.push(source.url);
      texts.push(markdown.toLowerCase());
      const here = addressesIn(markdown, source.url);
      inPages.push(...here);
      functions.push(...functionsIn(markdown, source.url).filter((f) => !functions.some((g) => g.name === f.name)));
      steps.push({ source: tool, text: `Read "${titleOf(source.url)}": ${here.length ? `${here.length} contract ${here.length === 1 ? "address" : "addresses"}` : "no contract address"}.` });
      found = choose(words, wanted, inAnswer, inPages);
    }
    // Functions: those the question names, else those the answer itself gives.
    const asked = functions.filter((f) => new RegExp(`\\b${f.name}\\b`, "i").test(question));
    functions = (asked.length ? asked : functions.filter((f) => f.where === "the answer")).slice(0, MAX_FUNCTIONS);
    for (const a of found) {
      const on = a.network ? ` on ${NETWORKS[a.network].name}` : "";
      const seen = onPage(a.address);
      const text = a.where !== "the answer" ? `The docs give ${a.address} as "${a.label}"${on}.` : seen ? `The docs' answer gives ${a.address} as "${a.label}"${on}, and "${titleOf(seen)}" has it too.` : `The docs' answer gives ${a.address} as "${a.label}"${on}; none of the pages read has it.`;
      steps.push({ source: a.where === "the answer" ? "Developer Docs MCP · the answer" : page(a.where), text });
    }
    // An address only the answer gives, where a page gives another that fits: said, and not called.
    for (const a of inAnswer.filter((x) => hits(x.label, words) > 0 && (x.network === null || x.network === wanted) && !found.some((f) => f.address === x.address) && !onPage(x.address)).slice(0, 2)) {
      steps.push({ source: "Developer Docs MCP · the answer", text: `The docs' answer also gives ${a.address} ("${a.label}"), but none of the pages read has it, so it is not called.` });
    }
    for (const f of functions) steps.push({ source: f.where === "the answer" ? "Developer Docs MCP · the answer" : page(f.where), text: `The docs give ${f.name}() as returning ${f.returns}: "${clip(f.text, 120)}".` });
  }

  // 3. The chain, at one block.
  const readings: ChainReading[] = [];
  for (const a of found) {
    const listed = knownToken(a.network ? NETWORKS[a.network] : net, a.address);
    const reading: ChainReading = { ...a, onPage: onPage(a.address), read: a.network === null || a.network === net.id, code: null, calls: [], token: null, agrees: null, skillEngine: listed?.symbol ?? null, skillEngineAgrees: null };
    readings.push(reading);
    if (!reading.read) {
      steps.push({ source: "this run", text: `Not read: the docs place ${short(a.address)} on ${NETWORKS[a.network!].name}, and this run reads ${net.name}.` });
      continue;
    }
    const code = await chain.code(a.address, head.number);
    reading.code = /^0x0*$/.test(code) ? "none" : /^0xef0100[0-9a-fA-F]{40}$/.test(code) ? "delegated" : "contract";
    steps.push({ source: "Chain MCP · get_code", text: reading.code === "none" ? `No contract at ${short(a.address)} on ${net.name}.` : reading.code === "delegated" ? `${short(a.address)} is an account whose code delegates to ${short(`0x${code.slice(8)}`)} (EIP-7702).` : `${short(a.address)} is a contract (${((code.length - 2) / 2).toLocaleString("en-US")} bytes of code).` });
    if (reading.code === "none") continue;
    const call = async (name: string, returns: string, from: FunctionCall["from"]): Promise<FunctionCall> => {
      const abi = parseAbiItem(`function ${name}() view returns (${returns})`) as AbiFunction;
      try {
        const data = await chain.call({ to: a.address, data: encodeFunctionData({ abi: [abi], functionName: name }) }, head.number);
        if (data === "0x") return { name, returns, from, ok: false, value: null, error: "it returned nothing" };
        const value = decodeFunctionResult({ abi: [abi], functionName: name, data }) as unknown;
        return { name, returns, from, ok: true, value: typeof value === "bigint" || typeof value === "number" ? value.toString() : String(value), error: null };
      } catch (error) {
        return { name, returns, from, ok: false, value: null, error: errorMessage(error).split("\n")[0]!.slice(0, 160) };
      }
    };
    for (const f of functions) reading.calls.push(await call(f.name, f.returns, "docs"));
    // The standard ERC-20 views, where the contract answers symbol(): to set beside the docs' label.
    const named = reading.calls.find((c) => c.name === "symbol");
    const symbol = named ?? (await call("symbol", "string", "erc20"));
    if (!named) reading.calls.push(symbol);
    if (symbol.ok) {
      for (const view of ERC20.slice(1)) if (!reading.calls.some((c) => c.name === view.name)) reading.calls.push(await call(view.name, view.returns, "erc20"));
      const value = (name: string) => reading.calls.find((c) => c.name === name && c.ok)?.value ?? null;
      const decimals = value("decimals") === null ? null : Number(value("decimals"));
      const supply = value("totalSupply");
      reading.token = { symbol: symbol.value!, name: value("name"), decimals, totalSupply: supply, totalSupplyShown: supply !== null && decimals !== null ? formatAmount(BigInt(supply), decimals, decimals > 6 ? 4 : decimals) : null };
    }
    for (const c of reading.calls) steps.push({ source: "Chain MCP · eth_call", text: c.ok ? `${c.name}() returns ${c.value}${c.from === "erc20" ? " (a standard ERC-20 view)" : ""}.` : c.from === "erc20" && c.name === "symbol" ? `symbol() did not answer (${c.error}), so it is not read as an ERC-20 token.` : `${c.name}() did not answer: ${c.error}.` });
    // The chain's own name against the docs' label, and against the Skill Engine's token list.
    if (reading.token) {
      const t = reading.token;
      reading.agrees = names(a.label, t.symbol) || (t.name !== null && names(a.label, t.name)) ? true : symbolsIn(a.label).length ? false : null;
      if (listed) reading.skillEngineAgrees = listed.symbol.toLowerCase() === t.symbol.toLowerCase();
    }
  }

  // 4. The verdict.
  const read = readings.filter((r) => r.read);
  const wrong = (r: ChainReading) => r.agrees === false || r.skillEngineAgrees === false;
  const verdict: DocsChainResult["verdict"] = !answered ? "no-answer" : !readings.length ? "nothing-to-call" : !read.length ? "other-network" : read.some(wrong) ? "mismatch" : read.some((r) => r.code === "none") ? "no-contract" : "confirmed";
  const where = net.name;
  const headline = (() => {
    if (verdict === "no-answer") return covered ? "The docs answered without citing a page, so nothing was called on chain." : "The docs do not cover this question, so nothing was called on chain.";
    if (verdict === "nothing-to-call") return "The docs answered, but gave no contract address to call.";
    const r = (verdict === "mismatch" ? read.find(wrong) : verdict === "no-contract" ? read.find((x) => x.code === "none") : read[0]) ?? readings[0]!;
    const docsSay = r.onPage ? `The docs give ${short(r.address)} as "${r.label}"` : `The docs' answer gives ${short(r.address)} as "${r.label}" (on none of the pages it cites)`;
    if (verdict === "other-network") return `${r.onPage ? "The docs place" : "The docs' answer places"} ${short(r.address)} ("${r.label}") on ${NETWORKS[r.network!].name}; this run reads ${where}.`;
    if (verdict === "no-contract") return `${docsSay}, but there is no contract at that address on ${where}.`;
    const t = r.token;
    if (verdict === "mismatch") {
      if (r.agrees === false) return `${docsSay}, but on ${where} it calls itself ${t!.symbol}${r.skillEngine === null ? "" : r.skillEngineAgrees ? `, and the Skill Engine lists it as ${r.skillEngine} too` : `, and the Skill Engine lists it as ${r.skillEngine}`}.`;
      return `${docsSay} and on ${where} it calls itself ${t!.symbol}, but the Skill Engine lists it as ${r.skillEngine}.`;
    }
    if (t) return `${docsSay}, and ${r.agrees ? `${where} agrees: ${what(r)}` : `on ${where} it is ${what(r)}`} whose symbol() is ${t.symbol}${t.decimals !== null ? `, with ${t.decimals} decimals` : ""}${t.totalSupplyShown ? ` and ${t.totalSupplyShown} ${t.symbol} in supply` : ""}.`;
    const fn = r.calls.find((c) => c.from === "docs" && c.ok);
    return `${docsSay}, and on ${where} it is ${what(r)}${fn ? `: ${fn.name}() returns ${fn.value}` : ""}.`;
  })();
  if (read.length) steps.push({ source: "the verdict", text: headline });

  return {
    schema: "pharos-agent/docs-chain/1",
    question,
    network: { id: net.id, name: net.name, chainId: net.chainId },
    chainMcp: { where: chain.mcp.where, server: chain.mcp.server ? `${chain.mcp.server.name} ${chain.mcp.server.version}` : null },
    docsMcp: { where: docs.where },
    block: { number: head.number.toString(), hash: head.hash, timestamp: new Date(Number(head.timestamp) * 1000).toISOString(), source: options.block === undefined ? "latest" : "requested" },
    evaluatedAt,
    docs: { status: answered ? "answered" : "no_answer", answer: answered ? clip(readable(body), 1200) : null, sources: sources.slice(0, 5), pages },
    functions,
    readings,
    verdict,
    steps,
    headline,
    toolCalls: { docs: docs.calls, chain: chain.mcp.toolCalls },
  };
}
