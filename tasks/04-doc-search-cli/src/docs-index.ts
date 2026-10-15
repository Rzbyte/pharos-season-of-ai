import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DOCS_HOST, DOCS_ORIGIN, INDEX_TTL_MS } from "./constants.js";
import { plainInline } from "./text.js";
import type { DocPage } from "./types.js";

/**
 * Read the docs' own page list (sitemap.md) into pages. Every markdown link to a page on
 * docs.pharos.xyz counts, whatever its nesting; the nearest heading above it becomes its section.
 * Links elsewhere, anchors and assets are skipped; a page listed twice is kept once.
 */
export function parseSitemap(markdown: string): DocPage[] {
  const pages = new Map<string, DocPage>();
  let section: string | null = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line);
    if (heading && !/\]\(/.test(heading[1]!)) {
      section = plainInline(heading[1]!) || section;
      continue;
    }
    for (const match of line.matchAll(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g)) {
      const path = docsPath(match[2]!);
      if (!path || pages.has(path)) continue;
      const title = plainInline(match[1]!);
      if (!title) continue;
      pages.set(path, { title, path, url: pageUrl(path), section });
    }
  }
  return [...pages.values()];
}

/** "/x/y.md", "https://docs.pharos.xyz/x/y", "x/y/" -> "/x/y"; null for anything not a docs page. */
export function docsPath(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, `${DOCS_ORIGIN}/`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== DOCS_HOST) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null; // a malformed %-escape is not a page
  }
  let path = decoded.replace(/\/+$/, "").replace(/\.md$/i, "");
  if (path === "" || path === "/sitemap" || path === "/llms" || path === "/llms-full") return null;
  if (/\.(png|jpe?g|gif|svg|webp|pdf|txt|json|xml|ico)$/i.test(path)) return null;
  if (!/^\/[\w\-./%]+$/.test(path) || path.includes("..")) return null;
  path = path.replace(/\/{2,}/g, "/");
  return path;
}

/** The human page URL on the docs site. */
export function pageUrl(path: string): string {
  return `${DOCS_ORIGIN}${path}`;
}

// ---------------------------------------------------------------------------
// A small disk cache for the CLI, so a second question does not re-read the index.

interface CacheFile {
  format: "pharos-docs-index/1";
  savedAt: number;
  pages: DocPage[];
}

export async function readIndexCache(file: string, now = Date.now(), ttlMs = INDEX_TTL_MS): Promise<DocPage[] | null> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as CacheFile;
    if (data.format !== "pharos-docs-index/1" || !Array.isArray(data.pages) || now - data.savedAt > ttlMs || data.savedAt > now) return null;
    // Re-validate every entry: a cache file is not trusted more than the network.
    const pages = data.pages.filter((page) => typeof page?.title === "string" && typeof page.path === "string" && docsPath(page.path) === page.path);
    return pages.length > 0 ? pages.map((page) => ({ ...page, url: pageUrl(page.path) })) : null;
  } catch {
    return null;
  }
}

export async function writeIndexCache(file: string, pages: DocPage[], now = Date.now()): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const data: CacheFile = { format: "pharos-docs-index/1", savedAt: now, pages };
    await writeFile(file, JSON.stringify(data), "utf8");
  } catch {
    // A cache that cannot be written is only slower, never wrong.
  }
}
