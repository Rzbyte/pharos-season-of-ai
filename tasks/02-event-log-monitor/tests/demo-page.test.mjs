// The Task 02 page without a browser: the feed bookkeeping (public/assets/feed.js) and the static files.
//   node --test tests/demo-page.test.mjs
// Every value is made up and never used as proof.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { applyWindow, createFeed, FEED_LIMIT, SEEN_LIMIT, shortHex } from "../public/assets/feed.js";
import { TASKS } from "../public/assets/tasks.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const event = (block, logIndex = 0, extra = {}) => ({
  key: `${hash(block * 100 + logIndex)}:${logIndex}`,
  type: "Transfer",
  from: "0x1234000000000000000000000000000000000AbC",
  to: "0xAbcd000000000000000000000000000000001234",
  amount: { raw: "125500000", formatted: "125.5", symbol: "USDC" },
  transactionHash: hash(block * 100 + logIndex),
  blockNumber: String(block),
  logIndex,
  summary: "125.5 USDC transferred from 0x1234…0AbC to 0xAbcd…1234",
  ...extra,
});
const window = (from, to, events = [], extra = {}) => ({ ok: true, fromBlock: String(from), toBlock: String(to), events, removedKeys: [], ...extra });

describe("applyWindow", () => {
  test("the first answer seeds the feed as 'at start' and sets the cursor", () => {
    const feed = createFeed();
    const change = applyWindow(feed, window(801, 1000, [event(900), event(950, 2)]), { first: true });
    assert.equal(change.added.length, 2);
    assert.ok(change.added.every((item) => item.fresh === false));
    assert.equal(feed.lastChecked, "1000");
    assert.equal(feed.newSinceStart, 0);
    assert.deepEqual(feed.items.map((item) => item.blockNumber), ["950", "900"], "newest first");
  });

  test("overlapping windows show each event once; the overlap only counts as duplicates", () => {
    const feed = createFeed();
    applyWindow(feed, window(801, 1000, [event(900), event(950)]), { first: true });
    const change = applyWindow(feed, window(806, 1005, [event(900), event(950), event(1003, 1)]));
    assert.deepEqual(change.added.map((item) => item.blockNumber), ["1003"]);
    assert.equal(change.added[0].fresh, true);
    assert.equal(feed.duplicates, 2);
    assert.equal(feed.newSinceStart, 1);
    assert.equal(feed.lastChecked, "1005");
    const again = applyWindow(feed, window(811, 1010, [event(950), event(1003, 1)]));
    assert.equal(again.added.length, 0);
    assert.equal(feed.items.length, 3);
    assert.equal(new Set(feed.items.map((item) => item.key)).size, 3);
  });

  test("same transaction, two log indexes: two events", () => {
    const feed = createFeed();
    const tx = hash(77);
    const change = applyWindow(feed, window(1, 200, [event(100, 0, { key: `${tx}:0`, transactionHash: tx }), event(100, 1, { key: `${tx}:1`, transactionHash: tx, type: "Burn" })]), { first: true });
    assert.deepEqual(change.added.map((item) => item.type), ["Transfer", "Burn"]);
  });

  test("an answer that ends before the cursor (an older cached copy) changes nothing", () => {
    const feed = createFeed();
    applyWindow(feed, window(801, 1000), { first: true });
    const change = applyWindow(feed, window(800, 999, [event(990)]));
    assert.equal(change.stale, true);
    assert.equal(feed.lastChecked, "1000");
    assert.equal(feed.items.length, 0);
  });

  test("an answer ending at the cursor (no new block yet) still applies its removed logs", () => {
    const feed = createFeed();
    const shown = event(990);
    applyWindow(feed, window(801, 1000, [shown]), { first: true });
    const change = applyWindow(feed, window(801, 1000, [], { removedKeys: [shown.key] }));
    assert.equal(change.stale, false);
    assert.equal(change.added.length, 0);
    assert.equal(feed.items[0].retracted, true);
  });

  test("blocks skipped while paused are reported as a gap", () => {
    const feed = createFeed();
    applyWindow(feed, window(801, 1000), { first: true });
    assert.deepEqual(applyWindow(feed, window(1501, 1700)).gap, { from: "1001", to: "1500" });
    assert.equal(applyWindow(feed, window(1506, 1705)).gap, null);
  });

  test("a removed log is never added, and one already shown is marked removed", () => {
    const feed = createFeed();
    const shown = event(900, 3);
    applyWindow(feed, window(801, 1000, [shown]), { first: true });
    const change = applyWindow(feed, window(806, 1005, [], { removedKeys: [shown.key, `${hash(5)}:0`] }));
    assert.equal(change.added.length, 0);
    assert.deepEqual(change.retracted.map((item) => item.key), [shown.key]);
    assert.equal(feed.items[0].retracted, true);
    assert.equal(feed.retracted, 1);
  });

  test("malformed events are dropped, never guessed at", () => {
    const feed = createFeed();
    const bad = [
      event(10, 0, { type: "Approval" }),
      event(11, 0, { from: "0x1234" }),
      event(12, 0, { key: "nope" }),
      event(13, 0, { key: `${hash(1)}:0` }),
      event(14, 0, { blockNumber: "0x0e" }),
      event(15, 0, { amount: null }),
      null,
    ];
    const change = applyWindow(feed, window(1, 200, [...bad, event(16)]), { first: true });
    assert.deepEqual(change.added.map((item) => item.blockNumber), ["16"]);
  });

  test("an answer without a valid block range throws and leaves the cursor", () => {
    const feed = createFeed();
    applyWindow(feed, window(801, 1000), { first: true });
    assert.throws(() => applyWindow(feed, { ok: true, fromBlock: null, toBlock: "1005", events: [] }));
    assert.throws(() => applyWindow(feed, window(1010, 1005)));
    assert.equal(feed.lastChecked, "1000");
  });

  test("the feed keeps the newest FEED_LIMIT events and remembers at most SEEN_LIMIT keys", () => {
    const feed = createFeed();
    applyWindow(feed, window(1, 1000, Array.from({ length: FEED_LIMIT + 5 }, (_, i) => event(i + 1))), { first: true });
    assert.equal(feed.items.length, FEED_LIMIT);
    assert.equal(feed.dropped, 5, "dropped events are counted, not lost silently");
    assert.equal(feed.shown, FEED_LIMIT + 5, "and the total still counts them");
    assert.equal(feed.items[0].blockNumber, String(FEED_LIMIT + 5));
    const many = createFeed();
    applyWindow(many, window(1, 10_000, Array.from({ length: SEEN_LIMIT + 3 }, (_, i) => event(i + 1))), { first: true });
    assert.equal(many.seen.size, SEEN_LIMIT);
  });

  test("shortHex", () => {
    assert.equal(shortHex("0xC879C018dB60520F4355C26eD1a6D572cdAC1815"), "0xC879…1815");
    assert.equal(shortHex("0x12"), "0x12");
  });
});

