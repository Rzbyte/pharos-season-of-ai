// Vercel function for every task the agent powers: GET /api/agent?task=NN&... (one function for all of
// them, within the platform's function limits). It runs the agent's compiled code (dist/src, built during
// `npm ci`) against the hosted Pharos Chain MCP; nothing is read from the environment and nothing is signed.
import { handle } from "../dist/src/web.js";

export function createHandler(options = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" }).end('{"error":{"kind":"usage","message":"Use GET /api/agent?task=NN."}}\n');
      return;
    }
    const { status, body, maxAge } = await handle(new URL(req.url ?? "/", "http://localhost"), options);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      // A result is about the latest block: shared at the edge for a few seconds at most. Errors never are.
      "cache-control": status === 200 && maxAge > 0 ? `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}` : "no-store",
    });
    res.end(`${JSON.stringify(body)}\n`);
  };
}

/** The deployed handler: always the hosted Pharos Chain MCP. */
export default createHandler();
