/**
 * zai dev … — test your agent end to end.
 *   up                     deploy a local marketplace (Anvil) with mock tokens and a mock DEX
 *   hire <amount>          hire an agent as a test buyer (BUYER_KEY; Anvil dev key locally)
 *   price [+5%|-3%|0.021]  show or move the mock DEX price (local only)
 *   cancel <id> / exit <id> / reclaim <id>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { erc20Abi, formatUnits, getAddress, parseEventLogs, parseUnits, type Abi, type Address, type Hex } from "viem";
import { marketplaceAbi, mockErc20Abi, routerAbi } from "../abi";
import { chain, deployment, deploymentFile, kitPath, network, publicClient, requireMarketplace, rpcUrl, walletFor } from "../config";
import { toDataUri } from "../metadata";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS } from "../networks";
import { formatMarket, parseMarket, symbolOf } from "../markets";
import { bestRoute, hubTokens } from "../routing";
import { fmt, readTrade, send } from "../trades";

const artifact = (name: string) =>
  JSON.parse(readFileSync(kitPath(`artifacts/${name}.json`), "utf8")) as { abi: Abi; bytecode: Hex };

const DEMO_METADATA = toDataUri({
  description: "Buys as soon as it is hired and exits at +10% or -5%, or after an hour.",
  strategy: "Take-profit / stop-loss",
  risk: "medium",
  links: { source: "https://github.com/jactheman/zilliqa-ai-agent-kit/blob/main/strategies/take-profit.ts" },
});

async function up() {
  if (network !== "local") throw new Error("dev up only deploys to a local chain (--network local)");
  try {
    await publicClient.getBlockNumber();
  } catch {
    throw new Error(`Can't reach ${rpcUrl}. Start a local chain first: anvil`);
  }

  const deployer = walletFor("deployer");
  const seller = walletFor("seller");
  const buyer = privateKeyToAccount(ANVIL_KEYS.buyer).address;
  const operator = privateKeyToAccount(ANVIL_KEYS.operator).address;

  const deploy = async (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const hash = await deployer.deployContract({ abi, bytecode, args });
    const { contractAddress } = await send(hash);
    if (!contractAddress) throw new Error(`${name} deployment returned no address`);
    return getAddress(contractAddress);
  };
  const call = async (address: Address, abi: Abi, functionName: string, args: unknown[]) =>
    send(await deployer.writeContract({ address, abi, functionName, args } as never));

  console.log("deploying mock tokens, mock DEX and marketplace…");
  const usd = await deploy("MockERC20", ["Mock USD", "mUSD"]);
  const zil = await deploy("MockERC20", ["Mock ZIL", "mZIL"]);
  const seed = await deploy("MockERC20", ["Mock SEED", "mSEED"]);
  const router = await deploy("MockRouter", []);
  await call(router, routerAbi, "setRate", [zil, usd, parseUnits("0.02", 18)]);
  // mSEED only trades against mZIL, like SEED on testnet, so mSEED/mUSD needs a two-hop route.
  await call(router, routerAbi, "setRate", [seed, zil, parseUnits("0.8", 18)]);
  const marketplace = await deploy("Marketplace", [deployer.account.address]);
  await call(marketplace, marketplaceAbi, "setRouter", [router, true]);
  await call(usd, mockErc20Abi, "mint", [buyer, parseUnits("10000", 18)]);

  const receipt = await send(
    await seller.writeContract({
      address: marketplace, abi: marketplaceAbi, functionName: "listAgent",
      args: ["MomentumBot", operator, 1000, DEMO_METADATA],
    }),
  );
  const [ev] = parseEventLogs({ abi: marketplaceAbi, eventName: "AgentListed", logs: receipt.logs });

  const out = {
    chainId: chain.id, marketplace, router, baseToken: usd, assetToken: zil, agentId: Number(ev.args.id),
    tokens: { mUSD: usd, mZIL: zil, mSEED: seed },
    markets: [{ base: usd, asset: zil }, { base: usd, asset: seed }],
  };
  writeFileSync(deploymentFile(), JSON.stringify(out, null, 2) + "\n");
  console.log(`✓ local marketplace ready at ${marketplace}`);
  console.log(`  demo agent #${out.agentId} "MomentumBot" (run it: ./zai run --agent ${out.agentId})`);
  console.log("  markets: mZIL/mUSD, mSEED/mUSD (via mZIL)");
  console.log(`  test buyer ${buyer} has 10,000 mUSD`);
  console.log(`  saved ${deploymentFile().replace(kitPath(""), "")}`);
  console.log("\nNext: ./zai register --name MyBot --fee 5 --new-operator");
}

async function hire(args: string[]) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { agent: { type: "string" }, duration: { type: "string" }, market: { type: "string" } },
  });
  const { marketplace } = deployment();
  const { base: baseToken, asset: assetToken } = values.market ? parseMarket(values.market) : deployment().markets[0];
  const agentId = BigInt(values.agent ?? deployment().agentId);
  const amount = parseUnits(positionals[0] ?? "100", 18);
  const duration = BigInt(values.duration ?? 3600);
  const wallet = walletFor("buyer");
  const me = wallet.account.address;

  const balance = await publicClient.readContract({ address: baseToken, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  if (balance < amount) throw new Error(`buyer balance ${fmt(balance)} is less than ${fmt(amount)}`);
  const allowance = await publicClient.readContract({ address: baseToken, abi: erc20Abi, functionName: "allowance", args: [me, marketplace] });
  if (allowance < amount) {
    await send(await wallet.writeContract({ address: baseToken, abi: erc20Abi, functionName: "approve", args: [marketplace, amount] }));
  }
  const receipt = await send(
    await wallet.writeContract({
      address: marketplace, abi: marketplaceAbi, functionName: "proposeTrade",
      args: [agentId, baseToken, assetToken, amount, duration],
    }),
  );
  const [ev] = parseEventLogs({ abi: marketplaceAbi, eventName: "TradeProposed", logs: receipt.logs });
  console.log(`✓ trade #${ev.args.id}: ${fmt(ev.args.amountIn)} ${symbolOf(baseToken)} escrowed for agent #${agentId} on ${formatMarket({ base: baseToken, asset: assetToken })}, deadline in ${duration}s`);
}

async function price(arg: string | undefined) {
  if (network !== "local") throw new Error("dev price only moves the mock DEX on a local chain");
  const { router, baseToken, assetToken } = deployment();
  const current = await publicClient.readContract({ address: router, abi: routerAbi, functionName: "rate", args: [assetToken, baseToken] });
  if (!arg) return console.log(`1 asset = ${formatUnits(current, 18)} base`);

  const pct = arg.match(/^([+-]?\d+(?:\.\d+)?)%$/);
  const next = pct ? (current * BigInt(Math.round((100 + Number(pct[1])) * 100))) / 10_000n : parseUnits(arg, 18);
  if (next <= 0n) throw new Error("price must stay above zero");
  await send(await walletFor("deployer").writeContract({ address: router, abi: routerAbi, functionName: "setRate", args: [assetToken, baseToken, next] }));
  console.log(`price ${formatUnits(current, 18)} -> ${formatUnits(next, 18)} base per asset`);
}

/** Buyer closes their own Open trade now (e.g. the agent's bot is offline). */
async function exit(idArg: string | undefined) {
  if (idArg === undefined) throw new Error("usage: zai dev exit <tradeId>");
  const id = BigInt(idArg);
  const d = deployment();
  const t = await readTrade(id);
  if (t.status !== "Open") throw new Error(`trade #${id} is ${t.status}, not Open`);
  const r = await bestRoute(publicClient, d.routers, t.assetToken, t.baseToken, t.assetAmount, hubTokens(d.markets));
  if (!r) throw new Error("no DEX route to sell this position right now");
  const quote = r.amountOut;
  await send(
    await walletFor("buyer").writeContract({
      address: d.marketplace, abi: marketplaceAbi, functionName: "exitPosition",
      args: [id, r.router, r.path, (quote * 99n) / 100n],
    }),
  );
  const settled = await readTrade(id);
  console.log(`✓ trade #${id} exited: ${fmt(settled.amountOut)} back (quoted ${fmt(quote)})`);
}

async function buyerAction(kind: "cancel" | "reclaim", idArg: string | undefined) {
  if (idArg === undefined) throw new Error(`usage: zai dev ${kind} <tradeId>`);
  const id = BigInt(idArg);
  await send(
    await walletFor("buyer").writeContract({
      address: deployment().marketplace, abi: marketplaceAbi,
      functionName: kind === "cancel" ? "cancelTrade" : "reclaim", args: [id],
    }),
  );
  console.log(`✓ trade #${id} ${kind === "cancel" ? "cancelled" : "reclaimed"}`);
}

export default async function dev(_cmd: string, args: string[]) {
  const [sub, ...rest] = args;
  if (sub === "up") return up();
  await requireMarketplace();
  if (sub === "hire") return hire(rest);
  if (sub === "price") return price(rest[0]);
  if (sub === "cancel" || sub === "reclaim") return buyerAction(sub, rest[0]);
  if (sub === "exit") return exit(rest[0]);
  throw new Error("usage: zai dev up | hire <amount> | price [+5%] | cancel <id> | exit <id> | reclaim <id>");
}
