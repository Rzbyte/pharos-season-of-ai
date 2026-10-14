// Vercel function behind the Pharos Inspector: GET /api/inspect?q=<address or transaction hash>.
//
// A separate function from /api/state on purpose, so an inspection can never slow down, break or
// change the Task 01 proof. Input is validated here before any MCP session is opened. Like
// /api/state, the endpoint is the fixed hosted constant: PHAROS_MCP_URL or PHAROS_MCP_TOKEN set on
// the deployment can neither redirect it nor add a token.
import { HOSTED_ENDPOINT } from "../dist/src/constants.js";
import { inspect } from "../inspector/inspect.js";

export function createHandler(endpoint = HOSTED_ENDPOINT, options = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" }).end('{"ok":false,"error":{"kind":"METHOD","message":"Use GET."}}\n');
      return;
    }
    const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("q");
    const { status, body, shareable: complete } = await inspect(query, { ...options, endpoint });
    // A complete read may be shared briefly, as /api/state does. A miss, an address whose type could
    // not be determined, a result in which a read failed, or a failure is never cached.
    const shareable = status === 200 && complete === true;
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": shareable ? "public, s-maxage=15, stale-while-revalidate=45" : "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  };
}

/** The deployed handler: always the official hosted endpoint. */
export default createHandler();
