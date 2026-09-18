import { existsSync, writeFileSync } from "node:fs";
import { kitPath } from "../config";

const TEMPLATE = (name: string) => `/**
 * ${name}: describe your strategy here.
 * Run it: ./zai run --agent <id> --strategy ${name}
 * Reference: docs/BUILDING-AGENTS.md#writing-a-strategy
 */
import { defineStrategy, diffBps, param, sma } from "../src/strategy";

const TAKE_PROFIT_BPS = param("TAKE_PROFIT_BPS", 500); // +5%
const STOP_LOSS_BPS = param("STOP_LOSS_BPS", 300); // -3%

export default defineStrategy({
  name: "${name}",
  describe: () => \`TP +\${TAKE_PROFIT_BPS / 100}%, SL -\${STOP_LOSS_BPS / 100}%\`,

  decide(position, market) {
    if (position.phase === "pending") {
      // Decide when to buy. market.history has one price sample per tick; sma() needs enough of them.
      const avg = sma(market.history, 10);
      if (avg !== null && diffBps(market.price, avg) > 200) return { action: "wait", note: "price running hot" };
      return { action: "open" };
    }

    if (position.pnlBps >= TAKE_PROFIT_BPS) return { action: "close", reason: "take-profit" };
    if (position.pnlBps <= -STOP_LOSS_BPS) return { action: "close", reason: "stop-loss" };
    return { action: "wait" };
  },
});
`;

export default async function init(_cmd: string, args: string[]) {
  const name = args[0];
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("usage: zai init <name>  (lowercase letters, digits, dashes)");
  const file = kitPath(`strategies/${name}.ts`);
  if (existsSync(file)) throw new Error(`strategies/${name}.ts already exists`);
  writeFileSync(file, TEMPLATE(name));
  console.log(`created strategies/${name}.ts\nrun it: ./zai run --agent <id> --strategy ${name}`);
}
