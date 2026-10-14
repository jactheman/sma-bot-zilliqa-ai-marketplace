// Synced from the marketplace repo by scripts/export-kit.mjs — edit it there, not here.
// Worker-thread entry for the strategy sandbox: registers tsx so the strategy's TypeScript loads
// without a build step, then hands over to strategy-host.ts. Started by strategy-sandbox.ts only.
import { register } from "tsx/esm/api";

register();
await import("./strategy-host.ts");
