# Vendored: the official Pharos Chain MCP server

`src/` is an unmodified copy of [PharosNetwork/pharos-mcp](https://github.com/PharosNetwork/pharos-mcp)
at commit `9a3750ca2747cdd3c88b21c6c53ea7c1d66e0cbb` ("Align get_logs block-range cap with the
upstream RPC limit"). The project is MIT-licensed (its `package.json` and README). The copy has three uses:

- **Atlantic, and executing.** The hosted endpoint (`https://mcp.pharos.xyz/mcp`) serves mainnet only
  and has `send_raw_transaction` turned off. For Atlantic the agent starts this server itself over
  stdio, with the server's own documented settings: `PHAROS_RPC_URL`, `PHAROS_CHAIN_ID`,
  `PHAROS_NATIVE_SYMBOL` and `ENABLE_SEND_RAW_TRANSACTION`. Nothing else of the agent's environment is
  passed to it, so never a key.
- **Tests.** The agent's tests talk to this real server code, over stdio, over its own HTTP mode, and
  in-process. Only the chain under it is a fake.
- **Reading the contract.** `src/server.ts` defines every tool and payload the agent relies on.

It is compiled on its own, with the upstream compiler settings (`tsconfig.json` here), into
`dist/vendor/pharos-mcp/`.

| File | Git blob at `9a3750c` |
|---|---|
| `src/config.ts` | `42f6b189b136fc3ba2e05d30a19f83a2a95aa330` |
| `src/http.ts` | `b5816d5c7f490116562430903e1ed28e9abcaa6f` |
| `src/index.ts` | `fc44ad578cb9ddc332509f83954a0f7bb6f61b28` |
| `src/rpc.ts` | `e8bafe6a99bf936f9bc8d71131f24acad4759487` |
| `src/server.ts` | `8728636fde9c7a37e3e928d53bb713d147b309f0` |
| `src/validation.ts` | `70ed5973e09a7695e565ed6f88282ebac2329e79` |

`agent/tests/proof.test.ts` recomputes these hashes on every test run, so any edit to the copy fails
the suite. To check against upstream yourself:

```sh
git clone https://github.com/PharosNetwork/pharos-mcp /tmp/pharos-mcp
git -C /tmp/pharos-mcp ls-tree 9a3750c src/
```
