// Task 02 page: the monitor's bookkeeping, with no DOM, so tests can import it in Node.
//
// Every /api/events answer is the same shared window: the Transfer events of one explicit block
// range ending at the head. The page keeps what a monitor needs between answers: the last block it
// has checked (its cursor) and the keys of the events it has shown (transactionHash + logIndex).
// An event is shown once, the first time it appears; the overlap between consecutive windows only
// counts as duplicates. The cursor moves only on a good answer that reaches past it.

/** Events kept on screen, newest first. */
export const FEED_LIMIT = 50;
/** Dedup memory: keys remembered, oldest forgotten first. */
export const SEEN_LIMIT = 5_000;

const KINDS = new Set(["Transfer", "Mint", "Burn"]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const DIGITS = /^(?:0|[1-9]\d*)$/;

export function createFeed() {
  return { lastChecked: null, startBlock: null, items: [], seen: new Map(), shown: 0, newSinceStart: 0, duplicates: 0, retracted: 0 };
}

/**
 * Apply one good answer. `first` marks the answer that starts a monitoring session: its events are
 * shown as "at start", later ones as new. Returns what changed:
 *   { added, retracted, gap, stale }
 * gap: { from, to } when blocks between the cursor and this window were never checked (the page was
 * paused for longer than one window); stale: an answer that ends before the cursor (an older
 * cached copy), which changes nothing. An answer ending at the cursor (no new block yet) still
 * applies its removed logs.
 */
export function applyWindow(feed, data, { first = false } = {}) {
  if (!data || !DIGITS.test(String(data.fromBlock)) || !DIGITS.test(String(data.toBlock))) throw new Error("the answer has no block range");
  const from = BigInt(data.fromBlock);
  const to = BigInt(data.toBlock);
  if (to < from) throw new Error("the answer's block range is reversed");
  const result = { added: [], retracted: [], gap: null, stale: false };
  if (feed.lastChecked !== null && to < BigInt(feed.lastChecked)) {
    result.stale = true;
    return result;
  }
  if (feed.lastChecked !== null && from > BigInt(feed.lastChecked) + 1n) result.gap = { from: String(BigInt(feed.lastChecked) + 1n), to: String(from - 1n) };
  if (feed.startBlock === null) feed.startBlock = String(from);

  const events = (Array.isArray(data.events) ? data.events : []).filter(isEvent).sort(byPosition);
  for (const event of events) {
    if (feed.seen.has(event.key)) {
      feed.duplicates += 1;
      continue;
    }
    remember(feed, event.key);
    const item = { ...event, fresh: !first, retracted: false };
    result.added.push(item);
  }
  // Removed-log policy, as in the CLI: a removed log is never shown as an event; one already shown is
  // marked removed.
  for (const key of Array.isArray(data.removedKeys) ? data.removedKeys : []) {
    const item = feed.items.find((entry) => entry.key === key && !entry.retracted) ?? result.added.find((entry) => entry.key === key);
    if (item && !item.retracted) {
      item.retracted = true;
      feed.retracted += 1;
      result.retracted.push(item);
    }
  }

  feed.items = [...[...result.added].reverse(), ...feed.items].slice(0, FEED_LIMIT);
  feed.shown += result.added.length;
  if (!first) feed.newSinceStart += result.added.length;
  feed.lastChecked = String(to);
  return result;
}

/** "0x1234…abcd". */
export function shortHex(value) {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}

function remember(feed, key) {
  feed.seen.set(key, true);
  while (feed.seen.size > SEEN_LIMIT) feed.seen.delete(feed.seen.keys().next().value);
}

/** Only well-formed events are shown; the API's are, and anything else is dropped rather than guessed at. */
function isEvent(event) {
  return (
    event !== null &&
    typeof event === "object" &&
    typeof event.key === "string" &&
    /^0x[0-9a-f]{64}:(?:0|[1-9]\d*)$/.test(event.key) &&
    event.key === `${event.transactionHash}:${event.logIndex}` &&
    KINDS.has(event.type) &&
    ADDRESS.test(String(event.from)) &&
    ADDRESS.test(String(event.to)) &&
    HASH.test(String(event.transactionHash)) &&
    DIGITS.test(String(event.blockNumber)) &&
    typeof event.amount?.formatted === "string" &&
    typeof event.amount?.symbol === "string"
  );
}

function byPosition(a, b) {
  const blocks = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (blocks !== 0n) return blocks < 0n ? -1 : 1;
  return a.logIndex - b.logIndex;
}
