// Task 13: reading what the Developer Docs MCP says. An askQuestion answer is split from its Sources (as
// Task 04 reads it); the docs saying they do not cover a question is caught with Task 04's English rules;
// and the text is searched for what can be called: contract addresses, each with the label and network
// its line, table row or heading gives it, and functions written with their return type.
import { getAddress, zeroAddress } from "viem";
import type { Address } from "../core/chain.js";
import { DOCS_ORIGIN } from "../core/docs-mcp.js";
import type { NetworkId } from "../core/networks.js";

export interface DocsSource {
  title: string | null;
  url: string;
}

export interface DocsAddress {
  address: Address;
  /** What the docs call it: the other cells of its table row, or the rest of its line, as plain text. */
  label: string;
  /** The network its row, line or heading names; null when none does. */
  network: NetworkId | null;
  /** "the answer", or the page it is on. */
  where: string;
}

export interface DocsFunction {
  name: string;
  /** Its return type, as the docs write it: uint256, address, bool, string, bytes32 and the like. */
  returns: string;
  /** The line it is on, as plain text. */
  text: string;
  where: string;
}

/** Markdown as plain text: links to their words, no images, code ticks, emphasis or tags. */
export function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Markdown as readable text, line by line: links to their words; no images, emphasis, tags, fences or heading marks. */
export function readable(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SOURCES = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?\s*(?:sources?|references?|citations?)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;

/** The answer before its Sources section, and the docs pages it links to (its own links first). */
export function splitAnswer(text: string): { body: string; sources: DocsSource[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((line) => SOURCES.test(line));
  const body = (at === -1 ? lines : lines.slice(0, at)).join("\n").trim();
  const links: DocsSource[] = [];
  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s)<>"']+)/g)) {
    try {
      const url = new URL((match[2] ?? match[3] ?? "").replace(/[.,;:]+$/, ""), `${DOCS_ORIGIN}/`);
      if (url.origin !== DOCS_ORIGIN) continue;
      url.hash = "";
      if (!links.some((l) => l.url === url.href)) links.push({ title: match[1] ? plain(match[1]) || null : null, url: url.href });
    } catch {
      // not a URL
    }
  }
  return { body, sources: links };
}

/**
 * The docs saying they do not cover the question (Task 04's English rules, tasks/04-doc-search-cli/src/
 * source-gate.ts): always about the documentation as the subject, so "No. Pharos does not support X."
 * stays an answer.
 */
const NOT_COVERED = (() => {
  const DOCS = String.raw`(?:the\s+)?(?:official\s+)?(?:pharos\s+)?(?:developer\s+)?(?:(?:docs|documentation|knowledge\s+base)(?:\s+(?:site|pages?|portal))?|doc\s+pages?)`;
  const INFO = String.raw`(?:information|documentation|mention|guide|guidance|details|instructions|tutorial|page|section|reference)s?`;
  const COVER = String.raw`(?:cover|contain|mention|include|describe|document|explain|address|discuss|have|specify|reference|detail|provide)`;
  const IS_NOT = String.raw`(?:\b(?:is|are|was|were)|'s|'re)(?:\s+not|n't)`;
  return [
    String.raw`\b${DOCS}\s+(?:(?:currently|also)\s+)?(?:do|does|did)(?:\s+not|n't)\s+(?:(?:currently|appear\s+to|seem\s+to)\s+)?${COVER}\b`,
    String.raw`${IS_NOT}\s+(?:(?:currently|explicitly)\s+)?(?:covered|mentioned|described|addressed|discussed|included|explained|specified|documented)\s+(?:anywhere\s+)?(?:in|by|within)\s+${DOCS}`,
    String.raw`${IS_NOT}\s+(?:(?:currently|explicitly)\s+)?documented\b`,
    String.raw`\b${DOCS}\s+(?:has|have|contains?|includes?)\s+no\s+(?:\w+\s+){0,2}?${INFO}\b`,
    String.raw`\bthere(?:\s+is|\s+are|'s)\s+no\s+(?:\w+\s+){0,2}?${INFO}\s+(?:about|on|for|regarding|covering|that|in)\b`,
    String.raw`\bi\s+(?:could\s*not|couldn't|cannot|can't|did\s*not|didn't|was\s+unable\s+to|am\s+unable\s+to|wasn't\s+able\s+to)\s+(?:find|locate)\b`,
    String.raw`\bi\s+(?:do\s*not|don't)\s+see\s+(?:any|anything)\b`,
    String.raw`\boutside\s+(?:of\s+)?(?:the\s+)?scope\s+of\s+${DOCS}`,
  ].map((rule) => new RegExp(rule, "i"));
})();

