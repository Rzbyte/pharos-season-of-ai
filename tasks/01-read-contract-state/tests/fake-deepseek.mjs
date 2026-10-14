// In-process stand-in for the DeepSeek chat completions endpoint, for the "Explain this result"
// tests. It answers POST /chat/completions in the OpenAI-compatible shape the real API uses:
// { choices: [{ index, message: { role: "assistant", content }, finish_reason }], usage }.
// Every request is recorded (method, path, headers, parsed body), so a test can check exactly what
// would have been sent, and count calls. Nothing reaches the network.
// Test fixtures only: every value here is made up.
import { createServer } from "node:http";

export const SAMPLE_ANSWER = [
  "This contract answered all four standard token questions at the inspected block.",
  "",
  "Its total supply is stored as a whole number in the token's smallest unit. With 6 decimals, the last six digits are the fraction, so one token is 1,000,000 of those units.",
  "",
  "The name and symbol are text the contract returns. Anyone can deploy a contract with any name or symbol, so they prove nothing about who made it.",
  "",
  "Details",
  "- The total supply is the number of tokens that existed at that block; it can differ in later blocks.",
  "- Decimals only change how the number is shown, not how many tokens exist.",
].join("\n");

/** The same, for a transaction: what a good answer to the current instructions looks like. */
export const SAMPLE_TX_ANSWER = [
  "This transaction completed successfully and was included in block 20,384,350.",
  "",
  "No native PROS was sent with it. Gas used shows how much computation the transaction consumed: 46,290 of the 120,000 its sender allowed.",
  "",
  "The recipient may be a wallet or a contract, and the exact purpose of the transaction cannot be determined from this inspection.",
  "",
  "Details",
  "- It recorded 2 log entries. Their contents are not part of this inspection.",
  "- The fee also depends on the gas price, which this inspection does not include.",
].join("\n");

/** The same, for a wallet-like address (no contract code): what a good answer looks like. */
export const SAMPLE_WALLET_ANSWER = [
  "This address has no smart-contract code at the inspected block, so it behaves like a wallet-like account rather than a smart contract. The inspection does not show who controls it.",
  "",
  "It holds 1.5 PROS, the network's own currency, at that block.",
  "",
  "It has sent 37 transactions so far. Transactions it received are not part of that count.",
  "",
  "Details",
  "- The balance and the count are from one block and can change in later ones.",
].join("\n");

/**
 * behavior: { content, finishReason, status, raw, delayMs } or a function (body, n) returning one.
 *   content       the answer's text (default: SAMPLE_TX_ANSWER for a transaction, SAMPLE_WALLET_ANSWER for a
 *                 wallet-like address, else SAMPLE_ANSWER)
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
    // By default, the sample answer for what was asked: a transaction, a wallet-like address or a contract.
    const asked = body?.messages?.[1]?.content ?? "";
    const sample = /"inspection": "A transaction/.test(asked) ? SAMPLE_TX_ANSWER : /"inspection": "An address checked for contract code/.test(asked) ? SAMPLE_WALLET_ANSWER : SAMPLE_ANSWER;
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: `fake-${requests.length}`,
        object: "chat.completion",
        created: 0,
        model: body?.model ?? null,
        choices: [{ index: 0, message: { role: "assistant", content: b.content ?? sample }, finish_reason: b.finishReason ?? "stop" }],
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
