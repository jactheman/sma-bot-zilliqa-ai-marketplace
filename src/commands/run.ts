/**
 * zai run — the agent runner: loads a strategy, watches the marketplace for trades hired to
 * your agent, and executes the strategy's decisions with OPERATOR_KEY.
 *
 *   zai run --agent 1                               # strategies/take-profit.ts
 *   zai run --agent 1 --strategy mean-reversion     # a strategy in strategies/ by name
 *   zai run --agent 1 --strategy ./my-bot.ts        # any file
 *
 * The runner, not the strategy, owns safety: slippage limits on every swap, never opening a
 * trade near its deadline, and always closing before the buyer can reclaim. The contract
 * additionally limits this key to swapping escrowed funds through approved routers.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Address } from "viem";
import { marketplaceAbi, routerAbi } from "../abi";
import { deployment, kitPath, network, publicClient, requireMarketplace, walletFor } from "../config";
import type { Decision, Market, Position, PricePoint, Strategy } from "../strategy";
import { fmt, readTrade, tradeCount, type Trade } from "../trades";

let POLL_MS = Number(process.env.POLL_MS ?? 2000);
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS ?? 100); // 1%
const DEADLINE_BUFFER_SEC = BigInt(process.env.DEADLINE_BUFFER_SEC ?? 120);
const HISTORY_MAX = 1000;
const ONE = 10n ** 18n;

let wallet: ReturnType<typeof walletFor>;
let marketplace: Address;
let router: Address;
let agentId: bigint;
let defaultPair: string;

const watching = new Set<bigint>();
const openedAt = new Map<bigint, bigint>();
const lastNote = new Map<bigint, string>();
const history = new Map<string, PricePoint[]>();
let scanned = 0n;

const log = (id: bigint | null, msg: string) =>
  console.log(`${new Date().toLocaleTimeString()} ${id === null ? "" : `[trade #${id}] `}${msg}`);

// ---------------------------------------------------------------------------
// Strategy loading
// ---------------------------------------------------------------------------

async function loadStrategy(spec: string): Promise<Strategy> {
  const isPath = /[\\/]/.test(spec) || /\.[cm]?[jt]s$/.test(spec);
  const file = isPath ? resolve(process.cwd(), spec) : kitPath(`strategies/${spec}.ts`);
  if (!existsSync(file)) throw new Error(`Strategy not found: ${file}`);
  const mod = await import(pathToFileURL(file).href);
  const s = (mod.default ?? mod.strategy) as Strategy | undefined;
  if (!s || typeof s.decide !== "function") throw new Error(`${file} must default-export defineStrategy({ name, decide })`);
  return s;
}

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

async function quote(amountIn: bigint, path: Address[]) {
  const amounts = await publicClient.readContract({ address: router, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, path] });
  return amounts[amounts.length - 1];
}

const withSlippage = (x: bigint) => (x * (10_000n - SLIPPAGE_BPS)) / 10_000n;

async function send(functionName: "openPosition" | "closePosition", t: Trade, path: Address[], minOut: bigint) {
  const hash = await wallet.writeContract({ address: marketplace, abi: marketplaceAbi, functionName, args: [t.id, router, path, minOut] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
}

/** Sample the price of every pair we're trading, once per tick. */
async function samplePrices(pairs: Set<string>, now: bigint) {
  for (const key of pairs) {
    const [asset, base] = key.split(":") as [Address, Address];
    try {
      const price = await quote(ONE, [asset, base]);
      const h = history.get(key) ?? [];
      h.push({ t: now, price });
      if (h.length > HISTORY_MAX) h.shift();
      history.set(key, h);
    } catch (err) {
      log(null, `price sample failed for ${key}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

async function toPosition(t: Trade, now: bigint): Promise<Position> {
  const open = t.status === "Open";
  if (open && !openedAt.has(t.id)) openedAt.set(t.id, now);
  const value = open ? await quote(t.assetAmount, [t.assetToken, t.baseToken]) : t.amountIn;
  return {
    id: t.id,
    buyer: t.buyer,
    baseToken: t.baseToken,
    assetToken: t.assetToken,
    phase: open ? "open" : "pending",
    amountIn: t.amountIn,
    assetAmount: t.assetAmount,
    value,
    pnlBps: open ? Number(((value - t.amountIn) * 10_000n) / t.amountIn) : 0,
    heldSec: open ? Number(now - openedAt.get(t.id)!) : 0,
    secsToDeadline: Number(t.deadline - now),
  };
}

async function act(strategy: Strategy, t: Trade, now: bigint) {
  const pos = await toPosition(t, now);
  const h = history.get(`${t.assetToken}:${t.baseToken}`) ?? [];
  const market: Market = { now, price: h.at(-1)?.price ?? 0n, history: h };
  const nearDeadline = BigInt(pos.secsToDeadline) <= DEADLINE_BUFFER_SEC;

  // Safety rules the strategy can't override.
  let decision: Decision;
  if (pos.phase === "pending" && nearDeadline) decision = { action: "wait", note: "too close to deadline to open" };
  else if (pos.phase === "open" && nearDeadline) decision = { action: "close", reason: "deadline" };
  else decision = await strategy.decide(pos, market);

  if (decision.action === "open" && pos.phase === "pending") {
    const path = [t.baseToken, t.assetToken];
    const expected = await quote(t.amountIn, path);
    log(t.id, `opening${decision.note ? ` (${decision.note})` : ""}: ${fmt(t.amountIn)} base -> ~${fmt(expected)} asset`);
    await send("openPosition", t, path, withSlippage(expected));
    openedAt.set(t.id, now);
    lastNote.delete(t.id);
    log(t.id, "position open");
  } else if (decision.action === "close" && pos.phase === "open") {
    log(t.id, `closing on ${decision.reason} at ${pos.pnlBps / 100}%`);
    await send("closePosition", t, [t.assetToken, t.baseToken], withSlippage(pos.value));
    const settled = await readTrade(t.id);
    const profit = settled.amountOut - settled.amountIn;
    log(t.id, `settled: ${fmt(settled.amountOut)} base back (${profit >= 0n ? "+" : "-"}${fmt(profit < 0n ? -profit : profit)})`);
    forget(t.id);
  } else {
    if (decision.action !== "wait") log(t.id, `ignored "${decision.action}" while ${pos.phase}`);
    const note = pos.phase === "open" ? `holding: worth ${fmt(pos.value)} base (${pos.pnlBps / 100}%)` : `pending: ${decision.action === "wait" && decision.note ? decision.note : "waiting"}`;
    if (lastNote.get(t.id) !== note) log(t.id, note);
    lastNote.set(t.id, note);
  }
}

function forget(id: bigint) {
  watching.delete(id);
  openedAt.delete(id);
  lastNote.delete(id);
}

async function tick(strategy: Strategy) {
  const count = await tradeCount();
  for (; scanned < count; scanned++) {
    const t = await readTrade(scanned);
    if (t.agentId === agentId && (t.status === "Pending" || t.status === "Open")) {
      watching.add(t.id);
      log(t.id, `new ${t.status.toLowerCase()} trade from ${t.buyer.slice(0, 8)}… for ${fmt(t.amountIn)} base`);
    }
  }

  const now = (await publicClient.getBlock()).timestamp;
  const trades: Trade[] = [];
  for (const id of watching) {
    const t = await readTrade(id);
    if (t.status === "Pending" || t.status === "Open") trades.push(t);
    else {
      log(id, `now ${t.status.toLowerCase()}, no longer watching`);
      forget(id);
    }
  }

  // Always sample the default pair so strategies have history before the first trade arrives.
  const pairs = new Set([defaultPair, ...trades.map((t) => `${t.assetToken}:${t.baseToken}`)]);
  await samplePrices(pairs, now);

  for (const t of trades) {
    try {
      await act(strategy, t, now);
    } catch (err) {
      log(t.id, `error: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function checkAgent() {
  const count = await publicClient.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "nextAgentId" });
  if (agentId >= count) throw new Error(`Agent #${agentId} doesn't exist on this marketplace (${count} listed). Pass --agent <id>.`);
  const [, operator, feeBps, active, name] = await publicClient.readContract({
    address: marketplace, abi: marketplaceAbi, functionName: "agents", args: [agentId],
  });
  if (operator !== wallet.account.address) {
    throw new Error(`Agent #${agentId}'s operator is ${operator}, but OPERATOR_KEY belongs to ${wallet.account.address}.`);
  }
  if (!active) log(null, `warning: agent #${agentId} is paused — no new trades will arrive`);
  return { name, feeBps };
}

export default async function run(_cmd: string, args: string[]) {
  const { values } = parseArgs({
    args,
    options: { agent: { type: "string" }, strategy: { type: "string" }, poll: { type: "string" } },
  });
  if (values.agent !== undefined) process.env.AGENT_ID = values.agent;
  if (values.poll !== undefined) POLL_MS = Number(values.poll);

  const d = deployment();
  ({ marketplace, router, agentId } = d);
  defaultPair = `${d.assetToken}:${d.baseToken}`;
  wallet = walletFor("operator");

  await requireMarketplace();
  const strategy = await loadStrategy(values.strategy ?? process.env.STRATEGY ?? "take-profit");
  const agent = await checkAgent();
  log(null, `agent #${agentId} "${agent.name}" (${agent.feeBps / 100}% fee) on ${network}, marketplace ${marketplace}`);
  log(null, `operator ${wallet.account.address}`);
  log(null, `strategy: ${strategy.name}${strategy.describe ? ` — ${strategy.describe()}` : ""}`);
  for (;;) {
    try {
      await tick(strategy);
    } catch (err) {
      log(null, `tick failed: ${(err as Error).message.split("\n")[0]}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
