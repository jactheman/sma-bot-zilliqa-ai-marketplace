// Synced from the marketplace repo by scripts/export-kit.mjs — edit it there, not here.
/**
 * Worker-thread side of the strategy sandbox (see strategy-sandbox.ts). Loads the strategy file,
 * reports its name, then answers { id, position, market } requests with { id, decision }.
 * Everything crosses the thread boundary as a structured clone, so the strategy only ever sees
 * plain data: no wallet, no operator key, no runner internals.
 */
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { Decision, Market, Position, Strategy } from "./strategy";

export type HostRequest = { id: number; position: Position; market: Market };
export type HostReply =
  | { type: "ready"; name: string; describe?: string }
  | { type: "decision"; id: number; decision: Decision }
  | { type: "error"; id: number; error: string };

const port = parentPort;
if (!port) throw new Error("strategy-host.ts only runs inside the runner's worker thread");
const { file } = workerData as { file: string };

const mod = await import(pathToFileURL(file).href);
const strategy = (mod.default ?? mod.strategy) as Strategy | undefined;
if (!strategy || typeof strategy.decide !== "function") {
  throw new Error(`${file} must default-export defineStrategy({ name, decide })`);
}

let describe: string | undefined;
try {
  describe = strategy.describe?.();
} catch (err) {
  describe = `describe() threw: ${(err as Error).message}`;
}
port.postMessage({ type: "ready", name: String(strategy.name ?? "unnamed"), describe } satisfies HostReply);

port.on("message", async (req: HostRequest) => {
  try {
    const decision = await strategy.decide(req.position, req.market);
    port.postMessage({ type: "decision", id: req.id, decision } satisfies HostReply);
  } catch (err) {
    port.postMessage({ type: "error", id: req.id, error: (err as Error)?.message ?? String(err) } satisfies HostReply);
  }
});
