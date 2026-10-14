# Task 02: Event / Log Monitor

Watches **Circle USDC Transfer events on Pharos Mainnet** through the **Pharos Chain MCP** server, and reports each new event once, decoded into its type, amount, sender, recipient, transaction hash and block. There is a CLI and a small live web page. Every chain read is an MCP tool call (`get_chain_info`, `get_block_number`, `get_logs`), and nothing talks to JSON-RPC directly.

| | |
|---|---|
| Contract | Circle USDC `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` (6 decimals) |
| Event | `Transfer(address,address,uint256)`, topic0 `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| Network | Pharos Mainnet, chain ID 1672 |
| MCP endpoint | `https://mcp.pharos.xyz/mcp` (hosted, no key) |

## Requirements

- [x] **Chain MCP log queries filtered by contract address and event signature.** Every `get_logs` call carries the exact USDC address, `topics: [Transfer topic0]` and an explicit hex `fromBlock`/`toBlock` of at most 1,000 blocks. See [Tool-call model](#tool-call-model).
- [x] **Runs continuously and reports only new events, with no duplicates.** `--watch` polls every 5 s (configurable). A cursor and a dedup key of `transactionHash` + `logIndex` keep every event to one report. See [Cursor, paging and retries](#cursor-paging-and-retries).
- [x] **Decodes each event into readable fields.** Each event has from, to, amount (with 6 decimals applied), tx hash and block, plus its log index. See [Decoding](#decoding).
- [ ] **Demonstrates catching at least one live event.** <!-- req-4 --> Ticked by `npm run proof`, only after the verifier has checked a real run against the hosted endpoint. See [Live proof](#live-proof).

<!-- proof-status:start -->
**Live proof:** pending. This development environment cannot reach `mcp.pharos.xyz` (its proxy answers 403), so no live run has been captured yet, and none is faked. Run `npm run proof` on a machine with internet access (see [Live proof](#live-proof)); it fills this section from the verified run.
<!-- proof-status:end -->

## Quick start

Node.js 20 or newer.

```sh
npm ci                 # installs and compiles (dist/)
npm start              # one finite scan: the last 1,000 blocks, then exit
npm run watch          # keep polling every 5 s and print only new events; Ctrl+C to stop
```

More:

```sh
npm start -- --blocks 300                         # the last 300 blocks
npm start -- --from-block 20247480 --to-block 20248479
npm run watch -- --interval 10 --lookback 100     # also report the last 100 blocks on the first poll
npm run watch -- --json                           # one JSON object per line
npm start -- --help
```

Ctrl+C in watch mode lets the current poll finish, prints a summary, closes the MCP session and exits 0. A second Ctrl+C quits at once.

## Sample output

<!-- live-output:start -->
_Pending the live proof run._ The shape, from a test run against the in-process fake MCP server (made-up values):

```text
Transfer  1,250 USDC transferred from 0x1234…0AbC to 0xAbcd…1234
  From     0x1234000000000000000000000000000000000AbC
  To       0xAbcd000000000000000000000000000000001234
  Amount   1,250 USDC (raw 1250000000)
  Tx hash  0x0000000000000000000000000134f75000000000000000000000000000000002
  Block    20248400 (log index 2)

Mint      5 USDC minted to 0xAbcd…1234
  ...

Stopped after 3 polls.
  Checked blocks  20248380..20248485 (106 blocks)
  Reported        4 events (2 Transfer, 1 Mint, 1 Burn)
  Skipped         0 duplicate, 0 removed, 0 malformed
  MCP tool calls  7 (get_chain_info 1, get_block_number 3, get_logs 3)
```
<!-- live-output:end -->

## How it works

### Tool-call model

| When | Tool | Arguments |
|---|---|---|
| Once per run | `get_chain_info` | none. The run stops (exit 6) unless it reports chain ID 1672. |
| Each poll (watch), once (finite) | `get_block_number` | none. This resolves the head that bounds the poll. |
| Per range of at most 1,000 blocks | `get_logs` | `{ address: "0xC879C018dB60520F4355C26eD1a6D572cdAC1815", topics: ["0xddf252ad…b3ef"], fromBlock: "0x…", toBlock: "0x…" }` |

A failed range is repeated once with identical arguments. No other tool is ever called, and `run.ts` refuses any name outside those three. `latest` is never sent: every range ends at a block number the poll resolved itself. A watch poll with no new block makes no `get_logs` call. In steady state a poll is one `get_block_number` plus one `get_logs`.

### Cursor, paging and retries

The cursor is the last block whose logs are fully processed.

1. `get_block_number` gives the head.
2. The blocks after the cursor, up to the head, are split into contiguous ranges of at most 1,000 blocks, the inclusive limit of `get_logs`. One poll handles at most 10 ranges, so a long outage is caught up over a few polls.
3. Each range is one `get_logs` call. The cursor moves to the range's last block only after that call succeeded and all its logs were processed.
4. A failed range is retried once with the exact same arguments. If it fails again, the poll stops and the cursor stays put, so the next poll asks for the same range again (extended to the new head). A lost MCP session is reopened on the next poll.

Watch mode starts at the head: by default it reports only events mined after it started. `--lookback n` also covers the last n blocks on the first poll. Finite mode scans one explicit range and exits.

### No duplicates

Each reported event is remembered by `transactionHash:logIndex`. A log with a key already reported is skipped and counted, never printed again. The ranges never overlap, so a duplicate can only come from the server, for example the same log twice in one response, or a transaction re-included in a later block. A log outside the range that was asked for is ignored until its own range is queried. A log that does not match the address and topic filter is ignored and reported as a warning. The dedup memory keeps the newest 50,000 keys.

### Removed logs

Policy (deterministic):

- A log with `removed: true` is **never reported as an event**.
- If the same `transactionHash` + `logIndex` was reported earlier, a **retraction** is printed (`Removed  Log 0x… (log index n) at block … came back with removed: true …`), and the key is forgotten. If the log is later re-included, it is reported again.
- Otherwise the removed log is only counted (`Skipped … removed`).

`eth_getLogs` over explicit, already-mined ranges rarely carries `removed: true`, since that flag mostly shows up in filter subscriptions. The policy is there so a reorged log can never pass as a normal new event.

### Decoding

Strict and fixed to the ERC-20 Transfer shape. A log is decoded only if all of these hold:

- the address is the watched contract;
- there are exactly 3 topics, and topic0 is the Transfer signature;
- topic1 (`from`) and topic2 (`to`) are 32-byte words with 12 zero bytes in front of a 20-byte address;
- `data` is exactly 32 bytes (the `uint256` amount);
- `transactionHash`, `blockNumber` and `logIndex` are well formed.

Anything else, an ERC-721 Transfer with 4 topics for example, is skipped with a reason and never guessed at. Amounts are exact: raw ÷ 10^6, without rounding, and the raw value is printed next to the formatted one.

**Classification** (deterministic, no AI): from the zero address is a **Mint**, to the zero address is a **Burn**, and anything else is a **Transfer**. Mint wins if both are zero. Each event gets one sentence:

- `125.5 USDC transferred from 0x1234…abcd to 0xabcd…1234`
- `125.5 USDC minted to 0xabcd…1234`
- `125.5 USDC burned from 0x1234…abcd`

## Live proof

`npm run proof` makes one watch run against the hosted endpoint: 6 polls, 5 s apart, with the first also covering the last 100 blocks. It saves:

- `proof/mcp-transcript.json`: every JSON-RPC message of the run, verbatim and in order. HTTP headers are not recorded.
- `proof/report.json`: the run's JSON report.
- `sample-output/live-run.txt`: the printed output.

Then `src/verify-proof.ts` checks those files **from the raw MCP messages**, not from the report's own claims, and only when every check passes does it write this README's proof sections:

- hosted endpoint `https://mcp.pharos.xyz/mcp`, and an MCP server that answered;
- `get_chain_info` reported chain ID 1672 before any other call;
- only `get_chain_info`, `get_block_number` and `get_logs` were called, with no other JSON-RPC method (no direct RPC);
- every `get_logs` call had exactly the USDC address and `[Transfer topic0]`, and an explicit hex range of at most 1,000 blocks that ends within the head resolved before it;
- the ranges are contiguous, and a failed range was repeated from the same block;
- for every reported event, from = topic1, to = topic2, amount = data (raw, and formatted with 6 decimals), and tx hash, block, log index and type match the raw log. This decoding is redone in the verifier, independently of the monitor's decoder;
- the keys are unique (`transactionHash:logIndex`), every well-formed Transfer log returned was reported, and the saved output prints each event exactly once;
- at least one real Transfer event, with a count of those mined after the monitor started.

### Running it from Termux (or any machine with internet access)

```sh
cd ~/pharos-season-of-ai                      # your clone of Rzbyte/pharos-season-of-ai
git fetch origin task-02-event-log-monitor
git checkout task-02-event-log-monitor
git pull origin task-02-event-log-monitor
cd tasks/02-event-log-monitor
npm ci
npm run proof
```

It takes about 30 seconds. At the observed rate (99 USDC Transfer logs in 1,000 blocks), the 100-block lookback should hold several events, and a few more should arrive during the run. If the verifier fails, nothing in the README changes and the reason is printed. To publish a verified run, commit `proof/`, `sample-output/` and `README.md`.

## Web demo

`public/` and `api/events.js` are a small live page for the same monitor. It reuses Task 01's design language (copied into this folder; Task 01 is untouched), but none of its features.

- **The page** shows the watched contract and event, a Monitoring / Paused status, the last checked block, Start monitoring / Stop buttons, and the new-events feed. Each feed entry has the type, amount, from → to, block, log index, and the tx with View in Explorer, newest first. New events are marked New. Events found by the first check are marked At start. Checks pause while the tab is in the background, and blocks skipped by a long pause are named.
- **`GET /api/events`** reads one shared window: the last 200 blocks up to the head, with `get_chain_info`, `get_block_number` and one exactly filtered `get_logs` call, using the CLI's own monitor code from `dist/src`. The answer is cached at the edge for 4 s, so all viewers share one upstream check. The MCP server limits requests per client IP, and every viewer's request would leave from the function's shared IP, so a per-viewer poll would not scale. The page keeps its own cursor (last checked block) and dedup set (`transactionHash:logIndex`). Consecutive windows overlap, and the overlap only counts as duplicates. Removed logs follow the same policy as the CLI.
- **Deploy:** `vercel.json` in this folder (root directory `tasks/02-event-log-monitor`). Not deployed yet.

## Files

```text
src/constants.ts     contract, topic, chain, limits
src/transfer.ts      strict Transfer decoding, Mint/Burn/Transfer classification, summary sentence
src/monitor.ts       TransferMonitor: cursor, 1,000-block paging, same-range retry, dedup, removed-log policy
src/run.ts, cli.ts   CLI: finite and --watch modes, output, JSON, report, transcript, Ctrl+C
src/proof.ts         proof verifier (from raw MCP messages) and README writer; verify-proof.ts runs it
src/mcp-client.ts, errors.ts, transcript.ts, format.ts   copied from Task 01 (MCP transport with the 1.0.2 fix, errors, transcript, formatting)
api/events.js        GET /api/events for the web page
public/              the web page; lab.css, lab.js, theme.js and fonts copied from Task 01
tests/               unit, monitor, e2e (CLI against a fake MCP server), proof, demo API, page and browser tests
```

## Tests

```sh
npm test                 # unit, monitor, e2e and proof tests (TypeScript, node:test)
npm run test:demo        # /api/events, feed bookkeeping and static page checks
NODE_PATH="$(npm root -g)" npm run test:browser   # Chromium via a global Playwright install; skipped without it
```

The fakes mirror the official `PharosNetwork/pharos-mcp` server: tool names, JSON-in-text payloads, the error shape, and the 1,000-block `get_logs` limit. Log fixtures use the live payload's field set (`address`, `blockHash`, `blockNumber`, `blockTimestamp`, `data`, `logIndex`, `removed`, `topics`, `transactionHash`, `transactionIndex`) with made-up values.

## Limits

- One contract and one event, by design: there are no other tokens, no Approval events, and no arbitrary ABIs.
- The CLI's dedup memory and its report are bounded (50,000 keys; the last 1,000 polls and 5,000 events in the report). Totals stay exact.
- The pharos-mcp server limits requests per client IP (120 a minute by default in its source; the hosted setting is not published). The CLI keeps one MCP session open across polls and, at the default 5 s interval, makes about 24 tool calls a minute.
