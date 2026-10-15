// The docs search page's question box, read like the CLI's command line, with no DOM, so tests can
// import it in Node. It accepts what the CLI accepts, plus a few page commands:
//   pharos-docs "question" [--json]     the same as the CLI
//   "question" [--json] / question      the command name may be left out
//   pharos-docs --help | --version, help, clear, history

/** @returns {{ kind: "empty" } | { kind: "help" } | { kind: "version" } | { kind: "clear" } | { kind: "history" } | { kind: "ask", question: string, json: boolean } | { kind: "error", message: string }} */
export function parseCommand(input) {
  let text = String(input ?? "").trim();
  if (!text) return { kind: "empty" };
  if (/^(help|\?)$/i.test(text)) return { kind: "help" };
  if (/^(clear|cls)$/i.test(text)) return { kind: "clear" };
  if (/^history$/i.test(text)) return { kind: "history" };
  text = text.replace(/^pharos-docs(?:\s+|$)/i, "");
  if (/^(-h|--help)$/.test(text)) return { kind: "help" };
  if (/^--version$/.test(text)) return { kind: "version" };
  let json = false;
  text = text.replace(/(^|\s)--json(?=\s|$)/g, () => {
    json = true;
    return " ";
  }).trim();
  const unknown = /(^|\s)(--?[a-z][\w-]*)(?=\s|$)/i.exec(text);
  if (unknown) return { kind: "error", message: `Unknown option ${unknown[2]}. Type help for commands.` };
  const quoted = /^(["'“”‘’])([\s\S]*)\1$/.exec(text) ?? /^["“]([\s\S]*)["”]$/.exec(text);
  const question = (quoted ? quoted[quoted.length - 1] : text).trim();
  if (!question) return { kind: "error", message: 'Ask a question, for example: pharos-docs "how do I deploy a contract?"' };
  if (question.length > 300) return { kind: "error", message: "Keep the question under 300 characters." };
  return { kind: "ask", question, json };
}

/** Plain-language reasons, the same wording as the CLI. */
export const REASONS = {
  no_matching_page: "No page in the Pharos Developer Docs matches this question.",
  page_unavailable: "The matching docs page could not be read.",
  not_in_docs: "The Pharos Developer Docs say they do not cover this.",
  weak_match: "The docs do not answer this question directly.",
  value_not_found: "The docs do not state this value, and values are never filled in from memory.",
  unsourced: "The docs answered without citing a docs.pharos.xyz page, so the answer is not shown.",
};

/** A history that remembers the last `size` commands, with up/down navigation. */
export function createHistory(size = 50) {
  const items = [];
  let cursor = 0;
  return {
    push(line) {
      if (line && items[items.length - 1] !== line) items.push(line);
      if (items.length > size) items.shift();
      cursor = items.length;
    },
    up() {
      if (items.length === 0) return null;
      cursor = Math.max(0, cursor - 1);
      return items[cursor];
    },
    down() {
      cursor = Math.min(items.length, cursor + 1);
      return cursor === items.length ? "" : items[cursor];
    },
    list: () => [...items],
  };
}
