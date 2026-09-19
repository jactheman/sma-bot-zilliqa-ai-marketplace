import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, NETWORKS, deploymentRouters, networkMarkets, networkTokens, parseMarkets, type Market, type NetworkName } from "./networks";

export type Role = keyof typeof ANVIL_KEYS;

export const network = (process.env.NETWORK ?? "local") as NetworkName;
if (!(network in NETWORKS)) throw new Error(`Unknown network "${network}" (local | testnet | mainnet)`);
const net = NETWORKS[network];

export const rpcUrl = process.env.RPC_URL ?? net.rpc;
export const chain = defineChain({
  id: net.id,
  name: net.name,
  nativeCurrency: { name: "ZIL", symbol: "ZIL", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
export const publicClient = createPublicClient({ chain, transport: http() });

export const kitPath = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
export const deploymentFile = () =>
  process.env.DEPLOYMENT_FILE ? resolve(process.cwd(), process.env.DEPLOYMENT_FILE) : kitPath(`deployments/${network}.json`);

export interface ResolvedDeployment {
  marketplace: Address;
  router: Address;
  baseToken: Address;
  assetToken: Address;
  agentId: bigint;
  /** Every approved router, markets offered and known tokens (see src/networks.ts). */
  routers: Address[];
  markets: Market[];
  tokens: Record<string, Address>;
}

let cached: ResolvedDeployment | undefined;

/** Marketplace addresses: env vars first, then deployments/<network>.json. */
export function deployment(): ResolvedDeployment {
  if (cached) return cached;
  const file = deploymentFile();
  const json = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const hint =
    network === "local"
      ? "Start a local chain with `anvil`, then run `./zai dev up`."
      : `The marketplace address for ${network} isn't published in this kit yet — update the kit, or set MARKETPLACE_ADDRESS.`;
  const pick = (env: string, key: string): Address => {
    const v = process.env[env] ?? json[key];
    if (!v) throw new Error(`No marketplace deployment for ${network}. ${hint}`);
    return getAddress(v);
  };
  cached = {
    marketplace: pick("MARKETPLACE_ADDRESS", "marketplace"),
    router: pick("ROUTER_ADDRESS", "router"),
    baseToken: pick("BASE_TOKEN", "baseToken"),
    assetToken: pick("ASSET_TOKEN", "assetToken"),
    agentId: BigInt(process.env.AGENT_ID ?? json.agentId ?? 0),
    routers: [],
    markets: [],
    tokens: {},
  };
  cached.routers = deploymentRouters({ router: cached.router, routers: json.routers });
  cached.markets = networkMarkets(network, { ...cached, markets: parseMarkets(json.markets) });
  cached.tokens = networkTokens(network, { tokens: json.tokens });
  return cached;
}

/** Fail early with an actionable message when the chain is down or the marketplace isn't there. */
export async function requireMarketplace() {
  const { marketplace } = deployment();
  let code;
  try {
    code = await publicClient.getCode({ address: marketplace });
  } catch {
    throw new Error(`Can't reach ${chain.name} at ${rpcUrl}.${network === "local" ? " Is `anvil` running?" : ""}`);
  }
  if (!code || code === "0x") {
    throw new Error(
      `No marketplace contract at ${marketplace} on ${chain.name}.` +
        (network === "local" ? " Anvil starts empty on every restart — run `./zai dev up`." : ""),
    );
  }
}

/** Private key for a role: <ROLE>_KEY from env/.env, or Anvil's public dev key on the local chain. */
export function keyFor(role: Role): Hex | undefined {
  return (process.env[`${role.toUpperCase()}_KEY`] ?? (network === "local" ? ANVIL_KEYS[role] : undefined)) as Hex | undefined;
}

export function walletFor(role: Role) {
  const key = keyFor(role);
  if (!key) throw new Error(`Set ${role.toUpperCase()}_KEY (in .env or the environment) to act as ${role} on ${network}.`);
  return createWalletClient({ account: privateKeyToAccount(key), chain, transport: http() });
}
