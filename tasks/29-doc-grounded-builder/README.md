# Task 29: Doc-Grounded Builder Agent

An agent that answers how to do something on Pharos from the official docs, then prepares it, or does
it. It asks the **Pharos Developer Docs MCP** how. It reads the action the question asks for and sets
its pieces beside the **Pharos Skill Engine**'s. Then it dry-runs the action through **Pharos Chain
MCP** and writes the Skill Engine's `cast` commands to send it. On Atlantic, with a key, the CLI sends
it and checks the receipt.

Code: [`agent/src/builder/`](../../agent/src/builder), on the shared agent runtime
([`agent/`](../../agent)): Task 13's Developer Docs MCP client and Task 08's dry run. Page: `/tasks/29`.

## Requirement

The official task map: *"Answers how to perform an action on Pharos using Docs MCP and then performs or
prepares that action using Chain MCP / SkillEngine where appropriate."* The full task page could not be
reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| Answers how, using Docs MCP | `askQuestion` with the question and a goal (the steps, the contract and function, the network). An answer the docs say they do not cover, or with no page behind it, is not acted on: the agent prepares nothing the docs do not answer. To find a token's address, it reads the pages the answer cites (`getPage`, at most two). |
| Prepares it, using Chain MCP | Task 08's dry run at one block: the state the transaction changes, `eth_call` from the sender, `estimate_gas` and the fee, the funds, and every balance before and after. A balance question is read there instead (`get_balance`, or `eth_call` `balanceOf`). |
| Performs it | On Atlantic, with `--execute` and `PRIVATE_KEY`: the dry-run transaction is signed locally and sent with `send_raw_transaction` through the official server. Then the receipt is checked against the prediction. Mainnet is prepared only: the hosted Chain MCP is read-only. |
| Using the Skill Engine | Its `cast` command templates for the action, filled in from its `networks.json` and `tokens.json`, with its gas rule: the estimate × 1.2, rounded up, times the gas price. The templates are quoted from the [Skill Engine](https://github.com/PharosNetwork/pharos-skill-engine/tree/a873387c9e34e9ae8e71360d43dc33329a335a24) at `a873387`: `references/transaction.md` and `references/query.md`. |
| Grounded in the docs | Each piece of the action is set beside what the docs say of it: the chain ID and RPC URL (the Skill Engine's `networks.json`), the token's address (its `tokens.json`), and the function to call. Each is said to agree, differ, or not be in the docs. Where they differ, the verdict says to check before sending. |

## The actions

The action is read from the question's words. The first verb it uses decides:

| Asked | Action | Prepared as |
|---|---|---|
| send, transfer, pay, move | PROS, or an official token | Task 08's native or ERC-20 transfer |
| approve, allowance | a spender for an official token | Task 08's ERC-20 approval ("unlimited" or "max" for the maximum) |
| wrap | PROS into WPROS (PHRS into WPHRS on Atlantic) | the wrapped token's payable `deposit()` |
| balance, how much | PROS or an official token | read at the block |

Its values come from the run's inputs (`--from`, `--to`, `--amount`, `--token`; the page's address
field) first. Then from the question: an amount with its token ("25 USDC"), an address after "to",
"for" or "from". On Pharos Mainnet the rest is the example's: the agent's example sender and recipient,
25 of a token or 0.01 PROS. The page and the output say which value came from where. A token that is
not official ("25 PEPE"), approving PROS, or a question about anything else (deploying, bridging) gets
the docs' answer and nothing prepared, with the reason.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js howto "How do I send USDC to another wallet on Pharos Mainnet?"
node dist/src/cli.js howto How do I wrap 0.5 PROS into WPROS --from 0x… --json
node dist/src/cli.js howto "How do I check my USDC balance?" --from 0x…
# Atlantic, sent with your testnet key (--from defaults to its address):
PRIVATE_KEY=0x... node dist/src/cli.js howto "How do I send 1 USDC to 0x…?" --network atlantic-testnet --execute
```

## The page

`/tasks/29` asks one question at a time, with an optional address, and prepares on Pharos Mainnet. It
shows:
- the verdict and its sentence: Ready, Would fail, Read, Not prepared, or Not in the docs;
- what the docs say, with the pages the answer cites (those read are marked);
- what it prepares, each value with where it came from;
- the docs beside the Skill Engine: each piece agrees, differs, or is not in the docs;
- the dry run: simulated, gas, fee, funds, and each balance before and after; or the balance read;
- the Skill Engine's commands, each with its reference and a Copy button, and its gas rule;
- how it got there: every step with its source, beside the answer on a wide screen, folded on a phone.

The examples ask how to send USDC, approve a spender, wrap PROS, and read a balance. The address bar
keeps the question and the address. Nothing is sent from the page: it holds no key.

## Proof

**Pending: the first live runs.** This repository's build environment reaches neither Pharos nor
`docs.pharos.xyz`. From any machine that can (Termux works):

```sh
cd agent && npm ci
node dist/src/cli.js howto "How do I send USDC to another wallet on Pharos Mainnet?" --proof ../tasks/29-doc-grounded-builder/proof/send-usdc.json
node dist/src/cli.js howto "How do I wrap 0.5 PROS into WPROS?" --proof ../tasks/29-doc-grounded-builder/proof/wrap.json
node dist/src/cli.js verify ../tasks/29-doc-grounded-builder/proof/send-usdc.json ../tasks/29-doc-grounded-builder/proof/wrap.json
# Optionally, performed on Atlantic with a testnet key holding 1 USDC and some PHRS:
PRIVATE_KEY=0x... node dist/src/cli.js howto "How do I send 1 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553?" --network atlantic-testnet --execute --proof ../tasks/29-doc-grounded-builder/proof/atlantic-sent.json
```

A proof holds both transcripts: every message to and from the Developer Docs MCP, and every message
to and from the Chain MCP server. For each, `verify` confirms:
- the official server answered, at the hosted endpoint (or run locally for Atlantic), with
  `get_chain_info` first, on the right chain;
- the Developer Docs MCP is the official endpoint;
- every state read before a send is at the one block;
- replaying both transcripts gives exactly the recorded action, comparisons, dry run and verdict;
- a sent transaction is exactly the dry-run one, signed by its sender;
- no key material is anywhere in it (the commands name `$PRIVATE_KEY`, a variable, never a key).

These runs are also the first time the agent reads the live docs pages. The tests use made-up pages in
the shape of Task 04's live answers. If the live docs give a token's address in a shape the agent does
not read, its comparison says "not in the docs" honestly, and the parser is fixed to what the proof
shows.

## Tests

```sh
cd agent && npm test                                                      # the agent's tests, offline
node --test tasks/29-doc-grounded-builder/tests/page.test.mjs            # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/29-doc-grounded-builder/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. A local stand-in answers
for the Developer Docs MCP, with made-up pages in the shape the live one gives. They cover:
- reading the action: a send, an approval, a wrap and a balance; inputs over the question; the
  example's values; refusals (a bad input, a token that is not official, approving PROS, nothing to
  prepare, Atlantic without a sender);
