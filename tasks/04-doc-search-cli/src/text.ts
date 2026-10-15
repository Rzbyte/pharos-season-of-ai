// Text handling shared by the ranker and the answer extractor. Deterministic, no model.

const STOPWORDS = new Set(
  (
    "a an the and or but if then of to in on at for from by with without into onto about as is are was were be been being " +
    "do does did doing done can could should would will shall may might must i me my we our you your it its this that these " +
    "those there here what which who whom whose when where why how any some all each every much many more most other such " +
    "than too very just also only own same so not no nor up down out over under again further once please tell show give " +
    "find get need want know use using used pharos docs doc documentation"
  ).split(" "),
);

/** Multi-word terms the docs and questions both use, joined so they match as one word. */
function joinPhrases(text: string): string {
  return text.replace(/chain[\s-]*id\b/gi, "chainid").replace(/json[\s-]*rpc/gi, "jsonrpc").replace(/cross[\s-]*chain/gi, "crosschain");
}

/** Lowercase word stems, stopwords dropped. "Deploying contracts" -> ["deploy", "contract"]. */
export function terms(text: string): string[] {
  return (joinPhrases(text).toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? [])
    .flatMap((word) => (word.includes("-") || word.includes("_") ? [word.replace(/[-_]/g, ""), ...word.split(/[-_]/)] : [word]))
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);
}

