// Task 04 page: how a result's answer text and sources are laid out. Pure functions, no DOM, so they
// are tested without a browser (tests/web-page.test.mjs).
//
// The answer arrives as plain text (the source gate's cleaned answer): paragraphs, "- " items,
// numbered steps ("1. ...") and code, whose lines are kept as written. Nothing here changes a word of
// it; it only says which lines are a step, an item, a paragraph or code, so the page can set them.

/** Lines indented by the docs (code inside a step keeps its indentation; prose never does). */
const INDENTED = /^(?: {2,}|\t)\S/;
/** A line that starts like a command or code, not like a sentence. */
const CODE_LINE =
  /^(?:\$ |#!|\/\/|pragma |import |export |contract |function |const |let |forge |cast |anvil |npm |npx |pnpm |yarn |git |curl |wget |cd |sudo |docker |cargo |node |python3? |pip3? |make |tar |chmod |mkdir |source |brew |solc )|^\[[\w.\- ]+\]$|^[\w.-]+ ?= ?\S/;
/** A line that ends like a sentence. */
const SENTENCE = /[A-Za-z][.!?]$/;

/** Whether a run of lines (no blank line inside) is code: all of it indented, or all of it command-like. */
function isCode(lines) {
  if (lines.every((line) => INDENTED.test(line))) return true;
  return lines.every((line) => CODE_LINE.test(line) && !(SENTENCE.test(line) && line.split(/\s+/).length > 3));
}

/** Code without its common indentation, its own indentation kept. */
function dedent(lines) {
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut).replace(/\s+$/, "")).join("\n");
}

/**
 * The answer as blocks, in order:
 *   { kind: "p", text }                          a paragraph (its own line breaks kept)
 *   { kind: "list", items: [text] }              "- " items
 *   { kind: "steps", items: [{ n, text, code }] } numbered steps, each with the code indented under it
 *   { kind: "code", text }                       code on its own
 * Code split by blank lines stays one block.
 */
export function answerBlocks(text) {
  // Runs of non-blank lines; consecutive code runs are one block (a blank line inside code).
  const runs = [];
  let run = null;
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) {
      run = null;
      continue;
    }
    if (!run) runs.push((run = []));
    run.push(line);
  }
  const merged = [];
  for (const lines of runs) {
    const code = isCode(lines);
    const last = merged.at(-1);
    if (code && last?.code) last.lines.push("", ...lines);
    else merged.push({ code, lines: [...lines] });
  }

  const blocks = [];
  for (const { code, lines } of merged) {
    const last = blocks.at(-1);
    if (code) {
      const text = dedent(lines);
      // Indented code right after a step belongs to that step.
      if (last?.kind === "steps" && lines.every((line) => !line.trim() || INDENTED.test(line))) last.items.at(-1).code.push(text);
      else blocks.push({ kind: "code", text });
      continue;
    }
    let paragraph = null;
    for (const line of lines) {
      const step = /^(\d+)[.)]\s+(.*)$/.exec(line);
      const item = /^[-•]\s+(.*)$/.exec(line);
      const previous = blocks.at(-1);
      if (step) {
        paragraph = null;
        const entry = { n: step[1], text: step[2], code: [] };
        if (previous?.kind === "steps") previous.items.push(entry);
        else blocks.push({ kind: "steps", items: [entry] });
      } else if (item) {
        paragraph = null;
        if (previous?.kind === "list") previous.items.push(item[1]);
        else blocks.push({ kind: "list", items: [item[1]] });
      } else if (paragraph) {
        paragraph.text += `\n${line}`;
      } else {
        blocks.push((paragraph = { kind: "p", text: line }));
      }
    }
  }
  return blocks;
}

/** Whether a link may be shown as a docs link: an https page on docs.pharos.xyz. */
export function isOfficial(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "docs.pharos.xyz" && !parsed.port && !parsed.username;
  } catch {
    return false;
  }
}

/** Where a docs page sits: the sections of its path, without the page ("getting-started / network"). */
export function docsSection(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).slice(0, -1).join(" / ");
  } catch {
    return "";
  }
}

/** How many of `total` sources are listed before "Show N more": all of them, unless at least two would wait. */
export function sourcesShown(total, first = 3) {
  return total <= first + 1 ? total : first;
}
