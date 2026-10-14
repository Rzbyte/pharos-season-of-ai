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
- [x] **Demonstrates catching at least one live event.** <!-- req-4 --> Ticked by `npm run proof`, only after the verifier has checked a real run against the hosted endpoint. See [Live proof](#live-proof).

<!-- proof-status:start -->
**Live proof:** captured 2026-10-14T20:47:42Z against `https://mcp.pharos.xyz/mcp` (pharos-mcp-server 0.1.0, chain ID 1672). 6 polls checked blocks 20250885..20251004 with 6 `get_logs` calls and reported **19 Transfer events** (3 mined after the monitor started).

Verified by `npm run verify-proof` from the raw MCP messages in [proof/mcp-transcript.json](proof/mcp-transcript.json) and [proof/report.json](proof/report.json):

- [x] transcript format: pharos-mcp-transcript/1, written by event-log-monitor
- [x] hosted endpoint: transcript https://mcp.pharos.xyz/mcp, report https://mcp.pharos.xyz/mcp
- [x] MCP server answered: pharos-mcp-server 0.1.0
- [x] run succeeded: transcript outcome ok=true, report ok=true
- [x] report matches transcript: report.json events and polls are the ones recorded in the transcript outcome
- [x] only Chain MCP tool calls: 13 tools/call requests, all of get_chain_info, get_block_number, get_logs; no other JSON-RPC methods
- [x] chain ID 1672: get_chain_info reported chainId 1672 before any other tool call
- [x] exact address and Transfer topic filter: all 6 get_logs calls: address 0xC879C018dB60520F4355C26eD1a6D572cdAC1815, topics [0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef]
- [x] explicit ranges of at most 1,000 blocks, contiguous: 6 hex ranges, each within the resolved head, no gaps or overlaps; a failed range repeated with the same fromBlock and toBlock
- [x] decoded fields match raw topics and data: 19 events: from = topic1, to = topic2, amount = data (uint256, 6 decimals), tx hash, block and log index as in the log
- [x] dedup by transactionHash + logIndex, nothing missed: 19 events, one per well-formed Transfer log returned (a key again only after its retraction)
- [x] removed logs never reported, retracted when shown before: 0 removed log(s) in the responses; 0 retraction(s) expected, 0 in the report
- [x] no duplicate event output: 19 events printed in the saved output, in the report's order, 19 distinct
- [x] caught at least one real Transfer event: 19 events (3 in blocks mined after the monitor started)
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
Saved as [sample-output/live-run.txt](sample-output/live-run.txt), from the same run.

```text
Pharos Event / Log Monitor

  Watching     Circle USDC · Transfer
  Contract     0xC879C018dB60520F4355C26eD1a6D572cdAC1815
  Event        Transfer(address,address,uint256)
  Topic0       0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  Network      Pharos Mainnet (chain ID 1672)
  Data source  Pharos Chain MCP (server: pharos-mcp-server 0.1.0)
               https://mcp.pharos.xyz/mcp
  Mode         Watch, polling every 5s, first poll covers the last 100 blocks, 6 polls

Started at head 20250984. Watching blocks from 20250885 on.
Transfer  58.261364 USDC transferred from 0x1F35…c85C to 0x912c…f647
  From     0x1F3546a29EeC2102c8d52E21a45114124014c85C
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   58.261364 USDC (raw 58261364)
  Tx hash  0x67db15c83c8821ee537c9c63ba869c08f3d0741efc8948fb151d72b070ab65e2
  Block    20250889 (log index 1)

Transfer  155.28187 USDC transferred from 0x9365…b470 to 0x912c…f647
  From     0x936564245B69f5a293b42cbd752E0eE3bb68b470
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   155.28187 USDC (raw 155281870)
  Tx hash  0x63821182b500fad59e34558a37968255dc9526b3cb0eb0ae7ed45f18cb45632d
  Block    20250889 (log index 4)

Transfer  38.820484 USDC transferred from 0x9365…b470 to 0x912c…f647
  From     0x936564245B69f5a293b42cbd752E0eE3bb68b470
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   38.820484 USDC (raw 38820484)
  Tx hash  0xfe2f915bc0671ce867fd114a90d026dd552324f95971214d1b84a6b3700629e3
  Block    20250899 (log index 1)

Transfer  58.309448 USDC transferred from 0x1F35…c85C to 0x912c…f647
  From     0x1F3546a29EeC2102c8d52E21a45114124014c85C
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   58.309448 USDC (raw 58309448)
  Tx hash  0xe81c9d90b4d03bec4e1ec0a7f9c5dd94bacff9e503f95e849dbd5b78e91c9ae3
  Block    20250925 (log index 1)

Transfer  70.71 USDC transferred from 0x0018…E28D to 0x768B…dE54
  From     0x0018b46177c611fc1EfBca63c845c2a69045E28D
  To       0x768B959191cE5876cabBbC014a08D72615BDdE54
  Amount   70.71 USDC (raw 70710000)
  Tx hash  0xd73f8e2f3263422221f6688af67e45584064920ad30ef8b090c8f5211626cd4c
  Block    20250941 (log index 0)

Transfer  310.564339 USDC transferred from 0x9365…b470 to 0x912c…f647
  From     0x936564245B69f5a293b42cbd752E0eE3bb68b470
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   310.564339 USDC (raw 310564339)
  Tx hash  0x6652038136c54e7b33770189c04e96ebe9036ecf9e5ee201fcaa6e6ae0f735bf
  Block    20250950 (log index 1)

Transfer  58.379769 USDC transferred from 0x1F35…c85C to 0x912c…f647
  From     0x1F3546a29EeC2102c8d52E21a45114124014c85C
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   58.379769 USDC (raw 58379769)
  Tx hash  0x36d59154c2ccb04034a5c31868a8839fcf9c57a1a6b863ceaa149ef6876a7d47
  Block    20250951 (log index 1)

Transfer  38.820953 USDC transferred from 0x9365…b470 to 0x912c…f647
  From     0x936564245B69f5a293b42cbd752E0eE3bb68b470
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   38.820953 USDC (raw 38820953)
  Tx hash  0x69144e8d2f61081f4ffb5bdb48244b1c7fdf1fab98a671c6db464960c36f6fbf
  Block    20250956 (log index 1)

Transfer  58.398307 USDC transferred from 0x1F35…c85C to 0x912c…f647
  From     0x1F3546a29EeC2102c8d52E21a45114124014c85C
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   58.398307 USDC (raw 58398307)
  Tx hash  0x6c2328bd52b527145e9c568702874e98d998c8e44ae8468ac3b653e82f7f0ef0
  Block    20250957 (log index 1)

Transfer  58.409445 USDC transferred from 0x1F35…c85C to 0x912c…f647
  From     0x1F3546a29EeC2102c8d52E21a45114124014c85C
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   58.409445 USDC (raw 58409445)
  Tx hash  0xcac453f6bd529b6386458c7f1dbaa857fefbc34fd065e674a7f9a3b324831538
  Block    20250961 (log index 1)

Transfer  77.669607 USDC transferred from 0x912c…f647 to 0x9365…b470
  From     0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  To       0x936564245B69f5a293b42cbd752E0eE3bb68b470
  Amount   77.669607 USDC (raw 77669607)
  Tx hash  0x8622dd84220f9207c4fb44344f272ab97e371b2334d2bfe68fff4c8041f1ffbc
  Block    20250964 (log index 0)

Transfer  70.71 USDC transferred from 0x768B…dE54 to 0x0018…E28D
  From     0x768B959191cE5876cabBbC014a08D72615BDdE54
  To       0x0018b46177c611fc1EfBca63c845c2a69045E28D
  Amount   70.71 USDC (raw 70710000)
  Tx hash  0x9f7f1ab5cec42bf2afa094cc4da92dbe78dbf3e96bbfce2c14af6142e7872ea6
  Block    20250966 (log index 0)

Transfer  58.382954 USDC transferred from 0x912c…f647 to 0x1F35…c85C
  From     0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  To       0x1F3546a29EeC2102c8d52E21a45114124014c85C
  Amount   58.382954 USDC (raw 58382954)
  Tx hash  0xb9715a6803ab229dc00d9e8349d396ca60c6aec67007c87fdce9e565f82d30a3
  Block    20250969 (log index 0)

Transfer  600 USDC transferred from 0x0018…E28D to 0xB274…9553
  From     0x0018b46177c611fc1EfBca63c845c2a69045E28D
  To       0xB2749BD12f19C24a2244176658F3dF3e48e79553
  Amount   600 USDC (raw 600000000)
  Tx hash  0x968810950de8d8fa80d17a9e1d03b72e8806a0d11d89579459bceaee45ce510c
  Block    20250972 (log index 0)

Transfer  38.821104 USDC transferred from 0x9365…b470 to 0x912c…f647
  From     0x936564245B69f5a293b42cbd752E0eE3bb68b470
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   38.821104 USDC (raw 38821104)
  Tx hash  0x1c46c279c81ddc9bcd14a2b7b9b9c947dd71ca952789c58ea828cc51648089da
  Block    20250972 (log index 5)

Transfer  58.402038 USDC transferred from 0x1F35…c85C to 0x912c…f647
  From     0x1F3546a29EeC2102c8d52E21a45114124014c85C
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   58.402038 USDC (raw 58402038)
  Tx hash  0x2c3fb79923193ff3ce2c80684fc4bc29279e30a3e1fa0cb1688cdc0cf058a15a
  Block    20250973 (log index 1)

Transfer  77.642602 USDC transferred from 0x9365…b470 to 0x912c…f647
  From     0x936564245B69f5a293b42cbd752E0eE3bb68b470
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   77.642602 USDC (raw 77642602)
  Tx hash  0x8972406a9cf2267dc69e2a2113af3ffd11d4e89a58e23727dc08c8011535064f
  Block    20250989 (log index 1)

Transfer  38.82164 USDC transferred from 0x9365…b470 to 0x912c…f647
  From     0x936564245B69f5a293b42cbd752E0eE3bb68b470
  To       0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  Amount   38.82164 USDC (raw 38821640)
  Tx hash  0x59f3c5d1aaae094ae38b80cc425acb43b57ce5d09454dad208617541e838fd8e
  Block    20250994 (log index 1)

Transfer  58.412564 USDC transferred from 0x912c…f647 to 0x1F35…c85C
  From     0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  To       0x1F3546a29EeC2102c8d52E21a45114124014c85C
  Amount   58.412564 USDC (raw 58412564)
  Tx hash  0x2fa247d86407506721f4d127b2c8ceb7342b60c5270ea4215be3d9f4b19f6ac2
  Block    20251001 (log index 0)

Stopped after 6 polls.
  Checked blocks  20250885..20251004 (120 blocks)
  Reported        19 events (19 Transfer, 0 Mint, 0 Burn)
  Skipped         0 duplicate, 0 removed, 0 malformed
  MCP tool calls  13 (get_chain_info 1, get_block_number 6, get_logs 6)
  Elapsed         29.3s
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
4. A failed range is retried once with the exact same arguments. If it fails again, the poll stops and the cursor stays put. The next poll first asks for exactly that range again, with the same `fromBlock` and `toBlock`, and only then plans the blocks mined since. A lost MCP session is reopened on the next poll.

Watch mode starts at the head: by default it reports only events mined after it started. `--lookback n` also covers the last n blocks on the first poll. Finite mode scans one explicit range and exits.

### No duplicates

Each reported event is remembered by `transactionHash:logIndex`. A log with a key already reported is skipped and counted, never printed again. The ranges never overlap, so a duplicate can only come from the server, for example the same log twice in one response, or a transaction re-included in a later block. A log outside the range that was asked for is ignored until its own range is queried. A log that does not match the address and topic filter is ignored and reported as a warning. The dedup memory keeps the newest 50,000 keys.

### Removed logs

Policy (deterministic):

- A log with `removed: true` is **never reported as an event**.
- If the same `transactionHash` + `logIndex` was reported earlier, a **retraction** is printed (`Removed  Log 0x… (log index n) at block … came back with removed: true …`), and the key is forgotten. This holds whatever block the removed log carries, even one behind the cursor, since a reorged log keeps its original block. If the log is later re-included, it is reported again.
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
- the ranges are contiguous, and a failed range (an error, or a payload that is not a log array) was repeated with the same `fromBlock` and `toBlock`. Requests and responses are paired session by session, so a run that reconnected verifies too;
- the monitor's policy is replayed over the raw responses: which logs must be reported, in what order, and which retracted. The report must match it exactly: every well-formed Transfer log of the watched contract once, nothing else, and a key again only after its retraction;
- for every reported event, from = topic1, to = topic2, amount = data (raw, and formatted with 6 decimals), and tx hash, block, log index and type match the raw log. This decoding is redone in the verifier, independently of the monitor's decoder;
- removed logs were never reported as events, and every one that removed an already reported event was retracted;
- the saved output prints exactly the reported events, in order, each once;
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

- **The page** shows the watched contract and event, a Monitoring / Paused status, the last checked block, Start monitoring / Stop buttons, and the new-events feed. Each feed entry has the type, amount, from → to, block, log index, and the tx with View in Explorer, newest first. "New events" lists only events found after monitoring started, with their count. The events already in the first check sit apart, under a collapsed "Initial events" section with their count. Checks pause while the tab is in the background, and blocks skipped by a long pause are named.
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