/** A light suffix stripper: enough to match "deploying"/"deployment"/"deploy". Same rule on both sides. */
export function stem(word: string): string {
  if (/^\d+$/.test(word) || word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`; // registries -> registry
  for (const suffix of ["ments", "ment", "ings", "ing", "ers", "er", "ed"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  if (/(?:ss|us|is)$/.test(word)) return word; // address, status, analysis
  if (/(?:s|x|z|ch|sh)es$/.test(word) && word.length - 2 >= 3) return word.slice(0, -2); // addresses -> address
  if (word.endsWith("s") && word.length - 1 >= 3) return word.slice(0, -1); // bridges -> bridge, fees -> fee
  return word;
}

/** Control characters and invisible direction marks: never passed on from the network to a terminal. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
export function stripControls(text: string): string {
  return text.replace(CONTROL, "");
}

/**
 * Developer vocabulary -> words the docs use for the same topic in page titles and paths. Topics only:
 * no value (chain ID, address, endpoint, gas figure) is ever stored here; values come from the pages.
 */
const SYNONYMS: Record<string, string[]> = {
  deploy: ["deploy", "foundry", "hardhat"],
  install: ["install", "setup", "foundry", "hardhat"],
  compile: ["foundry", "hardhat"],
  solidity: ["foundry", "hardhat", "contract"],
  forge: ["foundry"],
  chainid: ["network", "testnet", "mainnet"],
  chain: ["network"],
  network: ["network", "testnet", "mainnet"],
  testnet: ["testnet", "atlantic", "network"],
  mainnet: ["mainnet", "pacific", "network"],
  faucet: ["faucet", "testnet"],
  explorer: ["explorer", "network"],
  address: ["contract", "canonical", "registry"],
  canonical: ["canonical", "contract"],
  token: ["token", "registry"],
  usdc: ["token", "registry"],
  rpc: ["rpc", "jsonrpc", "method", "network"],
  endpoint: ["rpc", "network"],
  jsonrpc: ["rpc", "json", "method"],
  method: ["method", "rpc", "jsonrpc", "api"],
  api: ["api", "sdk", "rpc"],
  sdk: ["sdk", "api"],
  gas: ["gas", "fee", "network"],
  fee: ["fee", "gas"],
  wallet: ["wallet"],
  metamask: ["wallet", "metamask"],
  oracle: ["oracle", "chainlink"],
  price: ["oracle", "chainlink", "feed"],
  feed: ["oracle", "chainlink", "feed"],
  chainlink: ["chainlink", "oracle"],
  bridge: ["bridge", "crosschain", "cross"],
  crosschain: ["crosschain", "cross", "bridge"],
  ccip: ["chainlink", "crosschain"],
  skill: ["skill", "engine"],
  agent: ["skill", "agent", "engine"],
  mcp: ["mcp", "skill", "agent"],
  validator: ["validator", "node", "staking"],
  node: ["node", "validator"],
  stake: ["staking", "validator"],
};

/**
 * How-to verbs say which guide answers the question ("deploy" -> the Foundry and Hardhat guides) more
 * reliably than the nouns around them ("contract" also names the Canonical Contracts page), so their
 * topic words count as much as the question's own words.
 */
const INTENT_VERBS = new Set(["deploy", "install", "compile"]);

export function expand(term: string): string[] {
  return SYNONYMS[term] ?? [];
}

/**
 * The words of a question; the related topic words it implies (weighted lower by callers); and
 * `intent`, the topic words of its how-to verbs (weighted like its own words).
 */
export function questionTerms(question: string): { direct: string[]; related: string[]; intent: string[] } {
  const direct = [...new Set(terms(question))];
  const intent = [...new Set(direct.filter((term) => INTENT_VERBS.has(term)).flatMap((term) => expand(term).map(stem)))].filter((term) => !direct.includes(term));
  const related = [...new Set(direct.flatMap((term) => expand(term).map(stem)))].filter((term) => !direct.includes(term) && !intent.includes(term));
  return { direct, related, intent };
}

/**
 * What kind of volatile value a question asks for, if any. Such values (chain IDs, addresses, endpoints,
 * gas figures) are only ever answered with a value copied from a fetched page, never from memory.
 */
export type ValueKind = "chain-id" | "address" | "endpoint" | "number";
export function valueKind(question: string): ValueKind | null {
  const q = question.toLowerCase();
  if (/chain\s*-?\s*id|chainid/.test(q)) return "chain-id";
  if (/\b(contract|token|deployed|canonical)?\s*address(es)?\b/.test(q) && !/ip address|email/.test(q)) return "address";
  if (/\b(rpc|wss?|websocket|endpoint|url)\b/.test(q) && /\b(what|which|where)\b/.test(q)) return "endpoint";
  if (/\b(gas (price|limit)|block time|how many|how much|minimum stake)\b/.test(q)) return "number";
  return null;
}

export function hasValue(text: string, kind: ValueKind): boolean {
  if (kind === "chain-id") return /\b\d{3,}\b|\b0x[0-9a-f]{3,8}\b/i.test(text);
  if (kind === "address") return /\b0x[0-9a-fA-F]{40}\b/.test(text);
  if (kind === "endpoint") return /\b(?:https?|wss?):\/\/[^\s)]+/.test(text);
  return /\d/.test(text);
}

// ---------------------------------------------------------------------------
// Reading markdown and HTML into blocks

export interface Block {
  /** The heading the block sits under (for context in answers). */
  heading: string | null;
  kind: "heading" | "paragraph" | "item" | "row" | "code";
  text: string;
}

/** Strip inline markdown to readable text; links keep their label, images go. */
export function plainInline(text: string): string {
  return stripControls(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Markdown -> blocks: headings, paragraphs, list items, table rows (as "Header: value; Header: value"),
 * and code blocks. Front matter and GitBook hint markers are skipped.
 */
export function markdownBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const blocks: Block[] = [];
  let heading: string | null = null;
  let paragraph: string[] = [];
  let table: { header: string[] } | null = null;
  let code: string[] | null = null;
  const flush = () => {
    const text = plainInline(paragraph.join(" "));
    if (text) blocks.push({ heading, kind: "paragraph", text });
    paragraph = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (code) {
      if (/^\s*(```|~~~)/.test(line)) {
        if (code.length) blocks.push({ heading, kind: "code", text: code.join("\n").trim() });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      code = [];
      continue;
    }
    const cells = /^\s*\|(.+)\|\s*$/.exec(line);
    if (cells) {
      flush();
      const values = cells[1]!.split("|").map((cell) => plainInline(cell));
      if (values.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === "")) continue;
      if (!table) {
        table = { header: values };
      } else {
        // A two-column table is a list of name/value pairs: "Name: value". Wider tables keep
        // every column's header: "Header: x; Header: y".
        const text =
          table.header.length === 2 && values.length === 2 && values[0] && values[1]
            ? `${values[0]}: ${values[1]}`
            : values.map((value, i) => (table!.header[i] && value ? `${table!.header[i]}: ${value}` : value)).filter(Boolean).join("; ");
        if (text) blocks.push({ heading, kind: "row", text });
      }
      continue;
    }
    table = null;
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      heading = plainInline(h[2]!);
      if (heading) blocks.push({ heading, kind: "heading", text: heading });
      continue;
    }
    if (/^\s*\{%.*%\}\s*$/.test(line)) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const text = plainInline(item[1]!);
      if (text) blocks.push({ heading, kind: "item", text });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line.replace(/^\s*>\s?/, ""));
  }
  flush();
  return blocks;
}

/** HTML -> markdown-ish text, good enough to read headings, paragraphs, list items and table rows. */
export function htmlToText(html: string): string {
  const body = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<body[\s\S]*?<\/body>/i.exec(html)?.[0] ?? html;
  return decodeEntities(
    body
      .replace(/<(script|style|noscript|svg|nav|header|footer)[\s\S]*?<\/\1>/gi, "")
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, "")}\n\n`)
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/tr>/gi, " |")
      .replace(/<\/(p|div|section|article|li|table|ul|ol|pre|blockquote)>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ")
      .replace(/<tr[^>]*>/gi, "\n| ")
      .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** Absolute links in a markdown or text body. */
export function linksIn(text: string, base: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s)<>"']+)/g)) {
    const href = (match[1] ?? match[2] ?? "").replace(/[.,;:]+$/, "");
    try {
      found.add(new URL(href, base).href);
    } catch {
      // not a URL; ignore
    }
  }
  return [...found];
}

/** Cut text to at most `max` characters at a sentence or line boundary. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return `${(at > max * 0.5 ? cut.slice(0, at + 1) : cut).trimEnd()}…`;
}
