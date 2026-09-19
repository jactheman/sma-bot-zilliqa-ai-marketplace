/** zai markets — markets offered on this network, with their best route and current price. */
import { erc20Abi, formatUnits } from "viem";
import { deployment, network, publicClient, requireMarketplace } from "../config";
import { formatMarket, symbolOf } from "../markets";
import { approvedHubs, bestRoute, hubTokens } from "../routing";

export default async function markets() {
  await requireMarketplace();
  const d = deployment();
  const hubs = await approvedHubs(publicClient, d.marketplace, hubTokens(d.markets));
  const rows = [];
  for (const m of d.markets) {
    const [aDec, bDec] = await Promise.all([
      publicClient.readContract({ address: m.asset, abi: erc20Abi, functionName: "decimals" }),
      publicClient.readContract({ address: m.base, abi: erc20Abi, functionName: "decimals" }),
    ]);
    const r = await bestRoute(publicClient, d.routers, m.asset, m.base, 10n ** BigInt(aDec), hubs);
    rows.push({
      market: formatMarket(m),
      price: r ? `${Number(formatUnits(r.amountOut, bDec)).toPrecision(6)} ${symbolOf(m.base)}` : "no route",
      route: r ? r.path.map(symbolOf).join(" → ") : "",
    });
  }
  console.log(`markets on ${network} (${d.routers.length} approved DEX router(s))`);
  console.table(rows);
  console.log("Declare the ones your agent trades with: zai update <id> --market WZIL/USDC --market SEED/USDC");
}
