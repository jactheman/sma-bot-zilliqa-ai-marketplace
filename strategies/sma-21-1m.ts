/**
 * SMA 21 / 55 on 1-minute bars: buy when a closed 1m bar crosses above the 21 SMA while
 * price is above the 55 SMA; sell on a cross back below the 21, or at -5% / +8%.
 * Ticks are bucketed into 1m bars by chain timestamp; the still-forming bar is ignored.
 * Needs SLOW + 1 closed bars (~56 min). History is capped at 1,000 ticks, so run with
 * --poll 4000 or slower, or the history never covers enough minutes.
 * Run it: ./zai run --agent <id> --strategy sma-21-1m --poll 4000
 */
import { defineStrategy, param, type PricePoint } from "../src/strategy";

const BAR_SEC = BigInt(param("BAR_SEC", 60));
const FAST = param("FAST", 21);
const SLOW = param("SLOW", 55);
const TAKE_PROFIT_BPS = param("TAKE_PROFIT_BPS", 800); // +8%
const STOP_LOSS_BPS = param("STOP_LOSS_BPS", 500); // -5%

/** Close prices of completed bars, oldest first. */
function closedBars(history: readonly PricePoint[], now: bigint): bigint[] {
  const current = now / BAR_SEC;
  const closes: bigint[] = [];
  let bucket: bigint | null = null;
  for (const { t, price } of history) {
    const b = t / BAR_SEC;
    if (b >= current) break;
    if (b === bucket) closes[closes.length - 1] = price;
    else closes.push(price), (bucket = b);
  }
  return closes;
}

/** SMA of the n closes ending at index `end` (inclusive). */
function smaAt(closes: bigint[], n: number, end: number): bigint {
  let sum = 0n;
  for (let i = end - n + 1; i <= end; i++) sum += closes[i];
  return sum / BigInt(n);
}

export default defineStrategy({
  name: "sma-21-1m",
  describe: () =>
    `${FAST}/${SLOW} SMA on ${BAR_SEC}s bars; TP +${TAKE_PROFIT_BPS / 100}%, SL -${STOP_LOSS_BPS / 100}%`,

  decide(p, market) {
    if (p.phase === "open") {
      if (p.pnlBps <= -STOP_LOSS_BPS) return { action: "close", reason: "stop-loss" };
      if (p.pnlBps >= TAKE_PROFIT_BPS) return { action: "close", reason: "take-profit" };
    }

    const closes = closedBars(market.history, market.now);
    const need = Math.max(FAST, SLOW) + 1;
    if (closes.length < need) return { action: "wait", note: `warming up (${closes.length}/${need} bars)` };

    const last = closes.length - 1;
    const close = closes[last];
    const prevClose = closes[last - 1];
    const fast = smaAt(closes, FAST, last);
    const prevFast = smaAt(closes, FAST, last - 1);
    const slow = smaAt(closes, SLOW, last);

    if (p.phase === "pending") {
      const crossUp = prevClose <= prevFast && close > fast;
      return crossUp && close > slow
        ? { action: "open", note: `bar closed above SMA${FAST} and SMA${SLOW}` }
        : { action: "wait", note: "no cross up" };
    }

    const crossDown = prevClose >= prevFast && close < fast;
    return crossDown ? { action: "close", reason: `cross below SMA${FAST}` } : { action: "wait" };
  },
});
