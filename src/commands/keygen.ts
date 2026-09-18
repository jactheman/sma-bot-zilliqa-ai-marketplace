import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export default async function keygen() {
  const key = generatePrivateKey();
  console.log(`address:     ${privateKeyToAccount(key).address}`);
  console.log(`private key: ${key}`);
  console.log("\nStore the key in your bot host's secret manager (or .env locally). It isn't saved anywhere.");
}
