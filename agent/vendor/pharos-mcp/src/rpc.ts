export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const RETRYABLE_CODES = new Set([-32005, -32011]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Network-level errors worth retrying: fetch throws TypeError on connection
// failures, and AbortSignal.timeout() rejects with a DOMException named
// "TimeoutError" (or "AbortError"). The original code only retried TypeError,
// so a slow upstream that tripped the timeout was surfaced to the client
// immediately instead of being retried — a key amplifier of intermittent
// "timeout" reports. We now treat timeouts as retryable too.
function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  return false;
}

export class RpcClient {
  private requestId = 0;

  constructor(
    public readonly url: string,
    private readonly timeoutMs = 12_000,
    private readonly maxRetries = 3,
  ) {}

  // Exponential backoff with jitter so retried requests don't align.
  private backoffMs(attempt: number): number {
    const base = 250 * 2 ** attempt; // 250, 500, 1000, ...
    const jitter = base * 0.25 * ((this.requestId % 7) / 7); // deterministic, no Math.random
    return Math.min(base + jitter, 4_000);
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++this.requestId,
            method,
            params,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
            await delay(this.backoffMs(attempt));
            continue;
          }
          throw new RpcError(`RPC HTTP ${response.status} ${response.statusText}`);
        }

        const payload = (await response.json()) as RpcResponse<T>;
        if (payload.error) {
          const error = new RpcError(payload.error.message, payload.error.code, payload.error.data);
          if (RETRYABLE_CODES.has(payload.error.code) && attempt < this.maxRetries) {
            lastError = error;
            await delay(this.backoffMs(attempt));
            continue;
          }
          throw error;
        }
        if (!("result" in payload)) {
          throw new RpcError("RPC response did not contain result");
        }
        return payload.result as T;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries && isRetryableNetworkError(error)) {
          await delay(this.backoffMs(attempt));
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
