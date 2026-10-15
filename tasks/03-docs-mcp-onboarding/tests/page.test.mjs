// Task 03: the evidence page is built from evidence.json and states nothing else.
//   node --test tests/page.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { MAX_GAPS, renderMain, renderPage, validate } from "../build.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = (name) => readFileSync(new URL(`../../../shared/ui/${name}`, import.meta.url), "utf8");
const evidence = JSON.parse(read("evidence.json"));
const html = read("public/index.html");

const PROOF = "https://drive.google.com/drive/folders/1YE5OXTxgh1xyxhrWz2drJuabZeMd5K7C";
const VIDEO = "https://drive.google.com/file/d/1rT1rvJM3o2aLWhqF04cRsluy9Qu2epVt/view?usp=drivesdk";

/** Made-up content in the shape of real evidence, for the renderer only. Never shipped. */
const FIXTURE = {
  title: "Docs MCP Onboarding",
  goal: "Fixture goal",
  environment: "Fixture environment",
  journey: [{ stage: "Started", detail: "Fixture start" }, { stage: "Blocked", detail: null }, { stage: "Recovered", detail: null }, { stage: "Successful", detail: null }],
  outcome: ["Fixture outcome <b>one</b>"],
  gaps: [
    { title: "Fixture gap", happened: "What happened, <script>alert(1)</script>", fix: "The fix", queries: ["Fixture query"], evidence: { thumb: "evidence/gap-1-thumb.webp", full: "evidence/gap-1.png", alt: "A fixture screenshot" } },
    { title: "Second gap", happened: "Happened", fix: "Fix", queries: ["Fixture query"], evidence: null },
  ],
  links: { proof: "https://example.com/proof", video: "https://example.com/video" },
  sources: [{ title: "A source", url: "https://example.com/source" }],
};

