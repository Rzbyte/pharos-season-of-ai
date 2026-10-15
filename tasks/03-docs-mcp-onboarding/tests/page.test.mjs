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

/** Made-up content in the shape of real evidence, for the renderer only. Never shipped. */
const FIXTURE = {
  title: "Docs MCP Onboarding",
  goal: "Fixture goal",
  environment: "Fixture environment",
  journey: [{ stage: "Started", detail: "Fixture start" }, { stage: "Blocked", detail: null }, { stage: "Recovered", detail: null }, { stage: "Successful", detail: null }],
  outcome: ["Fixture outcome <b>one</b>"],
  gaps: [
    { title: "Fixture gap", happened: "What happened, <script>alert(1)</script>", fix: "The fix", evidence: { thumb: "evidence/gap-1-thumb.webp", full: "evidence/gap-1.png", alt: "A fixture screenshot" } },
    { title: "Second gap", happened: "Happened", fix: "Fix", evidence: null },
  ],
  links: { proof: "https://example.com/proof", video: "https://example.com/video" },
  sources: [{ title: "A source", url: "https://example.com/source" }],
};

describe("the content", () => {
  test("evidence.json is valid and holds only what the evidence states", () => {
    assert.deepEqual(validate(evidence), []);
    assert.deepEqual(evidence.journey.map((step) => step.stage), ["Started", "Blocked", "Recovered", "Successful"]);
    assert.deepEqual(evidence.outcome, ["Connected to Atlantic RPC", "eth_chainId succeeded", "eth_call succeeded"]);
  });

  test("bad content is refused, with the reason", () => {
    assert.match(validate({ ...FIXTURE, title: "" }).join(), /title is required/);
    assert.match(validate({ ...FIXTURE, gaps: Array.from({ length: MAX_GAPS + 1 }, () => FIXTURE.gaps[1]) }).join(), /at most 3/);
    assert.match(validate({ ...FIXTURE, links: { proof: "http://example.com", video: null } }).join(), /links.proof is an https URL/);
    assert.match(validate({ ...FIXTURE, links: { proof: "javascript:alert(1)", video: null } }).join(), /links.proof/);
    assert.match(validate({ ...FIXTURE, gaps: [{ ...FIXTURE.gaps[0], evidence: { thumb: "../x.png", full: "evidence/x.png", alt: "x" } }] }).join(), /under evidence\//);
    assert.match(validate({ ...FIXTURE, gaps: [{ ...FIXTURE.gaps[0], evidence: { ...FIXTURE.gaps[0].evidence, alt: "" } }] }).join(), /alt describes/);
    assert.match(validate({ ...FIXTURE, sources: [{ title: "x", url: "ftp://x" }] }).join(), /sources\[0\]/);
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

  test("the outcome is first and plain; nothing unknown is filled in", () => {
    const order = [">Docs MCP Onboarding</h1>", 'class="panel outcome"', ">Connected to Atlantic RPC<", ">Journey</h2>", ">Proof &amp; sources</h2>"].map((needle) => html.indexOf(needle));
    assert.ok(order.every((index) => index > 0));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    // No gaps, proof or video link yet: those sections and actions are left out, not faked.
    assert.doesNotMatch(html, />Gaps<|View proof|Watch video|class="context"/);
    assert.doesNotMatch(html, /\b(?:TODO|TBD|lorem|placeholder|coming soon|planned)\b/i);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
  });

  test("gaps render as title, what happened, the fix and a lazy thumbnail; text is escaped", () => {
    const main = renderMain(FIXTURE);
    assert.equal(main.match(/<li class="gap">/g).length, 2);
    assert.match(main, /<h3 class="gap-title"><span class="gap-n">1<\/span>Fixture gap<\/h3><p class="gap-happened">What happened, &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p><p class="gap-fix"><span class="gap-label">Suggested fix<\/span>The fix<\/p>/);
    assert.match(main, /<a class="shot" href="evidence\/gap-1\.png" data-evidence data-alt="A fixture screenshot"><img src="evidence\/gap-1-thumb\.webp" alt="" width="160" height="100" loading="lazy" decoding="async">/);
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
