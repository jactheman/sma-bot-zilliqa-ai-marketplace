// Synced from the marketplace repo by scripts/export-kit.mjs — edit it there, not here.
// Shared by the Node tools and the browser app.

type Hex40 = `0x${string}`;

/** A tradable pair: buyers deposit `base` and are paid back in it; agents trade into `asset`. */
export interface Market {
  base: Hex40;
  asset: Hex40;
}

interface NetworkConfig {
  id: number;
  name: string;
  rpc: string;
  /** Tokens by symbol. Local chains get theirs from the deployment file instead. */
  tokens: Record<string, Hex40>;
  /** Markets offered in the app and suggested to agent builders. */
  markets: Market[];
}

const TESTNET_TOKENS = {
  USDC: "0x1fD09F6701a1852132A649fe9D07F2A3b991eCfA",
  WZIL: "0x878c5008A348A60a5B239844436A7b483fAdb7F2",
  SEED: "0x28e8d39Fc68eaA27c88797Eb7D324b4B97D5b844",
} as const;

export const NETWORKS = {
  local: { id: 31337, name: "Anvil (local)", rpc: "http://127.0.0.1:8545", tokens: {}, markets: [] },
  testnet: {
    id: 33101,
    name: "Zilliqa EVM Testnet",
    rpc: "https://api.testnet.zilliqa.com",
    tokens: TESTNET_TOKENS,
    // PlunderSwap pools: WZIL/USDC directly, SEED via WZIL.
    markets: [
      { base: TESTNET_TOKENS.USDC, asset: TESTNET_TOKENS.WZIL },
      { base: TESTNET_TOKENS.USDC, asset: TESTNET_TOKENS.SEED },
    ],
  },
  mainnet: { id: 32769, name: "Zilliqa EVM Mainnet", rpc: "https://api.zilliqa.com", tokens: {}, markets: [] },
} satisfies Record<string, NetworkConfig>;

export type NetworkName = keyof typeof NETWORKS;

/** Anvil's public dev keys. Only ever used against a local chain. */
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  seller: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  operator: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  buyer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

export interface Deployment {
  chainId: number;
  marketplace: Hex40;
  /** Default router; `routers` lists every approved one when there are several. */
  router: Hex40;
  routers?: Hex40[];
  /** Default market (the first one offered). */
  baseToken: Hex40;
  assetToken: Hex40;
  agentId: number;
  /** Local deployments carry their own tokens and markets; live networks use NETWORKS. */
  tokens?: Record<string, Hex40>;
  markets?: Market[];
}

/**
 * Deployment files may store `markets` as an array or as a JSON string (Foundry's JSON writer
 * can only emit the latter). Accept both.
 */
export function parseMarkets(v: unknown): Market[] | undefined {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(v) ? (v as Market[]) : undefined;
}

/** Markets offered on a network: deployment's own, else the network's, else the default pair. */
export function networkMarkets(network: NetworkName, dep: Pick<Deployment, "baseToken" | "assetToken" | "markets">): Market[] {
  if (dep.markets?.length) return dep.markets;
  const configured: Market[] = NETWORKS[network].markets;
  return configured.length ? configured : [{ base: dep.baseToken, asset: dep.assetToken }];
}

/** Token symbol -> address for a network (deployment tokens override the config). */
export function networkTokens(network: NetworkName, dep: Pick<Deployment, "tokens">): Record<string, Hex40> {
  return { ...(NETWORKS[network].tokens as Record<string, Hex40>), ...(dep.tokens ?? {}) };
}

/** Every router a deployment approved. */
export const deploymentRouters = (dep: Pick<Deployment, "router" | "routers">): Hex40[] =>
  dep.routers?.length ? dep.routers : [dep.router];
