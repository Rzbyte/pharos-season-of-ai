// Task 29: what the docs say about the pieces of an action, set beside the Pharos Skill Engine's values.
// The docs' text (the answer and the pages read) is searched for chain IDs, RPC URLs, the token's
// address and the function to call; each is compared with what the Skill Engine's network and token
// lists hold. A piece the docs do not mention is said to be so, never assumed.
import type { Address } from "../core/chain.js";
import { NETWORKS, type Network, type Token } from "../core/networks.js";
import { addressesIn, names } from "../docs/answer.js";

export interface Grounding {
  id: "chain-id" | "rpc" | "token" | "function";
  /** What is checked, in a few words: "Chain ID", "USDC's address". */
  label: string;
  /** The value the action uses, from the Skill Engine (or the standard, for a function). */
  uses: string;
  /** Where that value comes from. */
  usesFrom: string;
  /** What the docs say of it; null when they do not mention it. */
  docs: string | null;
  /** Where in the docs: "the answer" or a page. */
  docsWhere: string | null;
  /** True: the docs give the same; false: they give another; null: they do not say. */
  agrees: boolean | null;
}

export interface DocsText {
  where: string;
  text: string;
}

const known = Object.values(NETWORKS);
const normalUrl = (url: string) => url.toLowerCase().replace(/[).,;:'"`]+$/, "").replace(/\/+$/, "");

/** Chain IDs the docs give: "chain ID is 688689", "| Chain ID | 1672 |". */
export function chainIdsIn(text: string): number[] {
  return [...new Set([...text.matchAll(/chain\s*id\b[^0-9\n]{0,24}(\d{3,9})/gi)].map((m) => Number(m[1])))];
}

/** RPC URLs the docs give: any http(s) URL with "rpc" or "dplabs" in its host. */
export function rpcUrlsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/https?:\/\/[^\s)<>|`'"\]]+/g)].map((m) => normalUrl(m[0])).filter((url) => /^https?:\/\/[^/]*(?:rpc|dplabs)/i.test(url)))];
}

/** Whether the docs name a function: "transfer(", or `transfer` set as code. */
export const namesFunction = (text: string, name: string): boolean => new RegExp(`\\b${name}\\s*\\(|\`${name}\``, "i").test(text);

/** The first text that holds a match, and where it is. */
function firstIn<T>(texts: readonly DocsText[], find: (text: string, where: string) => T | null): { found: T; where: string } | null {
  for (const { where, text } of texts) {
    const found = find(text, where);
    if (found !== null) return { found, where };
  }
  return null;
}

/** The network's chain ID and RPC URL against those the docs give. */
export function groundNetwork(net: Network, texts: readonly DocsText[]): Grounding[] {
  const out: Grounding[] = [];
  const ids = firstIn(texts, (text) => {
    const found = chainIdsIn(text);
    return found.length ? found : null;
  });
  const others = known.filter((n) => n.id !== net.id);
  if (ids) {
    const ours = ids.found.includes(net.chainId);
    const unknown = ids.found.filter((id) => id !== net.chainId && !others.some((n) => n.chainId === id));
    out.push({ id: "chain-id", label: "Chain ID", uses: String(net.chainId), usesFrom: "Skill Engine networks.json", docs: ids.found.join(", "), docsWhere: ids.where, agrees: ours ? true : unknown.length ? false : null });
  } else out.push({ id: "chain-id", label: "Chain ID", uses: String(net.chainId), usesFrom: "Skill Engine networks.json", docs: null, docsWhere: null, agrees: null });
  const urls = firstIn(texts, (text) => {
    const found = rpcUrlsIn(text);
    return found.length ? found : null;
  });
  const rpc = normalUrl(net.rpcUrl);
  out.push({ id: "rpc", label: "RPC URL", uses: net.rpcUrl, usesFrom: "Skill Engine networks.json", docs: urls ? urls.found.join(", ") : null, docsWhere: urls?.where ?? null, agrees: urls?.found.includes(rpc) ? true : null });
  return out;
}

/** The token's address in the Skill Engine's list against an address the docs give for its symbol. */
export function groundToken(net: Network, token: Token, texts: readonly DocsText[]): Grounding {
  const label = `${token.symbol}'s address`;
  const given = firstIn(texts, (text, where) => {
    const rows = addressesIn(text, where).filter((a) => names(a.label, token.symbol) && (a.network === null || a.network === net.id));
    return rows.length ? rows.map((r) => r.address) : null;
  });
  const ours = token.address.toLowerCase();
  if (!given) return { id: "token", label, uses: token.address, usesFrom: "Skill Engine tokens.json", docs: null, docsWhere: null, agrees: null };
  const same = given.found.some((a: Address) => a.toLowerCase() === ours);
  return { id: "token", label, uses: token.address, usesFrom: "Skill Engine tokens.json", docs: same ? token.address : given.found[0]!, docsWhere: given.where, agrees: same };
}

/** The function an action calls, named by the docs or not. */
export function groundFunction(signature: string, standard: string, texts: readonly DocsText[]): Grounding {
  const name = signature.slice(0, signature.indexOf("("));
  const named = firstIn(texts, (text) => (namesFunction(text, name) ? name : null));
  return { id: "function", label: "Function", uses: signature, usesFrom: standard, docs: named ? `${name}(…)` : null, docsWhere: named?.where ?? null, agrees: named ? true : null };
}
