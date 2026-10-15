// What both transports share: the fetch signature they accept (tests pass a fake), a capped body
// reader, and plain error wording.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Read a body as UTF-8, refusing (not truncating) one larger than `max` bytes. */
export async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error(`The response is ${declared} bytes; the limit is ${max}.`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`The response is larger than ${max} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function messageOf(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return error instanceof Error ? `${error.message}${cause}` : String(error);
}

export function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
