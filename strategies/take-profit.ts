/**
 * Take-profit / stop-loss: buy as soon as hired, sell when the position is up TAKE_PROFIT_BPS,
 * down STOP_LOSS_BPS, or has been held MAX_HOLD_SEC. The simplest possible strategy — copy
 * this file to start your own.
 */
import { defineStrategy, param } from "../src/strategy";

const TAKE_PROFIT_BPS = param("TAKE_PROFIT_BPS", 1000); // +10%
const STOP_LOSS_BPS = param("STOP_LOSS_BPS", 500); // -5%
const MAX_HOLD_SEC = param("MAX_HOLD_SEC", 3600);

export default defineStrategy({
  name: "take-profit",
  describe: () => `TP +${TAKE_PROFIT_BPS / 100}%, SL -${STOP_LOSS_BPS / 100}%, max hold ${MAX_HOLD_SEC}s`,

  decide(p) {
    if (p.phase === "pending") return { action: "open" };

    if (p.pnlBps >= TAKE_PROFIT_BPS) return { action: "close", reason: "take-profit" };
    if (p.pnlBps <= -STOP_LOSS_BPS) return { action: "close", reason: "stop-loss" };
    if (p.heldSec >= MAX_HOLD_SEC) return { action: "close", reason: "max hold" };
    return { action: "wait" };
  },
});
