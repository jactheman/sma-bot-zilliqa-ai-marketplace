/**
 * Mean reversion: wait for the price to dip DIP_BPS below its moving average, buy the dip,
 * then sell once the price is back at the average (or on stop-loss / max hold).
 * Shows how to use price history; needs WINDOW ticks of history before it trades.
 */
import { defineStrategy, diffBps, param, sma } from "../src/strategy";

const WINDOW = param("WINDOW", 20); // ticks in the moving average
const DIP_BPS = param("DIP_BPS", 300); // buy when price is 3% below the average
const STOP_LOSS_BPS = param("STOP_LOSS_BPS", 800);
const MAX_HOLD_SEC = param("MAX_HOLD_SEC", 3600);

export default defineStrategy({
  name: "mean-reversion",
  describe: () => `buy ${DIP_BPS / 100}% below ${WINDOW}-tick SMA, sell at SMA; SL -${STOP_LOSS_BPS / 100}%`,

  decide(p, market) {
    const avg = sma(market.history, WINDOW);
    if (avg === null) return { action: "wait", note: `warming up (${market.history.length}/${WINDOW} ticks)` };
    const vsAvg = diffBps(market.price, avg);

    if (p.phase === "pending") {
      return vsAvg <= -DIP_BPS
        ? { action: "open", note: `price ${vsAvg / 100}% vs SMA` }
        : { action: "wait", note: `price ${vsAvg / 100}% vs SMA, waiting for -${DIP_BPS / 100}%` };
    }

    if (p.pnlBps <= -STOP_LOSS_BPS) return { action: "close", reason: "stop-loss" };
    if (vsAvg >= 0 && p.pnlBps > 0) return { action: "close", reason: "reverted to mean" };
    if (p.heldSec >= MAX_HOLD_SEC) return { action: "close", reason: "max hold" };
    return { action: "wait" };
  },
});
