# Task 01: Technical Notes

Details behind the [README](README.md). Nothing here is needed to run or review the task.

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

## Tests

```bash
npm test
```

53 offline tests: ABI decoding, exact decimals formatting, the contract label and its three conditions (including `get_chain_info` missing or failing), the hosted-endpoint token rule, error mapping, the README proof checks, and end-to-end CLI runs against an in-process fake MCP server that mirrors pharos-mcp's tool names and payloads (block pinning, same-block retry, all four reads required, lost sessions, transcripts, hostile token names, full runs against servers that leave `tools/list` unanswered or do not implement it, and a run against a server that stops answering once a `GET` event stream is open, with a check that every request is an MCP POST to the endpoint plus the closing `DELETE`).

The CLI was also run against the official pharos-mcp server code (commit `9a3750c`) on a local machine with a stub RPC: version 1.0.0 including two server instances without session affinity, version 1.0.1 (no `tools/list`) including an unknown tool name, version 1.0.2 (no standalone `GET` stream) checking that only POSTs and the closing `DELETE` are sent. Those runs check behavior only and are not live chain data.

## Environment notes

Works on a VPS, in GitHub Codespaces and in Termux on Android (`pkg install nodejs` first). TypeScript is pinned to 5.9 because it is plain JavaScript; TypeScript 7 ships native binaries with no Android build.
