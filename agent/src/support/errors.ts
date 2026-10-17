// Task 27: why a call stopped, in plain language, from its revert data. Solidity's own Error(string) and
// Panic(uint256), and the custom errors of OpenZeppelin Contracts 5 that most tokens and access-
// controlled contracts revert with, decoded by their signatures; anything else is named by its selector.
import { decodeErrorResult, parseAbi } from "viem";
import { formatAmount } from "../core/amounts.js";
import type { Hex } from "../core/chain.js";

export interface DecodedError {
  /** "Error", "Panic", an OpenZeppelin error's name, or null when the selector is not known. */
  name: string | null;
  selector: Hex | null;
  /** The decoded arguments, as text. */
  args: Record<string, string>;
  /** What it means, in a sentence. */
  meaning: string;
}

const KNOWN = parseAbi([
  "error Error(string message)",
  "error Panic(uint256 code)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error ReentrancyGuardReentrantCall()",
  "error SafeERC20FailedOperation(address token)",
  "error AddressEmptyCode(address target)",
  "error FailedInnerCall()",
  "error FailedCall()",
]);

/** Solidity's panic codes (docs.soliditylang.org, "Panic via assert and Error via require"). */
const PANICS: Readonly<Record<string, string>> = {
  "0x0": "a generic compiler panic",
  "0x1": "an assert that failed",
  "0x11": "an arithmetic overflow or underflow: an amount went past what its type can hold, or below zero",
  "0x12": "a division or modulo by zero",
  "0x21": "a value out of range for an enum",
  "0x22": "a corrupted storage byte array",
  "0x31": "pop() on an empty array",
  "0x32": "an array index out of bounds",
  "0x41": "too much memory, or an array too large",
  "0x51": "a call to an uninitialized internal function",
};

/** Plain-language hints for the revert messages most often seen from tokens. */
const MESSAGES: readonly [RegExp, string][] = [
  [/exceeds balance|insufficient balance/i, "The sender did not hold enough."],
  [/allowance/i, "The spender was not approved for enough."],
  [/paused/i, "The contract is paused."],
  [/blacklist|blocked|frozen/i, "An address in it is blocked by the contract."],
  [/owner|not authori[sz]ed|access/i, "Only a particular account can do this."],
  [/expired|deadline/i, "A deadline in it had passed."],
  [/slippage|insufficient output|too little received/i, "The price moved past the limit it set."],
];

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * The revert, decoded. `token` is the token the call went to, when it is one, so amounts read in its
 * units. Null when there is no revert data at all.
 */
export function decodeRevert(data: Hex | null, token: { symbol: string; decimals: number } | null = null): DecodedError | null {
  if (!data || data === "0x") return null;
  const selector = data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : null;
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: KNOWN, data });
  } catch {
    return { name: null, selector, args: {}, meaning: `It stopped with a custom error the agent does not know${selector ? ` (selector ${selector})` : ""}.` };
  }
  const name = decoded.errorName;
  const item = KNOWN.find((entry) => entry.name === name) as { inputs: readonly { name?: string }[] };
  const values = (decoded.args ?? []) as readonly unknown[];
  const args: Record<string, string> = {};
  item.inputs.forEach((input: { name?: string }, index: number) => (args[input.name ?? `arg${index}`] = String(values[index])));
  const amount = (raw: string) => (token ? `${formatAmount(BigInt(raw), token.decimals, 6)} ${token.symbol}` : BigInt(raw).toLocaleString("en-US"));
  const meaning = ((): string => {
    switch (name) {
      case "Error": {
        const hint = MESSAGES.find(([pattern]) => pattern.test(args.message ?? ""))?.[1];
        return `It stopped with the message "${args.message}".${hint ? ` ${hint}` : ""}`;
      }
      case "Panic": {
        const code = `0x${BigInt(args.code ?? "0").toString(16)}`;
        return `It hit ${PANICS[code] ?? `panic code ${code}`} (panic ${code}).`;
      }
      case "ERC20InsufficientBalance":
        return `${short(args.sender!)} held ${amount(args.balance!)} and needed ${amount(args.needed!)}.`;
      case "ERC20InsufficientAllowance":
        return `${short(args.spender!)} was approved for ${amount(args.allowance!)} and needed ${amount(args.needed!)}.`;
      case "ERC20InvalidReceiver":
        return `The token refuses ${short(args.receiver!)} as a recipient (the zero address).`;
      case "ERC20InvalidSender":
        return `The token refuses ${short(args.sender!)} as a sender (the zero address).`;
      case "ERC20InvalidApprover":
        return `The token refuses ${short(args.approver!)} as an approver.`;
      case "ERC20InvalidSpender":
        return `The token refuses ${short(args.spender!)} as a spender (the zero address).`;
      case "OwnableUnauthorizedAccount":
        return `Only the contract's owner can do this, and ${short(args.account!)} is not it.`;
      case "OwnableInvalidOwner":
        return `${short(args.owner!)} cannot be made the owner.`;
      case "AccessControlUnauthorizedAccount":
        return `${short(args.account!)} lacks the role this needs (${args.neededRole!.slice(0, 10)}…).`;
      case "EnforcedPause":
        return "The contract is paused.";
      case "ExpectedPause":
        return "This works only while the contract is paused.";
      case "ReentrancyGuardReentrantCall":
        return "It called back into the contract while it was running, which the contract forbids.";
      case "SafeERC20FailedOperation":
        return `A token transfer or approval on ${short(args.token!)} failed.`;
      case "AddressEmptyCode":
        return `It called ${short(args.target!)}, which has no code.`;
      default:
        return "A call it made to another contract failed.";
    }
  })();
  return { name, selector, args, meaning };
}
