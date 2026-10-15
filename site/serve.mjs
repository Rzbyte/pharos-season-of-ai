#!/usr/bin/env node
// A local stand-in for the unified Vercel project, for previews and tests: the files in site/public,
// the rewrites in the root vercel.json, and /api/<name> answered by the root api/<name>.js adapter.
//
//   npm run build && npm run preview      http://127.0.0.1:3000 (real handlers: they reach the network)
//
// The order is Vercel's: a file that exists is served as is; otherwise the first matching rewrite;
// otherwise 404. Tests pass their own handlers (backed by in-repo fakes) instead of the real ones.
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** vercel.json rewrites as [regex, destination] pairs. Parameters: ":n" (one segment) or ":n(<regex>)". */
export function compileRewrites(rewrites) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return rewrites.map(({ source, destination }) => {
    let pattern = "";
    let last = 0;
    for (const match of source.matchAll(/:(\w+)(?:\(([^)]*)\))?/g)) {
      pattern += `${escape(source.slice(last, match.index))}(?<${match[1]}>${match[2] ?? "[^/]+"})`;
      last = match.index + match[0].length;
    }
    pattern += escape(source.slice(last));
    return [new RegExp(`^${pattern}$`), destination];
  });
}

/** The real handlers: each root api/<name>.js adapter. */
export async function realApis(names = ["state", "inspect", "explain", "events", "search"]) {
  const apis = {};
  for (const name of names) apis[name] = (await import(pathToFileURL(join(REPO, "api", `${name}.js`)).href)).default;
  return apis;
}

export async function createSiteServer({ root = join(REPO, "site", "public"), apis } = {}) {
  const config = JSON.parse(await readFile(join(REPO, "vercel.json"), "utf8"));
  const rewrites = compileRewrites(config.rewrites ?? []);
  const file = async (path) => {
    const full = normalize(join(root, decodeURIComponent(path)));
    if (!full.startsWith(root)) return null;
    try {
      const info = await stat(full);
      if (info.isFile()) return full;
      // A directory with an index, at its own path with a trailing slash ("/" is the lab).
      if (info.isDirectory() && path.endsWith("/")) {
        await stat(join(full, "index.html"));
        return join(full, "index.html");
      }
    } catch {
      // not a file
    }
    return null;
  };
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://site.local");
    const api = /^\/api\/([\w-]+)$/.exec(url.pathname);
    if (api) {
      const handler = apis?.[api[1]];
      if (!handler) return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"no such function"}');
      return handler(req, res);
    }
    let path = await file(url.pathname);
    if (!path) {
      for (const [pattern, destination] of rewrites) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        path = await file(destination.replace(/:(\w+)/g, (_, name) => match.groups[name]));
        break;
      }
    }
    if (!path) return void res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(await readFile(path));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createSiteServer({ apis: await realApis() });
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, "127.0.0.1", () => process.stdout.write(`Unified site on http://127.0.0.1:${port}\n`));
}
