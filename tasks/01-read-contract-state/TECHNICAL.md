# Task 01: Technical Notes

Details behind the [README](README.md). Nothing here is needed to run or review the task. The CLI comes first; the web demo has [its own section](#web-demo).

## Architecture

```
CLI --MCP over Streamable HTTP--> mcp.pharos.xyz/mcp --> Pharos RPC (server side)
```

One run is 9 HTTP requests: `initialize` and its `initialized` notification, `get_block_number` and `get_chain_info` in parallel, four `eth_call`s in parallel pinned to that block, and a final `DELETE` that closes the MCP session. All are POSTs except that `DELETE`, and each tool result comes back on its own POST's SSE stream.

The tools are called directly by their known names; the CLI does not call `tools/list`. MCP does not require listing tools before calling one, and a live run against the hosted server got no answer to `tools/list` (the request was cancelled after the timeout). A tool the server lacks is reported from that call's own `Tool <name> not found` error, with exit code 4.

The CLI does not open the optional standalone `GET` event stream that the MCP SDK opens after initialization by default. MCP 2025-11-25 makes that stream optional for clients ("The client **MAY** issue an HTTP GET"), and a server **MUST NOT** send a response on it except when resuming a stream, so a request/response client loses nothing by not opening it. Against the hosted endpoint, every request sent while that stream was open went unanswered; the same calls completed once it was not opened. SDK 1.32.1 has no setting for this, so `fetchWithoutStandaloneSse` in `src/mcp-client.ts`, passed through the transport's `fetch` option, answers that one GET locally with 405 (the spec's and the SDK's "no GET stream offered"). POSTs, the closing `DELETE` and any resuming GET with `Last-Event-ID` go out unchanged.

If a read fails for a transient reason (for example an RPC node one block behind), only that read is retried once, at the same block. The CLI never falls back to `latest`, because the output has to name the exact block the data came from.

| File | Role |
|---|---|
| `src/mcp-client.ts` | MCP SDK client; records every JSON-RPC message for the proof transcript |
| `src/erc20.ts` | Calldata, ABI decoding, block-pinned reads of the four required values |
| `src/run.ts` | Arguments, contract label, output table, plain-language summary, JSON report |
| `src/errors.ts` | Error kinds, exit codes, human-readable transport errors |
| `src/transcript.ts` | Writes `proof/mcp-transcript.json` |
| `src/readme-proof.ts`, `src/update-readme.ts` | Validate a live run and write it into the README |

viem is used only to encode calldata, decode return values and format units. There is no viem client or RPC transport:

```bash
grep -rnE "createPublicClient|createWalletClient|rpc\.pharos" src    # no matches
```

## Contract label

`Circle USDC Contract` comes from Circle's and Chainlink's official listings (`src/constants.ts`), not from the chain. It is applied only when all three hold:

1. the address is `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`
2. `get_chain_info` confirmed chain ID 1672
3. `symbol()` returned `USDC`

Otherwise the address is labelled from its on-chain name and symbol (for example `USD Coin (USDC) token contract`) and the output carries a warning saying why. Any other address is always labelled from its on-chain name.

## Proof pipeline

`npm run proof` runs `tsc`, then the CLI with `--transcript proof/mcp-transcript.json --save-output sample-output/live-run.txt`, then `src/update-readme.ts`. The README step leaves the README untouched and exits 1 unless:

- the run succeeded and used exactly `https://mcp.pharos.xyz/mcp`
- the transcript contains a `get_block_number` call
- every `eth_call` request carries the reported block as its `block` argument
- `name()`, `symbol()`, `decimals()` and `totalSupply()` each have a successful `eth_call` response
- the saved output shows the same contract address, block number and endpoint as the transcript

The transcript stores JSON-RPC message bodies only, never HTTP headers.

## Error handling

Every failure prints a specific message and a hint. With `--json`, errors are JSON too.

| Situation | Result | Exit |
|---|---|---|
| Invalid address, bad EIP-55 checksum, unknown option | Usage error | 2 |
| Endpoint unreachable, DNS, TLS, proxy block, HTTP 401/403/404/429/503, timeout | Named cause and next step | 3 |
| Server forgot the session (`Unknown MCP session`, e.g. a restart mid-run) | Reported as such, not as a wrong URL | 3 |
| Server lacks `eth_call` or `get_block_number` | Names the missing tool, from that call's own error | 4 |
| Any of the four reads reverts, returns nothing or returns invalid data | `NOT_ERC20`, naming each failed read | 5 |
| The RPC cannot serve the pinned block, even after one retry | Error naming the block; no switch to `latest` | 5 |
| `get_chain_info` fails or is not offered | Warning; network unknown; on-chain label instead of `Circle USDC Contract` | 0 |
| Chain ID is not 1672, or `symbol()` is not `USDC`, for the USDC address | On-chain label, with a warning | 0 |

## Options

```bash
npm start -- 0x52C48d4213107b20bC583832b0d951FB9CA8F0B0    # any other ERC-20 (this one is WPROS)
```

`--endpoint <url>` (default `$PHAROS_MCP_URL`, else the hosted endpoint), `--timeout <ms>` (default 20000), `--transcript <file>`, `--save-output <file>`, `--no-color`, `--json`, `--verbose`.

`PHAROS_MCP_TOKEN` is sent as a bearer token only to a custom endpoint, for a self-hosted pharos-mcp server started with `MCP_AUTH_TOKEN`. It is never sent to `mcp.pharos.xyz` (any scheme, port or path on that host); if it is set while using the hosted endpoint, the CLI says so and ignores it.

## Web demo

```
browser --GET /api/state-->    api/state.js    --the CLI, --json-->         mcp.pharos.xyz/mcp
browser --GET /api/inspect-->  api/inspect.js  --inspector/inspect.js-->    mcp.pharos.xyz/mcp
```

A static page in `public/` and two Vercel functions in `api/`. `vercel.json` installs with `npm ci`, builds with `npm run build` and gives each function 60 s. The browser calls only these two endpoints of its own site; it never talks to MCP or to Pharos RPC.

- **`GET /api/state`** runs the compiled CLI (`dist/src/run.js`) with `--json`, the hosted endpoint and an empty environment, so the snapshot is read, pinned to one block and labelled exactly as the CLI does it, transport fix included. It adds the formatted total supply, the tool name and version, and `fetchedAt`. A good read is sent with `Cache-Control: public, s-maxage=15, stale-while-revalidate=45`; a failure (502, or 500 if unexpected) with `no-store`.
- **`GET /api/inspect?q=<value>`** is the Pharos Inspector, a separate function so it can never slow down or change the Task 01 read. The input is checked first, by the rules the page also uses (`public/assets/inspect-input.js`): `0x` and 40 hex characters is an address, `0x` and 64 a transaction hash, anything else a 400 without opening an MCP session.
  - A contract: `get_block_number` and `get_chain_info`, then `name()`, `symbol()`, `decimals()` and `totalSupply()` with `eth_call` at that block. Each read is reported on its own, so the rest still show when some fail (a partial result, each missing value with its reason). A transient failure is retried once at the same block, never at `latest`.
  - A transaction: `get_transaction`, `get_transaction_receipt` and `get_chain_info`. A hash MCP does not know is reported as not found, not as an error. A pending transaction has no receipt yet, so it is a partial result: status pending, with no block, gas used or logs.
  - 15 s per MCP request and 45 s for the whole inspection, inside the function's 60 s. A good read may be cached for the same short time as `/api/state`; not found and failures are `no-store`.
- Both functions use the hosted endpoint constant: `PHAROS_MCP_URL` or `PHAROS_MCP_TOKEN` set on the deployment can neither redirect them nor add a token.

The page is plain HTML, CSS and ES modules: no framework, no bundler and no third-party requests. Its fonts are self-hosted (Geist, Geist Mono and Departure Mono, under the SIL Open Font License, licences next to the files), and there are no analytics. Every value it shows is written as text.

| File | Role |
|---|---|
| `public/index.html` | The Task 01 page: snapshot, Pharos Inspector, proof, sources |
| `public/assets/task-01.js` | The snapshot; calls `/api/state` |
| `public/assets/inspector.js` | The Inspector; calls `/api/inspect` |
| `public/assets/inspect-input.js` | Input rules shared by the page and `/api/inspect` |
| `public/assets/lab.css`, `lab.js`, `theme.js`, `tasks.js` | Shared by every task page: the design system, DOM and formatting helpers, the two themes, the 28-task manifest |
| `inspector/inspect.js` | The Inspector's MCP reads, reusing the CLI's client, decoders and error mapping |
| `scripts/check-mcp-capabilities.mjs` | Lists the tools an MCP server offers and the fields of one real transaction |

- **Snapshot states.** Reading, Fresh snapshot, Cached snapshot and Read failed. A snapshot is cached when the edge served an earlier read (`x-vercel-cache` HIT or STALE, or an `Age` header) or when it is the read already on screen (the same `fetchedAt`). A failed read keeps the last good snapshot, with the reason and what to do next.
- **Inspector states.** Inspecting, Success, Partial, Not found and Error. A failed inspection keeps the previous result on screen.
- **Themes.** Dark by default, light when the system asks for it or the reader picks it. `theme.js` runs before the stylesheet, so the page never flashes the other theme. A choice is kept on the device only (`localStorage`, key `agent-arena-lab:theme`).
- **Explorer links.** `<meta name="explorer" content="https://pharos.socialscan.io" data-name="SocialScan">` in `public/index.html` sets the block explorer's address and the name its links show, on one line. `explorerUrl()` in `lab.js` makes `/address/`, `/tx/` and `/block/` links only from an exact 40-hex address, a 64-hex transaction hash or a decimal block number, on a bare https origin; anything else gets no link. Links open a new tab with `rel="noopener noreferrer"`. To use another explorer with the same paths, change that one line.
- **Design system.** `lab.css` is one stylesheet in cascade layers (`tokens`, `base`, `shell`, `primitives`, `task`) on the Pharos brand kit: Blue `#0113B7`, Black `#0B0B0B`, Dark Gray `#343434`, Light Gray `#DFE3E5` and White `#FFFFFF`. Values derived from them are marked in the tokens, among them the dark theme's interaction blue `#4F84FF`, because Pharos Blue cannot be read as text on Black. Text passes WCAG AA in both themes, controls offer 44 px touch targets, and no text is smaller than 12 px. A later task page reuses the shared files and adds its own `task` layer.

## Tests

```bash
npm test                                                             # the CLI: 53 tests
node --test tests/demo-api.test.mjs                                  # /api/state: 6
node --test tests/inspector.test.mjs                                 # the Inspector and /api/inspect: 33
node --test tests/demo-page.test.mjs                                 # the page's files: 55
NODE_PATH="$(npm root -g)" node --test tests/demo-browser.test.mjs   # the page in Chromium: 19
```

`npm test` runs 53 offline tests of the CLI: ABI decoding, exact decimals formatting, the contract label and its three conditions (including `get_chain_info` missing or failing), the hosted-endpoint token rule, error mapping, the README proof checks, and end-to-end CLI runs against an in-process fake MCP server that mirrors pharos-mcp's tool names and payloads (block pinning, same-block retry, all four reads required, lost sessions, transcripts, hostile token names, full runs against servers that leave `tools/list` unanswered or do not implement it, and a run against a server that stops answering once a `GET` event stream is open, with a check that every request is an MCP POST to the endpoint plus the closing `DELETE`).

The four web suites need `dist/` (built by `npm install`) and stay offline too: the real handlers run against in-process fake MCP servers (`tests/fake-inspector-mcp.mjs`) with made-up values, never used as proof.

- `demo-api`: the state endpoint's report and caching, MCP-only reads with four `eth_call`s on one block, the transport fix, and a deployed handler that always targets the hosted endpoint without a token.
- `inspector`: the shared input rules, contract and transaction inspections (partial reads, not found, pending, reverted, same-block retries, timeouts and deadlines, hostile on-chain text), the inspect endpoint, and that the Inspector can never affect `/api/state`.
- `demo-page`: the shipped files. What the page may load and call, its wording (it never says "live"), both themes and their contrast, the brand palette, formatting, how explorer links are built, which links open a new tab, touch targets and the 12 px floor.
- `demo-browser`: Chromium through Playwright, which is not a dependency of this project; without a global install the suite is skipped and says why. Phone to desktop widths, 320 to 1280 px, in both themes (no overflow, the supply on one line, addresses and hashes split only into equal lines), theme switching without layout shift, every snapshot and Inspector state, Copy, explorer links, keyboard order and focus rings, 44 px touch targets, reduced motion, and that the page requests nothing outside its own site.

The CLI was also run against the official pharos-mcp server code (commit `9a3750c`) on a local machine with a stub RPC: version 1.0.0 including two server instances without session affinity, version 1.0.1 (no `tools/list`) including an unknown tool name, version 1.0.2 (no standalone `GET` stream) checking that only POSTs and the closing `DELETE` are sent. Those runs check behavior only and are not live chain data.

## Environment notes

Works on a VPS, in GitHub Codespaces and in Termux on Android (`pkg install nodejs` first). TypeScript is pinned to 5.9 because it is plain JavaScript; TypeScript 7 ships native binaries with no Android build.