- the comparisons: chain IDs, RPC URLs, a token's address on a registry page, a function, and the
  Skill Engine's gas rule;
- a USDC transfer: the registry page read, every piece agreeing, the dry run, the exact cast commands;
- a wrap through `deposit()`, and a balance read;
- the docs giving another address than the Skill Engine; a transfer that would fail; a question it
  prepares nothing for; one the docs do not cover;
- a bad input refused before any call, and a changed docs answer failing the proof;
- performing on Atlantic: signed with a public test key, sent through the official server run
  locally, the receipt matching the prediction, and the proof verifying with the signed transaction;
  refused on mainnet;
- the CLI and the HTTP route.

The browser suite drives the page against the real API handler. It covers:
- the send example on load, in full;
- Copy, which puts the command on the clipboard;
- the approval, wrap and balance examples, with an address given;
- the docs differing from the Skill Engine, and a transfer that would fail;
- a question the docs do not cover, one it prepares nothing for, and a bad address;
- an unreachable Developer Docs MCP;
- the proof, and six widths in both themes.

## Limits

- **Four actions**: sending, approving, wrapping, and reading a balance, of PROS or the official
  tokens in the Skill Engine's list. Anything else gets the docs' answer and nothing prepared.
- **The action is read from the question's words, not inferred.** A question phrased another way
  ("How can I give my USDC to someone?") may not be read as a send: the reason says so.
- **Sent only on Atlantic, from the CLI, with a key.** The page and the API prepare on Pharos Mainnet
  and send nothing.
- **The wrap is the wrapped token's `deposit()`**, the Skill Engine's call-with-value example. The dry
  run shows whether the token takes it.
- **The Skill Engine's commands are written, not run.** Running them needs Foundry, which does not run
  on every machine (it does not on Termux; see Task 03's evidence).
