#!/usr/bin/env node
// pharos-agent: the Pharos Agent Lab's agent, one capability per task.
//
//   pharos-agent guardian [preset | config.json] [--block N] [--json] [--proof FILE] [--execute] [--verbose]
//   pharos-agent dryrun [kind] [--token --from --to --amount ...] [--submit]
//   pharos-agent gate [policy] [kind] [--token --from --to --amount ...] [--execute]
//   pharos-agent watch [preset | watcher.json] [--store FILE] [--execute]
//   pharos-agent alert [preset | bot.json] [--store FILE] [--webhook URL]
//   pharos-agent whales [preset | watchlist.json] [--store FILE]
//   pharos-agent gas [preset | plan.json] [--store FILE] [--execute]
//   pharos-agent explain (0xHASH | [kind] --from --to --amount ...)
//   pharos-agent risk [kind] --from --to --amount ... [--blocks N]
//   pharos-agent audit [address] [--hours N | --since TIME [--until TIME] | --from-block N --to-block N]
//   pharos-agent digest [token | address] [--every hour|day|week] [--periods N] [--store FILE] [--so-far]
//   pharos-agent ask "question" [--network ID] [--docs-mcp URL]
//   pharos-agent howto "question" [--from --to --amount --token] [--execute]
//   pharos-agent pay "request" [--contacts FILE] [--from 0x…] [--execute]
//   pharos-agent invoice (FILE | "ethereum:…" | -) [--payees FILE] [--from 0x…] [--blocks N] [--execute]
//   pharos-agent recurring (FILE | -) [--store FILE] [--since DAY] [--from 0x…] [--execute]
//   pharos-agent x402 [run | serve | pay URL] [--price N] [--cap N] [--to 0x…] [--token T] [--execute]
//   pharos-agent buy [--to 0x…] [--amount N] [--token T] [--from 0x…] [--budget N] [--api URL] [--execute]
//   pharos-agent verify FILE...
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAmount, formatGwei, parseAmount } from "./core/amounts.js";
import { Chain } from "./core/chain.js";
import { AGENT, ChainMcp, type ChainMcpEndpoint } from "./core/chain-mcp.js";
import { AgentError, errorMessage } from "./core/errors.js";
import { accountFromEnv, signerFromEnv, type Signer } from "./core/execute.js";
import { network, type Network } from "./core/networks.js";
import { proofFile, type ProofFile } from "./core/proof.js";
import { parseGuardianConfig } from "./guardian/config.js";
import { GUARDIAN_PRESETS } from "./guardian/presets.js";
import { runGuardian, type GuardianRun } from "./guardian/run.js";
import { verifyGuardianProof } from "./guardian/verify.js";
import { parseDryRun } from "./dryrun/intent.js";
import { runDryRun, type DryRun } from "./dryrun/run.js";
import { verifyDryRunProof } from "./dryrun/verify.js";
import { EXAMPLE_PAYER, EXAMPLE_RECIPIENT } from "./guardian/presets.js";
import { runGate, type GateRun } from "./policy/check.js";
import { parsePolicy } from "./policy/config.js";
import { POLICY_PRESETS } from "./policy/presets.js";
import { verifyGateProof } from "./policy/verify.js";
import { parseWatcher } from "./trend/config.js";
import { WATCHER_PRESETS } from "./trend/presets.js";
import { runWatch, type TrendRun } from "./trend/run.js";
import { emptyStore, parseStore } from "./trend/store.js";
import { historyCheck, verifyTrendProof } from "./trend/verify.js";
import { parseAlertBot } from "./alert/config.js";
import { deliver } from "./alert/deliver.js";
import { ALERT_PRESETS } from "./alert/presets.js";
import { MAX_ALERTS, runAlerts } from "./alert/run.js";
import { afterDelivery, emptyAlertStore, parseAlertStore } from "./alert/store.js";
import { alertHistoryCheck, verifyAlertProof, type RecordedAlertRun } from "./alert/verify.js";
import { parseWatchlist } from "./whale/config.js";
import { WHALE_PRESETS } from "./whale/presets.js";
import { MAX_MOVES, runWhales, type WhaleRun } from "./whale/run.js";
import { emptyWhaleStore, parseWhaleStore } from "./whale/store.js";
import { verifyWhaleProof, whaleHistoryCheck } from "./whale/verify.js";
import { parseGasPlan } from "./gas/config.js";
import { GAS_PRESETS } from "./gas/presets.js";
import { runGasPlan, type GasRun } from "./gas/run.js";
import { emptyGasStore, parseGasStore } from "./gas/store.js";
import { gasHistoryCheck, verifyGasProof } from "./gas/verify.js";
import { explain as explainTx, type Explanation } from "./support/explain.js";
import { parseExplainRequest, verifyExplanationProof } from "./support/verify.js";
import { checkRisk, DEFAULT_BLOCKS, MAX_BLOCKS, type RiskReport } from "./risk/check.js";
import { verifyRiskProof } from "./risk/verify.js";
import { parsePeriod } from "./audit/period.js";
import { auditAddress, MAX_BLOCKS as MAX_AUDIT_BLOCKS, parseAuditAddress, type AuditReport } from "./audit/report.js";
import { verifyAuditProof } from "./audit/verify.js";
import { parseEvery, parseSubject, subjectName } from "./digest/config.js";
import { MAX_PERIODS, MAX_RUN_BLOCKS, runDigest, type DigestRun, type PeriodDigest } from "./digest/run.js";
import { digestKey, emptyDigestStore, parseDigestStore } from "./digest/store.js";
import { digestHistoryCheck, verifyDigestProof } from "./digest/verify.js";
import { DOCS_MCP, DocsMcp } from "./core/docs-mcp.js";
import { docsThenChain, parseQuestion, type DocsChainResult } from "./docs/run.js";
import { verifyDocsChainProof } from "./docs/verify.js";
import { parseAction, type ActionInputs } from "./builder/action.js";
import { howTo, type HowToResult } from "./builder/run.js";
import { verifyHowToProof } from "./builder/verify.js";
import { preparePayments, type PaymentFlow } from "./payment/flow.js";
import { parseContacts, parseRequest } from "./payment/request.js";
import { verifyPaymentProof } from "./payment/verify.js";
import { DEFAULT_BLOCKS as INVOICE_BLOCKS, parsePayees, payInvoice, plainPayees, type InvoicePayment } from "./invoice/pay.js";
import { readInvoice } from "./invoice/read.js";
import { verifyInvoiceProof } from "./invoice/verify.js";
import { runRecurring, type RecurringRun } from "./recurring/run.js";
import { readSchedule } from "./recurring/schedule.js";
import { parseRecurringStore, type RecurringStore } from "./recurring/store.js";
import { recurringHistoryCheck, verifyRecurringProof } from "./recurring/verify.js";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { getAddress, isAddress } from "viem";
import { facilitatorRoutes, LocalFacilitatorClient, paidEndpoint, payingFetch, pharosFacilitator, serve as serveHttp } from "./x402/parties.js";
import { readAsset, x402Network } from "./x402/pharos.js";
import { runX402, type X402Run } from "./x402/run.js";
import { verifyX402Proof } from "./x402/verify.js";
import { buy, runBuyer, type BuyerRun } from "./buyer/run.js";
import { verifyBuyerProof } from "./buyer/verify.js";
import { productRoutes, transferIntent } from "./x402/products.js";

const out = (text = "") => process.stdout.write(`${text}\n`);

