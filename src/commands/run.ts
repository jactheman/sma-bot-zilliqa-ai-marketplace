/**
 * zai run — the agent runner: loads a strategy, watches the marketplace for trades hired to
 * your agent, and executes the strategy's decisions with OPERATOR_KEY.
 *
 *   zai run --agent 1                               # strategies/take-profit.ts
 *   zai run --agent 1 --strategy mean-reversion     # a strategy in strategies/ by name
 *   zai run --agent 1 --strategy ./my-bot.ts        # any file
 *
 * The runner, not the strategy, owns safety: it only trades the markets the agent declares,
 * routes every swap through the best approved DEX path with a slippage limit, never opens a
 * trade near its deadline, and always closes before the buyer can reclaim. The contract
 * additionally limits this key to swapping escrowed funds through approved routers.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { erc20Abi, type Address } from "viem";
import { marketplaceAbi } from "../abi";
import { deployment, kitPath, network, publicClient, requireMarketplace, walletFor } from "../config";
import { loadMetadata } from "../metadata";
import type { Market as TradingMarket } from "../networks";
import { bestRoute, hasMarket, hubTokens, type Route } from "../routing";
import type { Decision, Market, Position, PricePoint, Strategy } from "../strategy";
import { fmt, readTrade, tradeCount, type Trade } from "../trades";

let POLL_MS = Number(process.env.POLL_MS ?? 2000);
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS ?? 100); // 1%
const DEADLINE_BUFFER_SEC = BigInt(process.env.DEADLINE_BUFFER_SEC ?? 120);
const METADATA_REFRESH_MS = 60_000;
const HISTORY_MAX = 1000;

let wallet: ReturnType<typeof walletFor>;
let marketplace: Address;
let agentId: bigint;
let routers: Address[];
let offeredMarkets: TradingMarket[];
let tokenNames: Record<string, Address> = {};

const watching = new Set<bigint>();
const openedAt = new Map<bigint, bigint>();
const lastNote = new Map<bigint, string>();
const history = new Map<string, PricePoint[]>();
const decimals = new Map<string, number>();
let scanned = 0n;

/** Markets this agent trades: from its details, else the marketplace default pair. */
let agentMarkets: TradingMarket[] = [];
let metadataLoadedAt = 0;

/** "WZIL/USDC" when the tokens are known, else shortened addresses. */
const symbol = (a: string) => Object.entries(tokenNames).find(([, t]) => t.toLowerCase() === a.toLowerCase())?.[0] ?? `${a.slice(0, 6)}…`;
const marketName = (m: TradingMarket) => `${symbol(m.asset)}/${symbol(m.base)}`;

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

const hubs = () => hubTokens([...offeredMarkets, ...agentMarkets]);

/** Best route across approved routers (direct or via a hub token); throws if there is none. */
async function route(from: Address, to: Address, amountIn: bigint): Promise<Route> {
  const r = await bestRoute(publicClient, routers, from, to, amountIn, hubs());
  if (!r) throw new Error(`no route from ${from} to ${to} on any approved DEX`);
  return r;
}

