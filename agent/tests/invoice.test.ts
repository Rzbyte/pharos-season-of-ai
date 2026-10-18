// Task 19, Invoice-to-Payment Agent: an invoice read into the one payment it asks for (every figure checked
// against the others, or a refusal that says which disagree), then prepared through the official Chain MCP
// server on a fake chain: the payee against your payees, what the payer sent before (a duplicate, a
// lookalike, transfers of nothing), Task 17's flow (the dry run, the funds, the transaction to sign), the
// EIP-681 link; held while anything calls for a check, and on Atlantic, with a key, sent.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getAddress } from "viem";
import { EXAMPLE } from "../src/builder/action.js";
import { Chain } from "../src/core/chain.js";
import { ChainMcp } from "../src/core/chain-mcp.js";
import { AgentError } from "../src/core/errors.js";
import { signerFromEnv } from "../src/core/execute.js";
import { HOSTED_CHAIN_MCP, NETWORKS } from "../src/core/networks.js";
import { proofFile, type ProofFile } from "../src/core/proof.js";
import { formatLink, parseLink } from "../src/invoice/link.js";
import { parsePayees, payInvoice, plainPayees, type InvoicePayment, type Payees } from "../src/invoice/pay.js";
import { readInvoice } from "../src/invoice/read.js";
import { verifyInvoiceProof } from "../src/invoice/verify.js";
import { defaultState, startFakeChain, type FakeChain, type FakeTransfer } from "./fake-chain.js";
import { connectOfficial } from "./official-server.js";

const net = NETWORKS["pharos-mainnet"];
const atlantic = NETWORKS["atlantic-testnet"];
const USDC = getAddress(net.tokens[1]!.address);
const lower = (address: string) => address.toLowerCase();
const STUDIO = EXAMPLE.counterparty;
/** Starts and ends like STUDIO, but is another address: what address poisoning plants. */
const LOOKALIKE = getAddress(`0xb274${"a".repeat(32)}9553`);
const OTHER = "0x4444444444444444444444444444444444444444";
const payees = parsePayees(`Example Studio = ${STUDIO}`);
const NOW = new Date("2026-09-21T15:00:00.000Z");

const INVOICE = `INVOICE
Invoice: INV-1042
From: Example Studio
Bill to: Example Shop
Issued: 2026-09-15
Due: 2026-10-01

Design work (10 h)        15.00 USDC
Hosting, September: 5 USDC

Subtotal: 20 USDC
Tax: 0
Total: 20.00 USDC
Amount due: 20 USDC

Pay to: ${STUDIO}
Network: Pharos Mainnet
Thank you for your business!`;