/** A proof or store as JSON at `path`, its folder made first (a task's proof/ folder starts out empty). */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const HELP = `pharos-agent ${AGENT.version}: the Pharos Agent Lab agent

  pharos-agent guardian [preset | config.json] [options]   Task 05, Threshold Guardian
      Reads every condition at one block through Pharos Chain MCP, decides, and prepares and
      simulates the action only when the rule holds. Default preset: payout (Pharos Mainnet).
      --block N        evaluate at block N instead of the latest
      --execute        Atlantic only: re-check at the newest block, then sign with PRIVATE_KEY and
                       broadcast through Chain MCP send_raw_transaction (the official server, run locally)
      --json           print the result as JSON
      --proof FILE     save the proof: input, result and every Chain MCP message
      --verbose        trace each Chain MCP call on stderr
      --chain-mcp URL  use this Chain MCP endpoint instead of the hosted one (recorded in the proof)
      --rpc URL        the RPC the locally run official server uses (Atlantic; recorded in the proof)

  pharos-agent dryrun [kind] [options]                     Task 08, Dry-Run Executor
      What a transaction would do and cost before it is sent: the state it changes, read at one block,
      simulated with eth_call there, priced with estimate_gas and the fee market. Kinds:
      erc20-transfer (default), native-transfer, erc20-approve, call.
      --token SYMBOL|0x…   an official token (USDC by default) or a token address
      --from 0x… --to 0x…  sender and recipient (the call's contract, for call)
      --amount N           in token units; "max" for an unlimited approval
      --spender 0x…        erc20-approve
      --signature S --args JSON --value N    call: "deposit(uint256)", ["1000"], native value
      --network ID         pharos-mainnet (default) or atlantic-testnet
      --submit             Atlantic only: send it (signed with PRIVATE_KEY; --from defaults to its
                           address), then compare the prediction with the receipt
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent gate [policy] [kind] [options]              Task 11, Policy Gatekeeper
      Checks one requested transfer or approval against a policy at one block, every rule, before
      anything is signed: allowlists, a per-action limit, a window limit from the sender's own
      Transfer logs, a time window at the block's time, a gas cap and a dry run. Policies: treasury
      (Pharos Mainnet, default), atlantic-treasury, or a policy JSON file. Kinds: erc20-transfer
      (default), native-transfer, erc20-approve. Exits with 9 when the request is denied.
      --token, --from, --to, --spender, --amount   the request, as for dryrun (a preset fills in its own)
      --execute            Atlantic only: when allowed and the dry run succeeds, send it (PRIVATE_KEY)
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent watch [preset | watcher.json] [options]     Task 09, Trend Watcher
      One observation per run, kept in a store file across runs. Acts only when the trend over the last
      N observations holds, once per trend: the action is dry-run, and on Atlantic with --execute sent.
      Preset: usdc-outflow (Pharos Mainnet). A watcher is JSON (agent/src/trend/config.ts).
      --store FILE         where the observations are kept between runs (default: trend-store.json)
      --execute, --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent alert [preset | bot.json] [options]         Task 22, On-Chain Alert Bot
      One run: the blocks since the last run scanned for matching transfers, and each state rule read
      and compared with the last run. Every new alert is printed once, and POSTed to the webhook; one
      the webhook did not take is kept and retried on the next run. Preset: usdc (Pharos Mainnet). A bot
      is JSON (agent/src/alert/config.ts).
      --store FILE         the bot's memory between runs (default: alert-store.json)
      --webhook URL        POST each alert as JSON; its line is in "text" and "content"
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent whales [preset | watchlist.json] [options]  Task 23, Whale-Watching Agent
      One run: each tracked address read at the newest block (holdings, nonce), and the blocks since
      the last run scanned for its token transfers. Surfaces the significant moves (a transfer of at
      least the token's minimum, a native balance change of at least the native minimum since the last
      run) and sums up the rest per address. Preset: usdc (Pharos Mainnet). A watchlist is JSON
      (agent/src/whale/config.ts).
      --store FILE         what the watcher saw last run (default: whale-store.json)
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent gas [preset | plan.json] [options]           Task 24, Gas Fee Optimizer
      Observes the fee (each block's base fee), keeps the observations across runs, and decides for one
      transaction whether to send it now or wait: send when the fee is at or below the target (a
      percentile of the observed fees, or a fixed fee) or the plan has waited past its deadline. Gives
      the fee settings, capped at the target, and the cost now and at the target. Presets: usdc (Pharos
      Mainnet, advice only), atlantic-usdc (testnet, from PRIVATE_KEY's address). A plan is JSON
      (agent/src/gas/config.ts).
      --store FILE         the observations kept between runs (default: gas-store.json)
      --execute            Atlantic only: send it, with those settings, when the decision is to send
      --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent explain (0xHASH | [kind] [options])          Task 27, dApp Support Agent
      Why a transaction failed, in plain language, with each finding's source. By hash: its receipt,
      its call replayed at the block before its own for the revert, decoded (Error, Panic, OpenZeppelin
      errors), the target's code, the sender's token balance, and whether it ran out of gas. Described
      instead (the kinds and options of dryrun): why it would fail if sent now.
      --network ID, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent risk [kind] [options]                       Task 25, Wallet Risk Checker
      Before a transaction, what the history of the address it goes to says: its code (a wallet, a
      contract, or a delegated account), nonce and balance; its recent token transfers with the sender,
      zero-value ones, and whether it only looks like an address the sender uses (address poisoning);
      an approval to a wallet or an unlimited one; tokens sent to a token contract; and the dry run.
      A risk level from the worst signal: do not send, check first, or it looks fine. The kinds and
      options of dryrun (the recipient, or with erc20-approve the spender, is the address checked).
      --blocks N           blocks of history to read (default 2,000, at most 10,000)
      --network ID, --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent audit [address] [options]                   Task 26, Audit-Log Agent
      What an address did over a period, in plain language: the transactions it sent (its nonce's
      change), its PROS before and after, each official token's transfers in and out with the main
      counterparties, its balance reconciled with them, the approvals it gave, transfers of nothing, and
      a timeline. The last hour by default; the example address on Pharos Mainnet when none is given.
      --hours N            the last N hours (1 to 168), ending at the newest block
      --since TIME         from this time (ISO 8601; UTC when no zone is given) to --until TIME, or to now
      --from-block N --to-block N   a block range instead
      Up to 100,000 blocks a report, two get_logs calls per 1,000; calls are paced under the hosted
      endpoint's 120 a minute, so a long period takes minutes.
      --network ID, --block (as the newest), --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent digest [token | address] [options]          Task 28, Weekly Digest Agent
      A periodic summary, in plain language, of a protocol (an official token: every transfer of it,
      its volume, senders and recipients, the largest, who sent and received the most, mints, burns)
      or a wallet (its transfers and approvals over every official token), period by period: UTC
      hours, days, or weeks from Monday. Each period is compared with the one before, and its busiest
      part named (a week's day, a day's hour). Only logs and block times are read in the past. Default:
      usdc, the last complete week.
      --every hour|day|week   the period (default week)
      --periods N          without a store, the last N complete periods (1 to 10, default 1)
      --store FILE         digest each period completed since the last run, once: for a schedule
      --so-far             also sum up the period still open
      A week of a protocol is about 480 get_logs calls: minutes, paced under the hosted endpoint's 120 a
      minute, and a proof of tens of megabytes. --network ID, --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent ask "question" [options]                    Task 13, Docs MCP + Chain MCP Agent
      A question about a Pharos contract, answered from the official docs, then checked on chain. The
      Developer Docs MCP answers it (askQuestion); the contract addresses, networks and functions come
      from that answer, or from the docs pages it cites (getPage, at most two). Chain MCP then reads each
      address's code, calls the functions the docs give, and, where it is a token, the standard ERC-20
      views, to set beside what the docs call it and the Skill Engine's token list. The verdict:
      confirmed, a mismatch, no contract there, another network, nothing to call, or not in the docs.
      --docs-mcp URL   use this Developer Docs MCP endpoint instead of the official one (recorded in the proof)
      --network ID, --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent howto "question" [options]                  Task 29, Doc-Grounded Builder Agent
      How to do something on Pharos, answered from the official docs, then prepared through Chain MCP
      and the Pharos Skill Engine: sending PROS or an official token, approving a spender, wrapping
      PROS, or reading a balance. The Developer Docs MCP answers (askQuestion; the pages it cites are
      read for a token's address); the chain ID, RPC URL, token address and function are set beside
      the Skill Engine's; Task 08's dry run prepares it at one block; the Skill Engine's cast commands
      are filled in. Values come from these options, else the question, else the example's (mainnet).
      --from 0x…           the sender, the owner, or the address whose balance is read
      --to 0x…             the recipient, or the spender (--spender works too)
      --amount N --token SYMBOL   the amount, and an official token or the native one
      --execute            Atlantic only: send it, signed with PRIVATE_KEY (--from defaults to its address)
      --docs-mcp URL, --network ID, --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent pay "request" [options]                     Task 17, Natural-Language Payment Agent
      A payment request in plain words, prepared as an on-chain payment flow: "Pay alice 25 USDC and
      bob 5 USDC", "Send 5 USDC each to alice and 0x…", "Split 30 USDC between alice and bob for
      dinner". Every word must be read, or the request is refused with the words that were not. Each
      payment is dry-run at one block (Task 08); the totals are checked against what the sender holds;
      the transactions to sign are given in nonce order, with the Skill Engine's cast commands.
      --contacts FILE      the address book: JSON {"alice": "0x…"}, or lines "alice = 0x…"
      --from 0x…           the sender (else the request's "from 0x…", else the example's on mainnet)
      --execute            Atlantic only: send them in order, signed with PRIVATE_KEY (--from defaults
                           to its address), each checked against its receipt; the first that fails
                           stops the rest
      --network ID, --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent invoice (FILE | "ethereum:…" | -) [options]  Task 19, Invoice-to-Payment Agent
      An invoice (a text file of its lines, "-" for standard input, or an EIP-681 payment link),
      read into the payment it asks for. Every figure must agree with the others (the lines, the
      subtotal, tax, total, what was paid, the amount due, the payment link), or it is refused,
      saying which disagree. The payee is checked against your payees, and the payer's transfers of
      the token over the last blocks for an earlier payment, a lookalike address and transfers of
      nothing. The payment is then prepared as Task 17's flow: the dry run, the transaction to sign,
      the Skill Engine's cast send, and the same payment as an EIP-681 link.
      --payees FILE        your payees: lines "Example Studio = 0x…", or JSON {"Example Studio": "0x…"}
      --from 0x…           the payer (else the invoice's bill-to address, else the example's on mainnet)
      --blocks N           blocks of the payer's history to read (default 2,000, at most 10,000)
      --execute            Atlantic only: sign with PRIVATE_KEY (--from defaults to its address) and send,
                           only when nothing calls for a check first; checked against its receipt
      --network ID, --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above
      Exits with 9 when the payment is held for a check.

  pharos-agent recurring (FILE | -) [options]              Task 18, Recurring Payment Agent
      A schedule of repeating payments, one a line: "Rent: 25 USDC to 0x…, monthly on the 1st". Daily
      or every N days, weekly or every N weeks on a weekday, monthly or every N months on a day (past a
      month's end, its last day), yearly on a month and day; each with "from" and "until" days. Each
      run works out what fell due by the block's UTC day and is not paid, takes the oldest (at most 3
      of one payment, 10 in all), and prepares them as Task 17's flow. With --store, what is paid is
      kept: a missed run is caught up and nothing is paid twice. Run it from cron.
      --store FILE         keep what is paid between runs (created on the first run; needed to send)
      --since DAY          the first day counted, YYYY-MM-DD, when starting (default: the block's day)
      --from 0x…           the payer (else the store's, else the example's on mainnet)
      --execute            Atlantic only, with --store: send them in order, signed with PRIVATE_KEY
                           (--from defaults to its address), each checked against its receipt and
                           recorded as paid
      --network ID, --block, --json, --proof, --verbose, --chain-mcp, --rpc   as above

  pharos-agent x402 [run] [options]                        Task 20, X402 Paywalled API
      An API that charges per request with x402 on Pharos, built on the official x402 packages as the
      Pharos skill sets them up. The paid endpoint, GET /data (live chain data through Chain MCP),
      answers 402 with its terms; the client signs an EIP-3009 authorization for them, never above
      its cap; the facilitator verifies it (the transfer simulated on chain), and settles it
      (transferWithAuthorization sent through Chain MCP); the data is released only once settled. On
      Pharos Mainnet the facilitator only verifies and the client pays with a key made for the run
      that holds nothing, so the payment is refused and nothing is sent.
      --price N            the price of GET /data in the asset (default 0.001)
      --cap N              the most the client pays a request (default: the price)
      --to 0x…             who is paid (default: the example recipient)
      --token SYMBOL|0x…   the asset (default: the official USDC)
      --execute            Atlantic only: the client pays with PRIVATE_KEY and the facilitator settles
                           with FACILITATOR_PRIVATE_KEY (else PRIVATE_KEY), paying the gas in PHRS
      --network ID, --json, --proof, --verbose, --chain-mcp, --rpc   as above
      Exits with 9 when nothing was settled (always on Pharos Mainnet).

  pharos-agent x402 serve [options]                        the same API, served over HTTP
      On 127.0.0.1 (--port, default 4020): GET /data (paid), Task 21's GET /risk and GET /dryrun of a
      transfer (paid, ?asset=…&from=…&to=…&amount=…), GET / (free: the terms), and the facilitator's
      POST /facilitator/verify, POST /facilitator/settle, GET /facilitator/supported.
      Runs until stopped (Ctrl-C).
      --facilitator URL    verify and settle with this x402 facilitator instead of the built-in one
      --execute            Atlantic only: the built-in facilitator settles (FACILITATOR_PRIVATE_KEY, else
                           PRIVATE_KEY); without it, it only verifies, and nothing paid is served
      --price, --to, --token, --network, --verbose, --chain-mcp, --rpc   as above

  pharos-agent x402 pay URL [options]                      the paying client, for any x402 endpoint
      Asks URL; answered 402, pays it by x402's exact scheme with PRIVATE_KEY, at most --cap of the
      asset a request, and prints the answer with its PAYMENT-RESPONSE. Atlantic only (--network
      atlantic-testnet): it signs a payment.
      --cap N              the most it pays a request (default 0.001)
      --token SYMBOL|0x…   the only asset it pays in (default: the official USDC)

  pharos-agent buy [options]                               Task 21, X402 Agent Buyer
      An agent with a job and a budget. The job: check a planned transfer before it is sent, and
      prepare it. It buys what it needs by x402 from an API that sells Task 25's risk check (/risk)
      and Task 08's dry run (/dryrun): it asks each price first (a 402 costs nothing), pays USDC only
      within its budget, and uses what it bought. "Do not send" or "check first" ends the job without
      buying the dry run; otherwise the dry run says whether the transfer would succeed, its cost,
      and the transaction to sign. The API runs in this process unless --api names one; on Pharos
      Mainnet nothing settles, so the first payment is refused and the job is not done.
      --to 0x… --amount N --token SYMBOL --from 0x…   the transfer (default: 25 USDC, the example's)
      --budget N           the USDC it may spend in all (default 0.01)
      --api URL            buy from this x402 API instead (x402 serve, or any that sells /risk and /dryrun)
      --vendor 0x…         who the API in this process is paid (default: a sample address)
      --execute            Atlantic only: pay with PRIVATE_KEY (--from defaults to its address); the
                           API in this process settles with FACILITATOR_PRIVATE_KEY (else PRIVATE_KEY)
      --network ID, --json, --proof, --verbose, --chain-mcp, --rpc   as above
      Exits with 9 unless the transfer is ready to sign.

  pharos-agent verify FILE... check proofs offline by replaying their recorded responses; several
                              proofs of one watcher, alert bot, watchlist, gas plan, digest or
                              recurring schedule, in run order,
                              are also checked as one history

Mainnet runs use the hosted Chain MCP (https://mcp.pharos.xyz/mcp, read-only). Atlantic runs start
the official Pharos Chain MCP server (vendored, unmodified) locally over stdio. The docs come from the
Pharos Developer Docs MCP (https://docs.pharos.xyz/~gitbook/mcp).`;

interface Flags {
  positional: string[];
  help: boolean;
  json: boolean;
  execute: boolean;
  verbose: boolean;
  block?: bigint;
  proof?: string;
  chainMcp?: string;
  docsMcp?: string;
  rpc?: string;
  submit: boolean;
  store?: string;
  webhook?: string;
  soFar: boolean;
  values: Record<string, string>;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positional: [], help: false, json: false, execute: false, verbose: false, submit: false, soFar: false, values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--submit") flags.submit = true;
    else if (arg === "--so-far") flags.soFar = true;
    else if (["--from", "--to", "--token", "--amount", "--spender", "--signature", "--args", "--value", "--network", "--blocks", "--hours", "--since", "--until", "--from-block", "--to-block", "--every", "--periods", "--contacts", "--payees", "--price", "--cap", "--port", "--facilitator", "--budget", "--vendor", "--api"].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new AgentError("usage", `${arg} needs a value.`);
      flags.values[arg.slice(2)] = value;
    }
    else if (arg === "--execute") flags.execute = true;
    else if (arg === "--verbose") flags.verbose = true;
    else if (arg === "--store") {
      const value = argv[++i];
      if (!value) throw new AgentError("usage", "--store needs a file.");
      flags.store = value;
    } else if (arg === "--webhook") {
      const value = argv[++i];
      if (!value || !/^https?:\/\/\S+$/.test(value)) throw new AgentError("usage", "--webhook must be an http(s) URL.");
      flags.webhook = value;
    } else if (arg === "--block" || arg === "--proof" || arg === "--chain-mcp" || arg === "--docs-mcp" || arg === "--rpc") {
      const value = argv[++i];
      if (!value) throw new AgentError("usage", `${arg} needs a value.`);
      if (arg === "--block") {
        if (!/^\d+$/.test(value)) throw new AgentError("usage", "--block must be a block number.");
        flags.block = BigInt(value);
      } else if (arg === "--proof") flags.proof = value;
      else {
        if (!/^https?:\/\/\S+$/.test(value)) throw new AgentError("usage", `${arg} must be an http(s) URL.`);
        if (arg === "--chain-mcp") flags.chainMcp = value;
        else if (arg === "--docs-mcp") flags.docsMcp = value;
        else flags.rpc = value;
      }
    } else if (arg.startsWith("--")) throw new AgentError("usage", `Unknown option ${arg}. See pharos-agent --help.`);
    else flags.positional.push(arg);
  }
  return flags;
}

/**
 * A guardian from a preset name or a file. "$SIGNER" in it stands for the address of PRIVATE_KEY (only the
 * address is derived here), so a preset can pay from, and check, the runner's own wallet.
 */