describe("the content", () => {
  test("evidence.json is valid and holds the submitted journey, outcome, gaps and links", () => {
    assert.deepEqual(validate(evidence), []);
    assert.deepEqual(evidence.journey.map((step) => step.stage), ["Started", "Blocked", "Recovered", "Successful"]);
    assert.ok(evidence.journey.every((step) => step.detail && step.log?.length), "every stage has one line and its log");
    assert.deepEqual(evidence.outcome.map((line) => (typeof line === "string" ? line : line.text)), ["Atlantic RPC connected", "eth_chainId verified", "eth_call succeeded"]);
    assert.equal(evidence.environment, "Android · Termux · ARM64");
    assert.deepEqual(evidence.links, { proof: PROOF, video: VIDEO });
    assert.equal(evidence.gaps.length, 3);
    assert.ok(evidence.gaps.every((gap) => gap.queries.length >= 1 && gap.evidenceUrl === PROOF && !gap.evidence), "exact queries; evidence is the proof folder, no local screenshots");
    // The six real queries, each asked once in the log.
    const asked = evidence.journey.flatMap((step) => step.log.filter((entry) => entry.kind === "query").map((entry) => entry.text));
    assert.equal(asked.length, 6);
    assert.equal(new Set(asked).size, 6);
    for (const gap of evidence.gaps) for (const query of gap.queries) assert.ok(asked.includes(query), "a gap's query is one of the logged queries");
    assert.match(asked[0], /^I'm new to Pharos and I want to build something simple\./);
    // Gap 1 carries the exact query that exposed the wrong expected chain ID, and nothing else.
    assert.deepEqual(evidence.gaps[0].queries, ['That worked.\n\nThe RPC returned:\n\n{"jsonrpc":"2.0","id":1,"result":"0xa8231"}\n\nI noticed this is different from the expected value you gave me, which was 0xa82f1.\n\nWhat should I do next?']);
    assert.equal(evidence.gaps[0].queryNote, undefined);
    assert.match(JSON.stringify(evidence), /0xa8231/);
    assert.match(JSON.stringify(evidence), /688689/);
  });

  test("bad content is refused, with the reason", () => {
    assert.match(validate({ ...FIXTURE, title: "" }).join(), /title is required/);
    assert.match(validate({ ...FIXTURE, gaps: Array.from({ length: MAX_GAPS + 1 }, () => FIXTURE.gaps[1]) }).join(), /at most 3/);
    assert.match(validate({ ...FIXTURE, links: { proof: "http://example.com", video: null } }).join(), /links.proof is an https URL/);
    assert.match(validate({ ...FIXTURE, links: { proof: "javascript:alert(1)", video: null } }).join(), /links.proof/);
    assert.match(validate({ ...FIXTURE, gaps: [{ ...FIXTURE.gaps[0], evidence: { thumb: "../x.png", full: "evidence/x.png", alt: "x" } }] }).join(), /under evidence\//);
    assert.match(validate({ ...FIXTURE, gaps: [{ ...FIXTURE.gaps[0], evidence: { ...FIXTURE.gaps[0].evidence, alt: "" } }] }).join(), /alt describes/);
    assert.match(validate({ ...FIXTURE, sources: [{ title: "x", url: "ftp://x" }] }).join(), /sources\[0\]/);
    assert.match(validate({ ...FIXTURE, gaps: [{ ...FIXTURE.gaps[1], queries: [] }] }).join(), /gaps\[0\]\.queries lists the exact queries/);
    assert.match(validate({ ...FIXTURE, gaps: [{ ...FIXTURE.gaps[1], evidenceUrl: "http://x" }] }).join(), /evidenceUrl/);
    assert.match(validate({ ...FIXTURE, journey: [{ stage: "Started", detail: null, log: [{ kind: "guess", text: "x" }] }] }).join(), /log is a list/);
    // A list field that is not a list is reported, never a crash.
    for (const key of ["journey", "gaps", "sources"]) {
      for (const bad of [{}, "", 3]) assert.ok(validate({ ...FIXTURE, [key]: bad }).length > 0, `${key}: ${JSON.stringify(bad)}`);
    }
  });
});

describe("the page", () => {
  test("public/index.html is exactly what evidence.json renders, with the shared shell", () => {
    execFileSync(process.execPath, [new URL("../build.mjs", import.meta.url).pathname, "--check"]);
    assert.ok(html.includes(`<!-- shell:header 03 -->\n${shared("header.html").replaceAll("{{n}}", "03").trim()}\n<!-- /shell:header -->`));
    assert.ok(html.includes(`<!-- shell:footer 03 -->\n${shared("footer.html").trim()}\n<!-- /shell:footer -->`));
    for (const name of ["lab.css", "lab.js", "theme.js", "tasks.js"]) assert.equal(read(`public/assets/${name}`), shared(name), name);
  });

  test("the outcome first, then the journey and its log, then the three gaps, then proof", () => {
    const order = [">Docs MCP Onboarding</h1>", 'class="panel outcome"', ">Atlantic RPC connected<", ">View proof<", ">Watch video<", ">Goal<", ">Android · Termux · ARM64<", ">Journey</h2>", ">Step-by-step log<", ">Documentation gaps</h2>", ">Proof &amp; sources</h2>"].map((needle) => html.indexOf(needle));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    // One summary card: the outcome and its proof, then the goal and the environment it was reached in.
    const card = html.slice(html.indexOf('<section class="panel outcome"'), html.indexOf("</section>", html.indexOf('<section class="panel outcome"')));
    for (const needle of [">View proof<", '<dl class="context">', ">Goal<", ">Environment<", ">No laptop was available, so the whole run was done on a phone.<"]) assert.ok(card.includes(needle), needle);
    assert.equal(html.match(/<li class="gap">/g).length, 3);
    assert.equal(html.match(/<li class="step" data-stage="/g).length, 4);
    // The log and every exact query are collapsed, so the page is not a wall of text.
    assert.match(html, /<details class="disclosure log" id="log">/);
    assert.equal(html.match(/<details class="gap-query">/g).length, 3);
    assert.doesNotMatch(html, /<details[^>]*\sopen/);
    assert.doesNotMatch(html, /\b(?:TODO|TBD|lorem|placeholder|coming soon|planned)\b/i);
    assert.doesNotMatch(html, /<img\b|<dialog\b/, "no screenshots are in the repository, so none are shown");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
  });

  test("each gap's default view is short: one line of what happened, one of the fix; the rest is in its disclosure", () => {
    for (const gap of evidence.gaps) {
      assert.ok(gap.title.length <= 40, gap.title);
      for (const key of ["happened", "fix"]) assert.ok(gap[key].length <= 120 && gap[key].split(/(?<=\.) /).length <= 2, `${gap.title}: ${key} is ${gap[key].length} characters`);
      assert.ok(gap.details, "the longer explanation is kept, behind the disclosure");
    }
    const gaps = [...html.matchAll(/<li class="gap">([\s\S]*?)<\/li>/g)].map(([, gap]) => gap);
    for (const gap of gaps) {
      const [visible, hidden] = gap.split('<details class="gap-query">');
      assert.doesNotMatch(visible, /gap-details|class="query"/, "details and queries are not in the default view");
      assert.match(hidden, /^<summary>Exact quer(?:y|ies \(\d\)) and details/);
      assert.match(hidden, /<p class="gap-details">/);
    }
    assert.doesNotMatch(html, /led to the chain ID check/);
  });

  test("proof, video and each gap's evidence point at the real Drive links, in a new tab", () => {
    const anchors = (url) => [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)].filter(([, href]) => href === url.replaceAll("&", "&amp;")).map(([tag]) => tag);
    assert.equal(anchors(PROOF).length, 1 + 3 + 1, "View proof, three gap evidence links, and the proof source row");
    assert.equal(anchors(VIDEO).length, 2, "Watch video and the video source row");
    for (const tag of [...anchors(PROOF), ...anchors(VIDEO)]) assert.match(tag, /target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /<a class="btn btn-primary" href="https:\/\/drive\.google\.com\/drive\/folders\/1YE5OXTxgh1xyxhrWz2drJuabZeMd5K7C"[^>]*><span>View proof<\/span>/);
    assert.match(html, /<a class="btn" href="https:\/\/drive\.google\.com\/file\/d\/1rT1rvJM3o2aLWhqF04cRsluy9Qu2epVt\/view\?usp=drivesdk"[^>]*>.*<span>Watch video<\/span>/);
  });

  test("gaps render as title, what happened, the fix and a lazy thumbnail; text is escaped", () => {
    const main = renderMain(FIXTURE);
    assert.equal(main.match(/<li class="gap">/g).length, 2);
    assert.match(main, /<h3 class="gap-title"><span class="gap-n">1<\/span>Fixture gap<\/h3><p class="gap-happened">What happened, &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p><p class="gap-fix"><span class="gap-label">Suggested fix<\/span>The fix<\/p>/);
    assert.match(main, /<a class="shot" href="\/evidence\/gap-1\.png" data-evidence data-alt="A fixture screenshot"><img src="\/evidence\/gap-1-thumb\.webp" alt="" width="160" height="100" loading="lazy" decoding="async">/);
    assert.equal(main.match(/<img src=/g).length, 1, "a thumbnail only; the full image loads when opened");
    assert.match(main, /<img id="viewer-img" alt="">/, "the viewer starts with no image");
    assert.match(main, /<dialog class="viewer" id="viewer"/);
    assert.match(main, /Fixture outcome &lt;b&gt;one&lt;\/b&gt;/);
    assert.match(main, /<dl class="context">/);
    for (const href of ["https://example.com/proof", "https://example.com/video"]) assert.match(main, new RegExp(`<a class="btn[^"]*" href="${href}" target="_blank" rel="noopener noreferrer">`));
    assert.doesNotMatch(renderMain(evidence), /<dialog/, "no viewer without evidence images");
  });

  test("every link that leaves the site opens a new tab with no opener and says so", () => {
    for (const page of [html, renderPage(FIXTURE)]) {
      for (const [anchor] of page.matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>[\s\S]*?<\/a>/g)) {
        assert.match(anchor, /target="_blank" rel="noopener noreferrer"/, anchor);
        assert.ok(/opens in a new tab/.test(anchor), anchor);
      }
    }
  });

  test("the page script only wires the shell and the viewer: no requests", () => {
    const script = read("public/assets/evidence.js");
    assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|innerHTML|localStorage/);
    assert.match(script, /renderTaskNav\(TASKS, "03", LAB\);/);
  });

  test("vercel.json deploys the built public/ folder and nothing else", () => {
    const config = JSON.parse(read("vercel.json"));
    assert.deepEqual([config.buildCommand, config.outputDirectory, config.functions], ["npm run build", "public", undefined]);
  });
});
