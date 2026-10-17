# Task 24 submission: Gas Fee Optimizer

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/24 |
| Repository | [`tasks/24-gas-fee-optimizer/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/24-gas-fee-optimizer); code in [`agent/src/gas/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/gas) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`get_block`, `get_gas_price`, `eth_call`, `estimate_gas`), and the official server run locally for Atlantic sending (`send_raw_transaction`) |

## Reviewer note

Each run reads the newest block's base fee through Chain MCP and keeps it with the earlier ones. A
first run also reads five earlier blocks. The transaction is dry-run at the same block for its gas.
The decision: send now when the base fee is at or below the target (the cheapest quarter of the last
12 observations by default), or wait and say what waiting saves. The fee settings cap the fee at the
target plus the priority fee, so the transaction never pays more. The run sets the cost now, at the
target and at most against the usual cap. On Atlantic with `--execute`, it sends once the decision is
to send.

## Key implementation detail

The optimization is checkable. A run's proof records the observations it judged by, and the replay
recomputes the target, the decision, the settings and the costs from the recorded Chain MCP answers.
For a run that sent, the verifier parses the broadcast transaction. It confirms the transaction is
exactly the dry-run one, signed by its sender, carrying exactly the decided `maxFeePerGas` and
`maxPriorityFeePerGas`. Several runs verify as one history.

## Video walkthrough (about 60 s)

1. Open `/tasks/24`: six base fees, five read from earlier blocks; the decision for a 25 USDC transfer, with why.
2. The fee and cost panel: the target, the capped settings, the cost now and at the target.
3. Press "Check every 30 s": each run adds the newest block's fee; when it reaches the target the decision turns to Send now.
4. Change the target to the lowest half: the same observations, a different decision.
5. In a terminal: `gas atlantic-usdc --execute` sends 1 testnet USDC when the fee is right; `verify` confirms the signed fee cap.

## X post draft

A gas fee optimizer on Pharos: it watches the base fee through Pharos Chain MCP, run after run, and
for one transaction decides to send now or wait for a cheaper block. Its fee cap is the target, so it
never pays more, and the proof checks the signed fees. https://pharos-agent-lab.vercel.app/tasks/24

## How it works (reply)

Each run adds the newest block's base fee to the ones it kept. The target is a percentile of them.
The transaction is dry-run for its gas and priced now and at the target. At or under the target it
sends, capped at the target plus the priority fee. Over it, it waits, with a deadline.
