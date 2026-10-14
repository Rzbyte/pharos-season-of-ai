// Vercel function behind "Explain this result": POST /api/explain.
//
// A plain-language explanation of one Pharos Inspector result, only when a visitor asks for it. It
// never reads the chain (no MCP, no RPC) and is never called by an inspection: it explains a result
// the Inspector already produced, which stays the source of truth. The provider key lives only in
// this function's environment (DEEPSEEK_API_KEY); without it, explanations are reported unavailable
// and the Inspector works as before.
//
// Before any work: POST only, from this site's own page only, JSON only, at most MAX_BODY_BYTES.
// explain/explain.js then checks the request against a fixed schema, serves a cached answer if there
// is one, rate limits new ones, and only then asks the model.
import { createExplainer } from "../explain/explain.js";
import { MAX_BODY_BYTES } from "../public/assets/explain-input.js";

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function createHandler(options = {}) {
  const explain = createExplainer(options);
  async function handler(req, res) {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...HEADERS, ...headers });
      res.end(`${JSON.stringify(body)}\n`);
    };
    const refuse = (status, kind, message, headers) => send(status, { ok: false, error: { kind, message } }, headers);
    try {
      if (req.method !== "POST") return refuse(405, "METHOD", "Use POST.", { allow: "POST" });
      if (fromAnotherSite(req)) return refuse(403, "CROSS_SITE", "Explanations can only be requested from this site's own page.");
      if (!/^application\/json\s*(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
        return refuse(415, "MEDIA_TYPE", "Send the inspection result as application/json.");
      }
      const read = await readJson(req, MAX_BODY_BYTES);
      if (read.status === 413) return refuse(413, "TOO_LARGE", "The request is larger than any inspection result.", { connection: "close" });
      if (!read.ok) return refuse(400, "INVALID_REQUEST", "The request is not valid JSON.");
      const { status, body, headers } = await explain(read.value, { client: clientOf(req) });
      return send(status, body, headers);
    } catch {
      return refuse(500, "UNEXPECTED", "Something went wrong while explaining. Try again later.");
    }
  }
  return handler;
}

/**
 * A browser says where a request comes from. One from another site (Sec-Fetch-Site, or an Origin that
 * is not this host) is refused, so no other page can spend this site's explanations. A request with
 * neither header is not from a browser page; the rate limit applies to it like any other.
 */
function fromAnotherSite(req) {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  } catch {
    return true;
  }
}

/** The client a rate limit counts against: the address Vercel puts first in x-forwarded-for. */
function clientOf(req) {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || String(req.headers["x-real-ip"] ?? "").trim() || req.socket?.remoteAddress || "unknown";
}

/**
 * The parsed body, never more than `limit` bytes of it: { ok: true, value }, { ok: false, status: 413 }
 * or { ok: false, status: 400 }. A declared length over the limit is refused before reading. Vercel's
 * Node.js runtime may already have read and parsed the body into req.body; plain Node has a stream.
 */
export async function readJson(req, limit) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) return { ok: false, status: 413 };

  if ("body" in req) {
    let body;
    try {
      body = req.body;
    } catch {
      return { ok: false, status: 400 };
    }
    if (body !== undefined && body !== null) {
      const text = Buffer.isBuffer(body) ? body.toString("utf8") : typeof body === "string" ? body : null;
      if (text === null) return Buffer.byteLength(JSON.stringify(body)) > limit ? { ok: false, status: 413 } : { ok: true, value: body };
      return Buffer.byteLength(text) > limit ? { ok: false, status: 413 } : parse(text);
    }
  }

  // Read with listeners, not for-await: leaving a for-await loop early destroys the request, and the
  // 413 would never reach the client. Past the limit, the rest is drained and discarded.
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const finish = (result) => {
      req.off("data", onData).off("end", onEnd).off("error", onError);
      resolve(result);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size <= limit) return void chunks.push(chunk);
      req.resume();
      finish({ ok: false, status: 413 });
    };
    const onEnd = () => finish(parse(Buffer.concat(chunks).toString("utf8")));
    const onError = () => finish({ ok: false, status: 400 });
    req.on("data", onData).on("end", onEnd).on("error", onError);
  });
}

function parse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** The deployed handler: the key is read from the environment on each request and sent only to the provider. */
export default createHandler({ apiKey: () => process.env.DEEPSEEK_API_KEY });
