import { formatUnits, type Address } from "viem";
import { marketplaceAbi } from "./abi";
import { deployment, publicClient } from "./config";

export const STATUS = ["None", "Pending", "Open", "Settled", "Cancelled", "Reclaimed"] as const;
export type StatusName = (typeof STATUS)[number];

export interface Trade {
  id: bigint;
  buyer: Address;
  agentId: bigint;
  baseToken: Address;
  assetToken: Address;
  amountIn: bigint;
  assetAmount: bigint;
  amountOut: bigint;
  deadline: bigint;
  feeBps: number;
  status: StatusName;
}

export async function readTrade(id: bigint): Promise<Trade> {
  const [buyer, agentId, baseToken, assetToken, amountIn, assetAmount, amountOut, deadline, feeBps, status] =
    await publicClient.readContract({ address: deployment().marketplace, abi: marketplaceAbi, functionName: "trades", args: [id] });
  return { id, buyer, agentId, baseToken, assetToken, amountIn, assetAmount, amountOut, deadline, feeBps, status: STATUS[status] };
}

export const tradeCount = () =>
  publicClient.readContract({ address: deployment().marketplace, abi: marketplaceAbi, functionName: "nextTradeId" });

export async function readAgent(id: bigint) {
  const [seller, operator, feeBps, active, name, metadataURI] = await publicClient.readContract({
    address: deployment().marketplace, abi: marketplaceAbi, functionName: "agents", args: [id],
  });
  return { id, seller, operator, feeBps, active, name, metadataURI };
}

export const agentCount = () =>
  publicClient.readContract({ address: deployment().marketplace, abi: marketplaceAbi, functionName: "nextAgentId" });

/** Human-readable token amount. */
export const fmt = (v: bigint, decimals = 18) =>
  Number(formatUnits(v, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });

export async function send(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return receipt;
}
