// Task 29: an action prepared the way the Pharos Skill Engine writes it. The Skill Engine
// (github.com/PharosNetwork/pharos-skill-engine, at the commit below) gives a Foundry `cast` command
// template for each action, and its own gas arithmetic: the estimate times 1.2, rounded up, is the
// suggested gas limit, and that times the gas price is the fee. The templates are quoted here with
// the reference each comes from; the agent fills them from the network's Skill Engine entry and the
// action, and runs none of them. The key is always `$PRIVATE_KEY`, never a value, as the Skill
// Engine's security rules ask.
import type { Address } from "../core/chain.js";
import { formatAmount } from "../core/amounts.js";
import type { Network } from "../core/networks.js";
import type { Action } from "./action.js";

export const SKILL_ENGINE = Object.freeze({ repo: "https://github.com/PharosNetwork/pharos-skill-engine", commit: "a873387c9e34e9ae8e71360d43dc33329a335a24" });

/** The templates, quoted from the Skill Engine's references. */
export const TEMPLATES = Object.freeze({
  nativeTransfer: { template: "cast send <to> --value <amount>ether --private-key <key> --rpc-url <rpc>", reference: "references/transaction.md#native-token-transfer" },
  contractWrite: { template: 'cast send <contract> "<method_sig>(<param_types>)" [args...] --private-key <key> --rpc-url <rpc>', reference: "references/transaction.md#contract-write-call" },
  estimate: { template: 'cast estimate <to> "<method_sig>(<param_types>)" [args...] --rpc-url <rpc>', reference: "references/transaction.md#estimate-gas-consumption" },
  gasPrice: { template: "cast gas-price --rpc-url <rpc>", reference: "references/transaction.md#query-gas-price" },
  nativeBalance: { template: "cast balance <address> --rpc-url <rpc> --ether", reference: "references/query.md#native-token-balance-ether" },
  tokenBalance: { template: 'cast call <token> "balanceOf(address)(uint256)" <holder> --rpc-url <rpc>', reference: "references/query.md#erc20-token-balance" },
});

export interface SkillCommand {
  /** What it does: "Send it", "Estimate its gas". */
  label: string;
  command: string;
  reference: string;
}

export interface SkillPlan {
  repo: string;
  commit: string;
  /** The network as the Skill Engine's networks.json names it. */
  network: { name: string; chainId: number; rpcUrl: string; explorerUrl: string; nativeToken: string };
  commands: SkillCommand[];
  /** The Skill Engine's fee arithmetic on the agent's own estimate and gas price; null for a read, or a transaction that would not go through. */
  fee: { gas: string; gasLimit: string; gasPrice: string; cost: string; costShown: string } | null;
}

/** The Skill Engine's name for a network. */
const skillName = (net: Network) => (net.id === "pharos-mainnet" ? "mainnet" : "atlantic-testnet");

/** The suggested gas limit and fee by the Skill Engine's rule: ceil(gas × 1.2), times the gas price. */
export function skillFee(gas: bigint, gasPrice: bigint, net: Network): NonNullable<SkillPlan["fee"]> {
  const gasLimit = (gas * 12n + 9n) / 10n;
  const cost = gasLimit * gasPrice;
  return { gas: gas.toString(), gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), cost: cost.toString(), costShown: `${formatAmount(cost, 18, 8)} ${net.nativeSymbol}` };
}

/**
 * The commands for an action. `raw` is the amount in the token's base units (cast takes integers for a
 * token's uint256); a native amount is written in ether units, as the templates do. A gas estimate is
 * given `--from` the sender: from the zero address, a token transfer's estimate would revert.
 */
export function skillPlan(action: Action, raw: bigint | null, net: Network, fee: SkillPlan["fee"]): SkillPlan {
  const rpc = net.rpcUrl;
  const network = { name: skillName(net), chainId: net.chainId, rpcUrl: net.rpcUrl, explorerUrl: net.explorerUrl, nativeToken: net.nativeSymbol };
  const commands: SkillCommand[] = [];
  const from = action.account.value;
  const to = action.counterparty?.value as Address | undefined;
  const ether = action.amount?.value ?? "0";
  const send = (label: string, command: string, reference: string) => commands.push({ label, command, reference });
  switch (action.kind) {
    case "native-transfer":
      send("Estimate its gas", `cast estimate ${to} --value ${ether}ether --from ${from} --rpc-url ${rpc}`, TEMPLATES.estimate.reference);
      send("Send it", `cast send ${to} --value ${ether}ether --private-key $PRIVATE_KEY --rpc-url ${rpc}`, TEMPLATES.nativeTransfer.reference);
      break;
    case "erc20-transfer":
    case "erc20-approve": {
      const method = action.kind === "erc20-transfer" ? "transfer(address,uint256)" : "approve(address,uint256)";
      const call = `${action.token!.address} "${method}" ${to} ${raw}`;
      send("Estimate its gas", `cast estimate ${call} --from ${from} --rpc-url ${rpc}`, TEMPLATES.estimate.reference);
      send("Send it", `cast send ${call} --private-key $PRIVATE_KEY --rpc-url ${rpc}`, TEMPLATES.contractWrite.reference);
      break;
    }
    case "wrap":
      send("Estimate its gas", `cast estimate ${action.token!.address} "deposit()" --value ${ether}ether --from ${from} --rpc-url ${rpc}`, TEMPLATES.estimate.reference);
      send("Send it", `cast send ${action.token!.address} "deposit()" --value ${ether}ether --private-key $PRIVATE_KEY --rpc-url ${rpc}`, TEMPLATES.contractWrite.reference);
      break;
    case "balance":
      if (action.token) send("Read it", `cast call ${action.token.address} "balanceOf(address)(uint256)" ${from} --rpc-url ${rpc}`, TEMPLATES.tokenBalance.reference);
      else send("Read it", `cast balance ${from} --rpc-url ${rpc} --ether`, TEMPLATES.nativeBalance.reference);
      break;
  }
  if (action.kind !== "balance") send("The gas price", `cast gas-price --rpc-url ${rpc}`, TEMPLATES.gasPrice.reference);
  return { repo: SKILL_ENGINE.repo, commit: SKILL_ENGINE.commit, network, commands, fee };
}
