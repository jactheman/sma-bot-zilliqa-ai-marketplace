/** Market helpers for the CLI: symbols <-> addresses and human-readable pairs. */
import { getAddress, isAddress, type Address } from "viem";
import { deployment } from "./config";
import type { Market } from "./networks";

/** Resolve a token symbol (from the network's token list) or an address. */
export function resolveToken(ref: string): Address {
  if (isAddress(ref)) return getAddress(ref);
  const tokens = deployment().tokens;
  const hit = Object.entries(tokens).find(([sym]) => sym.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new Error(`unknown token "${ref}" — use one of ${Object.keys(tokens).join(", ") || "(none)"} or a 0x address`);
  return hit[1];
}

export function symbolOf(address: string): string {
  const hit = Object.entries(deployment().tokens).find(([, a]) => a.toLowerCase() === address.toLowerCase());
  return hit ? hit[0] : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "WZIL/USDC" means: trade WZIL, deposited and paid out in USDC. */
export function parseMarket(spec: string): Market {
  const [asset, base] = spec.split("/");
  if (!asset || !base) throw new Error(`market "${spec}" must look like ASSET/BASE, e.g. WZIL/USDC`);
  const m = { base: resolveToken(base.trim()), asset: resolveToken(asset.trim()) };
  if (m.base.toLowerCase() === m.asset.toLowerCase()) throw new Error(`market "${spec}" uses the same token twice`);
  return m;
}

export const formatMarket = (m: Market) => `${symbolOf(m.asset)}/${symbolOf(m.base)}`;
