# Task 13: Docs MCP + Chain MCP Agent

An agent that answers a question about a Pharos contract from the official docs, then checks and
calls it on chain. It asks the **Pharos Developer Docs MCP**, finds the contract's address, network
and functions in the docs, then reads that address through **Pharos Chain MCP**. It reads whether a
contract is there, what the functions the docs describe return, and, for a token, its symbol, name,
decimals and supply. Then it says whether the chain agrees with the docs.

Code: [`agent/src/docs/`](../../agent/src/docs) and the Docs MCP client
[`agent/src/core/docs-mcp.ts`](../../agent/src/core/docs-mcp.ts), on the shared agent runtime
([`agent/`](../../agent)). Page: `/tasks/13`.

## Requirement

The official task map: *"Uses Developer Docs MCP and Chain MCP together, for example understanding a
function and then calling it."* The full task page could not be reached from the build environment;
this is built to that statement.

| What it asks | Where |
|---|---|
| Developer Docs MCP | `askQuestion` (the question, and a goal: the contract or function, its address, its network, what it returns), then `getPage` for the pages the answer cites, at most two. These are tools of the live endpoint's `tools/list`, and the client calls them the way Task 04's live proof recorded: stateless JSON-RPC POSTs, each answered as an event stream or as JSON. |
| Chain MCP | `get_chain_info` first, to check the chain. Then, at one block (`get_block_number`, `get_block`), the official server's `get_code` and `eth_call`. |
| Together | The docs decide what is called. An address comes from the docs' own text, a table row or a line, with the name and network it gives. A function comes from where the docs write it with a return type. The chain's answers are set beside the docs: the token's own symbol and name against the docs' name for it, and against the Skill Engine's token list. |
| Understanding a function, then calling it | A function the docs write with its return type is called with exactly that signature, and its value read as that type. The docs may write `function getBlockNumber() external view returns (uint256 blockNumber)` or `decimals() → uint8`. The function is one the question names, or else one the answer gives. |

## How it decides

1. **The docs answer.** An answer the docs say they do not cover is not acted on, nor one that cites
   no page. Task 04's rules decide which answers are not covered.
2. **The pages it cites are read.** `askQuestion` synthesizes its answer from the docs, so its
   addresses are checked against the docs themselves. The cited pages are read, the likeliest first,
   until an address fits the question's words and is on a page. If a page and the answer each give a
   fitting address, the page's is called. The steps then say the answer's own address was not called.
   An address only the answer gives is still used when nothing better fits, and it is marked as on
   none of the pages it cites.
3. **The chain is read.** At one block: the address's code, the functions the docs give, and for a
   contract that answers `symbol()`, its `name()`, `decimals()` and `totalSupply()`.
4. **The verdict:**

   | Verdict | When |
   |---|---|
   | Confirmed | A contract where the docs say, and nothing contradicts them |
   | Mismatch | The chain's own name for it is not the docs' name, or not the Skill Engine's |
   | No contract | No code at the address the docs give |
   | Another network | The docs place it on another network than the one read |
   | Nothing to call | The docs answered, but gave no address |
   | Not in the docs | The docs do not cover the question |

Every step names its source: a docs tool and page, or a Chain MCP tool. The agent adds no language
model. The docs' answer is the Developer Docs MCP's; the addresses come from the docs' text, and the
verdict from what the chain returns.

## Run it

```sh
cd agent && npm ci
node dist/src/cli.js ask "What is the USDC token address on Pharos Mainnet?"
node dist/src/cli.js ask What does decimals return for WPROS on Pharos Mainnet --json
node dist/src/cli.js ask "What is the USDC address on Atlantic Testnet?" --network atlantic-testnet
```

A question can be one argument or several words. `--verbose` traces every call to both MCPs.

## The page

`/tasks/13` asks one question at a time and reads Pharos Mainnet. It shows:
- the verdict, and the sentence that explains it;
- what the docs say, with the pages the answer cites (those read are marked);
- a card for each contract read: where the docs give it, its checks (code, the functions the docs
  give, its name on chain, the Skill Engine's token list), then its decimals and supply;
- how it got there: every step, each with its source.

The proof lists both MCPs' calls. The examples ask about USDC and WPROS. The address bar keeps the
question, so an answer can be linked.

## Proof

**Pending: the first live runs.** This repository's build environment reaches neither Pharos nor
`docs.pharos.xyz`. From any machine that can (Termux works):

```sh
cd agent && npm ci
node dist/src/cli.js ask "What is the USDC token address on Pharos Mainnet?" --proof ../tasks/13-docs-chain-agent/proof/usdc.json
node dist/src/cli.js ask "What is the WPROS token address on Pharos Mainnet?" --proof ../tasks/13-docs-chain-agent/proof/wpros.json
node dist/src/cli.js verify ../tasks/13-docs-chain-agent/proof/usdc.json ../tasks/13-docs-chain-agent/proof/wpros.json
```

A proof holds both transcripts: every message to and from the Developer Docs MCP, and every message
to and from the Chain MCP server. For each, `verify` confirms:
- the official server answered, at the hosted endpoint, with `get_chain_info` first, on the right chain;
- the Developer Docs MCP is the official endpoint;
- every state read is at the one block;
- replaying both transcripts gives exactly the recorded answer, readings and verdict.

These runs are also the first time the agent reads the live docs pages. The parser is built to the
shape of Task 04's live answers: markdown, relative links, a Sources section. The tests use made-up
pages in that shape. If the live pages give addresses in a shape it does not read, the verdict says
so honestly ("Nothing to call"), and the parser is fixed to what the proof shows.

## Tests

```sh
cd agent && npm test                                                  # the agent's tests, offline
node --test tasks/13-docs-chain-agent/tests/page.test.mjs            # the page's files
NODE_PATH="$(npm root -g)" node --test tasks/13-docs-chain-agent/tests/browser.test.mjs
```

The agent tests run the official server code with a fake chain under it. A local stand-in answers
for the Developer Docs MCP, with made-up pages in the shape the live one gives. They cover:
- reading the docs: the answer and its sources; answers the docs do not cover; addresses with their
  names and networks; functions with their return types;
- a token found on a cited page, and the chain agreeing;
- an address and a function in the answer, found on the page it cites, the function called;
- an address only the answer gives, not called where the page gives another; a page that cannot be
  read;
- the chain contradicting the docs, or the Skill Engine; no contract; another network; nothing to
  call; not covered;
- the replay, a changed docs answer, and an endpoint that is not the official one;
- the Docs MCP client: event streams, JSON, a tool's error, an HTTP error, its budget;
- the CLI and the HTTP route.

The browser suite drives the page against the real API handler. It covers:
- USDC on load, the WPROS example, a typed question, and Ask again;
- a mismatch, a question the docs do not cover, and an empty question;
- an unreachable Developer Docs MCP;
- the proof, and six widths in both themes.

## Limits

- **Read only.** Nothing is signed or sent.
- **One question at a time**, of at most 300 characters. A run reads at most two pages and three
  addresses, and calls at most two of the docs' functions.
- **Functions of no arguments, with a return type the docs write**: uint, int, address, bool, string
  and bytes32 types. A function that takes arguments is not called.
- **Names are compared, not code.** A contract that is not a token is confirmed by its code and the
  functions the docs give.
- **The page reads Pharos Mainnet.** The CLI also takes `--network atlantic-testnet`.
- **The answer is cut at 1,200 characters** in the result and on the page. The proof keeps all of it.