async function tokenDecimals(token: Address) {
  const key = token.toLowerCase();
  if (!decimals.has(key)) decimals.set(key, await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
  return decimals.get(key)!;
}

const withSlippage = (x: bigint) => (x * (10_000n - SLIPPAGE_BPS)) / 10_000n;

async function send(functionName: "openPosition" | "closePosition", t: Trade, r: Route) {
  const hash = await wallet.writeContract({
    address: marketplace, abi: marketplaceAbi, functionName, args: [t.id, r.router, r.path, withSlippage(r.amountOut)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
}

const pairKey = (asset: Address, base: Address) => `${asset}:${base}`;

/** Sample the price (1 whole asset in base, 1e18-scaled) of every pair we're trading, once per tick. */
async function samplePrices(pairs: Set<string>, now: bigint) {
  for (const key of pairs) {
    const [asset, base] = key.split(":") as [Address, Address];
    try {
      const [aDec, bDec] = await Promise.all([tokenDecimals(asset), tokenDecimals(base)]);
      const r = await route(asset, base, 10n ** BigInt(aDec));
      const price = (r.amountOut * 10n ** 18n) / 10n ** BigInt(bDec);
      const h = history.get(key) ?? [];
      h.push({ t: now, price });
      if (h.length > HISTORY_MAX) h.shift();
      history.set(key, h);
    } catch (err) {
      log(null, `price sample failed for ${key}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

/** Re-read the agent's declared markets now and then, so edits to its details take effect. */
async function refreshMarkets() {
  if (Date.now() - metadataLoadedAt < METADATA_REFRESH_MS) return;
  metadataLoadedAt = Date.now();
  try {
    const [, , , , , uri] = await publicClient.readContract({
      address: marketplace, abi: marketplaceAbi, functionName: "agents", args: [agentId],
    });
    const meta = await loadMetadata(uri);
    const next = meta?.markets?.length ? meta.markets : [offeredMarkets[0]];
    const changed = JSON.stringify(next) !== JSON.stringify(agentMarkets);
    agentMarkets = next;
    if (changed) log(null, `trading ${agentMarkets.length} market(s): ${agentMarkets.map(marketName).join(", ")}`);
  } catch (err) {
    if (!agentMarkets.length) agentMarkets = [offeredMarkets[0]];
    log(null, `couldn't load agent details (${(err as Error).message.split("\n")[0]}); keeping ${agentMarkets.length} market(s)`);
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

async function toPosition(t: Trade, now: bigint): Promise<Position> {
  const open = t.status === "Open";
  if (open && !openedAt.has(t.id)) openedAt.set(t.id, now);
  const value = open ? (await route(t.assetToken, t.baseToken, t.assetAmount)).amountOut : t.amountIn;
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
  // Only open trades on markets this agent says it trades. (Open ones are always managed.)
  if (t.status === "Pending" && !hasMarket(agentMarkets, t.baseToken, t.assetToken)) {
    const note = "pending: not a market this agent trades — leaving it for the buyer to cancel";
    if (lastNote.get(t.id) !== note) log(t.id, note);
    lastNote.set(t.id, note);
    return;
  }

  const pos = await toPosition(t, now);
  const h = history.get(pairKey(t.assetToken, t.baseToken)) ?? [];
  const market: Market = { now, price: h.at(-1)?.price ?? 0n, history: h };
  const nearDeadline = BigInt(pos.secsToDeadline) <= DEADLINE_BUFFER_SEC;

  // Safety rules the strategy can't override.
  let decision: Decision;
  if (pos.phase === "pending" && nearDeadline) decision = { action: "wait", note: "too close to deadline to open" };
  else if (pos.phase === "open" && nearDeadline) decision = { action: "close", reason: "deadline" };
  else decision = await strategy.decide(pos, market);

  if (decision.action === "open" && pos.phase === "pending") {
    const r = await route(t.baseToken, t.assetToken, t.amountIn);
    const via = r.path.length > 2 ? ` via ${r.path.length - 2} hop(s)` : "";
    log(t.id, `opening${decision.note ? ` (${decision.note})` : ""}: ${fmt(t.amountIn)} base -> ~${fmt(r.amountOut)} asset${via}`);
    await send("openPosition", t, r);
    openedAt.set(t.id, now);
    lastNote.delete(t.id);
    log(t.id, "position open");
  } else if (decision.action === "close" && pos.phase === "open") {
    log(t.id, `closing on ${decision.reason} at ${pos.pnlBps / 100}%`);
    await send("closePosition", t, await route(t.assetToken, t.baseToken, t.assetAmount));
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
  await refreshMarkets();

  const count = await tradeCount();
  for (; scanned < count; scanned++) {
    const t = await readTrade(scanned);
    if (t.agentId === agentId && (t.status === "Pending" || t.status === "Open")) {
      watching.add(t.id);
      log(t.id, `new ${t.status.toLowerCase()} trade from ${t.buyer.slice(0, 8)}… for ${fmt(t.amountIn)} ${symbol(t.baseToken)} on ${marketName({ base: t.baseToken, asset: t.assetToken })}`);
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

  // Sample every market we trade, so strategies have history before the first trade arrives.
  const pairs = new Set([
    ...agentMarkets.map((m) => pairKey(m.asset, m.base)),
    ...trades.map((t) => pairKey(t.assetToken, t.baseToken)),
  ]);
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
  ({ marketplace, agentId, routers } = d);
  offeredMarkets = d.markets;
  tokenNames = d.tokens;
  wallet = walletFor("operator");

  await requireMarketplace();
  const strategy = await loadStrategy(values.strategy ?? process.env.STRATEGY ?? "take-profit");
  const agent = await checkAgent();
  log(null, `agent #${agentId} "${agent.name}" (${agent.feeBps / 100}% fee) on ${network}, marketplace ${marketplace}`);
  log(null, `operator ${wallet.account.address} · ${routers.length} approved DEX router(s)`);
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
