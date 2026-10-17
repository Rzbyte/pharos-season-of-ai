// A deterministic JSON-RPC chain for tests: the upstream the official Chain MCP server talks to. It holds
// native balances, nonces, contract code and ERC-20 tokens (balanceOf, decimals, paused, totalSupply,
// transfer), answers the JSON-RPC methods the server uses, and applies signed transactions it is sent.
// Every value is made up; nothing here is or claims to be Pharos data.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, type Hex } from "viem";

export interface FakeToken {
  decimals: number;
  paused?: boolean;
  /** Addresses a transfer may not come from or go to (Circle's USDC has such a list). */
  blacklist?: string[];
  balances: Record<string, bigint>;
  /** owner → spender → amount. */
  allowances?: Record<string, Record<string, bigint>>;
}

export interface FakeChainState {
  chainId: number;
  head: bigint;
  /** Unix seconds of the head block; earlier blocks are one second apart. */
  headTime: bigint;
  baseFee: bigint | null;
  gasPrice: bigint;
  priorityFee: bigint;
  native: Record<string, bigint>;
  nonces: Record<string, bigint>;
  code: Record<string, Hex>;
  tokens: Record<string, FakeToken>;
  /** JSON-RPC methods that fail with this error. */
  failures: Record<string, { code: number; message: string }>;
}

export interface FakeReceipt {
  transactionHash: Hex;
  blockNumber: Hex;
  status: "0x1" | "0x0";
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  from: Hex;
  to: Hex;
  logs: unknown[];
  cumulativeGasUsed: Hex;
  type: Hex;
}

