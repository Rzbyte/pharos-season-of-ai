# pharos-agent

The agent behind Pharos Agent Lab Tasks 05 onward: one runtime that gains a capability per task,
instead of a separate app for each. Tasks 01 to 04 keep their own code.

```sh
cd agent
npm ci                                   # installs and compiles to dist/
node dist/src/cli.js --help
node dist/src/cli.js guardian payout     # Task 05 on Pharos Mainnet, through the hosted Chain MCP
node dist/src/cli.js dryrun              # Task 08: a USDC transfer, dry-run on Pharos Mainnet
npm test                                 # every test, offline
```

## What it is made of

| Path | What it is |
|---|---|
| `src/core/chain-mcp.ts` | The Chain MCP client, on the official MCP SDK. It reaches the hosted endpoint over Streamable HTTP, the official server run locally over stdio, or any transport (tests). It records every JSON-RPC message, never an HTTP header. |
| `src/core/chain.ts` | Typed wrappers for the official server's tools, each payload checked against the shape `vendor/pharos-mcp/src/server.ts` returns. Blocks are passed as 0x quantities. |
| `src/core/networks.ts` | Pharos Mainnet and Atlantic: RPCs, chain IDs, explorers and token addresses from the [Pharos Skill Engine](https://github.com/PharosNetwork/pharos-skill-engine) (`a873387`), and the hosted Chain MCP. |
| `src/core/abi.ts`, `amounts.ts` | Calls by signature (`"paused() returns (bool)"`) through viem; exact amounts in human units, with no floats. |
| `src/core/execute.ts` | Signing and broadcasting, apart from everything else. The key comes from `PRIVATE_KEY`, signs, and goes nowhere: only the signed transaction leaves, through Chain MCP `send_raw_transaction`. Atlantic only. |
| `src/core/simulate.ts` | A transaction simulated with `eth_call` at a pinned block (a revert is a result, with its reason), and priced with `estimate_gas` and the fee market by the formula `execute.ts` signs with. |
| `src/core/proof.ts` | The proof format (`pharos-agent-proof/1`) and its replay: recorded answers are fed back through the same code, which must make exactly the recorded calls and produce exactly the recorded result. |
| `src/guardian/` | Task 05, Threshold Guardian: config, deciding, the run, presets, the proof verifier. |
| `src/dryrun/` | Task 08, Dry-Run Executor: intents, the dry run (state, simulation, cost, predicted outcome, warnings), Atlantic submission compared with the receipt, the proof verifier. |
| `src/web.ts`, `api/agent.js` | One serverless function for every task: `GET /api/agent?task=NN`. |
| `vendor/pharos-mcp/` | The official Chain MCP server, unmodified ([PROVENANCE.md](vendor/pharos-mcp/PROVENANCE.md)). |

## Which Chain MCP, when

| Network | Chain MCP | Can it broadcast? |
|---|---|---|
| Pharos Mainnet (1672) | hosted, `https://mcp.pharos.xyz/mcp` | No: the hosted endpoint is read-only |
| Atlantic (688689) | the official server, started by the agent over stdio, on `https://atlantic.dplabs-internal.com` | Yes, when executing: `ENABLE_SEND_RAW_TRANSACTION=true`, local only |

`--chain-mcp URL` and `--rpc URL` override these. A proof records what was used, and the verifier
flags a mainnet proof that did not use the hosted endpoint.

## Proofs

`--proof FILE` saves:
- the input;
- the result;
- every MCP message of the run.

`pharos-agent verify FILE` checks a proof offline. It confirms:
- the official server (`pharos-mcp-server` in `initialize`) at the expected endpoint;
- the chain checked first;
- the result recomputed by replay.

Each capability adds its own checks. Tampering with any recorded answer, the decision, a block number
or the server identity fails verification ([`tests/proof.test.ts`](tests/proof.test.ts)).

## Tests

All offline. The fake is the chain under the official server (`tests/fake-chain.ts`, made-up values);
the server itself is the real, vendored code, reached three ways:
- in-process;
- over stdio, exactly as the CLI starts it for Atlantic, including signed broadcasts;
- over its own HTTP mode, the hosted path.

The CLI tests run the built binary end to end.
