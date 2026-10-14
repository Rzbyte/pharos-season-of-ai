// In-process stand-in for the DeepSeek chat completions endpoint, for the "Explain this result"
// tests. It answers POST /chat/completions in the OpenAI-compatible shape the real API uses:
// { choices: [{ index, message: { role: "assistant", content }, finish_reason }], usage }.
// Every request is recorded (method, path, headers, parsed body), so a test can check exactly what
// would have been sent, and count calls. Nothing reaches the network.
// Test fixtures only: every value here is made up.
import { createServer } from "node:http";

export const SAMPLE_ANSWER = [
  "What this shows",
  "This is a token contract on Pharos Mainnet, read at one block.",
  "",
  "What it means",
  "The contract answered all four standard token questions. Its total supply is the number of tokens that exist.",
  "",
  "Key details",
  "- Name and symbol: USDC",
  "- Decimals: 6, so one token is 1,000,000 of its smallest units",
  "",
  "Anything to note",
  "Anyone can deploy a contract with any name or symbol, so a name or symbol proves nothing about who made it.",
].join("\n");

/**
 * behavior: { content, finishReason, status, raw, delayMs } or a function (body, n) returning one.
 *   content       the answer's text (default SAMPLE_ANSWER)
 *   finishReason  "stop" (default) or "length"
 *   status        an HTTP error status to answer with instead
 *   raw           a raw response body to send as is (for malformed answers)
 *   delayMs       wait this long before answering (for timeouts)
 */
export async function startFakeDeepSeek(initial = {}) {
  const requests = [];
  let behavior = initial;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // Recorded as null: a test can see the request was not JSON.
    }
    requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    const b = typeof behavior === "function" ? behavior(body, requests.length) : behavior;
    if (b.delayMs) await new Promise((resolve) => setTimeout(resolve, b.delayMs));
    if (res.destroyed) return;
    if (b.status) {
      res.writeHead(b.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "fake provider failure", type: "fake", code: b.status } }));
      return;
    }
    if (b.raw !== undefined) {
      res.writeHead(200, { "content-type": "application/json" }).end(b.raw);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: `fake-${requests.length}`,
        object: "chat.completion",
        created: 0,
        model: body?.model ?? null,
        choices: [{ index: 0, message: { role: "assistant", content: b.content ?? SAMPLE_ANSWER }, finish_reason: b.finishReason ?? "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/chat/completions`,
    requests,
    /** Change what the next requests get. */
    set(next) {
      behavior = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
