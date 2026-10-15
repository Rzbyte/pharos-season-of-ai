# Task 04: Doc-Search CLI

`pharos-docs` asks the official **Pharos Developer Docs** a natural-language question through the **Pharos Developer Docs MCP** (`https://docs.pharos.xyz/~gitbook/mcp`) and prints a short answer with the docs pages it comes from. When the docs do not answer the question, it says so instead of guessing. A browser docs search page runs the same search code.

```console
$ pharos-docs "What is the Atlantic chain ID?"
```

## Requirements

- [x] **Accepts a natural-language question.** `pharos-docs "<question>"`, quoted or not. See [Usage](#usage).
- [x] **Returns a concise answer with source links.** The answer from the Developer Docs MCP, then numbered `docs.pharos.xyz` sources taken from that answer. See [Text output](#text-output).
- [x] **Says so when there is no good answer.** "No good answer found in the Pharos Developer Docs.", with the reason and nearby topics; never an invented answer. See [No-answer behavior](#no-answer-behavior).
- [x] **README with installation, usage and at least 3 example queries with output.** <!-- req-examples --> Installation and usage are below; the three examples are filled in by `npm run proof` from live runs against the Developer Docs MCP only. See [Examples](#examples).

<!-- proof-status:start -->
**Live proof:** captured 2026-10-15T20:39:19Z against the Pharos Developer Docs MCP (`https://docs.pharos.xyz/~gitbook/mcp`) by `npm run proof`, and verified from the saved JSON-RPC requests and raw responses (`npm run verify-proof`). Tools listed by the server: `searchDocumentation`, `getPage`, `askQuestion`, `sendFeedback`.

- **Simple factual query** ("What is the Atlantic chain ID?"): answered, 2 JSON-RPC requests (tools/list, tools/call askQuestion), 5 sources, 11/11 checks passed. Transcript: [proof/query-a.json](proof/query-a.json).
- **Procedural how-to query** ("How do I deploy a contract with Foundry?"): answered, 2 JSON-RPC requests (tools/list, tools/call askQuestion), 5 sources, 11/11 checks passed. Transcript: [proof/query-b.json](proof/query-b.json).
- **Not covered by the docs** ("How do I deploy an Anchor program to Solana?"): no_answer (not_in_docs), 2 JSON-RPC requests (tools/list, tools/call askQuestion), 3 nearby pages, 11/11 checks passed. Transcript: [proof/query-c.json](proof/query-c.json).
<!-- proof-status:end -->

## Transport: the Pharos Developer Docs MCP

Every question goes to the MCP server the docs site serves at **`https://docs.pharos.xyz/~gitbook/mcp`**, over MCP's Streamable HTTP transport: one JSON-RPC 2.0 request per HTTP POST.

| JSON-RPC request (POST) | What for |
|---|---|
| `tools/list` | Check that `askQuestion` is offered and takes a string `question` (and optionally `goal`). Once, then cached: 6 hours on disk for the CLI, on a warm instance for the web endpoint |
| `tools/call` `askQuestion` `{ question, goal }` | The question. The answer is text, then a `# Sources` list of `docs.pharos.xyz` pages |

What was verified against the live endpoint, and is all this client relies on:

- `GET` answers `405` with `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}`; the client only POSTs.
- `POST` with `Content-Type: application/json` and `Accept: application/json, text/event-stream` works, with no session and no authentication; none is invented here.
- Responses are server-sent events: `event: message`, then `data:` with the JSON-RPC response.
- `tools/list` returns `searchDocumentation` (`query`), `getPage` (`url`), `askQuestion` (`question`, optional `goal`) and `sendFeedback`. Only `askQuestion` is called.
- `askQuestion` answers with the answer text and a Sources section of official `docs.pharos.xyz` links; for a topic the docs do not cover, it says so ("No. The Pharos Developer Docs don't cover …") and still lists nearby pages.

The goal sent with every question is the one the live call was verified with: `Answer a developer question using the Pharos Developer Docs`.

The client is about 200 lines with no MCP SDK (`src/providers/mcp-http.ts`): it POSTs one JSON-RPC request with a per-request timeout, refuses redirects, reads at most 2 MB, parses the event stream by the WHATWG rules, skips notifications, and accepts only a JSON-RPC 2.0 response with its own request id and exactly one of `result` or `error`. A JSON-RPC error, an HTTP error, a tool error (`isError`), a result without text content, a malformed stream or a timeout is an error with its kind and reason. Nothing falls back to another transport.

Results, `--verbose` and the proof transcripts say what was used: `provider: "developer-docs-mcp"`, `transport: "docs-mcp"`, `endpoint: "https://docs.pharos.xyz/~gitbook/mcp"`.

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
      --timeout <ms>     Per-request timeout. Default: 30000 (20000 with docs-http)
      --no-cache         List the MCP tools again instead of using the local copy
  -v, --verbose          Print every request on stderr
      --transcript <f>   Save every request, raw response and the result as JSON (used by the proof)
      --transport <t>    docs-mcp (default) or docs-http (development only, see below)
      --max-pages <n>    docs-http only: ask at most n docs pages (1-3). Default: 2
  -h, --help             Show help
      --version          Show the version
```

Exit codes: `0` answered, `1` no good answer in the docs, `2` bad usage (for example no question), `3` the docs could not be reached or read, `4` unexpected.

Output is plain text, with no colors or cursor codes, so it reads the same in a terminal, a pipe or a log. Errors go to stderr; answers and no-answers go to stdout.

### Text output

```text
Answer
  <the answer, as askQuestion gave it, as plain text>

Sources
01  <page title>
    https://docs.pharos.xyz/<page>

Developer Docs MCP (askQuestion) · 2 requests to docs.pharos.xyz/~gitbook/mcp · <seconds> s
```

### `--json` output

One object, always the same keys in the same order (values here show the shape):

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
    "provider": "developer-docs-mcp",
    "transport": "docs-mcp",
    "endpoint": "https://docs.pharos.xyz/~gitbook/mcp",
    "pagesConsulted": [],
    "requests": 2,
    "elapsedMs": 1900
  }
}
```

`status` is `answered`, `no_answer` or `error`. For `no_answer`, `answer` is `null`, `sources` is empty, `reason` says why and `suggestions` lists nearby documented pages. For `error`, `error` is `{ kind, message }`. `requests` counts the JSON-RPC requests (2 with a fresh tool list, 1 with a cached one). `pagesConsulted` is used by docs-http only.

## How it works

```text
question
  -> tools/list, unless a verified list is cached       askQuestion offered? (providers/developer-docs-mcp.ts)
  -> tools/call askQuestion { question, goal }           JSON-RPC POST, event-stream response (providers/mcp-http.ts)
  -> the answer text, split from its Sources list        (text.ts answerAndSources)
  -> source gate: an answer, with official pages?        (source-gate.ts judgeAnswer)
  -> one result: answer + docs.pharos.xyz sources, or no_answer with the reason
```

```text
src/
  cli.ts, run.ts                   the CLI: arguments, output, exit codes, --transcript
  search.ts                        the pipeline, and the result schema
  providers/mcp-http.ts            the MCP client: JSON-RPC over POST, event stream, validation
  providers/developer-docs-mcp.ts  DeveloperDocsMcpProvider: tools/list, askQuestion (canonical)
  providers/provider.ts            the provider interfaces
  providers/http.ts                bounded body reading and error wording, shared
  providers/docs-http.ts           DocsHttpProvider: the docs-http development transport (not MCP)
  docs-index.ts, page-ranker.ts    docs-http only: sitemap.md and which pages to ask
  source-gate.ts                   what may be shown as an answer, and which URLs may be sources
  text.ts                          markdown reading, the answer/Sources split
  formatter.ts                     text and JSON output
  proof.ts, run-proof.ts, verify-proof.ts, probe.ts
api/search.js                      GET /api/search?q=: the docs search page's endpoint, MCP only
public/                            the docs search page
```

### Source gating

pharos-docs has no language model. The answer text comes from the Developer Docs MCP; pharos-docs decides whether to show it and with which sources, and never adds text or links:

- **Answer and sources are read structurally.** The answer is everything before the Sources heading (`# Sources`, `Sources:`, `**Sources**`, `References` and similar), without a restated question heading or a generated follow-up list. The sources are the docs pages the answer links to, then the links under its Sources heading, in that order. Markdown is reduced to plain text; numbered steps keep their numbers and code keeps its lines as written (placeholders and indentation included). The shown answer is at most 700 characters.
- **Only official pages are sources.** An `https://docs.pharos.xyz` page, by canonical URL, each once; any other host, plain `http`, or a look-alike host is dropped. The first five are shown. No URL comes from anywhere but the MCP's answer.
- **No docs page cited, no answer shown.** An answer whose links include no `docs.pharos.xyz` page is a no-answer (`unsourced`); its text is not shown.
- **"The docs don't cover this" is a no-answer** (`not_in_docs`), with the first three pages it listed as nearby topics. The rule reads the answer's opening (its first sentence, or the first two when the first is a short opener such as "No.") for a statement about the documentation: that the docs (docs, documentation, the Pharos Developer Docs, the docs site) do not cover, mention, include or document it; that it is not covered or documented in them; that there is no information or guide about it; that nothing in the docs covers it; that it could not be found; or that it is outside the docs' scope. Typographic apostrophes count ("don’t"). The rule names no topic, product or question; tests run it on made-up topics.
- **A negative fact about Pharos is an answer.** "No. Pharos does not support X" is about the product, not the docs, so it is shown with its sources. So is an answer that answers first and notes a gap in the docs later.
- **On topic.** The answer, with the titles of the pages it cites, must contain at least half the question's words (`weak_match` otherwise).
- **Value questions** (chain ID, contract address, endpoint, a number): the answer must state a value of that kind (`value_not_found` otherwise). No such value exists anywhere in this code to fall back on.

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
| `not_in_docs` | The answer says the Pharos Developer Docs do not cover the question |
| `weak_match` | The answer does not address the question |
| `value_not_found` | The question asks for a value the answer does not state |
| `unsourced` | The answer cites no `docs.pharos.xyz` page |
| `no_matching_page`, `page_unavailable` | docs-http only |

An MCP that cannot be reached, an HTTP or JSON-RPC error, a tool error, a malformed response or a timeout is an **error** (exit 3), not a no-answer: the tool cannot say the docs lack something it could not read. It is never answered another way.

## Examples

Three runs against the live Developer Docs MCP, captured by `npm run proof` and verified from their saved JSON-RPC requests and raw responses. Nothing below is written by hand; until the proof is captured, these sections are empty.

<!-- example-a:start -->
**Simple factual query**

```console
$ pharos-docs "What is the Atlantic chain ID?"
Answer
  Atlantic Testnet’s chain ID is 688689. See Atlantic Testnet.

Sources
01  Atlantic Testnet
    https://docs.pharos.xyz/getting-started/network/atlantic-testnet
02  Cross Chain Infrastructure
    https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain
03  Pharos Network Snapshots
    https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots
04  LayerZero
    https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/layerzero
05  Token Registry
    https://docs.pharos.xyz/getting-started/token-registry

Developer Docs MCP (askQuestion) · 2 requests to docs.pharos.xyz/~gitbook/mcp · 10.0 s
```
<!-- example-a:end -->

<!-- example-b:start -->
**Procedural how-to query**

```console
$ pharos-docs "How do I deploy a contract with Foundry?"
Answer
  Use a Foundry script to deploy, then run it with forge script --broadcast. The Write Your First Token shows the full Pharos example.

  1. Compile and test your contract:

     forge build
     forge test

  2. Create script/DeployToken.s.sol. For a token contract with a uint256 initial-supply constructor, use:

     // SPDX-License-Identifier: MIT
     pragma solidity ^0.8.0;

     import "forge-std/Script.sol";
     import "../src/Token.sol";

     contract DeployToken is Script {
         function run() external {
             vm.startBroadcast();
             Token token = new Token(1_000_000);
             vm.stopBroadcast();
         }
     }

  3. Set your private key and deploy.…

Sources
01  Write Your First Token
    https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token
02  Write Your First NFT
    https://docs.pharos.xyz/developer-guide/foundry/write-your-first-nft
03  Canonical Contracts
    https://docs.pharos.xyz/getting-started/canonical-contracts
04  Validator Node Deployment
    https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment
05  Foundry
    https://docs.pharos.xyz/developer-guide/foundry

Developer Docs MCP (askQuestion) · 2 requests to docs.pharos.xyz/~gitbook/mcp · 15.7 s
```
<!-- example-b:end -->

<!-- example-c:start -->
**Not covered by the docs**

```console
$ pharos-docs "How do I deploy an Anchor program to Solana?"
No good answer found in the Pharos Developer Docs.
  The Pharos Developer Docs say they do not cover this.

Nearby documented topics
01  Rust
    https://docs.pharos.xyz/developer-guide/rust
02  Validator Node Deployment
    https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment
03  Write Your First Uniswap Contract
    https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-uniswap-contract

  Try rephrasing the question, or open one of the pages above.

Developer Docs MCP (askQuestion) · 2 requests to docs.pharos.xyz/~gitbook/mcp · 12.1 s
```
<!-- example-c:end -->

`--json` for the first example:

<!-- json-example:start -->
```console
$ pharos-docs "What is the Atlantic chain ID?" --json
{
  "schema": "pharos-docs-result/1",
  "status": "answered",
  "question": "What is the Atlantic chain ID?",
  "answer": "Atlantic Testnet’s chain ID is 688689. See Atlantic Testnet.",
  "sources": [
    {
      "title": "Atlantic Testnet",
      "url": "https://docs.pharos.xyz/getting-started/network/atlantic-testnet"
    },
    {
      "title": "Cross Chain Infrastructure",
      "url": "https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain"
    },
    {
      "title": "Pharos Network Snapshots",
      "url": "https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots"
    },
    {
      "title": "LayerZero",
      "url": "https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/layerzero"
    },
    {
      "title": "Token Registry",
      "url": "https://docs.pharos.xyz/getting-started/token-registry"
    }
  ],
  "reason": null,
  "suggestions": [],
  "error": null,
  "meta": {
    "tool": "pharos-docs",
    "version": "1.0.0",
    "provider": "developer-docs-mcp",
    "transport": "docs-mcp",
    "endpoint": "https://docs.pharos.xyz/~gitbook/mcp",
    "pagesConsulted": [],
    "requests": 2,
    "elapsedMs": 9976
  }
}
```
<!-- json-example:end -->

## Web demo

`public/` is a docs search page for the same tool, laid out as a workspace exactly the screen's height: one box ("Ask the docs…") stays at the bottom, and each question is answered in the thread above it with its source pages, or a plain "No good answer found." Only the thread scrolls; a new question is brought to its top, and the last six are kept. A question may also be typed in the CLI form, `pharos-docs "question"`, and `--json` shows the raw result; every answer also has a JSON toggle. How it answers, CLI usage and the proof links sit beside the thread on a wide screen and open from About on a phone. `help` opens the CLI usage, `clear` (or New) empties the thread, and ↑/↓ recall earlier questions.

Every question goes to `GET /api/search?q=`, which runs **the same `search()` and `DeveloperDocsMcpProvider` as the CLI** and returns the same `pharos-docs-result/1` object; the page only lays it out. The endpoint is MCP only and fixed in code (no setting can point it elsewhere): a verified tool list is remembered on a warm instance and forgotten after an error, each MCP request has 25 s (the function has 60 s), and an MCP failure is a `502` with the reason. Good answers are cached at the edge for 5 minutes (`s-maxage=300`); errors are never cached.

## Proof

```sh
npm run probe          # tools/list and one askQuestion against the live MCP -> proof/mcp-probe.json
npm run proof          # the three examples through the real CLI, verified, written into this README
npm run verify-proof   # re-check the committed proof files, offline
```

`npm run proof` runs the three example questions through the real CLI against `https://docs.pharos.xyz/~gitbook/mcp` with `--no-cache --transcript`. It saves for each:

- `proof/query-<a|b|c>.json` (`pharos-docs-mcp-transcript/1`): the endpoint, provider and transport; the tool list and the selected tool; every JSON-RPC request exactly as POSTed, with its HTTP status, content type, size, sha256 and the raw event stream received; the answer as `askQuestion` returned it (text, answer part, listed sources); the result; start and finish times. No headers or credentials are recorded (none are sent);
- `sample-output/query-<a|b|c>.txt`: the printed output;
- `sample-output/query-a.json`: the `--json` result of the first example.

The verifier then checks each run from its transcript, trusting nothing the result says about itself:

- every request was a JSON-RPC 2.0 POST to `https://docs.pharos.xyz/~gitbook/mcp`, each with its own id;
- the transcript and the result both say `developer-docs-mcp`, `docs-mcp` and the official endpoint;
- every saved response re-reads as a JSON-RPC result for its own request id;
- the tools were listed live in that run, and `askQuestion` was offered with a string `question`;
- `askQuestion` was called exactly once, with the question (and the goal pharos-docs sends);
- the result has the schema's keys in order, and the expected status (answered, answered, no answer);
- the result is recomputed from the saved event stream: the same parser and gate give exactly this answer, these sources, this status and reason;
- every source is a `docs.pharos.xyz` page the MCP's answer listed, with no duplicates; for the no-answer run, no answer and no source;
- the saved output shows the answer and every source URL, or the no-answer message.

Only when every check passes does it write the examples and the proof status above. If one fails, the README is left unchanged and the reason is printed.

### Running the proof from Termux (or any machine with internet access)

```sh
cd ~/pharos-season-of-ai
git fetch origin fix-task-04-docs-mcp
git checkout fix-task-04-docs-mcp
git pull origin fix-task-04-docs-mcp
cd tasks/04-doc-search-cli
npm ci
node dist/src/cli.js "What is the Atlantic chain ID?" --no-cache
node dist/src/cli.js "How do I deploy a contract with Foundry?" --no-cache
node dist/src/cli.js "How do I deploy an Anchor program to Solana?" --no-cache
node dist/src/cli.js "What is the Atlantic chain ID?" --json --no-cache
npm run probe
npm run proof
npm run verify-proof
```

Then commit `proof/`, `sample-output/` and `README.md`.

## Development transport: docs-http (not MCP)

`--transport docs-http` asks the docs' public HTTP query interface instead: `GET /sitemap.md` for the page list, then `GET /<page>.md?ask=<question>&goal=<goal>` for one to three ranked pages, answered extractively or from the composed answer. It predates the MCP integration and is kept for development and comparison only. It is never the default, nothing falls back to it, the web endpoint does not include it, and it says what it is wherever it runs: a note on stderr, `provider` and `transport` `docs-http` in results, and `pharos-docs-transcript/1` transcripts that call its requests plain HTTP GETs. Its proof from before the MCP integration is kept in [proof/archive/docs-http-2026-10-15/](proof/archive/docs-http-2026-10-15/) as history.

## Tests

```sh
npm test               # MCP client and provider, source gate, search, CLI (real binary), proof verifier, static checks
npm run test:web       # /api/search and the docs search page
NODE_PATH="$(npm root -g)" npm run test:browser   # Chromium via a global Playwright install; skipped without it
```

All network calls in tests go to in-process fakes with made-up values (for example the chain ID `424242`), never to the real docs: a fake Developer Docs MCP with the verified wire format (405 on GET, event-stream responses, the four tools) and failure modes (timeouts, HTTP and JSON-RPC errors, malformed streams, wrong ids, tool errors, oversized bodies, a missing `askQuestion`), and a fake docs site for docs-http. The real MCP is exercised only by `npm run probe` and `npm run proof`.

## Known limitations

- **The answer text is composed by the docs' MCP.** `askQuestion` returns "a synthesized answer with links to source pages" (its own description). pharos-docs shows it only through the gate above and only with `docs.pharos.xyz` pages that answer gives; it does not fetch those pages to re-check each statement. The proof shows each result follows exactly from the saved MCP response, not that the response itself is right.
- **The `askQuestion` output format is not formally specified.** What is relied on is what was verified: the answer, then a `# Sources` list of Markdown links. Other spellings of the heading are read too; an answer without a Sources section is judged by its own links.
- **"Not covered" is read from wording.** The rule is generic, but it is a rule about phrasing: a refusal worded in a way it does not recognise still has to pass the on-topic check, and could in principle be shown as an answer. Proof C checks the live behavior.
- **Long source lists are cut.** `askQuestion` can list many pages under Sources; the first five official ones are shown (three as nearby topics).
- **English questions.**
