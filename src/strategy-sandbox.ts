// Synced from the marketplace repo by scripts/export-kit.mjs — edit it there, not here.
/**
 * Runs a strategy in a worker thread, away from the operator key.
 *
 * A strategy file is arbitrary TypeScript. Loaded in-process it could read OPERATOR_KEY from the
 * environment, reach the runner's wallet and sign whatever it liked, so "the runner owns safety"
 * would only be true for honest strategies. Here the strategy runs in its own thread with a copy
 * of the environment that has anything secret-looking removed (names containing KEY, SECRET,
 * PASSWORD, PRIVATE, RPC_URL or RAILWAY), and only plain data crosses the boundary: the runner
 * posts a position and a market, the worker answers with a decision, and the main thread alone
 * decides what gets signed. A strategy that hangs is terminated after DECIDE_TIMEOUT_MS and
 * restarted on the next call; one that crashes is restarted the same way.
 *
 * What this does not do: a strategy can still use the network and read files, so keep keys in
 * environment variables (sealed on Railway), never in a .env file on the bot's host.
 */
import { Worker } from "node:worker_threads";
import type { Decision, Market, Position, Strategy } from "./strategy";
import type { HostReply, HostRequest } from "./strategy-host";

const SECRET_ENV = /KEY|SECRET|PASSWORD|PRIVATE|RPC_URL|RAILWAY/i;
const DECIDE_TIMEOUT_MS = Number(process.env.STRATEGY_TIMEOUT_MS ?? 10_000);
const ACTIONS = new Set(["open", "close", "wait"]);

/** The environment a strategy may see: everything except names that look like secrets. */
export const strategyEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !SECRET_ENV.test(e[0])));

export interface SandboxedStrategy extends Strategy {
  /** Stop the worker thread. */
  close(): Promise<void>;
}

type Waiter = { resolve: (d: Decision) => void; reject: (e: Error) => void };

class WorkerStrategy implements SandboxedStrategy {
  name = "";
  describe?: () => string;
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Waiter>();
  private seq = 0;
  private closed = false;

  constructor(private readonly file: string) {}

  async start(): Promise<this> {
    const info = await this.spawn();
    this.name = info.name;
    if (info.describe !== undefined) this.describe = () => info.describe!;
    return this;
  }

  private spawn(): Promise<{ name: string; describe?: string }> {
    const worker = new Worker(new URL("./strategy-worker.mjs", import.meta.url), {
      workerData: { file: this.file },
      env: strategyEnv(),
    });
    this.worker = worker;
    const fail = (err: Error) => {
      if (this.worker === worker) this.worker = null;
      for (const w of this.pending.values()) w.reject(err);
      this.pending.clear();
    };
    return new Promise((resolve, reject) => {
      worker.on("message", (m: HostReply) => {
        if (m.type === "ready") return resolve({ name: m.name, describe: m.describe });
        const w = this.pending.get(m.id);
        if (!w) return;
        this.pending.delete(m.id);
        if (m.type === "decision") w.resolve(m.decision);
        else w.reject(new Error(`strategy threw: ${m.error}`));
      });
      worker.on("error", (err) => {
        reject(err);
        fail(err);
      });
      worker.on("exit", (code) => {
        const err = new Error(this.closed ? "strategy worker closed" : `strategy worker exited with code ${code}`);
        reject(err);
        fail(err);
      });
    });
  }

  async decide(position: Position, market: Market): Promise<Decision> {
    if (this.closed) throw new Error("strategy worker closed");
    if (!this.worker) await this.spawn(); // restart after a crash or a timeout
    const worker = this.worker!;
    const id = ++this.seq;
    const decision = await new Promise<Decision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void worker.terminate(); // a hung strategy is replaced on the next call
        if (this.worker === worker) this.worker = null;
        reject(new Error(`strategy took longer than ${DECIDE_TIMEOUT_MS / 1000}s (STRATEGY_TIMEOUT_MS)`));
      }, DECIDE_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (d) => (clearTimeout(timer), resolve(d)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      worker.postMessage({ id, position, market } satisfies HostRequest);
    });
    if (!decision || typeof decision !== "object" || !ACTIONS.has((decision as { action?: unknown }).action as string)) {
      throw new Error(`strategy returned something that isn't a decision: ${JSON.stringify(decision)}`);
    }
    return decision;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.worker?.terminate();
    this.worker = null;
  }
}

/** Load `file` (an absolute path to a strategy module) in a worker thread. */
export const loadStrategyInWorker = (file: string): Promise<SandboxedStrategy> => new WorkerStrategy(file).start();
