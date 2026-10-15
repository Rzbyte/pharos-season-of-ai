# Task 04: Doc-Search CLI

`pharos-docs` asks the official **Pharos Developer Docs** a natural-language question and prints a short answer with the pages it comes from. When the docs do not answer the question, it says so instead of guessing. A browser docs search page runs the same search code.

```console
$ pharos-docs "what is the Atlantic testnet chain ID?"
```

## Requirements

- [x] **Accepts a natural-language question.** `pharos-docs "<question>"`, quoted or not. See [Usage](#usage).
- [x] **Returns a concise answer with source links.** A few sentences or rows from the docs, then numbered `docs.pharos.xyz` sources. See [Text output](#text-output).
- [x] **Says so when there is no good answer.** "No good answer found in the Pharos Developer Docs.", with the reason and nearby topics; never an invented answer. See [No-answer behavior](#no-answer-behavior).
- [x] **README with installation, usage and at least 3 example queries with output.** <!-- req-examples --> Installation and usage are below; the three examples are filled in by `npm run proof` from real runs only. See [Examples](#examples).

<!-- proof-status:start -->
**Live proof:** captured 2026-10-15T01:45:10Z against `https://docs.pharos.xyz` by `npm run proof`, and verified from the saved requests and response bodies (`npm run verify-proof`).

- **Simple factual query** ("What is the chain ID of the Atlantic testnet?"): answered, 2 HTTPS requests to docs.pharos.xyz, 10/10 checks passed. Transcript: [proof/query-a.json](proof/query-a.json).
- **Multi-step developer workflow** ("How do I set up Foundry and deploy a contract to the Atlantic testnet?"): answered, 3 HTTPS requests to docs.pharos.xyz, 10/10 checks passed. Transcript: [proof/query-b.json](proof/query-b.json).
- **Not covered by the docs** ("How do I deploy an Anchor program to Solana?"): no_answer (not_in_docs), 3 HTTPS requests to docs.pharos.xyz, 10/10 checks passed. Transcript: [proof/query-c.json](proof/query-c.json).
<!-- proof-status:end -->

## Transport: what this actually calls

**This is not an MCP client.** The Developer Docs MCP server's tool schema, a public MCP endpoint and an A2A agent card for external clients are not publicly documented, so this tool does not use one, and does not reverse-engineer one.

It uses the **dynamic query interface that the Pharos docs themselves document**, over plain HTTPS:

| Request | What for |
|---|---|
| `GET https://docs.pharos.xyz/sitemap.md` | The page list, read once and cached for 6 hours |
| `GET https://docs.pharos.xyz/<page>.md?ask=<question>&goal=<goal>` | One page, asked the question (one page by default, at most three) |
| `GET https://docs.pharos.xyz/<page>` | Only when the `.md` page is missing or empty: the HTML page |

Following the docs' own guidance, it prefers `.md` pages, reads the smallest relevant page first, falls back to the HTML page when the markdown is missing, uses `sitemap.md` to find pages, and never pulls `llms-full.txt`. Network values (chain IDs, addresses, endpoints, gas figures) are only ever shown as copied from a page fetched for that question; none is stored in the code.

Results, `--verbose` and the proof transcripts call these requests what they are: `transport: "docs-http"`, "HTTPS requests to docs.pharos.xyz".

## Installation

Node.js 20 or newer. No runtime dependencies.

```sh
git clone https://github.com/Rzbyte/pharos-season-of-ai.git
cd pharos-season-of-ai/tasks/04-doc-search-cli
npm ci            # installs TypeScript and compiles to dist/
npm link          # optional: puts `pharos-docs` on your PATH
```

Without `npm link`, run `node dist/src/cli.js "<question>"` or `npm start -- "<question>"`.

## Usage

```console
$ pharos-docs "<question>" [options]

      --json             Print the result as JSON (schema pharos-docs-result/1)
      --max-pages <n>    Ask at most n docs pages (1-3). Default: 2
      --timeout <ms>     Per-request timeout. Default: 20000
      --no-cache         Re-read the docs index instead of using the local copy
  -v, --verbose          Print every docs request on stderr
      --transcript <f>   Save every request and the result as JSON (used by the proof)
  -h, --help             Show help
      --version          Show the version
```

Exit codes: `0` answered, `1` no good answer in the docs, `2` bad usage (for example no question), `3` the docs could not be reached or read, `4` unexpected.

Output is plain text, with no colors or cursor codes, so it reads the same in a terminal, a pipe or a log. Errors go to stderr; answers and no-answers go to stdout.

### Text output

```text
Answer
  <the answer: a few sentences or rows, verbatim from the page>

Sources
01  <page title>
    https://docs.pharos.xyz/<page>

1 docs page asked · 2 HTTPS requests to docs.pharos.xyz · 1.2 s
```

### `--json` output

One object, always the same keys in the same order:

```json
{
  "schema": "pharos-docs-result/1",
  "status": "answered",
  "question": "…",
  "answer": "…",
  "sources": [{ "title": "…", "url": "https://docs.pharos.xyz/…" }],
  "reason": null,
  "suggestions": [],
  "error": null,
  "meta": {
    "tool": "pharos-docs",
    "version": "1.0.0",
    "transport": "docs-http",
    "pagesConsulted": [{ "title": "…", "url": "…", "requestUrl": "…", "kind": "page", "outcome": "used" }],
    "requests": 2,
    "elapsedMs": 1180
  }
}
```

`status` is `answered`, `no_answer` or `error`. For `no_answer`, `answer` is `null`, `sources` is empty, `reason` says why and `suggestions` lists nearby documented pages. For `error`, `error` is `{ kind, message }`.

## How it works

```text
question
  -> docs index (sitemap.md, cached)
  -> rank pages by title, path and section            (page-ranker.ts)
  -> ask 1 page, or 2-3 for a multi-part question     (providers/docs-http.ts, ?ask=)
  -> source gate: is the answer in what came back?    (source-gate.ts)
  -> one result: answer + docs.pharos.xyz sources, or no_answer with the reason
```

```text
src/
  cli.ts, run.ts         the CLI: arguments, output, exit codes, --transcript
  search.ts              the pipeline above, and the result schema
  providers/provider.ts  DocsProvider: the transport interface
  providers/docs-http.ts DocsHttpProvider: the docs' HTTPS query interface
  docs-index.ts          sitemap.md -> pages; the CLI's disk cache
  page-ranker.ts         which page(s) to ask
  source-gate.ts         what may be shown as an answer, and which URLs may be sources
  text.ts                tokenizing, markdown/HTML reading
  formatter.ts           text and JSON output
  proof.ts, run-proof.ts, verify-proof.ts, probe.ts
api/search.js            GET /api/search?q=: the docs search page's endpoint, same core
public/                  the docs search page
```

**Page ranking** (deterministic, no model). Every page in the index is scored on the question's words in its title (3), path (2) and section (1). Documented synonyms count half: "chain ID" relates to the network pages, "price feed" to the oracle pages. The topic words of how-to verbs count fully, so "deploy" points to the Foundry and Hardhat guides. Ties go to the deeper, more specific page. One page is asked by default. A second (at most three) is asked only for a multi-part question ("set up X and deploy to Y") when it covers a question word the first does not, or when it scores within 15% of the first.

### Source gating

An answer is shown only when the source gate can trace it to text the docs returned for this question:

- **A page's own content** (markdown, or HTML reduced to text): the answer is its best-matching passages (paragraphs, list items, table rows, code), **verbatim**. The best passage must cover at least half the question's words, counting its section heading and the page title.
- **A short answer the docs compose for `?ask=`**, or a JSON body: shown as given, only if it covers the same share of the question and does not say the docs lack the information ("I couldn't find…", "is not documented…"). Only the answer segment counts: the leading `#` heading that restates the question is metadata, and the answer stops at the first generated section (`Suggested Follow-up Questions`, `Related Questions`, `Sources`, `See also` and similar). Text and links after that point are never part of the answer.
- **Value questions** (chain ID, contract address, endpoint, gas figure): the answer must contain a value of that kind copied from the fetched page; otherwise the result is `value_not_found`. No such value exists anywhere in this code to fall back on.
- **Several pages, one answer.** When two or three pages answer, the best answer is shown whole and each later one adds only the statements (sentences, list items, rows) it does not repeat. A statement counts as already said when every number, hex value and URL in it was already shown and at least 80% of its words (stemmed, without stopwords) appear in one earlier statement, or in two consecutive ones. A different value is never folded in. Kept statements are verbatim and in order. If only one page has anything to show, its answer stands alone; otherwise each part is labelled with its page title. Plain text comparison, no model, the same output every run.
- **Sources** are only `https://docs.pharos.xyz` pages that were asked in this run and whose answer was used, deduplicated by canonical URL, in answer order. A page whose answer repeated another's still stated it, so it stays a source. A page the answer only links to, a "see also" link, or a generated follow-up question was never read, so it is not a source. A simple one-page question has one source. The proof checks every source was asked in that run.

There is no language model in this tool.

### No-answer behavior

```text
No good answer found in the Pharos Developer Docs.
  <the reason>

Nearby documented topics
01  <page title>
    https://docs.pharos.xyz/<page>

  Try rephrasing the question, or open one of the pages above.
```

| `reason` | When |
|---|---|
| `no_matching_page` | No page in the index relates to the question (no page is asked) |
| `not_in_docs` | The docs' answer says the docs do not cover it |
| `weak_match` | The page does not answer the question directly |
| `value_not_found` | The page does not state the value asked for |
| `page_unavailable` | The matching page could not be read |

A docs site that cannot be reached, a timeout or a malformed response is an **error** (exit 3), not a no-answer: the tool cannot say the docs lack something it could not read.

## Examples

Three real runs against `https://docs.pharos.xyz`, captured by `npm run proof` and verified from their saved requests and response bodies. Nothing below is written by hand.

<!-- example-a:start -->
**Simple factual query**

```console
$ pharos-docs "What is the chain ID of the Atlantic testnet?"
Answer
  The Atlantic testnet chain ID is 688689. See Atlantic Testnet.

Sources
01  Atlantic Testnet
    https://docs.pharos.xyz/getting-started/network/atlantic-testnet

1 docs page asked · 2 HTTPS requests to docs.pharos.xyz · 1.4 s
```
<!-- example-a:end -->

<!-- example-b:start -->
**Multi-step developer workflow**

```console
$ pharos-docs "How do I set up Foundry and deploy a contract to the Atlantic testnet?"
Answer
  Install Foundry, then use the Pharos token example:

  git clone https://github.com/PharosNetwork/examples
  cd examples/token/foundry/contract
  forge install OpenZeppelin/openzeppelin-contracts --no-git
  forge build
  forge test

  The example contract is src/Token.sol; its deployment script is script/DeployToken.s.sol. Set a testnet-funded deployer key, then broadcast the script to Atlantic:

  export PRIVATE_KEY=
  forge script script/DeployToken.s.sol \
  --rpc-url https://atlantic.dplabs-internal.com \
  --broadcast

  Atlantic’s chain ID is 688689. The explorer is atlantic.pharosscan.xyz. Make sure the deployer has enough testnet tokens for gas.…

Sources
01  Atlantic Testnet
    https://docs.pharos.xyz/getting-started/network/atlantic-testnet
02  Write Your First Uniswap Contract
    https://docs.pharos.xyz/developer-guide/foundry/write-your-first-uniswap-contract

2 docs pages asked · 3 HTTPS requests to docs.pharos.xyz · 0.6 s
```
<!-- example-b:end -->

<!-- example-c:start -->
**Not covered by the docs**

```console
$ pharos-docs "How do I deploy an Anchor program to Solana?"
No good answer found in the Pharos Developer Docs.
  The matching docs page says it does not cover this.

Nearby documented topics
01  Foundry
    https://docs.pharos.xyz/developer-guide/foundry
02  Hardhat
    https://docs.pharos.xyz/developer-guide/hardhat
03  Validator Node Deployment
    https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment

  Try rephrasing the question, or open one of the pages above.

2 docs pages asked · 3 HTTPS requests to docs.pharos.xyz · 0.6 s
```
<!-- example-c:end -->

`--json` for the first example:

<!-- json-example:start -->
```console
$ pharos-docs "What is the chain ID of the Atlantic testnet?" --json
{
  "schema": "pharos-docs-result/1",
  "status": "answered",
  "question": "What is the chain ID of the Atlantic testnet?",
  "answer": "The Atlantic testnet chain ID is 688689. See Atlantic Testnet.",
  "sources": [
    {
      "title": "Atlantic Testnet",
      "url": "https://docs.pharos.xyz/getting-started/network/atlantic-testnet"
    }
  ],
  "reason": null,
  "suggestions": [],
  "error": null,
  "meta": {
    "tool": "pharos-docs",
    "version": "1.0.0",
    "transport": "docs-http",
    "pagesConsulted": [
      {
        "title": "Atlantic Testnet",
        "url": "https://docs.pharos.xyz/getting-started/network/atlantic-testnet",
        "requestUrl": "https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md?ask=What%20is%20the%20chain%20ID%20of%20the%20Atlantic%20testnet%3F&goal=A%20concise%2C%20factual%20answer%20for%20a%20developer%2C%20using%20only%20the%20Pharos%20documentation%2C%20with%20the%20page%20it%20comes%20from.",
        "kind": "answer",
        "outcome": "used"
      }
    ],
    "requests": 2,
    "elapsedMs": 1360
  }
}
```
<!-- json-example:end -->

## Web demo

`public/` is a docs search page for the same tool, laid out as a workspace exactly the screen's height: one box ("Ask the docs…") stays at the bottom, and each question is answered in the thread above it with its source pages, or a plain "No good answer found." Only the thread scrolls; a new question is brought to its top, and the last six are kept. A question may also be typed in the CLI form, `pharos-docs "question"`, and `--json` shows the raw result; every answer also has a JSON toggle. How it answers, CLI usage and the proof links sit beside the thread on a wide screen and open from About on a phone. `help` opens the CLI usage, `clear` (or New) empties the thread, and ↑/↓ recall earlier questions. Every question goes to `GET /api/search?q=`, which runs **the same `search()` and `DocsHttpProvider` as the CLI** and returns the same `pharos-docs-result/1` object; the page only lays it out. Nothing is canned. Good answers are cached at the edge for 5 minutes (`s-maxage=300`); errors are never cached.

Deploy: `vercel.json` in this folder (project root `tasks/04-doc-search-cli`). Not deployed yet.

## Proof

```sh
npm run probe          # optional: how docs.pharos.xyz answers (sitemap, ?ask= response shape) -> proof/probe.json
npm run proof          # the three examples, verified, written into this README
npm run verify-proof   # re-check the committed proof files, offline
```

`npm run proof` runs the three example questions through the real CLI against `https://docs.pharos.xyz` with `--no-cache --transcript`. It saves for each:

- `proof/query-<a|b|c>.json`: every request (URL, purpose, status, content type, size, sha256, and the full body of each page response), then the result;
- `sample-output/query-<a|b|c>.txt`: the printed output;
- `sample-output/query-a.json`: the `--json` result of the first example.

The verifier then checks each run from the raw requests and bodies:

- every request was an HTTPS GET to `docs.pharos.xyz`, labelled `docs-http`, not MCP;
- the index was read live (`/sitemap.md`, 200);
- every `?ask=` request is exactly `<page>.md?ask=<encoded question>&goal=<encoded goal>`, and there are at most three;
- the result has the schema's keys in order, and the expected status (answered, answered, no answer);
- every source is a `docs.pharos.xyz` page asked in that run (never a page only linked to, or a generated follow-up question), with no duplicates;
- every number, hex value and URL in the answer appears verbatim in a fetched body and in the part of it an answer may come from (the retained answer segment, not the restated question or the follow-ups), and at least 90% of its words do. The verifier re-reads each saved body with the same parser the search used;
- for the no-answer run, no answer and no source were produced;
- the saved output shows the answer and every source URL, or the no-answer message.

Only when every check passes does it write the examples and the proof status above. If one fails, the README is left unchanged and the reason is printed.

### Running it from Termux (or any machine with internet access)

```sh
cd ~/pharos-season-of-ai
git fetch origin task-04-doc-search-cli
git checkout task-04-doc-search-cli
git pull origin task-04-doc-search-cli
cd tasks/04-doc-search-cli
npm ci
npm run probe
npm run proof
```

Then commit `proof/`, `sample-output/` and `README.md`.

## Tests

```sh
npm test               # unit, provider, search, CLI (real binary), proof verifier, static checks
npm run test:web       # /api/search and the docs search page
NODE_PATH="$(npm root -g)" npm run test:browser   # Chromium via a global Playwright install; skipped without it
```

All network calls in tests go to an in-process fake docs site with made-up values (for example the chain ID `424242`), never to the real docs. The real docs are exercised only by `npm run probe` and `npm run proof`.

## Known limitations

- **No public Developer Docs MCP transport.** The external MCP endpoint, its tool schema and an A2A agent card are not publicly documented, so this tool uses the docs' documented HTTPS query interface instead. It does not claim MCP.
- **The `?ask=` response format is not specified publicly.** The provider reads every documented shape without a model: the page's own markdown (answered extractively), a short composed answer (shown only if it passes the gate), JSON, or the HTML page. Live, the composed answer arrives as Markdown with the question restated as an `#` heading and a generated `# Suggested Follow-up Questions:` list after the answer; both are cut off by heading name, so a renamed generated section would need adding to that list. `npm run probe` shows which shape the live site returns.
- **Ranking uses page titles, paths and sections only.** A question phrased in words no page title or path uses can miss its page; the result then says no matching page was found, with nearby topics.
- **English questions.** The tokenizer and synonyms are English.

## Swapping in an official MCP transport later

Everything above the transport talks to one interface, `DocsProvider` in `src/providers/provider.ts`:

```ts
interface DocsProvider {
  readonly name: string;
  readonly transport: string;            // "docs-http" today
  index(): Promise<DocPage[]>;          // the page list
  ask(page: DocPage, question: string, goal: string): Promise<PageResponse>;
  requests(): RequestRecord[];
}
```

When a public Developer Docs MCP endpoint and tool schema are documented, an `McpDocsProvider` can implement `index()` and `ask()` with MCP tool calls, return the same `PageResponse`, and report `transport: "mcp"`. It is then passed to `search()` in `run.ts` and `api/search.js`. Ranking, the source gate, the CLI, the docs search page, the result schema and the tests stay as they are, and the proof verifier gets an MCP check alongside its HTTP one.