export interface FakeChain {
  url: string;
  state: FakeChainState;
  requests: { method: string; params: unknown[] }[];
  receipts: Map<string, FakeReceipt>;
  /** Called before each request is answered; tests use it to change the chain mid-run. */
  onRequest?: (method: string, params: unknown[], count: number) => void;
  close(): Promise<void>;
}

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const ERROR_ABI = parseAbi(["error Error(string)"]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const hex = (value: bigint): Hex => `0x${value.toString(16)}`;
const word = (type: string, value: unknown): Hex => encodeAbiParameters([{ type }], [value]);
const lower = (value: unknown) => String(value).toLowerCase();

class Revert extends Error {
  constructor(readonly reason: string) {
    super(`execution reverted: ${reason}`);
  }
  get data(): Hex {
    return encodeErrorResult({ abi: ERROR_ABI, errorName: "Error", args: [this.reason] });
  }
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function defaultState(overrides: Partial<FakeChainState> = {}): FakeChainState {
  return { chainId: 1672, head: 5_000_000n, headTime: 1_790_000_000n, baseFee: 1_000_000_000n, gasPrice: 1_200_000_000n, priorityFee: 100_000_000n, native: {}, nonces: {}, code: {}, tokens: {}, failures: {}, ...overrides };
}

export async function startFakeChain(state: FakeChainState): Promise<FakeChain> {
  const requests: FakeChain["requests"] = [];
  const receipts = new Map<string, FakeReceipt>();
  const blockOf = (tag: unknown): bigint => {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return state.head;
    if (tag === "earliest") return 0n;
    return BigInt(tag as string);
  };
  // State as it was while each earlier block was the head, kept before every applied transaction, so a
  // read at an older block sees that block's state (as an archive node would).
  type World = Pick<FakeChainState, "native" | "nonces" | "tokens">;
  const history = new Map<bigint, World>();
  const worldAt = (tag: unknown): World => {
    const n = blockOf(tag);
    if (n >= state.head || history.size === 0) return state;
    const exact = history.get(n);
    if (exact) return exact;
    const first = [...history.keys()].reduce((a, b) => (b < a ? b : a));
    return n < first ? history.get(first)! : state;
  };
  const tokenCall = (world: World, to: string, data: Hex, from: string | undefined, apply: boolean): Hex => {
    const token = world.tokens[to]!;
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: ERC20, data });
    } catch {
      throw new Revert("unknown function");
    }
    switch (decoded.functionName) {
      case "balanceOf":
        return word("uint256", token.balances[lower(decoded.args[0])] ?? 0n);
      case "decimals":
        return word("uint8", token.decimals);
      case "paused":
        return word("bool", token.paused === true);
      case "totalSupply":
        return word("uint256", Object.values(token.balances).reduce((a, b) => a + b, 0n));
      case "allowance": {
        const [owner, spender] = decoded.args as [string, string];
        return word("uint256", token.allowances?.[lower(owner)]?.[lower(spender)] ?? 0n);
      }
      case "approve": {
        if (token.paused) throw new Revert("Pausable: paused");
        const [spender, amount] = decoded.args as [string, bigint];
        const owner = lower(from ?? "0x0000000000000000000000000000000000000000");
        if (apply) {
          token.allowances ??= {};
          token.allowances[owner] = { ...(token.allowances[owner] ?? {}), [lower(spender)]: amount };
        }
        return word("bool", true);
      }
      case "transfer": {
        if (token.paused) throw new Revert("Pausable: paused");
        const sender = lower(from ?? "0x0000000000000000000000000000000000000000");
        const [recipient, amount] = decoded.args as [string, bigint];
        if (token.blacklist?.some((address) => [sender, lower(recipient)].includes(lower(address)))) throw new Revert("Blacklistable: account is blacklisted");
        if ((token.balances[sender] ?? 0n) < amount) throw new Revert("ERC20: transfer amount exceeds balance");
        if (apply) {
          token.balances[sender] = (token.balances[sender] ?? 0n) - amount;
          token.balances[lower(recipient)] = (token.balances[lower(recipient)] ?? 0n) + amount;
        }
        return word("bool", true);
      }
    }
  };
  const execute = (world: World, tx: { from?: string; to?: string; data?: Hex; value?: string | bigint }, apply: boolean): Hex => {
    const to = lower(tx.to);
    const value = tx.value === undefined ? 0n : BigInt(tx.value);
    const from = tx.from ? lower(tx.from) : undefined;
    if (value > 0n && from && (world.native[from] ?? 0n) < value) throw new RpcFailure(-32000, "insufficient funds for gas * price + value");
    if (world.tokens[to] && tx.data && tx.data !== "0x") return tokenCall(world, to, tx.data, from, apply);
    if (apply && value > 0n && from) {
      world.native[from] = (world.native[from] ?? 0n) - value;
      world.native[to] = (world.native[to] ?? 0n) + value;
    }
    return "0x";
  };
  const methods: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => hex(BigInt(state.chainId)),
    eth_blockNumber: () => hex(state.head),
    web3_clientVersion: () => "fake-chain/1.0 (deterministic test fixture)",
    eth_getBalance: ([address, tag]) => hex(worldAt(tag).native[lower(address)] ?? 0n),
    eth_getTransactionCount: ([address, tag]) => hex(tag === "pending" ? (state.nonces[lower(address)] ?? 0n) : (worldAt(tag).nonces[lower(address)] ?? 0n)),
    eth_gasPrice: () => hex(state.gasPrice),
    eth_maxPriorityFeePerGas: () => hex(state.priorityFee),
    eth_getBlockByNumber: ([tag]) => {
      const n = blockOf(tag);
      if (n > state.head) return null;
      return { number: hex(n), hash: keccak256(word("uint256", n)), timestamp: hex(state.headTime - (state.head - n)), ...(state.baseFee !== null ? { baseFeePerGas: hex(state.baseFee) } : {}), gasUsed: "0x5208", gasLimit: "0x1c9c380", transactions: [] };
    },
    eth_getCode: ([address]) => state.code[lower(address)] ?? (state.tokens[lower(address)] ? "0x6080604052" : "0x"),
    eth_getStorageAt: () => word("uint256", 0n),
    eth_call: ([tx, tag]) => execute(worldAt(tag), tx as never, false),
    eth_estimateGas: ([tx]) => {
      const t = tx as { to?: string; data?: Hex };
      execute(state, t, false);
      return state.tokens[lower(t.to)] ? hex(t.data?.startsWith("0x095ea7b3") ? 46_500n : 51_234n) : hex(21_000n);
    },
    eth_getLogs: () => [],
    eth_getTransactionReceipt: ([hash]) => receipts.get(lower(hash)) ?? null,
    eth_getTransactionByHash: () => null,
    eth_sendRawTransaction: async ([raw]) => {
      const serialized = raw as Hex;
      const tx = parseTransaction(serialized);
      const from = lower(await recoverTransactionAddress({ serializedTransaction: serialized as never }));
      if (tx.chainId !== state.chainId) throw new RpcFailure(-32000, `invalid chain id ${tx.chainId}`);
      if (BigInt(tx.nonce ?? 0) !== (state.nonces[from] ?? 0n)) throw new RpcFailure(-32000, "nonce too low");
      const gasUsed = state.tokens[lower(tx.to)] ? (tx.data?.startsWith("0x095ea7b3") ? 46_123n : 49_871n) : 21_000n;
      const fee = gasUsed * (state.baseFee ?? state.gasPrice);
      let status: "0x1" | "0x0" = "0x1";
      const logs: unknown[] = [];
      history.set(state.head, structuredClone({ native: state.native, nonces: state.nonces, tokens: state.tokens }));
      try {
        execute(state, { from, to: tx.to ?? undefined, data: tx.data, value: tx.value }, true);
        if (state.tokens[lower(tx.to)] && tx.data) {
          const decoded = decodeFunctionData({ abi: ERC20, data: tx.data });
          if (decoded.functionName === "transfer") {
            const [recipient, amount] = decoded.args as [string, bigint];
            logs.push({ address: lower(tx.to), topics: [TRANSFER_TOPIC, word("address", from), word("address", recipient)], data: word("uint256", amount), logIndex: "0x0" });
          }
        }
      } catch (error) {
        if (!(error instanceof Revert)) throw error;
        status = "0x0";
      }
      state.native[from] = (state.native[from] ?? 0n) - fee;
      state.nonces[from] = (state.nonces[from] ?? 0n) + 1n;
      state.head += 1n;
      state.headTime += 1n;
      const hash = keccak256(serialized);
      receipts.set(hash, { transactionHash: hash, blockNumber: hex(state.head), status, gasUsed: hex(gasUsed), effectiveGasPrice: hex(state.baseFee ?? state.gasPrice), from: from as Hex, to: lower(tx.to) as Hex, logs, cumulativeGasUsed: hex(gasUsed), type: "0x2" });
      return hash;
    },
  };
  const fake: FakeChain = {
    url: "",
    state,
    requests,
    receipts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const { id, method, params = [] } = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      requests.push({ method, params });
      fake.onRequest?.(method, params, requests.length);
      const reply = (payload: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
      try {
        const failure = state.failures[method];
        if (failure) throw new RpcFailure(failure.code, failure.message);
        const handler = methods[method];
        if (!handler) throw new RpcFailure(-32601, `the method ${method} does not exist`);
        reply({ result: await handler(params) });
      } catch (error) {
        if (error instanceof Revert) reply({ error: { code: 3, message: error.message, data: error.data } });
        else if (error instanceof RpcFailure) reply({ error: { code: error.code, message: error.message } });
        else reply({ error: { code: -32603, message: (error as Error).message } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
