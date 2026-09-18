/** zai status — trades and P&L on the current network. */
import { marketplaceAbi } from "../abi";
import { deployment, network, publicClient, requireMarketplace } from "../config";
import { fmt, readTrade, tradeCount } from "../trades";

export default async function status() {
  await requireMarketplace();
  const { marketplace } = deployment();
  const agents = await publicClient.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "nextAgentId" });
  const n = await tradeCount();
  console.log(`marketplace ${marketplace} on ${network}: ${agents} agents, ${n} trades\n`);
  const rows = [];
  for (let i = n > 50n ? n - 50n : 0n; i < n; i++) {
    const t = await readTrade(i);
    const pnl = t.status === "Settled" ? t.amountOut - t.amountIn : null;
    rows.push({
      trade: Number(i), agent: Number(t.agentId), status: t.status, in: fmt(t.amountIn),
      out: t.status === "Settled" ? fmt(t.amountOut) : "",
      pnl: pnl === null ? "" : `${pnl >= 0n ? "+" : "-"}${fmt(pnl < 0n ? -pnl : pnl)}`,
    });
  }
  if (rows.length) console.table(rows);
  else console.log("no trades yet — hire an agent with: ./zai dev hire 100 --agent <id>");
}