export const notCovered = (body: string): boolean => NOT_COVERED.some((rule) => rule.test(body.replace(/[’‘]/g, "'")));

const ADDRESS = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const networkIn = (text: string): NetworkId | null => (/\bmainnet\b/i.test(text) ? "pharos-mainnet" : /\b(?:atlantic|testnet)\b/i.test(text) ? "atlantic-testnet" : null);
const clip = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Every contract address in markdown, with the label and network its row, line or heading gives it. */
export function addressesIn(markdown: string, where: string): DocsAddress[] {
  const out: DocsAddress[] = [];
  let heading = "";
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const title = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (title) heading = plain(title[1]!);
    const found = [...line.matchAll(ADDRESS)].map((m) => m[0]);
    if (!found.length) continue;
    const row = /^\s*\|/.test(line);
    const words = row
      ? line
          .split("|")
          .map((cell) => cell.trim())
          .filter((cell) => cell && !/^0x[0-9a-fA-F]{40}$/.test(plain(cell)) && !/^[-:]+$/.test(cell))
          .map(plain)
          .filter(Boolean)
          .join(" · ")
      : plain(line.replace(ADDRESS, "…")).replace(/^[-*+]\s+|^\d+[.)]\s+/, "").replace(/[\s:,;.()·-]+$/, "").replace(/^[\s:,;.()·-]+/, "");
    for (const raw of found) {
      const address = getAddress(raw.toLowerCase());
      if (address === zeroAddress) continue;
      const network = networkIn(line) ?? networkIn(heading) ?? (where.startsWith("http") ? networkIn(where.replace(/[-/]/g, " ")) : null);
      const label = clip(words || heading || "no label");
      // The same address may be listed twice under different names (a docs error): both are kept.
      if (out.some((a) => a.address === address && a.network === network && a.label === label)) continue;
      out.push({ address, label, network, where });
    }
  }
  return out;
}

const TYPE = String.raw`(uint\d{0,3}|int\d{0,3}|address|bool|string|bytes32)`;
const SOLIDITY = new RegExp(String.raw`\bfunction\s+([A-Za-z_]\w*)\s*\(\s*\)\s*(?:(?:external|public|view|pure)\s+)*returns\s*\(\s*${TYPE}(?:\s+\w+)?\s*\)`, "g");
const SHORT = new RegExp(String.raw`\b([A-Za-z_]\w*)\(\)\s*(?:→|->|returns?\s*:?)\s*\(?\s*${TYPE}\b`, "gi");

/** Functions of no arguments the docs write with a return type: "function totalSupply() view returns (uint256)". */
export function functionsIn(markdown: string, where: string): DocsFunction[] {
  const out: DocsFunction[] = [];
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    for (const match of [...line.matchAll(SOLIDITY), ...line.matchAll(SHORT)]) {
      const [name, returns] = [match[1]!, match[2]!.toLowerCase()];
      if (!out.some((f) => f.name === name)) out.push({ name, returns: returns === "uint" ? "uint256" : returns === "int" ? "int256" : returns, text: clip(plain(line), 160), where });
    }
  }
  return out;
}

const STOP = new Set("what which where when who whom whose how does did doing done have has had the this that these those there their them they and for from with into onto about address addresses contract contracts function functions call calls called value values pharos mainnet testnet atlantic network chain onchain token tokens official deployed deploy deployment its it's are was were is be been being can could should would will shall may might must on of in at to by an a or as do me my our your you please tell show give find get read return returns".split(" "));

/** The words of a question worth matching against a label: three letters or more, not filler. */
export const keywords = (question: string): string[] => [...new Set(question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w));

/** How many of those words a label has, each as a whole word. */
export const hits = (label: string, words: readonly string[]): number => words.filter((w) => new RegExp(`\\b${w}\\b`).test(label.toLowerCase())).length;

/** Whether a label names `text` (a symbol or a name): its words, in order, among the label's. */
export function names(label: string, text: string): boolean {
  const words = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const [l, t] = [words(label), words(text)];
  return t.length > 0 && l.some((_, i) => t.every((w, j) => l[i + j] === w));
}

/** Capitalised words that are not token symbols, for telling whether a label names one. */
const NOT_SYMBOLS = new Set("ERC EVM USD NFT RPC API ABI URL DEX AMM EOA MCP SDK CLI JSON HTTP HTTPS UTC DAO CEX TVL APR APY OTC KYC AML FAQ PDF EIP BIP ZKP POS POW".split(" "));

/** The words of a label written like token symbols: USDC, WPROS, WETH (three to ten capitals and digits). */
export const symbolsIn = (label: string): string[] => (label.match(/\b[A-Z][A-Z0-9]{2,9}\b/g) ?? []).filter((w) => !NOT_SYMBOLS.has(w));
