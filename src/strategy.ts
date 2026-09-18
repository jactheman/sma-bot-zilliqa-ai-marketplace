// Synced from the marketplace repo by scripts/export-kit.mjs — edit it there, not here.
/**
 * The strategy interface. A strategy is one file that default-exports `defineStrategy({...})`.
 * The runner (src/bot.ts) handles everything else: discovering trades, pricing, signing,
 * slippage limits, retries, and closing before the buyer's deadline.
 *
 * See docs/BUILDING-AGENTS.md for a walkthrough.
 */
import type { Address } from "viem";

/** Price of 1 whole asset token in base tokens, 1e18-scaled, sampled once per runner tick. */
export interface PricePoint {
  t: bigint; // chain timestamp (seconds)
  price: bigint;
}

/** A trade hired to this agent, as the strategy sees it. All token amounts are raw (wei-style) units. */
export interface Position {
  id: bigint;
  buyer: Address;
  baseToken: Address;
  assetToken: Address;
  phase: "pending" | "open";
  amountIn: bigint; // base escrowed by the buyer
  assetAmount: bigint; // asset held; 0 while pending
  value: bigint; // what the position is worth in base right now (amountIn while pending)
  pnlBps: number; // unrealized P&L in basis points; 0 while pending
  heldSec: number; // seconds since opened (as seen by this runner); 0 while pending
  secsToDeadline: number; // after this the buyer can reclaim
}

export interface Market {
  now: bigint;
  /** Latest price of 1 asset in base (1e18-scaled). */
  price: bigint;
  /** Oldest first. Grows by one point per tick, capped at 1,000 points. Empty history is possible after a restart. */
  history: readonly PricePoint[];
}

export type Decision =
  | { action: "open"; note?: string } // pending only: swap base -> asset
  | { action: "close"; reason: string } // open only: swap back and settle
  | { action: "wait"; note?: string }; // do nothing this tick

export interface Strategy {
  name: string;
  /** One line shown at startup, e.g. the parameters in use. */
  describe?: () => string;
  /** Called every tick for every pending or open trade. Keep it fast and side-effect free. */
  decide: (position: Position, market: Market) => Decision | Promise<Decision>;
}

export const defineStrategy = (s: Strategy): Strategy => s;

/** Read a numeric strategy parameter from the environment. */
export function param(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

/** Simple moving average of the last `n` prices, or null if there isn't enough history yet. */
export function sma(history: readonly PricePoint[], n: number): bigint | null {
  if (history.length < n || n <= 0) return null;
  let sum = 0n;
  for (let i = history.length - n; i < history.length; i++) sum += history[i].price;
  return sum / BigInt(n);
}

/** (a - b) / b in basis points. */
export const diffBps = (a: bigint, b: bigint) => (b === 0n ? 0 : Number(((a - b) * 10_000n) / b));