describe("reading an invoice", () => {
  const read = (text: string, on = net) => readInvoice(text, on);
  const refuses = (text: string, pattern: RegExp, on = net) => assert.throws(() => read(text, on), (e: unknown) => e instanceof AgentError && e.kind === "usage" && pattern.test(e.message), `${text.slice(0, 60)}… should refuse with ${pattern}`);

  test("its lines and figures, each checked against the others; dates, terms; the lines that are none of it", () => {
    const inv = read(INVOICE);
    assert.deepEqual([inv.number, inv.issuer, inv.billTo, inv.payer, inv.payee, inv.network, inv.asset, inv.token, inv.due], ["INV-1042", "Example Studio", "Example Shop", null, { address: STUDIO, name: null }, "Pharos Mainnet", "USDC", USDC, { amount: "20", raw: "20000000" }]);
    assert.deepEqual(inv.lines, [{ text: "Design work (10 h)", amount: "15", raw: "15000000" }, { text: "Hosting, September", amount: "5", raw: "5000000" }]);
    assert.deepEqual([inv.figures.subtotal?.amount, inv.figures.tax?.amount, inv.figures.total?.amount, inv.figures.amountDue?.amount, inv.figures.paid], ["20", "0", "20", "20", null]);
    assert.deepEqual(inv.sums, ["The 2 lines add up to the subtotal, 20 USDC.", "The subtotal is the total, 20 USDC.", "The amount due is the total, 20 USDC."]);
    assert.deepEqual([inv.issued, inv.dueDate, inv.dueFrom, inv.notRead], ["2026-09-15", "2026-10-01", "invoice", ["INVOICE", "Thank you for your business!"]]);

    const terms = read(`Invoice no. A-7\nDate: 1 October 2026\nTerms: Net 30\nPay to:\nExample Studio\n${lower(STUDIO)}\nTotal 1,250.50 USDC\nVAT ID: GB123456789\nPhone: +1 555 0100\nSuite 200`);
    assert.deepEqual([terms.number, terms.issued, terms.dueDate, terms.dueFrom, terms.payee.name, terms.due.amount, terms.notRead], ["A-7", "2026-10-01", "2026-10-31", "terms", "Example Studio", "1250.5", ["VAT ID: GB123456789", "Phone: +1 555 0100", "Suite 200"]]);
    for (const [written, iso] of [["2026-10-17", "2026-10-17"], ["Oct 17, 2026", "2026-10-17"], ["17th of October 2026", "2026-10-17"], ["Saturday, 17 October 2026", "2026-10-17"], ["10/17/2026", "2026-10-17"], ["17/10/2026", "2026-10-17"], ["17.10.2026", "2026-10-17"]]) assert.equal(read(`Due date: ${written}\nTotal: 1 USDC\nPay to: ${STUDIO}`).dueDate, iso, written);

    const partly = read(`Consulting 100.00 USDC\nSubtotal 100.00 USDC\nDiscount: -10 USDC\nVAT (20%): 20.00 USDC\nTotal: 110 USDC\nAmount paid: 50 USDC\nBalance due: 60 USDC\nWallet (Pharos): ${STUDIO}`);
    assert.deepEqual([partly.due.amount, partly.figures.discount?.amount, partly.figures.paid?.amount], ["60", "10", "50"]);
    assert.deepEqual(partly.sums, ["The line is the subtotal, 100 USDC.", "The subtotal, less 10 USDC discount and plus 20 USDC tax, comes to the total, 110 USDC.", "The total, less 50 USDC paid, leaves the amount due, 60 USDC."]);
    const mail = read(`From: Example Studio <invoices@studio.example>\nTo: Example Shop, ${EXAMPLE.account}\nAmount due: 3 USDC\nPay to: ${STUDIO}`);
    assert.deepEqual([mail.issuer, mail.billTo, mail.payer], ["Example Studio", "Example Shop", EXAMPLE.account]);
    assert.deepEqual(read(`Total: 2 USDC\nTotal: 2.00 USDC\nPay to: ${STUDIO}`).due.amount, "2", "the same figure twice is fine");
  });

  test("a payment link: alone, or inside an invoice it agrees with; its gas settings are not used", () => {
    const pros = read(`ethereum:${STUDIO}@1672?value=1e16`);
    assert.deepEqual([pros.asset, pros.token, pros.due, pros.payee.address, pros.link, pros.sums], ["PROS", null, { amount: "0.01", raw: "10000000000000000" }, STUDIO, { uri: `ethereum:${STUDIO}@1672?value=1e16`, chainId: 1672, ignored: [] }, []]);
    const usdc = read(`Invoice #2026-17\nTotal 20 USDC\nPay with: ethereum:${USDC}@1672/transfer?address=${STUDIO}&uint256=2e7&gasLimit=90000.`);
    assert.deepEqual([usdc.number, usdc.asset, usdc.due.raw, usdc.link?.ignored], ["2026-17", "USDC", "20000000", ["gasLimit"]]);
    assert.deepEqual(parseLink(`ethereum:pay-${STUDIO}?value=2.014e18`), { uri: `ethereum:pay-${STUDIO}?value=2.014e18`, chainId: null, to: STUDIO, token: null, raw: 2_014_000_000_000_000_000n, ignored: [] });
    for (const payment of [{ to: STUDIO, token: USDC, raw: 20_000_000n }, { to: STUDIO, token: null, raw: 10n ** 16n }]) {
      const back = parseLink(formatLink(net, payment));
      assert.deepEqual([back.to, back.token, back.raw, back.chainId], [payment.to, payment.token, payment.raw, 1672]);
    }
  });

  test("refused, saying why: figures that disagree, a link that disagrees, no payee or amount, nothing due", () => {
    refuses(`Design 15.00 USDC\nHosting 5.00 USDC\nSubtotal: 25 USDC\nPay to: ${STUDIO}`, /^The lines add up to 20 USDC, but the subtotal says 25 USDC\.$/);
    refuses(`Design 15.00 USDC\nHosting 5.00 USDC\nTotal: 25 USDC\nPay to: ${STUDIO}`, /^The 2 lines add up to 20 USDC, but the total says 25 USDC\.$/);
    refuses(`Subtotal: 100 USDC\nTax: 10 USDC\nTotal: 100 USDC\nPay to: ${STUDIO}`, /^The subtotal, 100 USDC, plus 10 USDC tax, comes to 110 USDC, but the total says 100 USDC\.$/);
    refuses(`Total: 100 USDC\nPaid: 40 USDC\nAmount due: 70 USDC\nPay to: ${STUDIO}`, /^The total, 100 USDC, less 40 USDC paid, leaves 60 USDC, but the amount due says 70 USDC\.$/);
    refuses(`Total: 20 USDC\nTotal: 25 USDC\nPay to: ${STUDIO}`, /gives the total twice, differently: 20 USDC and 25 USDC/);
    refuses(`Total: 20 USDC\nethereum:${USDC}@1672/transfer?address=${STUDIO}&uint256=2e8`, /^The invoice asks for 20 USDC, but its payment link asks for 200 USDC\.$/);
    refuses(`Total: 20 USDC\nPay to: ${OTHER}\nethereum:${USDC}@1672/transfer?address=${STUDIO}&uint256=2e7`, /gives two addresses to pay: 0x4444…4444 and 0xB274…9553 \(one in its payment link\)/);
    refuses("Total: 20 USDC\nBill to: Example Shop", /gives no address to pay: a "Pay to: 0x…" line, or a payment link/);
    refuses(`Design 15.00 USDC\nPay to: ${STUDIO}`, /gives no total or amount due/);
    refuses(`Total: 20 USDC\nAmount paid: 20 USDC\nPay to: ${STUDIO}`, /^Nothing is due: 20 USDC of 20 USDC is paid already\.$/);
    refuses(`Total: 20\nPay to: ${STUDIO}`, /names no asset/);
    refuses(`Total: 20 USDC\nPay to: ${STUDIO}\nBill to: ${STUDIO}`, /billed to the address it asks to be paid at/);
    refuses(`Total: 20 USDC\nPay to: ${USDC}`, /paid at the USDC token contract itself/);
    refuses("Total: 20 USDC\nPay to: 0x0000000000000000000000000000000000000000", /the zero address/);
  });

  test("refused: a currency, another network, an address that fails its checksum, a link that is not a payment", () => {
    refuses(`Total: $20.00\nPay to: ${STUDIO}`, /^The invoice is in \$, a currency, not an asset on Pharos\. Ask the issuer for an amount in USDC or another official token\.$/);
    refuses(`Total: 20 EUR\nPay to: ${STUDIO}`, /in EUR, a currency/);
    refuses(`Total: 20 PEPE\nPay to: ${STUDIO}`, /"PEPE" is not PROS or an official Pharos Mainnet token \(WPROS, USDC, LINK, WETH\)\./);
    refuses(`Total: 20 USDC\nTotal due: 0.01 PROS\nPay to: ${STUDIO}`, /amounts in USDC and PROS: it asks for one payment, in one asset/);
    refuses(`Total: 20 USDC\nNetwork: Ethereum\nPay to: ${STUDIO}`, /^The invoice asks for payment on Ethereum, not on Pharos\.$/);
    refuses(`Total: 20 USDC\nNetwork Base\nPay to: ${STUDIO}`, /payment on Base, not on Pharos/);
    refuses(`Total: 20 USDC\nNetwork: Mainnet\nPay to: ${STUDIO}`, /"Mainnet" of which chain\?/);
    refuses(`Total: 20 USDC\nNetwork: Pharos Atlantic\nPay to: ${STUDIO}`, /is for Atlantic \("Pharos Atlantic"\): run it on atlantic-testnet/);
    refuses(`ethereum:${STUDIO}@688689?value=1e16`, /chain 688689, Atlantic: run it on atlantic-testnet/);
    refuses(`ethereum:${STUDIO}@1?value=1e16`, /chain 1, another chain, not Pharos/);
    refuses(`Total: 20 USDC\nPay to: ${STUDIO.slice(0, -1)}4`, /fails its checksum: a character may be wrong/);
    refuses(`Total: 20 USDC\nPay to: 0xB274…9553`, /"0xB274" is not an address: 0x and 40 hex characters/);
    refuses(`Total: 20 USDC\nDue date: 05/06/2026\nPay to: ${STUDIO}`, /"05\/06\/2026" reads as two dates/);
    refuses(`Total: 20 USDC\nDue date: 2026-02-30\nPay to: ${STUDIO}`, /not a real date/);
    refuses(`Total: 20 USDC\nDue date: soon\nPay to: ${STUDIO}`, /the date is not one the agent reads/);
    refuses("ethereum:studio.eth@1672?value=1e16", /an ENS name/);
    refuses(`ethereum:${USDC}@1672/approve?address=${STUDIO}&uint256=1`, /calls approve, not a payment/);
    refuses(`ethereum:${STUDIO}@1672?value=1e16&foo=1`, /a parameter the agent does not read: "foo"/);
    refuses(`ethereum:${STUDIO}@1672?value=1.5`, /not a whole number of base units/);
    refuses(`ethereum:${OTHER}@1672/transfer?address=${STUDIO}&uint256=1`, /a token at 0x4444…|not an official Pharos Mainnet token/);
    refuses(`ethereum:${STUDIO}@1672?value=1\nethereum:${STUDIO}@1672?value=2`, /two payment links/);
    refuses(`Design work -5.00 USDC\nTotal: 5 USDC\nPay to: ${STUDIO}`, /negative amount is not read/);
    refuses("", /Paste an invoice/);
    refuses(`Total: 1 USDC\nPay to: ${STUDIO}\n${"x".repeat(4001)}`, /at most 4,000 characters/);
  });

  test("your payees: a name may have spaces; by line or JSON; refused when unreadable", () => {
    assert.deepEqual(parsePayees(`Example Studio = ${STUDIO}\nAcme, Inc.: ${lower(OTHER)}`), { "example studio": { name: "Example Studio", address: STUDIO }, "acme inc": { name: "Acme, Inc.", address: getAddress(OTHER) } });
    assert.deepEqual(parsePayees({ "Example Studio": STUDIO }), payees);
    assert.throws(() => parsePayees("Example Studio"), /A payee line reads "name = 0x…"/);
    assert.throws(() => parsePayees("Example Studio = 0x12"), /Example Studio's address must be 0x and 40 hex characters/);
    assert.throws(() => parsePayees(`A = ${STUDIO}\na = ${OTHER}`), /"a" is in your payees twice/);
    assert.throws(() => parsePayees(`Studio = ${STUDIO.slice(0, -1)}4`), /fails its checksum/);
  });
});

describe("the prepared payment", () => {
  let fake: FakeChain;
  const PAYER = EXAMPLE.account;
  const history = (transfers: Omit<FakeTransfer, "token" | "from">[]) => transfers.map((t) => ({ token: USDC, from: PAYER, ...t }));
  before(async () => {
    fake = await startFakeChain(defaultState({ native: { [lower(PAYER)]: 10n ** 18n }, nonces: { [lower(PAYER)]: 41n }, tokens: { [lower(USDC)]: { decimals: 6, balances: { [lower(PAYER)]: 100_000_000n } } } }));
  });
  after(() => fake.close());

  async function pay(text: string, book: Payees = payees, transfers: FakeTransfer[] = []): Promise<{ result: InvoicePayment; proof: ProofFile }> {
    fake.state.transfers = transfers;
    const official = await connectOfficial(fake, net, { budget: 60 });
    try {
      const result = await payInvoice(text, { chain: official.chain, payees: book, now: () => NOW });
      const proof = JSON.parse(JSON.stringify(proofFile({ task: "19", capability: "invoice-payment", about: "test", mcp: official.mcp, network: net, startedAt: new Date(), input: { invoice: text, payees: plainPayees(book) }, result }))) as ProofFile;
      proof.chainMcp = { ...proof.chainMcp, kind: "hosted", endpoint: HOSTED_CHAIN_MCP };
      return { result, proof };
    } finally {
      await official.close();
    }
  }

  test("a known payee, not paid before: the history read, the dry run, the transaction to sign and its link; the proof verifies", async () => {
    const { result, proof } = await pay(INVOICE, payees, history([{ to: OTHER, amount: 7_000_000n, block: 4_999_000n }]));
    assert.deepEqual([result.verdict, result.payer, result.payee.book, result.nonce], ["ready", { address: PAYER, from: "example" }, { status: "matches", name: "Example Studio", address: STUDIO }, 41]);
    assert.deepEqual(result.due, { date: "2026-10-01", days: 10, words: "due in 10 days" });
    assert.deepEqual(result.history, { token: "USDC", from: "4998001", to: "5000000", pages: 2, sent: 1, toPayee: 0, duplicates: [], zeroValue: 0, lookalike: null });
    assert.deepEqual(result.checks.map((c) => [c.id, c.state]), [["figures", "ok"], ["network", "ok"], ["duplicate", "ok"], ["payee", "ok"], ["due", "info"], ["dry-run", "ok"], ["funds", "ok"]]);
    assert.deepEqual([result.payment.amount, result.payment.asset, result.payment.memo, result.payment.dryRun.verdict, result.payment.tx?.nonce, result.payment.tx?.to, result.payment.submission], ["20", "USDC", "invoice INV-1042", "would-succeed", 41, USDC, null]);
    assert.equal(result.payment.command, `cast send ${USDC} "transfer(address,uint256)" ${STUDIO} 20000000 --private-key $PRIVATE_KEY --rpc-url https://rpc.pharos.xyz`);
    assert.equal(result.link, `ethereum:${USDC}@1672/transfer?address=${STUDIO}&uint256=20000000`);
    assert.match(result.headline, /^Invoice INV-1042 from Example Studio: 20 USDC to 0xB274…9553, due in 10 days, ready to sign\. It dry-runs at block 5,000,000 for about [\d.]+ PROS of gas\. Nothing was sent: the hosted Chain MCP is read-only\.$/);
    assert.deepEqual(result.steps.map((s) => s.source), ["the invoice", "your payees", "Chain MCP · get_logs", "Chain MCP · get_transaction_count", "Chain MCP · eth_call · estimate_gas", "the flow", "the flow", "Skill Engine · references/transaction.md", "the block's time", "the verdict"]);
    assert.equal(result.steps[0]!.text, "Read invoice INV-1042 from Example Studio: 20 USDC to 0xB274…9553, due 2026-10-01. The 2 lines add up to the subtotal, 20 USDC. The subtotal is the total, 20 USDC. The amount due is the total, 20 USDC. 2 lines are not part of it, and shown as not read.");
    assert.equal(result.steps[2]!.text, "USDC sent by 0x912c…f647 in blocks 4,998,001 to 5,000,000 (2 queries): 1 transfer, none to the payee.");
    assert.deepEqual((await verifyInvoiceProof(proof)).filter((c) => !c.ok), []);
  });

  test("held for a check: a new payee; one maybe paid already; a lookalike of a payee, with transfers of nothing", async () => {
    const fresh = (await pay(INVOICE, {})).result;
    assert.deepEqual([fresh.verdict, fresh.checks.filter((c) => c.state === "warn").map((c) => c.title)], ["check-first", ["A new payee"]]);
    assert.match(fresh.headline, new RegExp(String.raw`^Check first: a new payee\. Invoice INV-1042 from Example Studio asks for 20 USDC to ${STUDIO}\. Nothing was sent`));
    assert.ok(fresh.payment.tx, "a held payment is still prepared");
    const paidBefore = (await pay(INVOICE, {}, history([{ to: STUDIO, amount: 5_000_000n, block: 4_999_500n }]))).result;
    assert.deepEqual([paidBefore.verdict, paidBefore.checks.find((c) => c.id === "payee")?.title], ["ready", "Paid before"]);
    const twice = (await pay(INVOICE, payees, history([{ to: STUDIO, amount: 20_000_000n, block: 4_999_900n }]))).result;
    assert.deepEqual([twice.verdict, twice.history?.duplicates.map((d) => d.block)], ["check-first", ["4999900"]]);
    assert.match(twice.checks.find((c) => c.id === "duplicate")!.detail, /^20 USDC went from 0x912c…f647 to 0xB274…9553 in block 4,999,900 \(0x[0-9a-f]{64}\)\. Make sure this invoice was not paid already\.$/);
    const swapped = INVOICE.replace(`Pay to: ${STUDIO}`, `Pay to: ${LOOKALIKE}`);
    const poisoned = (await pay(swapped, payees, history([{ to: STUDIO, amount: 20_000_000n, block: 4_998_500n }, { to: LOOKALIKE, amount: 0n, block: 4_998_600n }]))).result;
    assert.deepEqual([poisoned.verdict, poisoned.checks.filter((c) => c.state === "warn").map((c) => c.id)], ["check-first", ["lookalike", "zero-value", "payee"]]);
    assert.deepEqual([poisoned.history?.lookalike, poisoned.payee.book.status, poisoned.payment.to.name], [{ address: STUDIO, times: 1 }, "differs", null], "never named for the studio it is not");
    assert.match(poisoned.headline, /^Check first: looks like an address the payer pays \(and 2 more\)\./);
  });

  test("one that would not go through; one paid in PROS, which leaves no log; a payer only Atlantic lacks", async () => {
    const big = (await pay(INVOICE.replaceAll("20 USDC", "200 USDC").replace("20.00 USDC", "200.00 USDC").replace("15.00 USDC", "195.00 USDC"))).result;
    assert.deepEqual([big.verdict, big.payment.tx, big.checks.find((c) => c.id === "dry-run")?.state], ["would-fail", null, "fail"]);
    assert.match(big.headline, /^Invoice INV-1042 from Example Studio: 200 USDC to 0xB274…9553 would not go through: /);
    const pros = (await pay(`ethereum:${STUDIO}@1672?value=1e16`)).result;
    assert.deepEqual([pros.verdict, pros.history, pros.payee.book.status, pros.checks.find((c) => c.id === "duplicate")?.state, pros.payment.tx?.value], ["ready", null, "listed", "info", "10000000000000000"]);
    assert.equal(pros.link, `ethereum:${STUDIO}@1672?value=10000000000000000`);
    const official = await connectOfficial(fake, net);
    try {
      await assert.rejects(payInvoice(INVOICE.replace("Network: Pharos Mainnet", ""), { chain: new Chain(official.mcp, atlantic) }), /Name the payer/);
    } finally {
      await official.close();
    }
  });

  test("a changed recorded answer fails the proof", async () => {
    const { proof } = await pay(INVOICE);
    const forged = JSON.parse(JSON.stringify(proof)) as ProofFile;
    const nonceReply = forged.transcript.find((m) => m.direction === "server->client" && JSON.stringify(m.message).includes('\\"nonce\\"'));
    assert.ok(nonceReply, "the nonce answer is in the transcript");
    const content = (nonceReply.message as unknown as { result: { content: { text: string }[] } }).result.content[0]!;
    content.text = content.text.replace("41", "7");
    assert.deepEqual((await verifyInvoiceProof(forged)).filter((c) => !c.ok).map((c) => c.name), ["payment recomputed from the recorded responses"]);
  });
});

describe("paying the invoice on Atlantic", () => {
  // The well-known Hardhat/Anvil test key #1: public, only ever used here on a fake chain.
  const signer = signerFromEnv({ PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
  const TUSDC = getAddress(atlantic.tokens[0]!.address);
  const text = `Invoice: T-1\nFrom: Example Studio\nTotal: 1.5 USDC\nNetwork: Atlantic\nPay to: ${STUDIO}`;

  test("with a key, a payee you know is paid: signed here, sent, checked against its receipt; a new one is held; the proof verifies", async () => {
    const chainFake = await startFakeChain(defaultState({ chainId: 688689, native: { [lower(signer.address)]: 10n ** 18n }, tokens: { [lower(TUSDC)]: { decimals: 6, balances: { [lower(signer.address)]: 5_000_000n } } } }));
    const run = async (book: Payees) => {
      const mcp = await ChainMcp.connect({ kind: "local", network: { ...atlantic, rpcUrl: chainFake.url }, broadcast: true }, { timeoutMs: 15_000 });
      try {
        const result = await payInvoice(text, { chain: new Chain(mcp, atlantic), payees: book, from: signer.address, signer, wait: { pollMs: 10 }, now: () => NOW });
        return { result, proof: JSON.parse(JSON.stringify(proofFile({ task: "19", capability: "invoice-payment", about: "test", mcp, network: atlantic, startedAt: new Date(), input: { invoice: text, payees: plainPayees(book), from: signer.address }, result }))) as ProofFile };
      } finally {
        await mcp.close();
      }
    };
    try {
      const held = (await run({})).result;
      assert.deepEqual([held.verdict, held.payment.submission, chainFake.state.tokens[lower(TUSDC)]!.balances[lower(STUDIO)]], ["check-first", null, undefined], "a new payee is held, even with a key");
      const { result, proof } = await run(payees);
      assert.deepEqual([result.verdict, result.payment.submission?.status, result.payment.submission?.matched], ["sent", "success", true]);
      assert.equal(chainFake.state.tokens[lower(TUSDC)]!.balances[lower(STUDIO)], 1_500_000n);
      assert.equal(result.headline, "Invoice T-1 paid: 1.5 USDC to 0xB274…9553, sent and checked against its receipt.");
      const checks = await verifyInvoiceProof(proof);
      assert.deepEqual(checks.filter((c) => !c.ok), []);
      assert.equal(checks.find((c) => c.name === "signed transactions")!.detail, "1 on chain 688689, each signed by its sender, each exactly the prepared payment, in order");
    } finally {
      await chainFake.close();
    }
  });
});