async function loadGuardian(source: string | undefined, signer: () => Signer) {
  const name = source ?? "payout";
  let text: string;
  const preset = GUARDIAN_PRESETS[name];
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No guardian preset or file "${name}".`, "Presets: payout (mainnet), atlantic-payout (testnet, pays from PRIVATE_KEY's address). Or pass a path to a guardian JSON file.");
    }
  }
  if (text.includes("$SIGNER")) {
    if (!process.env.PRIVATE_KEY) throw new AgentError("usage", `"${name}" pays from your own wallet ($SIGNER), so it needs PRIVATE_KEY (an Atlantic testnet key) for the address.`, "export PRIVATE_KEY=0x... (never commit it)");
    text = text.replaceAll("$SIGNER", signer().address);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  return { config: parseGuardianConfig(json), input: json };
}

function endpointFor(net: Network, flags: Flags): ChainMcpEndpoint {
  const local = (broadcast: boolean): ChainMcpEndpoint => ({ kind: "local", network: flags.rpc ? { ...net, rpcUrl: flags.rpc } : net, broadcast });
  if (flags.execute) {
    if (net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (network: atlantic-testnet).");
    if (flags.chainMcp) throw new AgentError("usage", "--execute broadcasts through the official server run locally; --chain-mcp does not apply.");
    return local(true);
  }
  if (flags.chainMcp) return { kind: "hosted", url: flags.chainMcp };
  return net.hostedChainMcp && !flags.rpc ? { kind: "hosted", url: net.hostedChainMcp } : local(false);
}

function printGuardian(run: GuardianRun): void {
  const mark = (passed: boolean | null) => (passed === true ? "pass" : passed === false ? "FAIL" : "n/a ");
  out(`Pharos Threshold Guardian · ${run.guardian}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${BigInt(run.block.number).toLocaleString("en-US")} · ${run.block.timestamp}`);
  out(`  Rule        fire when ${run.rule} conditions hold`);
  out();
  const width = Math.max(...run.conditions.map((c) => c.label.length));
  for (const c of run.conditions) {
    const seen = c.observed ?? `unreadable (${c.error})`;
    out(`  ${mark(c.passed)}  ${c.label.padEnd(width)}  ${seen.padEnd(16)}  ${c.op} ${c.threshold}   [${c.tool}]`);
  }
  out();
  out(`  Decision    ${run.decision.fire ? "FIRE" : "HOLD"}: ${run.decision.summary}`);
  const a = run.action;
  if (!a) {
    out("  Action      not fired");
  } else {
    out(`  Action      ${a.summary}`);
    if (a.simulation.ok) {
      out(`              simulated at block ${BigInt(a.simulation.block).toLocaleString("en-US")}: ${a.type === "erc20-transfer" ? "transfer returns true" : "succeeds"}`);
      out(`              gas ${BigInt(a.gas!).toLocaleString("en-US")} × ${formatGwei(BigInt(a.gasPrice!))} = ${a.cost!.display} (payer holds ${a.payerBalance!.display})`);
    }
    if (a.status === "blocked") out(`              BLOCKED: ${a.reason}`);
    else if (!run.execution) out(`              not sent${run.network.chainId === 1672 ? ": the hosted Chain MCP is read-only; --execute runs on Atlantic" : ""}`);
  }
  const e = run.execution;
  if (e) {
    out(`  Re-check    block ${BigInt(e.recheck.block).toLocaleString("en-US")}: ${e.recheck.decision.summary}`);
    if (e.sent) {
      out(`  Sent        ${e.txHash} (nonce ${e.nonce})`);
      out(`  Receipt     ${e.status}${e.blockNumber ? ` in block ${BigInt(e.blockNumber).toLocaleString("en-US")}` : ""}${e.gasUsed ? `, gas used ${BigInt(e.gasUsed).toLocaleString("en-US")}` : ""}${e.effectiveGasPrice ? ` at ${formatGwei(BigInt(e.effectiveGasPrice))}` : ""}`);
    } else out(`  Not sent    ${e.reason}`);
  }
  out();
  out(`  ${run.toolCalls} Chain MCP calls. Nothing was signed${run.execution?.sent ? " except the transaction above, locally" : ""}.`);
}

async function guardian(flags: Flags): Promise<number> {
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  const { config, input } = await loadGuardian(flags.positional[1], keySigner);
  const net = network(config.network);
  const signer = flags.execute ? keySigner() : undefined;
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const run = await runGuardian(config, { chain: new Chain(mcp, net), block: flags.block, signer });
    if (flags.proof) {
      const proof = proofFile({ task: "05", capability: "threshold-guardian", about: "One Threshold Guardian run: the guardian (input), its result, and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input, result: run });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printGuardian(run);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.outcome === "hold" || run.outcome === "fire" || run.outcome === "executed" ? 0 : 8;
  } finally {
    await mcp.close();
  }
}

/** An official token by symbol on `net`, or any address as given. */
function tokenFor(net: Network, value: string): string {
  if (/^0x/i.test(value)) return value;
  const token = net.tokens.find((entry) => entry.symbol.toLowerCase() === value.toLowerCase());
  if (!token) throw new AgentError("usage", `${value} is not an official ${net.name} token. Use one of ${net.tokens.map((t) => t.symbol).join(", ")}, or a token address.`);
  return token.address;
}

function printDryRun(run: DryRun): void {
  const verdict = run.verdict === "would-succeed" ? "WOULD SUCCEED" : run.verdict === "would-revert" ? "WOULD REVERT" : "CANNOT PAY";
  out(`Pharos Dry-Run Executor · ${run.summary}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${BigInt(run.block.number).toLocaleString("en-US")} · ${run.block.timestamp}`);
  out(`  Verdict     ${verdict}${run.reason ? `: ${run.reason}` : run.returns ? `: returns ${run.returns}` : ""}`);
  out();
  const width = Math.max(...run.outcome.map((l) => `${l.role} ${l.asset}`.length)) + 2;
  run.outcome.forEach((l, index) => {
    const label = `${l.role === "allowance" ? "Allowance" : l.role === "sender" ? "Sender" : "Recipient"} ${l.asset}`.padEnd(width);
    out(`  ${index === 0 ? "Outcome " : "        "}    ${label}${l.shown.before}${l.shown.after ? ` → ${l.shown.after}${l.shown.change && l.role !== "allowance" ? ` (${l.shown.change})` : ""}` : " (unchanged: it would not go through)"}`);
  });
  if (run.gas) {
    out(`  Gas         ${BigInt(run.gas.gas).toLocaleString("en-US")} (limit ${BigInt(run.gas.gasLimit).toLocaleString("en-US")}) at about ${formatGwei(BigInt(run.gas.expectedFeePerGas))}: about ${formatAmount(BigInt(run.gas.expectedCost), 18, 8)} ${network(run.network.id).nativeSymbol}, at most ${formatAmount(BigInt(run.gas.maxCost), 18, 8)} ${network(run.network.id).nativeSymbol}`);
  }
  out(`  Funds       the sender holds ${run.funds.shown.holds}${run.funds.shown.needs ? `; it needs up to ${run.funds.shown.needs}` : ""}`);
  for (const [index, warning] of run.warnings.entries()) out(`  ${index === 0 ? "Warnings" : "        "}    ${warning.message}`);
  const s = run.submission;
  if (!s) out(`  Submitted   no${run.network.chainId === 1672 ? ": the hosted Chain MCP is read-only; --submit runs on Atlantic" : ""}`);
  else {
    out(`  Submitted   ${s.txHash} (nonce ${s.nonce}): ${s.status}${s.blockNumber ? ` in block ${BigInt(s.blockNumber).toLocaleString("en-US")}` : ""}`);
    for (const c of s.comparisons) out(`    ${c.match ? "match" : "DIFF "}  ${c.what.padEnd(18)} predicted ${c.predicted}; actual ${c.actual}`);
    out(`  Prediction  ${s.matched ? "matched the receipt in every line" : "did not match in every line (see DIFF)"}`);
  }
  out();
  out(`  ${run.toolCalls} Chain MCP calls.${s ? "" : " Nothing was signed or sent."}`);
}

async function dryrun(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const kind = flags.positional[1] ?? "erc20-transfer";
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  if (flags.submit && !v.from) v.from = keySigner().address;
  const example = net.id === "pharos-mainnet";
  const intent: Record<string, unknown> = { kind, from: v.from ?? (example ? EXAMPLE_PAYER : undefined), to: v.to ?? (example && kind !== "call" ? EXAMPLE_RECIPIENT : undefined), amount: v.amount ?? (kind === "native-transfer" ? "0.01" : "25") };
  if (kind === "erc20-transfer" || kind === "erc20-approve") intent.token = tokenFor(net, v.token ?? "USDC");
  if (kind === "erc20-approve") intent.spender = v.spender;
  if (kind === "call") {
    intent.signature = v.signature;
    try {
      intent.args = v.args ? (JSON.parse(v.args) as unknown) : [];
    } catch {
      throw new AgentError("usage", "--args must be a JSON list, like '[\"1000\"]'.");
    }
    intent.value = v.value ?? "0";
  }
  const input = { network: net.id, intent };
  const request = parseDryRun(input);
  if (flags.submit && net.id !== "atlantic-testnet") throw new AgentError("usage", "--submit is limited to the Atlantic testnet (--network atlantic-testnet).");
  const started = new Date();
  const endpoint: ChainMcpEndpoint = flags.submit
    ? { kind: "local", network: flags.rpc ? { ...net, rpcUrl: flags.rpc } : net, broadcast: true }
    : flags.chainMcp
      ? { kind: "hosted", url: flags.chainMcp }
      : net.hostedChainMcp && !flags.rpc
        ? { kind: "hosted", url: net.hostedChainMcp }
        : { kind: "local", network: flags.rpc ? { ...net, rpcUrl: flags.rpc } : net, broadcast: false };
  const mcp = await ChainMcp.connect(endpoint, { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 60 });
  try {
    const run = await runDryRun(request.intent, { chain: new Chain(mcp, net), block: flags.block, signer: flags.submit ? keySigner() : undefined });
    if (flags.proof) {
      const proof = proofFile({ task: "08", capability: "dry-run-executor", about: "One Dry-Run Executor run: the transaction (input), the prediction (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: request, result: run });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printDryRun(run);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.submission && !run.submission.matched ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

function printGate(run: GateRun): void {
  const mark = (passed: boolean | null) => (passed === true ? "pass" : passed === false ? "FAIL" : "n/a ");
  const shown = (value: string) => (/^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);
  out(`Pharos Policy Gatekeeper · ${run.policy.name}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${BigInt(run.block.number).toLocaleString("en-US")} · ${run.block.timestamp}`);
  out(`  Request     ${run.summary}`);
  out();
  const seen = (r: GateRun["rules"][number]) => (r.passed === null ? `unreadable (${r.error})` : r.observed === null ? "does not apply" : shown(r.observed));
  const [width, seenWidth, limitWidth] = [(r: GateRun["rules"][number]) => r.label, seen, (r: GateRun["rules"][number]) => r.limit].map((column) => Math.max(...run.rules.map((r) => column(r).length)));
  for (const r of run.rules) {
    out(`  ${mark(r.passed)}  ${r.label.padEnd(width!)}  ${seen(r).padEnd(seenWidth!)}  ${r.limit.padEnd(limitWidth!)}  [${r.tool}]`);
    if (r.note) out(`        ${"".padEnd(width!)}  ${r.note}`);
  }
  out();
  const { decision: d } = run;
  out(`  Decision    ${d.allowed ? "ALLOWED" : "DENIED"}: ${d.passed} of ${d.total} rules hold${d.failed.length ? `; failing: ${d.failed.join(", ")}` : ""}${d.unreadable.length ? `; unreadable: ${d.unreadable.join(", ")}` : ""}`);
  const dry = run.dryRun;
  if (dry) out(`  Dry run     ${dry.verdict.replace("-", " ")}${dry.gas ? `; gas ${BigInt(dry.gas.gas).toLocaleString("en-US")} (limit ${BigInt(dry.gas.gasLimit).toLocaleString("en-US")}), about ${formatAmount(BigInt(dry.gas.expectedCost), 18, 8)} ${network(run.network.id).nativeSymbol}` : ""}${dry.reason ? `: ${dry.reason}` : ""}`);
  const e = run.execution;
  if (e) {
    out(`  Sent        ${e.txHash} (nonce ${e.nonce}): ${e.status}${e.blockNumber ? ` in block ${BigInt(e.blockNumber).toLocaleString("en-US")}` : ""}`);
    for (const c of e.comparisons) out(`    ${c.match ? "match" : "DIFF "}  ${c.what.padEnd(18)} predicted ${c.predicted}; actual ${c.actual}`);
  } else if (run.notSent) out(`  Not sent    ${run.notSent}`);
  else out(`  Sent        no${d.allowed ? (run.network.chainId === 1672 ? ": the hosted Chain MCP is read-only; --execute runs on Atlantic" : "") : ": denied"}`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls.${e ? "" : " Nothing was signed or sent."}`);
}

async function gate(flags: Flags): Promise<number> {
  const v = flags.values;
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  const name = flags.positional[1] ?? "treasury";
  const preset = POLICY_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset.policy());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No policy preset or file "${name}".`, "Presets: treasury (mainnet), atlantic-treasury (testnet, from PRIVATE_KEY's address). Or pass a path to a policy JSON file.");
    }
  }
  // "$SIGNER" stands for the address of PRIVATE_KEY, in the policy and in the request.
  const needsKey = () => {
    if (!process.env.PRIVATE_KEY) throw new AgentError("usage", `"${name}" uses your own wallet ($SIGNER), so it needs PRIVATE_KEY (an Atlantic testnet key) for the address.`, "export PRIVATE_KEY=0x... (never commit it)");
    return keySigner().address;
  };
  if (text.includes("$SIGNER")) text = text.replaceAll("$SIGNER", needsKey());
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const policy = parsePolicy(json);
  const net = network(policy.network);
  const kind = flags.positional[2] ?? "erc20-transfer";
  const defaults: Record<string, string> = preset?.request ?? {};
  const fill = (value: string | undefined) => (value === "$SIGNER" ? needsKey() : value);
  const intent: Record<string, unknown> = { kind, from: fill(v.from ?? defaults.from ?? (flags.execute ? "$SIGNER" : undefined)), to: fill(v.to ?? defaults.to), amount: v.amount ?? defaults.amount ?? "1" };
  if (kind === "erc20-transfer" || kind === "erc20-approve") intent.token = v.token ? tokenFor(net, v.token) : (defaults.token ?? tokenFor(net, "USDC"));
  if (kind === "erc20-approve") intent.spender = fill(v.spender);
  const request = parseDryRun({ network: net.id, intent });
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const run = await runGate(policy, request.intent, { chain: new Chain(mcp, net), block: flags.block, signer: flags.execute ? keySigner() : undefined });
    if (flags.proof) {
      const proof = proofFile({ task: "11", capability: "policy-gatekeeper", about: "One Policy Gatekeeper run: the policy and the request (input), the decision (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { policy: json, request }, result: run });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printGate(run);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.outcome === "denied" ? 9 : run.execution && !run.execution.matched ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

function printWatch(run: TrendRun, storePath: string): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out(`Pharos Trend Watcher · ${run.watcher}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${n(run.block.number)} · ${run.block.timestamp}`);
  out(`  Observing   ${run.observing.label}`);
  out(`  Store       ${storePath}: ${run.store.observations.length} ${run.store.observations.length === 1 ? "observation" : "observations"}${run.store.actedAt ? `; acted at block ${n(run.store.actedAt)}` : ""}`);
  if (run.skipped) out(`  Skipped     ${run.skipped}`);
  out();
  const width = Math.max(0, ...run.trend.window.map((p) => p.shown.length));
  for (const [index, p] of run.trend.window.entries()) out(`  ${index === 0 ? "Counted " : "        "}    block ${n(p.block).padStart(12)}  ${p.timestamp.slice(11, 19)}  ${p.shown.padStart(width)}${p.change ? `  ${p.change}` : ""}`);
  out(`  Trend       ${run.trend.label}: ${run.trend.detail}${run.trend.holds ? " (holds)" : " (not yet)"}`);
  if (run.action) out(`  Action      ${run.action.headline}`);
  const e = run.execution;
  if (e) {
    out(`  Sent        ${e.txHash} (nonce ${e.nonce}): ${e.status}${e.blockNumber ? ` in block ${n(e.blockNumber)}` : ""}`);
    for (const c of e.comparisons) out(`    ${c.match ? "match" : "DIFF "}  ${c.what.padEnd(18)} predicted ${c.predicted}; actual ${c.actual}`);
  } else if (run.notSent) out(`  Not sent    ${run.notSent}`);
  else if (run.action) out(`  Sent        no${run.network.chainId === 1672 ? ": the hosted Chain MCP is read-only; --execute runs on Atlantic" : ""}`);
  out(`  Outcome     ${run.outcome.toUpperCase()}${run.outcome === "watching" ? "" : ": the next trend counts only observations after this block"}`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls.${e ? "" : " Nothing was signed or sent."}`);
}

