# Task 10: Batch Executor

Several independent actions from one sender, bundled into one optimized execution flow. A batch is
written one action a line (sends of PROS or an official token, approvals and revokes, wraps). The agent
merges what can be merged, shows the batch is independent or refuses it, dry-runs every transaction at
one block through **Pharos Chain MCP** with the reads they share made once, and plans them as one
nonce sequence with one fee quote. On Atlantic it signs them and sends them back to back, then checks
every balance and allowance the batch changed. What the bundling saved is counted, not claimed.

Code: [`agent/src/batch/`](../../agent/src/batch), on the shared agent runtime ([`agent/`](../../agent)),
with Task 08's dry run ([`agent/src/dryrun/`](../../agent/src/dryrun)) for each transaction. The size of a
batch follows the **Pharos Skill Engine**'s batch transfer: up to ten, one transaction each.
Page: `/tasks/10`.

## Requirement

The official task map: *"Bundles multiple independent actions into an optimized execution flow."* The
full task page could not be reached from the build environment; this is built to that statement.

| What it asks | Where |
|---|---|
| Multiple actions | A batch, one action a line, read whole before anything is asked of the chain: `send 25 USDC to 0x…`, `send 0.01 PROS to 0x…`, `approve 100 USDC for 0x…` (or `max`), `revoke USDC for 0x…`, `wrap 0.5 PROS`; `#` starts a note. A line it cannot read is refused with its number and the shape it should have. |
| Independent | Shown, not assumed. Every action is signed by one sender, and every balance the batch takes from must cover all it takes before anything the batch adds to it, so any order gives the same end balances. No allowance may be set twice (the one sent last would win). A send of WPROS that needs the batch's wrap first is not independent. A batch that is not independent is refused, saying which lines depend on what. |
| Bundles | One flow: one block for every read, one nonce sequence, one fee quote. Sends of one asset to one address are merged into one transaction (`--no-merge`, or "Keep them apart" on the page, keeps them apart). At most ten, one transaction each: the [Pharos Skill Engine's batch transfer](https://github.com/PharosNetwork/pharos-skill-engine/blob/a873387c9e34e9ae8e71360d43dc33329a335a24/references/transaction.md#batch-transfer--airdrop) (`a873387`) sends up to ten that way (its "simple mode", no contract deployed), and above ten deploys a disposable distributor contract to send them all in one transaction, which this agent does not do. |
| Optimized | Measured. The dry runs share their reads (the chain, the block, a token's code and decimals, the sender's balances, the fee quote), each made once: the result counts the calls made beside what the same dry runs ask when each runs on its own, as Task 08 runs it. Merging saves transactions. A transaction that would revert on its own is left out, so it burns no gas, and the others go, since they do not depend on it. On Atlantic the transactions are sent back to back, without waiting for a receipt between them, and the receipts are awaited together. |
| Execution flow | On Atlantic, with a key: signed here and sent through Chain MCP `send_raw_transaction` in nonce order; a send the node refuses stops the rest (they would wait behind its nonce); then every balance and allowance the batch changed is read again before its first block and after its last, and compared with the plan, the fees taken from the receipts. |

## How a batch goes

1. **Read**: every line, or a refusal naming the line. Only actions whose effects are known before they
   run are taken: a contract call of any other kind could change anything, so its independence could
   not be shown.
2. **Plan**: sends of one asset to one address merged; two approvals of one allowance refused.
3. **Pin and dry-run**: the chain checked, one block pinned, the sender's next nonce, then Task 08's
   dry run of each transaction (the state it changes, `eth_call` from the sender, `estimate_gas` and the
   fee), every read they share answered once.
4. **Prove independence**: each token's sends against what the sender holds, the native token's sends,
   wraps and every transaction's most gas against its balance; each allowance set once.
5. **Finish**: ready (the transactions to sign, in nonce order), partly ready (some left out), not a batch,
   short, or would fail; on Atlantic, sent and checked.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js batch                        # the example batch on Pharos Mainnet: merged, planned
node dist/src/cli.js batch batch.txt --from 0x…   # your batch, one action a line ("-" reads standard input)
node dist/src/cli.js batch batch.txt --no-merge   # every send its own transaction
# Atlantic: signed with PRIVATE_KEY (the sender is its address) and sent back to back
PRIVATE_KEY=0x... node dist/src/cli.js batch batch.txt --network atlantic-testnet --execute
```

On Atlantic, write the native token as PHRS (`send 0.01 PHRS to 0x…`, `wrap 0.1 PHRS`) and the
official Atlantic tokens by symbol. Options: `--from`, `--no-merge`, `--execute`, `--block N`,
`--json`, `--proof FILE`, `--verbose`. Exit 0 when every action is ready (or sent), 9 when the batch is
not ready in full, 8 when a send did not go as planned. The CLI takes up to 10 actions, the page 6.

## The page

`/tasks/10` plans a batch on Pharos Mainnet from the example sender (or one you name):
- the verdict and its sentence;
- the plan: each transaction, the lines it carries, its dry run, nonce and state (in the plan, left out
  and why, not independent and why);
- independence, one check at a time, each with its source;
- what bundling saves: the calls made against the same dry runs one by one, the transactions against
  the lines, the one fee quote, the nonce sequence;
- the transactions to sign, with a Copy button;
- how it got there: every step with its source, folded on a phone.

Examples: the payroll batch (two sends to one address merged), one too big (left out, the rest still
ready), and order matters (an approval and a revoke of one allowance). Nothing is sent from the page: it
holds no key, and the hosted Chain MCP is read-only. The address bar keeps the batch.

## Proof

**Pending: the first live runs.** This repository's build environment cannot reach Pharos. From any
machine that can (Termux works):

```sh
cd agent && npm ci
mkdir -p ../tasks/10-batch-executor/proof
# Pharos Mainnet, read-only, no key: the example batch, planned
node dist/src/cli.js batch --proof ../tasks/10-batch-executor/proof/mainnet.json
node dist/src/cli.js verify ../tasks/10-batch-executor/proof/mainnet.json
# Atlantic, sent back to back, with a testnet key holding a little USDC and some PHRS:
printf 'send 1 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553 # rent\nsend 0.5 USDC to 0x1F3546a29EeC2102c8d52E21a45114124014c85C\nsend 0.25 USDC to 0xB2749BD12f19C24a2244176658F3dF3e48e79553\nsend 0.001 PHRS to 0x1F3546a29EeC2102c8d52E21a45114124014c85C\n' > ../tasks/10-batch-executor/proof/atlantic.txt
PRIVATE_KEY=0x... node dist/src/cli.js batch ../tasks/10-batch-executor/proof/atlantic.txt --network atlantic-testnet --execute --proof ../tasks/10-batch-executor/proof/atlantic.json
node dist/src/cli.js verify ../tasks/10-batch-executor/proof/atlantic.json
```

The example sender's holdings decide the mainnet verdict: ready when it holds the 40 USDC and a little
PROS the example takes, short otherwise, saying by how much. Either proof is as valid.

`verify` replays the recorded Chain MCP answers through the same code, shared reads and all, and checks:
- the official server answered, at the hosted endpoint (or run locally for Atlantic), with
  `get_chain_info` first, on the right chain;
- the batch is read again, and every state read of the plan is at the one block;
- the plan, the independence checks, the savings and the verdict come out exactly as recorded, from
  exactly the recorded calls;
- the calls the result counts are the calls the transcript holds before any send;
- for a batch sent: each broadcast is exactly the planned transaction at its nonce, signed by the sender,
  and every send came before any receipt was asked for;
- no key material is anywhere in it.

## Tests

```sh
cd agent && npm test                                                  # the agent's tests, offline
node --test tasks/10-batch-executor/tests/page.test.mjs              # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/10-batch-executor/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it, whose wrapped token takes
deposits as WETH9 does, and which can hold transactions sent back to back for one block. They cover:
- reading: every form, notes and comments; refusals naming the line (an unknown verb or asset, PROS
  approved, a wrap of a token, a zero amount, too many decimals, a failed checksum, a line not read,
  an empty batch, too many actions or characters);
- Pharos Mainnet: the example merged and ready, its calls counted exactly (21 made, 36 one by one), the
  proof verifying and a forged one failing; unmerged; one left out and the rest ready; every one failing;
  short in any order; two approvals of one allowance; a send that needs the wrap first, and the same
  lines independent once the WPROS is held; a send to oneself; a sender needed on Atlantic;
- Atlantic: four transactions sent back to back into one block, every value compared, the proof
  verifying, a renumbered send failing it; a chain that mines each at once (the blocks said as they
  were); a send the node refuses (the rest not sent, what was sent compared); only on Atlantic, only from
  the key's address;
- the CLI (mainnet with its proof, a file, standard input, refusals, Atlantic `--execute` with its proof)
  and the HTTP route.

The browser suite drives the page against the real API handler: the example on load, one too big and
order matters, a batch of your own kept apart, a batch sent (a real run on a fake Atlantic chain, answered
to the page), bad fields never sent, a line the API cannot read, the proof, and six widths in both themes.

## Limits

- **One sender, known effects.** Sends of PROS or an official token, approvals and revokes, wraps.
  Arbitrary contract calls are not batched: their effects, and so their independence, cannot be known
  before they run.
- **Not one transaction, at most ten.** A wallet (an EOA) cannot put several calls into one transaction
  without a contract to make them. The Pharos Skill Engine's batch transfer deploys a disposable
  distributor for that above ten recipients; this agent deploys no contract (and none is deployed at a
  known address on Pharos: Multicall3 would make the calls as itself, not as the sender, and EIP-7702
  needs a delegate contract). The bundle is one flow: one block, one nonce sequence, one fee quote, sent
  back to back, up to ten, as the Skill Engine's simple mode sends them.
- **Order-free by balance.** Independence is shown from balances and allowances, assuming the official
  tokens behave as plain ERC-20 tokens (no fee on transfer, no rebasing): the dry runs check each
  transaction on its own, and the sums are checked against the balances, but a token's code is not read.
- **Sending is Atlantic's.** On Pharos Mainnet the plan is the whole job: the page and the hosted Chain
  MCP never send.
- **A dependent batch is refused, not ordered.** Steps whose order matters are another task's (Task 06,
  the saga executor).