describe("static files", () => {
  test("the page loads only its own assets, all present", async () => {
    const html = await read("public/index.html");
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(refs.sort(), ["/assets/fonts/Geist-SemiBold.woff2", "/assets/lab.css", "/assets/monitor.css", "/assets/monitor.js", "/assets/theme.js"]);
    for (const ref of refs) await read(`public${ref}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
    assert.doesNotMatch(html, /<script[^>]+src="https?:/, "no third-party script");
    assert.match(html, /data-api="\/api\/events"/);
    assert.match(html, /<meta name="explorer" content="https:\/\/pharos\.socialscan\.io">/);
    assert.match(html, /<span id="task-count"><b>02<\/b> \/ 28<\/span>/);
  });

  test("every element the script looks up exists", async () => {
    const [html, script] = await Promise.all([read("public/index.html"), read("public/assets/monitor.js")]);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const [, id] of script.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(id), `#${id} missing`);
  });

  test("the hierarchy: what is watched, whether it runs, the latest events, the initial history, then proof", async () => {
    const html = await read("public/index.html");
    const order = [
      ">Event / Log Monitor</h1>",
      ">Circle USDC</p>",
      "<code>Transfer(address,address,uint256)</code>",
      'id="status"',
      ">Last checked block<",
      'id="toggle"',
      ">This session</h2>",
      'id="feed"',
      ">Initial history</h2>",
      ">Proof &amp; technical details</h2>",
    ];
    const at = order.map((needle) => html.indexOf(needle));
    assert.ok(at.every((index) => index !== -1), JSON.stringify(at));
    assert.deepEqual([...at].sort((a, b) => a - b), at, "in this order");
    assert.match(html, />View transaction</);
    // One control, not a pair of buttons; initial history starts collapsed and unrendered.
    assert.doesNotMatch(html, /id="(start|stop)"/);
    assert.match(html, /<button class="btn" id="initial-toggle" type="button" aria-expanded="false" aria-controls="initial-feed">Show initial events<\/button>/);
    assert.match(html, /<ol class="events" id="initial-feed" aria-labelledby="initial-h" hidden><\/ol>/);
    assert.match(html, /<ol class="events" id="feed" aria-labelledby="session-h"><\/ol>/);
  });

  test("no copy that only restates the interface", async () => {
    const html = await read("public/index.html");
    assert.doesNotMatch(html, /class="task-about"|class="jump"/, "the about paragraph and jump links are gone");
    assert.equal((html.match(/every <span id="interval">/g) ?? []).length, 0, "the interval is stated once, in the status");
  });

  test("scripts write text, never HTML", async () => {
    for (const file of ["monitor.js", "feed.js", "lab.js"]) {
      const text = await read(`public/assets/${file}`);
      assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
    }
  });

  test("no scope creep on the page: no AI, notifications, sockets or storage of events", async () => {
    const files = ["public/index.html", "public/assets/monitor.js", "public/assets/feed.js", "api/events.js"];
    for (const file of files) {
      const text = await read(file);
      assert.doesNotMatch(text, /WebSocket|Notification\(|deepseek|openai|explain|indexedDB|localStorage/i, file);
    }
  });

  test("lab.css carries the shared design system without Task 01's inspector or explain rules", async () => {
    const css = await read("public/assets/lab.css");
    assert.doesNotMatch(css, /inspect|explain/);
    assert.match(css, /--brand: #0113B7;/);
  });

  test("the task manifest links only to this deployment's own page", () => {
    const own = TASKS.find((task) => task.n === "02");
    assert.equal(own.status, "available");
    assert.equal(own.path, "/");
    const first = TASKS.find((task) => task.n === "01");
    assert.equal(first.status, "available");
    assert.equal(first.path, null);
    assert.equal(TASKS.filter((task) => task.path !== null).length, 1);
  });

  test("vercel.json deploys public/ and the one function", async () => {
    const config = JSON.parse(await read("vercel.json"));
    assert.equal(config.outputDirectory, "public");
    assert.deepEqual(Object.keys(config.functions), ["api/events.js"]);
    assert.deepEqual((await readdir(new URL("../api/", import.meta.url))).sort(), ["events.js"]);
  });
});
