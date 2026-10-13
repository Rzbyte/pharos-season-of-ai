import { formatUnits } from "viem";

/** 1234567 -> "1,234,567". Works on arbitrarily long digit strings (no float rounding). */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Exact decimal conversion of a raw token amount: raw / 10^decimals, with the
 * integer part grouped. No rounding, so 1 wei of an 18-decimal token stays visible.
 */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  const text = formatUnits(raw, decimals);
  const negative = text.startsWith("-");
  const [whole = "0", fraction] = (negative ? text.slice(1) : text).split(".");
  return `${negative ? "-" : ""}${groupDigits(whole)}${fraction ? `.${fraction}` : ""}`;
}

// Characters that must never reach a terminal verbatim: token names and revert
// reasons are attacker-controlled. Built from code points so this file stays ASCII.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls, including ESC (ANSI escape injection)
  [0x007f, 0x009f], // DEL and C1 controls
  [0x200b, 0x200f], // zero-width characters and directional marks
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidi embeddings and overrides (display spoofing)
  [0x2060, 0x2069], // word joiner, invisible operators, bidi isolates
  [0xfeff, 0xfeff], // zero-width no-break space
];
const hex4 = (codePoint: number) => codePoint.toString(16).padStart(4, "0");
const UNSAFE_CHARACTERS = new RegExp(`[${UNSAFE_RANGES.map(([from, to]) => `\\u${hex4(from)}-\\u${hex4(to)}`).join("")}]`, "g");
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/** Make an on-chain string safe to print in a terminal. */
export function sanitizeForTerminal(value: string, maxLength = 120): string {
  const cleaned = [...value.replace(UNSAFE_CHARACTERS, REPLACEMENT_CHARACTER)];
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength).join("")}...` : cleaned.join("");
}

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
}

export function createStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (text: string) => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    green: wrap(32, 39),
    cyan: wrap(36, 39),
  };
}

/** Greedy word wrap for plain-language paragraphs. Words longer than the width stay intact. */
export function wrapText(text: string, width: number, indent = "  "): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((entry) => `${indent}${entry}`).join("\n");
}

/** Two-column "label  value" block with aligned values. A null row renders as a blank line. */
export function renderRows(rows: ReadonlyArray<readonly [string, string] | null>, style: Style, indent = "  "): string {
  const labels = rows.filter((row): row is readonly [string, string] => row !== null).map(([label]) => label.length);
  const width = Math.max(0, ...labels) + 2;
  return rows.map((row) => (row === null ? "" : `${indent}${style.dim(row[0].padEnd(width))}${row[1]}`)).join("\n");
}
