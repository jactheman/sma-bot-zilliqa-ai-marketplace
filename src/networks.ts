// Synced from the marketplace repo by scripts/export-kit.mjs — edit it there, not here.
// Shared by the Node tools and the browser app.
export const NETWORKS = {
  local: { id: 31337, name: "Anvil (local)", rpc: "http://127.0.0.1:8545" },
  testnet: { id: 33101, name: "Zilliqa EVM Testnet", rpc: "https://api.testnet.zilliqa.com" },
  mainnet: { id: 32769, name: "Zilliqa EVM Mainnet", rpc: "https://api.zilliqa.com" },
} as const;

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
  marketplace: `0x${string}`;
  router: `0x${string}`;
  baseToken: `0x${string}`;
  assetToken: `0x${string}`;
  agentId: number;
}
