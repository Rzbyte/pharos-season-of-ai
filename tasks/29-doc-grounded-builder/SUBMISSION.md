# Task 29 submission: Doc-Grounded Builder Agent

| | |
|---|---|
| Live route | https://pharos-agent-lab.vercel.app/tasks/29 |
| Repository | [`tasks/29-doc-grounded-builder/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/tasks/29-doc-grounded-builder); code in [`agent/src/builder/`](https://github.com/Rzbyte/pharos-season-of-ai/tree/main/agent/src/builder) |
| Proof | `proof/` (pending the first live runs; the commands are in the [README](README.md#proof)) |
| Pharos technology | Pharos Developer Docs MCP: `https://docs.pharos.xyz/~gitbook/mcp` (`askQuestion`, `getPage`). Pharos Chain MCP: the hosted `https://mcp.pharos.xyz/mcp` (`eth_call`, `estimate_gas`, `get_balance`, `get_code`); on Atlantic, the official server run locally (`send_raw_transaction`). Pharos Skill Engine at `a873387`: `networks.json`, `tokens.json`, and its `cast` templates |

## Reviewer note

The agent answers how to do something on Pharos, from the docs, then prepares it. The Developer Docs
MCP answers the question. The agent reads the action the question asks for: sending PROS or a token,
approving a spender, wrapping PROS, or reading a balance. Each of its pieces is set beside the Skill
Engine's and against what the docs say: the chain ID, the RPC URL, the token's address, the function.
The action is then dry-run through Chain MCP at one block. The Skill Engine's `cast` commands to send it
are written out, with its gas rule. On Atlantic, the CLI signs and sends it, then checks the receipt.

## Key implementation detail

Nothing is prepared that the docs do not answer: an answer they do not cover, or one that cites no
page, stops the run. Every value of the action says where it came from: the question, an input, or the
example's. The dry run is Task 08's. The commands are quoted from the Skill Engine's references, filled
in, never run. `pharos-agent verify` replays both recorded transcripts, the Docs MCP's and the Chain
MCP's, to the same action, comparisons, dry run and verdict. For a sent run, it also checks the signed
transaction is exactly the dry-run one.

## Video walkthrough (about 60 s)

1. Open `/tasks/29`: "How do I send USDC…". The docs' answer and the Token Registry page; the transfer
   it prepares, each value's source; the four pieces beside the Skill Engine; the dry run; the `cast`
   commands, and Copy.
2. "Wrap PROS": `deposit()` on WPROS, dry-run. "A balance", with an address typed: read at the block.
3. In a terminal, on Atlantic: `howto "How do I send 1 USDC to 0x…?" --network atlantic-testnet
   --execute --proof sent.json`, then `verify sent.json`.

## X post draft

A Pharos agent that turns "how do I…?" into a ready transaction. The Developer Docs MCP answers how;
the agent checks the docs against the Skill Engine, dry-runs it through Pharos Chain MCP, and writes
the cast commands to send it. On testnet it sends it too.
https://pharos-agent-lab.vercel.app/tasks/29

## How it works (reply)

askQuestion answers, and getPage reads the cited page for the token's address. The chain ID, RPC,
address and function are compared with the Skill Engine's. eth_call and estimate_gas dry-run it, and
the Skill Engine's cast templates are filled in. On Atlantic, send_raw_transaction sends it.
