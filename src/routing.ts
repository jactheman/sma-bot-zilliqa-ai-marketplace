// Synced from the marketplace repo by scripts/export-kit.mjs — edit it there, not here.
/**
 * Route finding shared by the agent runner, the CLI and the web app, so all three quote the
 * same way: try every approved router, directly and through each "hub" token, keep the best.
 */
import type { Address } from "viem";
import { marketplaceAbi, routerAbi } from "./abi";
import type { Market } from "./networks";

export interface Route {
  router: Address;
  path: Address[];
  amountOut: bigint;
}

/** Anything with viem's readContract (PublicClient in Node or the browser). */
type Reader = { readContract: (args: any) => Promise<unknown> };

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const marketKey = (m: Market) => `${m.base.toLowerCase()}/${m.asset.toLowerCase()}`;
export const hasMarket = (markets: Market[], base: string, asset: string) =>
  markets.some((m) => sameAddress(m.base, base) && sameAddress(m.asset, asset));

/** Tokens worth routing through: everything that appears in the offered markets. */
export function hubTokens(markets: Market[]): Address[] {
  const seen = new Map<string, Address>();
  for (const m of markets) for (const t of [m.base, m.asset]) seen.set(t.toLowerCase(), t as Address);
  return [...seen.values()];
}

/**
 * The subset of `candidates` the marketplace allows multi-hop paths through (owner-approved and
 * past the approval delay). Routing through anything else would revert on-chain.
 */
export async function approvedHubs(client: Reader, marketplace: Address, candidates: Address[]): Promise<Address[]> {
  const flags = await Promise.all(
    candidates.map((t) =>
      (client.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "allowedHubs", args: [t] }) as Promise<boolean>)
        .catch(() => false),
    ),
  );
  return candidates.filter((_, i) => flags[i]);
}

/** Candidate paths: direct, then one hop through each hub. */
export function candidatePaths(from: Address, to: Address, hubs: Address[]): Address[][] {
  const paths: Address[][] = [[from, to]];
  for (const h of hubs) if (!sameAddress(h, from) && !sameAddress(h, to)) paths.push([from, h, to]);
  return paths;
}

/**
 * Best quote for swapping `amountIn` of `from` into `to` across `routers`, or null when no route
 * exists (every path reverts or returns zero, e.g. no pool).
 */
export async function bestRoute(
  client: Reader,
  routers: Address[],
  from: Address,
  to: Address,
  amountIn: bigint,
  hubs: Address[],
): Promise<Route | null> {
  let best: Route | null = null;
  const paths = candidatePaths(from, to, hubs);
  await Promise.all(
    routers.flatMap((router) =>
      paths.map(async (path) => {
        try {
          const amounts = (await client.readContract({
            address: router, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, path],
          })) as readonly bigint[];
          const amountOut = amounts[amounts.length - 1];
          if (amountOut > 0n && (!best || amountOut > best.amountOut)) best = { router, path, amountOut };
        } catch {
          // No pool on this path/router.
        }
      }),
    ),
  );
  return best;
}

/**
 * Price impact of a trade in basis points: how much worse the full-size rate is than a tiny
 * reference trade. Returns null if the pair can't be quoted.
 */
export async function priceImpactBps(
  client: Reader, routers: Address[], from: Address, to: Address, amountIn: bigint, hubs: Address[],
): Promise<{ impactBps: number; route: Route } | null> {
  const full = await bestRoute(client, routers, from, to, amountIn, hubs);
  if (!full) return null;
  const small = amountIn / 1000n || 1n;
  const ref = await bestRoute(client, routers, from, to, small, hubs);
  if (!ref || ref.amountOut === 0n) return { impactBps: 0, route: full };
  // Compare rates: full.out/amountIn vs ref.out/small.
  const impact = 1 - Number((full.amountOut * small * 1_000_000n) / (ref.amountOut * amountIn)) / 1_000_000;
  return { impactBps: Math.max(0, Math.round(impact * 10_000)), route: full };
}