async function watch(flags: Flags): Promise<number> {
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  const name = flags.positional[1] ?? "usdc-outflow";
  const preset = WATCHER_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No watcher preset or file "${name}".`, "Preset: usdc-outflow (mainnet). Or pass a path to a watcher JSON file.");
    }
  }
  if (text.includes("$SIGNER")) {
    if (!process.env.PRIVATE_KEY) throw new AgentError("usage", `"${name}" uses your own wallet ($SIGNER), so it needs PRIVATE_KEY (an Atlantic testnet key) for the address.`, "export PRIVATE_KEY=0x... (never commit it)");
    text = text.replaceAll("$SIGNER", keySigner().address);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const watcher = parseWatcher(json);
  const net = network(watcher.network);
  // The store: the observations of earlier runs, or a new one on the first run.
  const storePath = flags.store ?? "trend-store.json";
  let saved: string | null = null;
  try {
    saved = await readFile(storePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${storePath} cannot be read: ${errorMessage(error)}`);
  }
  let stored: unknown = null;
  if (saved !== null) {
    try {
      stored = JSON.parse(saved);
    } catch (error) {
      throw new AgentError("usage", `The store ${storePath} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const store = stored === null ? emptyStore(watcher) : parseStore(stored, watcher);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const run = await runWatch(watcher, store, { chain: new Chain(mcp, net), block: flags.block, signer: flags.execute ? keySigner() : undefined });
    if (flags.proof) {
      const proof = proofFile({ task: "09", capability: "trend-watcher", about: "One Trend Watcher run: the watcher and the store it started from (input), the run and the store it left (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several in run order.", mcp, network: net, startedAt: started, input: { watcher: json, store }, result: run });
      await writeJson(flags.proof, proof);
    }
    // Written only after a run that worked, and whole: a new file, then renamed over the old one.
    await writeJson(`${storePath}.tmp`, run.store);
    await rename(`${storePath}.tmp`, storePath);
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printWatch(run, storePath);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.execution && !run.execution.matched ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

function printAlerts(run: RecordedAlertRun, storePath: string): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out(`Pharos On-Chain Alert Bot · ${run.bot}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${n(run.block.number)} · ${run.block.timestamp}`);
  out(`  Scanned     ${run.scanned ? `blocks ${n(run.scanned.from)}–${n(run.scanned.to)} (${run.scanned.pages} get_logs ${run.scanned.pages === 1 ? "call" : "calls"})` : "no new blocks"}${run.skipped ? `; skipped ${n(run.skipped.from)}–${n(run.skipped.to)}, too far behind` : ""}`);
  out(`  Store       ${storePath}`);
  out();
  const width = Math.max(...run.rules.map((r) => r.label.length));
  for (const r of run.rules) {
    const now = r.kind === "transfer" ? `${r.matches} new` : r.state === "unreadable" ? `unreadable (${r.error})` : `${r.state === "holds" ? "HOLDS" : "clear"}: ${r.observed}`;
    out(`  ${r.label.padEnd(width)}  ${now}   [${r.tool}]`);
  }
  out();
  if (!run.alerts.length) out("  Alerts      none new");
  for (const [index, a] of run.alerts.entries()) out(`  ${index === 0 ? "Alerts  " : "        "}    ${a.kind === "transfer" ? "" : `${a.kind.toUpperCase()} `}${a.label}: ${a.message}`);
  if (run.truncated) out(`              and ${run.truncated} more matching transfers, beyond the ${MAX_ALERTS} one run reports`);
  const d = run.delivery;
  if (d) out(`  Delivered   ${d.delivered.length} ${d.channel === "webhook" ? "to the webhook" : "here"}${d.failed.length ? `; ${d.failed.length} kept to retry (${d.failed[0]!.error})` : ""}`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls. Nothing was signed or sent.`);
}

async function alert(flags: Flags): Promise<number> {
  const name = flags.positional[1] ?? "usdc";
  const preset = ALERT_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No alert bot preset or file "${name}".`, "Preset: usdc (mainnet). Or pass a path to an alert bot JSON file.");
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const bot = parseAlertBot(json);
  const net = network(bot.network);
  const storePath = flags.store ?? "alert-store.json";
  let saved: string | null = null;
  try {
    saved = await readFile(storePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${storePath} cannot be read: ${errorMessage(error)}`);
  }
  let stored: unknown = null;
  if (saved !== null) {
    try {
      stored = JSON.parse(saved);
    } catch (error) {
      throw new AgentError("usage", `The store ${storePath} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const store = stored === null ? emptyAlertStore(bot) : parseAlertStore(stored, bot);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const run = await runAlerts(bot, store, { chain: new Chain(mcp, net), block: flags.block });
    // Every pending alert, new or kept from a failed delivery, goes out now.
    const delivery = await deliver(bot.name, run.store.pending, flags.webhook ?? null);
    const recorded: RecordedAlertRun = { ...run, delivery };
    // The store first: once alerts are delivered, what the bot remembers must say so.
    await writeJson(`${storePath}.tmp`, afterDelivery(run.store, delivery.delivered));
    await rename(`${storePath}.tmp`, storePath);
    if (flags.proof) {
      const proof = proofFile({ task: "22", capability: "alert-bot", about: "One On-Chain Alert Bot run: the bot and the store it started from (input), the run with its alerts, the store it left and the delivery (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several in run order.", mcp, network: net, startedAt: started, input: { bot: json, store }, result: recorded });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(recorded, null, 2));
    else printAlerts(recorded, storePath);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

function printWhales(run: WhaleRun, storePath: string): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out(`Pharos Whale Watcher · ${run.watchlist}`);
  out();
  out(`  Network     ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP   ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block       ${n(run.block.number)} · ${run.block.timestamp}`);
  out(`  Scanned     ${run.scanned ? `blocks ${n(run.scanned.from)}–${n(run.scanned.to)} (${run.scanned.pages} get_logs ${run.scanned.pages === 1 ? "call" : "calls"}): ${run.transfers} ${run.transfers === 1 ? "transfer" : "transfers"} by tracked addresses` : "no new blocks"}${run.skipped ? `; skipped ${n(run.skipped.from)}–${n(run.skipped.to)}, too far behind` : ""}`);
  out(`  Store       ${storePath}`);
  for (const a of run.addresses) {
    const since = a.since === null ? "first seen" : `since block ${n(a.since)}`;
    out();
    out(`  ${a.label} (${a.address}, ${a.contract ? "has code" : "no code"})`);
    for (const t of a.tokens) {
      const moved = t.in.count || t.out.count ? ` · this run: ${t.in.count} in (${t.in.shown}), ${t.out.count} out (${t.out.shown})` : "";
      out(`    ${t.symbol.padEnd(6)} ${t.shown}${t.changeShown === null ? `, ${since}` : ` ${t.changeShown} ${since}`}${moved}`);
    }
    out(`    ${network(run.network.id).nativeSymbol.padEnd(6)} ${a.native.shown}${a.native.changeShown === null ? `, ${since}` : ` ${a.native.changeShown} ${since}`}`);
    out(`    Nonce  ${n(a.nonce)}${a.sent === null ? "" : ` · ${a.sent} ${a.sent === 1 ? "transaction" : "transactions"} sent ${since}`}`);
  }
  out();
  if (!run.events.length) out("  Significant none this run");
  for (const [index, e] of run.events.entries()) out(`  ${index === 0 ? "Significant" : "           "} ${e.message}`);
  if (run.truncated) out(`              and ${run.truncated} more significant transfers, beyond the ${MAX_MOVES} one run reports`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls. Nothing was signed or sent.`);
}

async function whales(flags: Flags): Promise<number> {
  const name = flags.positional[1] ?? "usdc";
  const preset = WHALE_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No watchlist preset or file "${name}".`, "Preset: usdc (mainnet). Or pass a path to a watchlist JSON file.");
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const list = parseWatchlist(json);
  const net = network(list.network);
  const storePath = flags.store ?? "whale-store.json";
  let saved: string | null = null;
  try {
    saved = await readFile(storePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${storePath} cannot be read: ${errorMessage(error)}`);
  }
  let stored: unknown = null;
  if (saved !== null) {
    try {
      stored = JSON.parse(saved);
    } catch (error) {
      throw new AgentError("usage", `The store ${storePath} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const store = stored === null ? emptyWhaleStore(list) : parseWhaleStore(stored, list);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 120 });
  try {
    const run = await runWhales(list, store, { chain: new Chain(mcp, net), block: flags.block });
    await writeJson(`${storePath}.tmp`, run.store);
    await rename(`${storePath}.tmp`, storePath);
    if (flags.proof) {
      const proof = proofFile({ task: "23", capability: "whale-watcher", about: "One Whale-Watching Agent run: the watchlist and the store it started from (input), the run with its significant moves, each address's report and the store it left (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several in run order.", mcp, network: net, startedAt: started, input: { watchlist: json, store }, result: run });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printWhales(run, storePath);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

function printGas(run: GasRun, storePath: string): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  const d = run.dryRun;
  out(`Pharos Gas Fee Optimizer · ${run.plan}`);
  out();
  out(`  Network      ${run.network.name} (chain ${run.network.chainId})`);
  out(`  Chain MCP    ${run.chainMcp.where}${run.chainMcp.server ? ` (${run.chainMcp.server})` : ""}`);
  out(`  Block        ${n(run.block.number)} · ${run.block.timestamp}`);
  out(`  Transaction  ${d.summary} (${d.verdict === "would-succeed" ? `would succeed${d.gas ? `, ${n(d.gas.gas)} gas` : ""}` : d.verdict === "cannot-pay" ? "cannot pay its fee" : "would revert"})`);
  out(`  Store        ${storePath}`);
  out();
  const fresh = new Set(run.observed.map((o) => o.block));
  for (const [index, o] of run.window.entries()) {
    const full = BigInt(o.gasLimit) > 0n ? Number((BigInt(o.gasUsed) * 1000n) / BigInt(o.gasLimit)) / 10 : 0;
    out(`  ${index === 0 ? "Observed    " : "            "} block ${n(o.block).padStart(11)}  ${formatGwei(BigInt(o.fee)).padStart(16)}  ${`${full}% full`.padStart(9)}${o.block === run.block.number ? "  now" : fresh.has(o.block) ? "  read now" : ""}`);
  }
  out(`  ${run.fee.source === "base-fee" ? "Base fee    " : "Gas price   "} now ${run.fee.shown.now} · lowest ${run.stats.shown.min} · median ${run.stats.shown.median} · highest ${run.stats.shown.max}`);
  out(`  Target       ${run.target.shown}: ${run.target.how}`);
  out(`  Decision     ${{ send: "SEND NOW", wait: "WAIT", blocked: "NOT SENDABLE", sent: "ALREADY SENT" }[run.decision]}: ${run.reason}`);
  if (run.settings) out(`  Settings     maxFeePerGas ${run.settings.shown.maxFeePerGas} · maxPriorityFeePerGas ${run.settings.shown.maxPriorityFeePerGas}`);
  const c = run.costs;
  if (c) {
    out(`  Cost         now ${c.shown.now} · at the target ${c.shown.atTarget}${BigInt(c.saving) > 0n ? ` · waiting saves ${c.shown.saving}` : ""}`);
    out(`               at most ${c.shown.cappedMax} with this cap, against ${c.shown.standardMax} with the usual one (twice the base fee plus the priority fee)`);
  }
  const x = run.execution;
  if (x) out(`  Sent         ${x.txHash} · ${x.status}${x.blockNumber ? ` in block ${n(x.blockNumber)}` : ""}${x.cost ? ` · cost ${formatAmount(BigInt(x.cost), 18, 8)} ${network(run.network.id).nativeSymbol}` : ""}`);
  else if (run.notSent) out(`  Sent         ${run.notSent}`);
  out();
  out(`  ${run.toolCalls} Chain MCP calls.`);
}

async function gasPlan(flags: Flags): Promise<number> {
  let key: Signer | undefined;
  const keySigner = () => (key ??= signerFromEnv());
  const name = flags.positional[1] ?? "usdc";
  const preset = GAS_PRESETS[name];
  let text: string;
  if (preset) text = JSON.stringify(preset());
  else {
    try {
      text = await readFile(name, "utf8");
    } catch {
      throw new AgentError("usage", `No gas plan preset or file "${name}".`, "Presets: usdc (mainnet), atlantic-usdc (testnet, from PRIVATE_KEY's address). Or pass a path to a gas plan JSON file.");
    }
  }
  // "$SIGNER" stands for the address of PRIVATE_KEY.
  if (text.includes("$SIGNER")) {
    if (!process.env.PRIVATE_KEY) throw new AgentError("usage", `"${name}" sends from your own wallet ($SIGNER), so it needs PRIVATE_KEY (an Atlantic testnet key) for the address.`, "export PRIVATE_KEY=0x... (never commit it)");
    text = text.replaceAll("$SIGNER", keySigner().address);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentError("usage", `${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const plan = parseGasPlan(json);
  const net = network(plan.network);
  if (flags.execute && net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (network: atlantic-testnet).");
  const storePath = flags.store ?? "gas-store.json";
  let saved: string | null = null;
  try {
    saved = await readFile(storePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${storePath} cannot be read: ${errorMessage(error)}`);
  }
  let stored: unknown = null;
  if (saved !== null) {
    try {
      stored = JSON.parse(saved);
    } catch (error) {
      throw new AgentError("usage", `The store ${storePath} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const store = stored === null ? emptyGasStore(plan) : parseGasStore(stored, plan);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 120 });
  try {
    const run = await runGasPlan(plan, store, { chain: new Chain(mcp, net), block: flags.block, signer: flags.execute ? keySigner() : undefined });
    await writeJson(`${storePath}.tmp`, run.store);
    await rename(`${storePath}.tmp`, storePath);
    if (flags.proof) {
      const proof = proofFile({ task: "24", capability: "gas-optimizer", about: "One Gas Fee Optimizer run: the plan and the store it started from (input), the observations, the decision, the fee settings and costs, the dry run, any transaction sent and the store it left (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several in run order.", mcp, network: net, startedAt: started, input: { plan: json, store }, result: run });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printGas(run, storePath);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return run.execution && !run.execution.matched ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

function printExplanation(x: Explanation): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out("Pharos dApp Support Agent");
  out();
  out(`  Network      ${x.network.name} (chain ${x.network.chainId})`);
  out(`  Chain MCP    ${x.chainMcp.where}${x.chainMcp.server ? ` (${x.chainMcp.server})` : ""}`);
  out(`  Asked        ${x.request.kind === "hash" ? `the transaction ${x.request.hash}` : "a transaction described, not sent"}`);
  if (x.transaction) out(`  Transaction  ${x.transaction.summary} (from ${x.transaction.from})`);
  if (x.block) out(`  Block        ${n(x.block.number)} · ${x.block.timestamp}`);
  out(`  Status       ${{ succeeded: "SUCCEEDED", failed: "FAILED", pending: "PENDING", "not-found": "NOT FOUND", "would-succeed": "WOULD SUCCEED", "would-fail": "WOULD FAIL" }[x.status]}`);
  out();
  const width = Math.max(...x.findings.map((f) => f.check.length));
  for (const f of x.findings) out(`  ${f.tone === "cause" ? "!" : " "} ${f.check.padEnd(width)}  ${f.seen}   [${f.tool}]`);
  out();
  if (x.cause) out(`  Why          ${x.cause.text}`);
  if (x.cause?.error?.name) out(`  Error        ${x.cause.error.name}${Object.keys(x.cause.error.args).length ? ` (${Object.entries(x.cause.error.args).map(([k, v]) => `${k}: ${v}`).join(", ")})` : ""}`);
  if (x.fix) out(`  Fix          ${x.fix}`);
  if (!x.cause) out(`  ${x.headline}`);
  out();
  out(`  ${x.toolCalls} Chain MCP calls. Nothing was signed or sent.`);
}

async function explainCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const first = flags.positional[1];
  let input: Record<string, unknown>;
  if (first?.startsWith("0x")) input = { kind: "hash", hash: first };
  else {
    const kind = first ?? "erc20-transfer";
    const example = net.id === "pharos-mainnet";
    const intent: Record<string, unknown> = { kind, from: v.from ?? (example ? EXAMPLE_PAYER : undefined), to: v.to ?? (example && kind !== "call" ? EXAMPLE_RECIPIENT : undefined), amount: v.amount ?? (kind === "native-transfer" ? "0.01" : "25") };
    if (kind === "erc20-transfer" || kind === "erc20-approve") intent.token = tokenFor(net, v.token ?? "USDC");
    if (kind === "erc20-approve") intent.spender = v.spender;
    if (kind === "call") {
      intent.signature = v.signature;
      try {
        intent.args = v.args ? (JSON.parse(v.args) as unknown) : [];
      } catch {
        throw new AgentError("usage", "--args must be a JSON list, like '[\"1000\"]'.");
      }
      intent.value = v.value ?? "0";
    }
    input = { kind: "intent", intent };
  }
  const request = parseExplainRequest(input, net.id);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 40 });
  try {
    const result = await explainTx(request, { chain: new Chain(mcp, net) });
    if (flags.proof) {
      const proof = proofFile({ task: "27", capability: "dapp-support", about: "One dApp Support Agent answer: the transaction asked about (input), the explanation with every finding (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: request, result });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(result, null, 2));
    else printExplanation(result);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

function printRisk(r: RiskReport): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  const c = r.counterparty;
  out("Pharos Wallet Risk Checker");
  out();
  out(`  Network       ${r.network.name} (chain ${r.network.chainId})`);
  out(`  Chain MCP     ${r.chainMcp.where}${r.chainMcp.server ? ` (${r.chainMcp.server})` : ""}`);
  out(`  Block         ${n(r.block.number)} · ${r.block.timestamp}`);
  out(`  Transaction   ${r.transaction.summary}`);
  out(`  Counterparty  ${c.address} (the ${r.transaction.role}): ${c.code === "none" ? "no code" : c.code === "delegated" ? `delegated to ${c.delegate}` : `a contract${c.token ? ` (${c.token})` : ""}`}, nonce ${n(c.nonce)}, ${c.balanceShown}`);
  if (r.history) out(`  History       blocks ${n(r.history.from)}–${n(r.history.to)}, ${r.history.token}: ${r.history.transfers} ${r.history.transfers === 1 ? "transfer" : "transfers"} by either, ${r.history.withSender} between them, ${r.history.zeroValue} of nothing`);
  out();
  if (!r.signals.length) out("  No signals.");
  for (const s of r.signals) out(`  ${s.severity.toUpperCase().padEnd(6)}  ${s.title}: ${s.detail}   [${s.tool}]`);
  out();
  out(`  Risk          ${r.level.toUpperCase()}: ${{ "do-not-send": "do not send", "check-first": "check first", "looks-fine": "nothing suspicious found" }[r.verdict]}`);
  out(`  ${r.toolCalls} Chain MCP calls. Nothing was signed or sent.`);
}

async function riskCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const kind = flags.positional[1] ?? "erc20-transfer";
  const example = net.id === "pharos-mainnet";
  const intent: Record<string, unknown> = { kind, from: v.from ?? (example ? EXAMPLE_PAYER : undefined), to: v.to ?? (example && kind !== "call" ? EXAMPLE_RECIPIENT : undefined), amount: v.amount ?? (kind === "native-transfer" ? "0.01" : "25") };
  if (kind === "erc20-transfer" || kind === "erc20-approve") intent.token = tokenFor(net, v.token ?? "USDC");
  if (kind === "erc20-approve") intent.spender = v.spender;
  if (kind === "call") {
    intent.signature = v.signature;
    try {
      intent.args = v.args ? (JSON.parse(v.args) as unknown) : [];
    } catch {
      throw new AgentError("usage", "--args must be a JSON list, like '[\"1000\"]'.");
    }
    intent.value = v.value ?? "0";
  }
  const request = parseDryRun({ network: net.id, intent });
  let blocks = DEFAULT_BLOCKS;
  if (v.blocks !== undefined) {
    if (!/^\d+$/.test(v.blocks) || Number(v.blocks) < 1 || Number(v.blocks) > MAX_BLOCKS) throw new AgentError("usage", `--blocks must be a whole number from 1 to ${MAX_BLOCKS.toLocaleString("en-US")}.`);
    blocks = Number(v.blocks);
  }
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const report = await checkRisk(request.intent, { chain: new Chain(mcp, net), blocks, block: flags.block });
    if (flags.proof) {
      const proof = proofFile({ task: "25", capability: "risk-checker", about: "One Wallet Risk Checker run: the planned transaction and the blocks of history read (input), the signals, the risk level and the verdict (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { intent: request.intent, blocks }, result: report });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(report, null, 2));
    else printRisk(report);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

function printAudit(r: AuditReport): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out("Pharos Audit-Log Agent");
  out();
  out(`  Network       ${r.network.name} (chain ${r.network.chainId})`);
  out(`  Chain MCP     ${r.chainMcp.where}${r.chainMcp.server ? ` (${r.chainMcp.server})` : ""}`);
  out(`  Address       ${r.address} (${r.account.code === "none" ? "a wallet" : r.account.code === "delegated" ? `a wallet delegated to ${r.account.delegate}` : "a contract"})`);
  out(`  Period        ${r.period.description}: blocks ${n(r.period.from.number)}–${n(r.period.to.number)}, ${r.period.from.timestamp} to ${r.period.to.timestamp}`);
  out();
  for (const line of r.summary) out(`  ${line}`);
  if (r.events.length) {
    const total = r.events.length + r.truncated;
    out();
    out(`  Timeline, newest first${total > 10 ? ` (10 of ${total.toLocaleString("en-US")})` : ""}; times estimated from the block number:`);
    for (const e of r.events.slice(0, 10)) out(`    ${n(e.block).padStart(12)}  ~${e.approxTime.slice(11, 19)}  ${e.text}  ${e.tx}`);
  }
  out();
  out(`  ${r.toolCalls} Chain MCP calls, ${r.scanned.pages} of them get_logs. Nothing was signed or sent.`);
}

async function auditCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const target = flags.positional[1] ?? (net.id === "pharos-mainnet" ? EXAMPLE_PAYER : undefined);
  if (!target) throw new AgentError("usage", "audit needs an address on this network.");
  const address = parseAuditAddress(target);
  const period = parsePeriod({ hours: v.hours, since: v.since, until: v.until, fromBlock: v["from-block"], toBlock: v["to-block"] });
  const endpoint = endpointFor(net, flags);
  const started = new Date();
  // Pacing waits are said even without --verbose: a long period takes minutes at the hosted endpoint's rate.
  const trace = (line: string) => (flags.verbose || line.startsWith("pacing:")) && process.stderr.write(`  ${line}\n`);
  const mcp = await ChainMcp.connect(endpoint, { trace, budget: (MAX_AUDIT_BLOCKS / 1000) * 2 + 80, pace: endpoint.kind === "hosted" ? { calls: 100 } : undefined });
  try {
    const report = await auditAddress(address, period, { chain: new Chain(mcp, net), maxBlocks: MAX_AUDIT_BLOCKS, block: flags.block });
    if (flags.proof) {
      const proof = proofFile({ task: "26", capability: "audit-log", about: "One Audit-Log Agent report: the address and the period asked (input), the report with its figures and sentences (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { address, period, maxBlocks: MAX_AUDIT_BLOCKS }, result: report });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(report, null, 2));
    else printAudit(report);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

function printDigest(r: DigestRun, storePath: string | undefined): void {
  const n = (value: string) => BigInt(value).toLocaleString("en-US");
  out("Pharos Weekly Digest Agent");
  out();
  out(`  Network       ${r.network.name} (chain ${r.network.chainId})`);
  out(`  Chain MCP     ${r.chainMcp.where}${r.chainMcp.server ? ` (${r.chainMcp.server})` : ""}`);
  out(`  Subject       ${r.subject.kind === "token" ? `${r.subject.label} (${r.subject.address}), the token` : `${r.subject.address}, a wallet`}, every ${r.every}`);
  out(`  Newest block  ${n(r.head.number)} · ${r.head.timestamp}`);
  const show = (d: PeriodDigest) => {
    out();
    out(`  ${d.label.charAt(0).toUpperCase()}${d.label.slice(1)}${d.complete ? "" : ", so far"}${d.blocks ? ` (blocks ${n(d.blocks.from)}–${n(d.blocks.to)})` : ""}`);
    for (const line of d.sentences) out(`    ${line}`);
  };
  for (const d of r.digests) show(d);
  if (r.current) show(r.current);
  if (!r.digests.length && !r.current) {
    out();
    out(`  ${r.headline}`);
  }
  out();
  if (r.now.supplyShown !== null) out(`  Now: a total supply of ${r.now.supplyShown} ${r.subject.label}.`);
  else out(`  Now it holds ${r.now.holdings.length ? r.now.holdings.map((h) => `${h.shown} ${h.symbol}`).join(", ") : "nothing of PROS or the official tokens"}.`);
  if (r.behind) out(`  ${r.behind} more ${r.behind === 1 ? "period has" : "periods have"} ended; the next run digests ${r.behind === 1 ? "it" : "them"}.`);
  if (r.cut) out(`  The oldest ${r.cut === 1 ? "period" : `${r.cut} periods`} asked for did not fit in the blocks one run reads, and ${r.cut === 1 ? "is" : "are"} left out.`);
  out(`  ${r.toolCalls} Chain MCP calls${r.scanned ? `, ${r.scanned.pages} of them get_logs` : ""}. Nothing was signed or sent.`);
  if (storePath) out(`  Store: ${storePath} (${r.store.digested ? `the last digest ended at ${r.store.digested}` : "nothing digested yet"}).`);
}

async function digestCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const subject = parseSubject(flags.positional[1] ?? "usdc", net);
  const every = parseEvery(v.every ?? "week");
  let periods: number | undefined;
  if (v.periods !== undefined) {
    if (!/^\d+$/.test(v.periods) || Number(v.periods) < 1 || Number(v.periods) > MAX_PERIODS) throw new AgentError("usage", `--periods must be a whole number from 1 to ${MAX_PERIODS}.`);
    if (flags.store) throw new AgentError("usage", "--periods is for a run without a store; with one, each period completed since the last run is digested.");
    periods = Number(v.periods);
  }
  const key = digestKey(net.id, subjectName(subject), every);
  let store = emptyDigestStore(key);
  let input: unknown = null;
  if (flags.store) {
    let saved: string | null = null;
    try {
      saved = await readFile(flags.store, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${flags.store} cannot be read: ${errorMessage(error)}`);
    }
    if (saved !== null) {
      try {
        input = JSON.parse(saved);
      } catch (error) {
        throw new AgentError("usage", `The store ${flags.store} is not valid JSON: ${errorMessage(error)}`);
      }
      store = parseDigestStore(input, key);
    }
  }
  const endpoint = endpointFor(net, flags);
  const started = new Date();
  // Pacing waits are said even without --verbose: a week of a protocol takes minutes at the hosted endpoint's rate.
  const trace = (line: string) => (flags.verbose || line.startsWith("pacing:")) && process.stderr.write(`  ${line}\n`);
  const mcp = await ChainMcp.connect(endpoint, { trace, budget: (MAX_RUN_BLOCKS / 1000) * 2 + 400, pace: endpoint.kind === "hosted" ? { calls: 100 } : undefined });
  try {
    const run = await runDigest(subject, every, store, { chain: new Chain(mcp, net), periods, soFar: flags.soFar, block: flags.block });
    if (flags.store) {
      await writeJson(`${flags.store}.tmp`, run.store);
      await rename(`${flags.store}.tmp`, flags.store);
    }
    if (flags.proof) {
      const proof = proofFile({ task: "28", capability: "digest", about: "One Weekly Digest Agent run: the subject, the cadence and the store it started from (input), the digests with their figures and sentences and the store it left (result), and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several in run order.", mcp, network: net, startedAt: started, input: { subject: subjectName(subject), every, periods, soFar: flags.soFar, store: flags.store ? store : null }, result: run });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printDigest(run, flags.store);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

const VERDICTS: Record<DocsChainResult["verdict"], string> = { confirmed: "CONFIRMED", mismatch: "MISMATCH", "no-contract": "NO CONTRACT", "other-network": "OTHER NETWORK", "nothing-to-call": "NOTHING TO CALL", "no-answer": "NOT IN THE DOCS" };

function printDocsChain(r: DocsChainResult): void {
  out("Pharos Docs MCP + Chain MCP Agent");
  out();
  out(`  Question     ${r.question}`);
  out(`  Docs MCP     ${r.docsMcp.where}`);
  out(`  Network      ${r.network.name} (chain ${r.network.chainId})`);
  out(`  Chain MCP    ${r.chainMcp.where}${r.chainMcp.server ? ` (${r.chainMcp.server})` : ""}`);
  out(`  Block        ${BigInt(r.block.number).toLocaleString("en-US")} · ${r.block.timestamp}`);
  if (r.docs.answer) {
    out();
    out("  The docs say:");
    for (const line of r.docs.answer.split("\n")) out(line.trim() ? `    ${line}` : "");
    if (r.docs.sources.length) out(`  Sources: ${r.docs.sources.map((s) => s.url).join(", ")}`);
  }
  out();
  r.steps.forEach((step, i) => out(`  ${String(i + 1).padStart(2)}. ${step.text}   [${step.source}]`));
  out();
  out(`  Verdict      ${VERDICTS[r.verdict]}: ${r.headline}`);
  out(`  ${r.toolCalls.docs} Developer Docs MCP and ${r.toolCalls.chain} Chain MCP calls. Nothing was signed or sent.`);
}

async function askCommand(flags: Flags): Promise<number> {
  const net = network(flags.values.network ?? "pharos-mainnet");
  // The question in one argument, or in several words without quotes.
  const question = parseQuestion(flags.positional.slice(1).join(" "));
  const trace = flags.verbose ? (line: string) => process.stderr.write(`  ${line}\n`) : undefined;
  const docs = new DocsMcp(flags.docsMcp ?? DOCS_MCP, { budget: 4, trace });
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace, budget: 40 });
  try {
    const result = await docsThenChain(question, { docs, chain: new Chain(mcp, net), block: flags.block });
    if (flags.proof) {
      const proof: ProofFile = { ...proofFile({ task: "13", capability: "docs-chain", about: "One Docs MCP + Chain MCP Agent answer: the question (input); the docs' answer, the contracts it names, what the chain says of each and the verdict (result); every JSON-RPC message exchanged with the Pharos Chain MCP server (transcript) and with the Pharos Developer Docs MCP (docsMcp), in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { question }, result }), docsMcp: { endpoint: docs.where, transcript: docs.recorder.messages } };
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(result, null, 2));
    else printDocsChain(result);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

const HOW_TO_VERDICTS: Record<HowToResult["verdict"], string> = { ready: "READY", "would-fail": "WOULD FAIL", sent: "SENT", read: "READ", "not-prepared": "NOT PREPARED", "no-answer": "NOT IN THE DOCS" };

function printHowTo(r: HowToResult): void {
  out("Pharos Doc-Grounded Builder Agent");
  out();
  out(`  Question     ${r.question}`);
  out(`  Docs MCP     ${r.docsMcp.where}`);
  out(`  Network      ${r.network.name} (chain ${r.network.chainId})`);
  out(`  Chain MCP    ${r.chainMcp.where}${r.chainMcp.server ? ` (${r.chainMcp.server})` : ""}`);
  out(`  Block        ${BigInt(r.block.number).toLocaleString("en-US")} · ${r.block.timestamp}`);
  if (r.docs.answer) {
    out();
    out("  The docs say:");
    for (const line of r.docs.answer.split("\n")) out(line.trim() ? `    ${line}` : "");
    if (r.docs.sources.length) out(`  Sources: ${r.docs.sources.map((s) => s.url).join(", ")}`);
  }
  out();
  r.steps.filter((step) => step.source !== "the verdict").forEach((step, i) => out(`  ${String(i + 1).padStart(2)}. ${step.text}   [${step.source}]`));
  if (r.skillEngine) {
    out();
    out(`  With the Skill Engine (${r.skillEngine.repo}, ${r.skillEngine.commit.slice(0, 7)}), not run here:`);
    for (const c of r.skillEngine.commands) out(`    ${c.command}`);
  }
  out();
  out(`  Verdict      ${HOW_TO_VERDICTS[r.verdict]}: ${r.headline}`);
  const sent = r.prepared?.submission;
  out(`  ${r.toolCalls.docs} Developer Docs MCP and ${r.toolCalls.chain} Chain MCP calls. ${sent ? `Signed here and sent: ${sent.txHash}.` : "Nothing was signed or sent."}`);
}

async function howToCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const question = parseQuestion(flags.positional.slice(1).join(" "));
  if (flags.execute && net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (--network atlantic-testnet).");
  const signer = flags.execute ? signerFromEnv() : undefined;
  const inputs: ActionInputs = { from: v.from ?? signer?.address, to: v.to ?? v.spender, amount: v.amount, token: v.token };
  for (const key of Object.keys(inputs) as (keyof ActionInputs)[]) if (inputs[key] === undefined) delete inputs[key];
  // The question and the inputs are checked before anything starts.
  parseAction(question, inputs, net);
  const trace = flags.verbose ? (line: string) => process.stderr.write(`  ${line}\n`) : undefined;
  const docs = new DocsMcp(flags.docsMcp ?? DOCS_MCP, { budget: 4, trace });
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace, budget: 60 });
  try {
    const result = await howTo(question, { docs, chain: new Chain(mcp, net), inputs, block: flags.block, signer });
    if (flags.proof) {
      const proof: ProofFile = { ...proofFile({ task: "29", capability: "how-to", about: "One Doc-Grounded Builder Agent answer: the question and the values given (input); the docs' answer, the action, its pieces against the Skill Engine's, the dry run (and the send, on Atlantic), the Skill Engine's commands and the verdict (result); every JSON-RPC message exchanged with the Pharos Chain MCP server (transcript) and with the Pharos Developer Docs MCP (docsMcp), in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { question, inputs }, result }), docsMcp: { endpoint: docs.where, transcript: docs.recorder.messages } };
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(result, null, 2));
    else printHowTo(result);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return result.prepared?.submission && !result.prepared.submission.matched ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

const FLOW_VERDICTS: Record<PaymentFlow["verdict"], string> = { ready: "READY", short: "SHORT", "would-fail": "WOULD FAIL", sent: "SENT", "partly-sent": "PARTLY SENT" };

function printPaymentFlow(f: PaymentFlow): void {
  const n = (value: string | number) => BigInt(value).toLocaleString("en-US");
  out("Pharos Natural-Language Payment Agent");
  out();
  out(`  Request      ${f.request}`);
  out(`  Network      ${f.network.name} (chain ${f.network.chainId})`);
  out(`  Chain MCP    ${f.chainMcp.where}${f.chainMcp.server ? ` (${f.chainMcp.server})` : ""}`);
  out(`  Block        ${n(f.block.number)} · ${f.block.timestamp}`);
  out(`  Sender       ${f.sender.address} (${{ input: "given", request: "the request's", example: "the example's" }[f.sender.from]}), next nonce ${f.nonce}`);
  for (const p of f.payments) {
    out();
    const to = p.to.name ? `${p.to.name} (${p.to.address})` : p.to.address;
    out(`  ${String(p.n).padStart(2)}. ${p.amount} ${p.asset} to ${to}${p.share ? ` (${p.share === "each" ? "each" : "a share of the split"})` : ""}${p.memo ? `, for ${p.memo}` : ""}`);
    out(`      ${p.dryRun.verdict === "would-succeed" ? "would succeed" : p.dryRun.verdict === "would-revert" ? "would revert" : "cannot pay"}${p.dryRun.gas ? `, ${n(p.dryRun.gas.gas)} gas` : ""}${p.tx ? `, nonce ${p.tx.nonce}` : ""}${p.dryRun.reason ? `: ${p.dryRun.reason}` : ""}`);
    out(`      ${p.command}`);
    if (p.submission) out(`      sent: ${p.submission.txHash}, ${p.submission.status}${p.submission.status === "success" ? `, receipt ${p.submission.matched ? "matches" : "does not match"}` : ""}`);
  }
  out();
  f.totals.forEach((t, k) => out(`  ${k === 0 ? "Totals      " : "            "} ${t.asset}: ${t.raw === "0" ? "" : `${t.shown} in all; `}needs ${t.needsShown}, holds ${t.holdsShown}${t.covered ? "" : " (not enough)"}`));
  out(`  Verdict      ${FLOW_VERDICTS[f.verdict]}: ${f.headline}`);
  const sent = f.payments.filter((p) => p.submission);
  out(`  ${f.toolCalls} Chain MCP calls. ${sent.length ? `Signed here and sent: ${sent.map((p) => p.submission!.txHash).join(", ")}.` : "Nothing was signed or sent."}`);
}

async function payCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const request = flags.positional.slice(1).join(" ");
  if (flags.execute && net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (--network atlantic-testnet).");
  let contactsInput: unknown = undefined;
  if (v.contacts) {
    let text: string;
    try {
      text = await readFile(v.contacts, "utf8");
    } catch (error) {
      throw new AgentError("usage", `The address book ${v.contacts} cannot be read: ${errorMessage(error)}`);
    }
    try {
      contactsInput = text.trim().startsWith("{") ? (JSON.parse(text) as unknown) : text;
    } catch (error) {
      throw new AgentError("usage", `The address book ${v.contacts} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const contacts = parseContacts(contactsInput);
  const signer = flags.execute ? signerFromEnv() : undefined;
  if (v.from !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(v.from)) throw new AgentError("usage", "--from must be a 0x address (40 hex characters).");
  const from = (v.from as `0x${string}` | undefined) ?? signer?.address;
  // The request is read whole before anything starts.
  parseRequest(request, contacts, net);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 160 });
  try {
    const flow = await preparePayments(request, { chain: new Chain(mcp, net), contacts, from, block: flags.block, signer });
    if (flags.proof) {
      const proof = proofFile({ task: "17", capability: "payment-flow", about: "One Natural-Language Payment Agent flow: the request, the address book and the sender given (input); every payment read from it, each dry-run, the totals, the transactions to sign, the Skill Engine's commands and the verdict, with each send on Atlantic (result); and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { request, contacts, from, maxPayments: 10 }, result: flow });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(flow, null, 2));
    else printPaymentFlow(flow);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return flow.verdict === "partly-sent" || flow.payments.some((p) => p.submission && !p.submission.matched) ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

const INVOICE_VERDICTS: Record<InvoicePayment["verdict"], string> = { ready: "READY", "check-first": "CHECK FIRST", short: "SHORT", "would-fail": "WOULD FAIL", sent: "SENT", "not-sent": "NOT SENT" };
const MARKS: Record<InvoicePayment["checks"][number]["state"], string> = { ok: "ok  ", info: "info", warn: "warn", fail: "fail" };

function printInvoicePayment(r: InvoicePayment): void {
  const n = (value: string | number) => BigInt(value).toLocaleString("en-US");
  const inv = r.invoice;
  const p = r.payment;
  out("Pharos Invoice-to-Payment Agent");
  out();
  out(`  Invoice      ${inv.number ?? "(no number)"}${inv.issuer ? ` from ${inv.issuer}` : ""}${inv.billTo ? `, billed to ${inv.billTo}` : ""}`);
  out(`  Amount due   ${p.amount} ${p.asset}${r.due.date ? `, ${r.due.words} (${r.due.date})` : ""}`);
  const book = r.payee.book;
  const said = book.status === "matches" || book.status === "listed" ? `${book.name} in your payees` : book.status === "other-name" ? `${book.name} in your payees, not ${inv.issuer ?? inv.payee.name}` : book.status === "differs" ? `not the address your payees give ${book.name}` : "not in your payees";
  out(`  Pay to       ${r.payee.address} (${said})`);
  out(`  Network      ${r.network.name} (chain ${r.network.chainId})`);
  out(`  Chain MCP    ${r.chainMcp.where}${r.chainMcp.server ? ` (${r.chainMcp.server})` : ""}`);
  out(`  Block        ${n(r.block.number)} · ${r.block.timestamp}`);
  out(`  Payer        ${r.payer.address} (${{ input: "given", invoice: "the invoice's bill-to", example: "the example's" }[r.payer.from]}), next nonce ${r.nonce}`);
  out();
  r.checks.forEach((c, k) => out(`  ${k === 0 ? "Checks      " : "            "} ${MARKS[c.state]}  ${c.title}: ${c.detail}`));
  out();
  out(`  Payment      ${p.dryRun.verdict === "would-succeed" ? "would succeed" : p.dryRun.verdict === "would-revert" ? "would revert" : "cannot pay"}${p.dryRun.gas ? `, ${n(p.dryRun.gas.gas)} gas` : ""}${p.tx ? `, nonce ${p.tx.nonce}` : ""}`);
  out(`               ${p.command}`);
  out(`  Link         ${r.link}`);
  if (p.submission) out(`  Sent         ${p.submission.txHash}, ${p.submission.status}${p.submission.status === "success" ? `, receipt ${p.submission.matched ? "matches" : "does not match"}` : ""}`);
  if (inv.notRead.length) out(`  Not read     ${inv.notRead.join(" · ")}`);
  out(`  Verdict      ${INVOICE_VERDICTS[r.verdict]}: ${r.headline}`);
  out(`  ${r.toolCalls} Chain MCP calls. ${p.submission ? `Signed here and sent: ${p.submission.txHash}.` : "Nothing was signed or sent."}`);
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return path === "-" ? await new Promise<string>((resolve, reject) => {
      let text = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (text += chunk));
      process.stdin.on("end", () => resolve(text));
      process.stdin.on("error", reject);
    }) : await readFile(path, "utf8");
  } catch (error) {
    throw new AgentError("usage", `${what} ${path} cannot be read: ${errorMessage(error)}`);
  }
}

/** The CLI reads invoices longer than the page does. */
const CLI_MAX_INVOICE = 12_000;

async function invoiceCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const source = flags.positional[1];
  if (!source || flags.positional.length > 2) throw new AgentError("usage", 'invoice needs one invoice: a file of its lines, "-" for standard input, or a payment link in quotes ("ethereum:…").');
  if (flags.execute && net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (--network atlantic-testnet).");
  const text = /^ethereum:/i.test(source) ? source : await readText(source, "The invoice");
  let payeesInput: unknown = undefined;
  if (v.payees) {
    const book = await readText(v.payees, "The payees file");
    try {
      payeesInput = book.trim().startsWith("{") ? (JSON.parse(book) as unknown) : book;
    } catch (error) {
      throw new AgentError("usage", `The payees file ${v.payees} is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const payees = parsePayees(payeesInput);
  const blocks = v.blocks === undefined ? INVOICE_BLOCKS : Number(v.blocks);
  const signer = flags.execute ? signerFromEnv() : undefined;
  if (v.from !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(v.from)) throw new AgentError("usage", "--from must be a 0x address (40 hex characters).");
  const from = (v.from as `0x${string}` | undefined) ?? signer?.address;
  // The invoice is read whole before anything starts.
  readInvoice(text, net, CLI_MAX_INVOICE);
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const result = await payInvoice(text, { chain: new Chain(mcp, net), payees, from, block: flags.block, blocks, signer, maxInvoice: CLI_MAX_INVOICE });
    if (flags.proof) {
      const proof = proofFile({ task: "19", capability: "invoice-payment", about: "One Invoice-to-Payment Agent run: the invoice, your payees, the payer and the blocks of history given (input); the invoice as read, every check, the payment prepared (its dry run, the transaction to sign, the Skill Engine's command, its EIP-681 link) and the verdict, with the send on Atlantic (result); and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { invoice: text, payees: plainPayees(payees), from, blocks, maxInvoice: CLI_MAX_INVOICE }, result });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(result, null, 2));
    else printInvoicePayment(result);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return result.verdict === "check-first" ? 9 : result.verdict === "not-sent" || (result.payment.submission && !result.payment.submission.matched) ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

const RECURRING_VERDICTS: Record<RecurringRun["verdict"], string> = { "nothing-due": "NOTHING DUE", ready: "READY", short: "SHORT", "would-fail": "WOULD FAIL", sent: "SENT", "partly-sent": "PARTLY SENT" };

function printRecurring(r: RecurringRun, storePath: string | undefined): void {
  const n = (value: string | number) => BigInt(value).toLocaleString("en-US");
  out("Pharos Recurring Payment Agent");
  out();
  out(`  Schedule     ${r.items.length} ${r.items.length === 1 ? "payment" : "payments"}: ${r.items.map((i) => `${i.name}, ${i.amount} ${i.asset} ${i.every}`).join("; ")}`);
  out(`  Network      ${r.network.name} (chain ${r.network.chainId})`);
  out(`  Chain MCP    ${r.chainMcp.where}${r.chainMcp.server ? ` (${r.chainMcp.server})` : ""}`);
  out(`  Block        ${n(r.block.number)} · ${r.block.timestamp} (day ${r.today})`);
  out(`  Payer        ${r.payer.address} (${{ input: "given", store: "the store's", example: "the example's" }[r.payer.from]})${r.nonce !== null ? `, next nonce ${r.nonce}` : ""}`);
  out(`  Counting     from ${r.since} (${{ store: "the store's start", input: "given", month: "the first of the month", today: "today" }[r.sinceFrom]})`);
  out();
  out(`  Owed         ${r.owed.length === 0 ? "nothing" : `${r.owed.length}, oldest first; this run takes ${r.due.length}`}`);
  r.payments.forEach((p, k) => {
    const o = r.owed.find((owed) => owed.id === r.due[k])!;
    out(`  ${String(k + 1).padStart(3)}. ${p.memo} (${o.late === 0 ? "today" : `${o.late} ${o.late === 1 ? "day" : "days"} late`}): ${p.amount} ${p.asset} to ${p.to.address}`);
    out(`       ${p.dryRun.verdict === "would-succeed" ? "would succeed" : p.dryRun.verdict === "would-revert" ? "would revert" : "cannot pay"}${p.dryRun.gas ? `, ${n(p.dryRun.gas.gas)} gas` : ""}${p.tx ? `, nonce ${p.tx.nonce}` : ""}${p.dryRun.reason ? `: ${p.dryRun.reason}` : ""}`);
    out(`       ${p.command}`);
    if (p.submission) out(`       sent: ${p.submission.txHash}, ${p.submission.status}${p.submission.status === "success" ? `, receipt ${p.submission.matched ? "matches" : "does not match"}` : ""}`);
  });
  if (r.later) out(`  Waiting      ${r.later} more for the next run`);
  out(`  Next         ${r.items.filter((i) => i.next).map((i) => `${i.name} on ${i.next}`).join(", ") || "none: every payment has ended"}`);
  if (r.store) out(`  Store        ${storePath}: ${r.store.paid.length} recorded as paid${r.store.paid.some((p) => p.status === "pending") ? `, ${r.store.paid.filter((p) => p.status === "pending").length} pending` : ""}`);
  out(`  Verdict      ${RECURRING_VERDICTS[r.verdict]}: ${r.headline}`);
  const sent = r.payments.filter((p) => p.submission);
  out(`  ${r.toolCalls} Chain MCP calls. ${sent.length ? `Signed here and sent: ${sent.map((p) => p.submission!.txHash).join(", ")}.` : "Nothing was signed or sent."}`);
}

async function recurringCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  const net = network(v.network ?? "pharos-mainnet");
  const source = flags.positional[1];
  if (!source || flags.positional.length > 2) throw new AgentError("usage", 'recurring needs one schedule: a file of its lines, or "-" for standard input.');
  if (flags.execute && net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (--network atlantic-testnet).");
  if (flags.execute && !flags.store) throw new AgentError("usage", "--execute needs --store FILE: what is paid is recorded there, so nothing is paid twice.");
  if (v.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v.since)) throw new AgentError("usage", "--since must be a day as YYYY-MM-DD.");
  const text = await readText(source, "The schedule");
  const signer = flags.execute ? signerFromEnv() : undefined;
  if (v.from !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(v.from)) throw new AgentError("usage", "--from must be a 0x address (40 hex characters).");
  const from = (v.from as `0x${string}` | undefined) ?? signer?.address;
  // The schedule and the store are read whole before anything starts.
  readSchedule(text, net);
  let store: RecurringStore | null = null;
  if (flags.store) {
    let saved: string | null = null;
    try {
      saved = await readFile(flags.store, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw new AgentError("usage", `The store ${flags.store} cannot be read: ${errorMessage(error)}`);
    }
    if (saved !== null) {
      let raw: unknown;
      try {
        raw = JSON.parse(saved);
      } catch (error) {
        throw new AgentError("usage", `The store ${flags.store} is not valid JSON: ${errorMessage(error)}`);
      }
      store = parseRecurringStore(raw, net.id, from);
    }
  }
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 240 });
  try {
    const result = await runRecurring(text, { chain: new Chain(mcp, net), store, keep: Boolean(flags.store), from, since: v.since, block: flags.block, signer });
    if (flags.proof) {
      const proof = proofFile({ task: "18", capability: "recurring-payments", about: "One Recurring Payment Agent run: the schedule, the store it started from, the payer and the first day counted (input); every payment owed by the block's day, the ones this run took, each dry-run, the transactions to sign, the Skill Engine's commands, each send on Atlantic, the store it left and the verdict (result); and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>, or several runs in order as one history.", mcp, network: net, startedAt: started, input: { schedule: text, store, keep: Boolean(flags.store), from, since: v.since }, result });
      await writeJson(flags.proof, proof);
    }
    if (flags.store && result.store) {
      await writeJson(`${flags.store}.tmp`, result.store);
      await rename(`${flags.store}.tmp`, flags.store);
    }
    if (flags.json) out(JSON.stringify(result, null, 2));
    else printRecurring(result, flags.store);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return result.verdict === "partly-sent" || result.payments.some((p) => p.submission && !p.submission.matched) ? 8 : 0;
  } finally {
    await mcp.close();
  }
}

const X402_VERDICTS: Record<X402Run["verdict"], string> = { paid: "PAID", refused: "REFUSED", "not-settled": "NOT SETTLED", "not-paid": "NOT PAID" };

/** The asset: an official token's symbol, or an address; absent, the network's official USDC. */
function x402Asset(net: Network, value: string | undefined): `0x${string}` {
  if (value === undefined) {
    const usdc = net.tokens.find((t) => t.symbol === "USDC");
    if (!usdc) throw new AgentError("usage", `No official USDC on ${net.name}: give --token.`);
    return getAddress(usdc.address);
  }
  if (value.startsWith("0x")) {
    if (!isAddress(value)) throw new AgentError("usage", "--token must be an official token's symbol or a 0x address (with a valid checksum).");
    return getAddress(value);
  }
  const token = net.tokens.find((t) => t.symbol.toLowerCase() === value.toLowerCase());
  if (!token) throw new AgentError("usage", `"${value}" is not an official ${net.name} token: give its address.`);
  return getAddress(token.address);
}

/** The terms an endpoint is run with: the price, the cap, who is paid and the asset. */
function x402Terms(flags: Flags, net: Network): { price: string; cap?: string; payTo: `0x${string}`; asset: `0x${string}`; given?: `0x${string}` } {
  const v = flags.values;
  const number = (value: string | undefined, what: string) => {
    if (value !== undefined && !/^\d+(\.\d+)?$/.test(value)) throw new AgentError("usage", `${what} must be a number of the asset, like 0.001.`);
    return value;
  };
  if (v.to !== undefined && !isAddress(v.to)) throw new AgentError("usage", "--to must be a 0x address (with a valid checksum).");
  const asset = x402Asset(net, v.token);
  const payTo = getAddress(v.to ?? EXAMPLE_RECIPIENT);
  if (payTo === asset) throw new AgentError("usage", "--to is the asset's own contract: a payment to it would be lost.");
  if (/^0x0{40}$/.test(payTo)) throw new AgentError("usage", "--to cannot be the zero address.");
  return { price: number(v.price, "--price") ?? "0.001", cap: number(v.cap, "--cap"), payTo, asset, given: v.token === undefined ? undefined : asset };
}

function printX402(r: X402Run): void {
  const n = (value: string | number) => BigInt(value).toLocaleString("en-US");
  out("Pharos X402 Paywalled API");
  out();
  out(`  Network      ${r.network.name} (chain ${r.network.chainId}), x402 network ${r.network.x402}`);
  out(`  Chain MCP    ${r.chainMcp.where}${r.chainMcp.server ? ` (${r.chainMcp.server})` : ""}`);
  out(`  Block        ${n(r.block.number)} · ${r.block.timestamp}`);
  out(`  Asset        ${r.asset.name ?? "no name()"} (${r.asset.symbol ?? "no symbol()"}) at ${r.asset.address}, ${r.asset.version ? `version ${r.asset.version}` : "no version()"}, ${r.asset.decimals} decimals: ${r.asset.eip3009 ? "EIP-3009" : "not EIP-3009"}`);
  out(`  Endpoint     ${r.endpoint.method} ${r.endpoint.path}, ${r.endpoint.price.shown} a request, paid to ${r.payTo}`);
  out(`  Client       ${r.payer.key === "given" ? `PRIVATE_KEY's address, ${r.payer.address}` : `a key made for this run, holding nothing: ${r.payer.address}`}; pays at most ${r.cap.shown} a request`);
  out(`  Facilitator  ${r.facilitator.settles ? `settles with ${r.facilitator.address}` : "verifies only: it holds no key, so nothing can be sent"}`);
  out();
  r.steps.filter((s) => s.source !== "the verdict").forEach((s, k) => out(`  ${String(k + 1).padStart(3)}. ${s.source}: ${s.text}`));
  if (r.data !== null) out(`  Data         ${JSON.stringify(r.data)}`);
  out(`  Verdict      ${X402_VERDICTS[r.verdict]}: ${r.headline}`);
  out(`  ${r.toolCalls} Chain MCP calls. ${r.settlement ? `One transaction sent, by the facilitator: ${r.settlement.tx}.` : "No transaction was sent."}`);
}

async function x402Command(flags: Flags): Promise<number> {
  const sub = flags.positional[1] ?? "run";
  if (sub === "serve") return x402Serve(flags);
  if (sub === "pay") return x402Pay(flags);
  if (sub !== "run" || flags.positional.length > 2) throw new AgentError("usage", 'x402 takes run (the default), serve, or pay URL.');
  const net = network(flags.values.network ?? "pharos-mainnet");
  if (flags.execute && net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (--network atlantic-testnet).");
  const terms = x402Terms(flags, net);
  const payer = flags.execute ? accountFromEnv() : undefined;
  const facilitator = flags.execute ? signerFromEnv(process.env, process.env.FACILITATOR_PRIVATE_KEY ? "FACILITATOR_PRIVATE_KEY" : "PRIVATE_KEY") : undefined;
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 80 });
  try {
    const result = await runX402({ chain: new Chain(mcp, net), payer, facilitator, payTo: terms.payTo, price: terms.price, cap: terms.cap, asset: terms.asset });
    if (flags.proof) {
      const proof = proofFile({ task: "20", capability: "x402-payment", about: "One X402 Paywalled API run: the price, the client's cap, who is paid and the asset (input); the asset as the chain reports it, the endpoint's 402 terms, the authorization the client signed, the facilitator's verify and settle, the settlement's receipt, what the client received and the verdict (result); and every JSON-RPC message exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { payTo: terms.payTo, price: terms.price, cap: terms.cap, asset: terms.given }, result });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(result, null, 2));
    else printX402(result);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return result.verdict === "paid" ? 0 : 9;
  } finally {
    await mcp.close();
  }
}

async function x402Serve(flags: Flags): Promise<number> {
  const v = flags.values;
  if (flags.positional.length > 2) throw new AgentError("usage", "x402 serve takes options only.");
  const net = network(v.network ?? "pharos-mainnet");
  if (flags.execute && net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (--network atlantic-testnet).");
  if (flags.execute && v.facilitator) throw new AgentError("usage", "--execute settles with the built-in facilitator; --facilitator names another one.");
  if (v.facilitator !== undefined && !/^https?:\/\/\S+$/.test(v.facilitator)) throw new AgentError("usage", "--facilitator must be an http(s) URL.");
  if (v.cap !== undefined) throw new AgentError("usage", "--cap is the paying client's: see x402 pay.");
  const port = v.port === undefined ? 4020 : Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535 || !/^\d+$/.test(v.port ?? "0")) throw new AgentError("usage", "--port must be a port number.");
  const terms = x402Terms(flags, net);
  const signer = flags.execute ? signerFromEnv(process.env, process.env.FACILITATOR_PRIVATE_KEY ? "FACILITATOR_PRIVATE_KEY" : "PRIVATE_KEY") : null;
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 2_000 });
  const chain = new Chain(mcp, net);
  try {
    await chain.expectChain();
    const asset = await readAsset(chain, terms.asset, "latest");
    if (asset.decimals === null) throw new AgentError("usage", `${terms.asset} answers no decimals(): it is not a token the endpoint can price in.`);
    const amount = parseAmount(terms.price, asset.decimals, "--price");
    if (amount === 0n) throw new AgentError("usage", "--price must be more than zero.");
    // x402 answers a failed chain read as a failed check, so the operator is told what really happened.
    const builtIn = v.facilitator ? null : pharosFacilitator(chain, signer, { onFault: (error, signed) => process.stderr.write(`Chain MCP failed during a payment${signed ? `, after the settlement ${signed} was signed (check its receipt)` : ", which x402 answers as refused"}: ${errorMessage(error)}\n`) });
    const client = builtIn ? new LocalFacilitatorClient(builtIn) : new HTTPFacilitatorClient({ url: v.facilitator! });
    const price = `${formatAmount(amount, asset.decimals, asset.decimals)} ${asset.symbol ?? "units"}`;
    let url = "";
    // GET /data at --price, and Task 21's products (/risk, /dryrun) at their default prices.
    const decimals = asset.decimals;
    const products = productRoutes(chain, decimals, { data: terms.price });
    const shownPrice = (raw: string) => `${formatAmount(BigInt(raw), decimals, decimals)} ${asset.symbol ?? "units"}`;
    const endpoint = await paidEndpoint({
      chain,
      asset,
      payTo: terms.payTo,
      routes: products,
      facilitator: client,
      free: { "/": async () => ({ api: "Pharos X402 Paywalled API", x402: x402Network(net), paid: products.map((r) => ({ method: "GET", path: r.path, price: shownPrice(r.amount), amount: r.amount, asset: asset.address, payTo: terms.payTo, scheme: "exact", description: r.description })), facilitator: v.facilitator ?? `${url}/facilitator`, settles: Boolean(v.facilitator || signer) }) },
    });
    const routes = builtIn ? facilitatorRoutes(builtIn) : null;
    let served = 0;
    const server = await serveHttp(async (request) => {
      if (routes && new URL(request.url).pathname.startsWith("/facilitator/")) return routes(request);
      const response = await endpoint(request);
      if (response.status === 200 && response.headers.has("payment-response")) served += 1;
      return response;
    }, port);
    url = server.url;
    out("Pharos X402 Paywalled API");
    out();
    out(`  Serving      ${url} on ${net.name} (x402 network ${x402Network(net)})`);
    out(`  Paid         GET ${url}/data, ${price} a request (${amount} base units of ${asset.address}), paid to ${terms.payTo}`);
    for (const r of products.filter((product) => product.path !== "/data")) out(`               GET ${url}${r.path}?asset=…&from=…&to=…&amount=…, ${shownPrice(r.amount)} a request`);
    out(`  Free         GET ${url}/ (the terms)`);
    out(`  Facilitator  ${v.facilitator ?? `${url}/facilitator (POST /verify, POST /settle, GET /supported)`}${builtIn ? (signer ? `, settles with ${signer.address}` : ", verifies only: nothing paid is served") : ""}`);
    if (!asset.eip3009) out(`  Note         ${asset.address} does not answer EIP-3009: the exact scheme cannot settle in it.`);
    out(`  Pay it       pharos-agent x402 pay ${url}/data --network atlantic-testnet`);
    out("  Stop it      Ctrl-C");
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await server.close();
    process.stderr.write(`Stopped: ${served} paid ${served === 1 ? "request" : "requests"} served, each settled, ${mcp.toolCalls} Chain MCP calls.\n`);
    return 0;
  } finally {
    await mcp.close();
  }
}

async function x402Pay(flags: Flags): Promise<number> {
  const v = flags.values;
  const target = flags.positional[2];
  if (!target || flags.positional.length > 3 || !/^https?:\/\/\S+$/.test(target)) throw new AgentError("usage", "x402 pay needs one http(s) URL to ask.");
  const net = network(v.network ?? "pharos-mainnet");
  if (net.id !== "atlantic-testnet") throw new AgentError("usage", "x402 pay signs a payment, so it is limited to the Atlantic testnet (--network atlantic-testnet).");
  if (v.cap !== undefined && !/^\d+(\.\d+)?$/.test(v.cap)) throw new AgentError("usage", "--cap must be a number of the asset, like 0.001.");
  const asset = x402Asset(net, v.token);
  const decimals = net.tokens.find((t) => t.address.toLowerCase() === asset.toLowerCase())?.decimals;
  if (decimals === undefined) throw new AgentError("usage", "x402 pay pays in an official token only: give its symbol or address.");
  const cap = parseAmount(v.cap ?? "0.001", decimals, "--cap");
  const account = accountFromEnv();
  const seen: { status: number; required: string | null; signature: string | null; paymentResponse: string | null }[] = [];
  const recording: typeof fetch = async (input, init) => {
    const request = new Request(input as never, init);
    const response = await fetch(request);
    seen.push({ status: response.status, required: response.headers.get("payment-required"), signature: request.headers.get("payment-signature"), paymentResponse: response.headers.get("payment-response") });
    return response;
  };
  out("Pharos X402 client");
  out();
  out(`  Asking       GET ${target}`);
  out(`  Paying with  ${account.address}, at most ${formatAmount(cap, decimals, decimals)} of ${asset} a request, on ${x402Network(net)}`);
  let response: Response;
  try {
    response = await payingFetch(account, net, asset, cap.toString(), recording)(target);
  } catch (error) {
    out(`  Not paid     ${errorMessage(error)}`);
    return 9;
  }
  const required = seen.find((s) => s.required)?.required;
  const accepted = required ? decodePaymentRequiredHeader(required).accepts?.[0] : undefined;
  if (accepted) out(`  402 asked    ${accepted.amount} base units of ${accepted.asset} to ${accepted.payTo}, on ${accepted.network}, by the ${accepted.scheme} scheme`);
  const signature = seen.find((s) => s.signature)?.signature;
  const auth = signature ? (decodePaymentSignatureHeader(signature).payload as { authorization?: { value: string; to: string; validBefore: string } }).authorization : undefined;
  if (auth) out(`  Signed       an EIP-3009 authorization: ${auth.value} base units to ${auth.to}, valid until ${new Date(Number(auth.validBefore) * 1000).toISOString()}`);
  const settled = seen.at(-1)?.paymentResponse;
  if (settled) {
    const r = decodePaymentResponseHeader(settled) as { success?: boolean; transaction?: string; network?: string };
    out(`  Settled      ${r.success ? `${r.transaction} on ${r.network}` : "no"}`);
  }
  const last = seen.at(-1);
  const refused = response.status === 402 && last?.signature && last.required ? decodePaymentRequiredHeader(last.required).error : undefined;
  if (refused) out(`  Refused      ${refused}`);
  const body = await response.text();
  out(`  Answer       ${response.status}${body ? `: ${body.length > 2_000 ? `${body.slice(0, 2_000)}…` : body}` : ""}`);
  return response.status === 200 ? 0 : 9;
}

const BUYER_VERDICTS: Record<BuyerRun["verdict"], string> = { ready: "READY", "do-not-send": "DO NOT SEND", "check-first": "CHECK FIRST", "would-fail": "WOULD FAIL", "not-done": "NOT DONE" };

function printBuyer(r: BuyerRun): void {
  out("Pharos X402 Agent Buyer");
  out();
  out(`  Job          ${r.job.summary}`);
  out(`  Budget       ${r.budget.shown}, paid by ${r.payer.key === "given" ? `PRIVATE_KEY's address, ${r.payer.address}` : `a key made for this run, holding nothing: ${r.payer.address}`}`);
  out(`  API          ${r.api.where === "in-process" ? `in this process (its facilitator ${r.api.settles ? `settles with ${r.api.facilitator}` : "verifies only"}), paid to ${r.api.payTo}` : r.api.url}`);
  out(`  Network      ${r.network.name} (chain ${r.network.chainId}), x402 network ${r.network.x402}`);
  if (r.chainMcp) out(`  Chain MCP    ${r.chainMcp.where}${r.chainMcp.server ? ` (${r.chainMcp.server})` : ""}`);
  out();
  out("  Plan");
  for (const [k, p] of r.plan.entries()) out(`  ${String(k + 1).padStart(3)}. ${p.path.padEnd(8)} ${(p.price?.shown ?? "no price").padEnd(12)} ${p.note}`);
  out();
  r.steps.filter((s) => s.source !== "the verdict").forEach((s, k) => out(`  ${String(k + 1).padStart(3)}. ${s.source}: ${s.text}`));
  out(`  Ledger       ${r.ledger.committed.shown} signed for, ${r.ledger.settled.shown} settled, ${r.ledger.remaining.shown} left`);
  if (r.tx) out(`  To sign      ${JSON.stringify(r.tx)}`);
  out(`  Verdict      ${BUYER_VERDICTS[r.verdict]}: ${r.headline}`);
  out(`  ${r.chainMcp ? `${r.toolCalls} Chain MCP calls (the API's and its facilitator's). ` : ""}${r.purchases.some((p) => p.settlement?.success) ? `Settled: ${r.purchases.filter((p) => p.settlement?.success).map((p) => p.settlement!.transaction).join(", ")}.` : "Nothing settled."}`);
}

async function buyCommand(flags: Flags): Promise<number> {
  const v = flags.values;
  if (flags.positional.length > 1) throw new AgentError("usage", "buy takes options only.");
  const net = network(v.network ?? "pharos-mainnet");
  if (flags.execute && net.id !== "atlantic-testnet") throw new AgentError("usage", "--execute is limited to the Atlantic testnet (--network atlantic-testnet).");
  if (v.api !== undefined && !/^https?:\/\/\S+$/.test(v.api)) throw new AgentError("usage", "--api must be an http(s) URL.");
  if (v.api !== undefined && flags.proof) throw new AgentError("usage", "A proof records the API's Chain MCP calls, so it needs the API in this process: leave out --api.");
  if (v.vendor !== undefined && (v.api !== undefined || !isAddress(v.vendor))) throw new AgentError("usage", v.api !== undefined ? "--vendor is for the API in this process, not one at --api." : "--vendor must be a 0x address (with a valid checksum).");
  if (v.budget !== undefined && !/^\d+(\.\d+)?$/.test(v.budget)) throw new AgentError("usage", "--budget must be a number of USDC, like 0.01.");
  const payer = flags.execute ? accountFromEnv() : undefined;
  const job = { asset: v.token ?? "USDC", from: v.from ?? payer?.address ?? EXAMPLE_PAYER, to: v.to ?? EXAMPLE_RECIPIENT, amount: v.amount ?? "25" };
  const intent = transferIntent(new URLSearchParams(job), net);
  const budget = v.budget ?? "0.01";
  if (v.api !== undefined) {
    const usdc = net.tokens.find((t) => t.symbol === "USDC");
    if (!usdc) throw new AgentError("usage", `No official USDC on ${net.name}.`);
    const result = await buy({ net, fetcher: fetch, api: { url: v.api, where: "remote" }, job: intent, budget, asset: { address: getAddress(usdc.address), symbol: usdc.symbol, decimals: usdc.decimals }, payer });
    const run: BuyerRun = { ...result, chainMcp: null, block: null, toolCalls: 0 };
    if (flags.json) out(JSON.stringify(run, null, 2));
    else printBuyer(run);
    return run.verdict === "ready" ? 0 : 9;
  }
  const facilitator = flags.execute ? signerFromEnv(process.env, process.env.FACILITATOR_PRIVATE_KEY ? "FACILITATOR_PRIVATE_KEY" : "PRIVATE_KEY") : undefined;
  const payTo = v.vendor !== undefined ? getAddress(v.vendor) : undefined;
  const started = new Date();
  const mcp = await ChainMcp.connect(endpointFor(net, flags), { trace: flags.verbose ? (line) => process.stderr.write(`  ${line}\n`) : undefined, budget: 240 });
  try {
    const result = await runBuyer({ chain: new Chain(mcp, net), job: intent, budget, payer, facilitator, payTo });
    if (flags.proof) {
      const proof = proofFile({ task: "21", capability: "x402-buyer", about: "One X402 Agent Buyer run: the job, the budget and the API's payee (input); the prices its 402s asked, the plan, every purchase with the authorization signed, the API's answer and its settlement, the ledger and the outcome (result); and every JSON-RPC message the API in this process and its facilitator exchanged with the Pharos Chain MCP server, in order. Check it with: pharos-agent verify <this file>.", mcp, network: net, startedAt: started, input: { job, budget, ...(payTo ? { payTo } : {}) }, result });
      await writeJson(flags.proof, proof);
    }
    if (flags.json) out(JSON.stringify(result, null, 2));
    else printBuyer(result);
    if (flags.proof) process.stderr.write(`Proof saved to ${flags.proof}\n`);
    return result.verdict === "ready" ? 0 : 9;
  } finally {
    await mcp.close();
  }
}

async function verify(flags: Flags): Promise<number> {
  const paths = flags.positional.slice(1);
  if (!paths.length) throw new AgentError("usage", "verify needs a proof file.");
  const verifiers: Record<string, (proof: ProofFile) => Promise<{ name: string; ok: boolean; detail: string }[]>> = { "threshold-guardian": verifyGuardianProof, "dry-run-executor": verifyDryRunProof, "policy-gatekeeper": verifyGateProof, "trend-watcher": verifyTrendProof, "alert-bot": verifyAlertProof, "whale-watcher": verifyWhaleProof, "gas-optimizer": verifyGasProof, "dapp-support": verifyExplanationProof, "risk-checker": verifyRiskProof, "audit-log": verifyAuditProof, digest: verifyDigestProof, "docs-chain": verifyDocsChainProof, "how-to": verifyHowToProof, "payment-flow": verifyPaymentProof, "invoice-payment": verifyInvoiceProof, "recurring-payments": verifyRecurringProof, "x402-payment": verifyX402Proof, "x402-buyer": verifyBuyerProof };
  const proofs: ProofFile[] = [];
  let failed = 0;
  let total = 0;
  for (const path of paths) {
    const proof = JSON.parse(await readFile(path, "utf8")) as ProofFile;
    const verifier = verifiers[proof.capability];
    if (!verifier) throw new AgentError("usage", `No verifier for "${proof.capability}".`);
    const checks = await verifier(proof);
    if (paths.length > 1) out(path);
    for (const check of checks) out(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
    failed += checks.filter((c) => !c.ok).length;
    total += checks.length;
    proofs.push(proof);
  }
  // Several runs of one watcher or bot, in order: one history, each run from the store the last one left.
  const histories: Record<string, (proofs: readonly ProofFile[]) => { name: string; ok: boolean; detail: string }> = { "trend-watcher": historyCheck, "alert-bot": alertHistoryCheck, "whale-watcher": whaleHistoryCheck, "gas-optimizer": gasHistoryCheck, digest: digestHistoryCheck, "recurring-payments": recurringHistoryCheck };
  const historyOf = histories[proofs[0]?.capability ?? ""];
  if (proofs.length > 1 && historyOf && proofs.every((p) => p.capability === proofs[0]!.capability)) {
    const history = historyOf(proofs);
    out(`  ${history.ok ? "PASS" : "FAIL"}  ${history.name}: ${history.detail}`);
    failed += history.ok ? 0 : 1;
    total += 1;
  }
  out(failed ? `\n${failed} check(s) failed.` : `\nProof${paths.length > 1 ? "s" : ""} verified: ${total} checks.`);
  return failed ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const command = flags.positional[0];
  if (!command || command === "help" || flags.help) {
    out(HELP);
    return command || flags.help ? 0 : 2;
  }
  if (command === "guardian") return guardian(flags);
  if (command === "dryrun") return dryrun(flags);
  if (command === "gate") return gate(flags);
  if (command === "watch") return watch(flags);
  if (command === "alert") return alert(flags);
  if (command === "whales") return whales(flags);
  if (command === "gas") return gasPlan(flags);
  if (command === "explain") return explainCommand(flags);
  if (command === "risk") return riskCommand(flags);
  if (command === "audit") return auditCommand(flags);
  if (command === "digest") return digestCommand(flags);
  if (command === "ask") return askCommand(flags);
  if (command === "howto") return howToCommand(flags);
  if (command === "pay") return payCommand(flags);
  if (command === "invoice") return invoiceCommand(flags);
  if (command === "recurring") return recurringCommand(flags);
  if (command === "x402") return x402Command(flags);
  if (command === "buy") return buyCommand(flags);
  if (command === "verify") return verify(flags);
  throw new AgentError("usage", `Unknown command "${command}". See pharos-agent --help.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      const known = error instanceof AgentError;
      process.stderr.write(`pharos-agent: ${known ? error.message : errorMessage(error)}\n${known && error.hint ? `  ${error.hint}\n` : ""}`);
      process.exitCode = known ? error.exitCode : 1;
    },
  );
}

