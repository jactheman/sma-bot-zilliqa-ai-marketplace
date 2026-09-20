/** register | update | show | agents — manage listings. Writes sign with SELLER_KEY. */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatEther, getAddress, parseEther, parseEventLogs, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { marketplaceAbi } from "../abi";
import { deployment, network, publicClient, requireMarketplace, walletFor } from "../config";
import { checkMetadataUri, isEmptyMetadata, loadMetadata, sanitizeMetadata, toDataUri, type AgentMetadata } from "../metadata";
import { formatMarket, parseMarket } from "../markets";
import { approvedHubs, bestRoute, hubTokens } from "../routing";
import { agentCount, readAgent, send } from "../trades";

const OPTIONS = {
  name: { type: "string" },
  fee: { type: "string" },
  operator: { type: "string" },
  "new-operator": { type: "boolean" },
  pause: { type: "boolean" },
  resume: { type: "boolean" },
  mine: { type: "boolean" },
  metadata: { type: "string" },
  description: { type: "string" },
  strategy: { type: "string" },
  risk: { type: "string" },
  website: { type: "string" },
  source: { type: "string" },
  market: { type: "string", multiple: true },
} as const;

type Opts = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];
const DETAIL_FLAGS = ["description", "strategy", "risk", "website", "source", "market"] as const;
const OPERATOR_GAS_FUNDING = parseEther("1"); // local only

/** Percent string ("5", "2.5") -> basis points, validated against the contract cap. */
function feeBps(pct: string) {
  const bps = Math.round(Number(pct) * 100);
  if (!Number.isFinite(bps) || bps < 0 || bps > 1200) throw new Error(`--fee must be between 0 and 12 (percent of profit), got "${pct}"`);
  return bps;
}

/** metadataURI from --metadata (URI or .json file) or the detail flags; undefined if none given. */
async function metadataFromArgs(opts: Opts, current?: AgentMetadata | null): Promise<string | undefined> {
  const usesFlags = DETAIL_FLAGS.some((k) => opts[k] !== undefined);
  if (opts.metadata !== undefined && usesFlags) throw new Error("use either --metadata or the detail flags, not both");

  let uri: string;
  if (usesFlags) {
    if (opts.risk !== undefined && !["low", "medium", "high"].includes(opts.risk)) throw new Error("--risk must be low, medium or high");
    const base = current ?? {};
    const meta = sanitizeMetadata({
      ...base,
      ...(opts.description !== undefined && { description: opts.description }),
      ...(opts.strategy !== undefined && { strategy: opts.strategy }),
      ...(opts.risk !== undefined && { risk: opts.risk }),
      links: {
        ...base.links,
        ...(opts.website !== undefined && { website: opts.website }),
        ...(opts.source !== undefined && { source: opts.source }),
      },
      ...(opts.market !== undefined && { markets: opts.market.map(parseMarket) }),
    });
    if (opts.market) await checkMarketsRoutable(meta.markets ?? []);
    for (const k of ["website", "source"] as const) {
      if (opts[k] && !meta.links?.[k]) throw new Error(`--${k} must be an http(s) URL under 200 characters`);
    }
    uri = isEmptyMetadata(meta) ? "" : toDataUri(meta);
  } else if (opts.metadata !== undefined) {
    if (opts.metadata.endsWith(".json") && existsSync(opts.metadata)) {
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(opts.metadata, "utf8"));
      } catch {
        throw new Error(`${opts.metadata} is not valid JSON`);
      }
      uri = toDataUri(sanitizeMetadata(json));
    } else {
      uri = opts.metadata;
    }
  } else {
    return undefined;
  }

  const problem = checkMetadataUri(uri);
  if (problem) throw new Error(problem);
  try {
    const meta = await loadMetadata(uri);
    if (meta && isEmptyMetadata(meta)) console.log("warning: metadata has no recognised fields (description, strategy, risk, links)");
  } catch (err) {
    if (uri.startsWith("data:")) throw err;
    console.log(`warning: couldn't load ${uri} right now (${(err as Error).message}); saving it anyway`);
  }
  return uri;
}

/** Warn about declared markets no approved DEX can route (the bot couldn't trade them). */
async function checkMarketsRoutable(markets: NonNullable<AgentMetadata["markets"]>) {
  const d = deployment();
  const hubs = await approvedHubs(publicClient, d.marketplace, hubTokens([...d.markets, ...markets]));
  for (const m of markets) {
    const r = await bestRoute(publicClient, d.routers, m.base, m.asset, 10n ** 15n, hubs);
    if (!r) console.log(`warning: no DEX route for ${formatMarket(m)} — buyers could hire you on it but your bot couldn't trade it`);
  }
}

function printMetadata(meta: AgentMetadata | null) {
  if (!meta || isEmptyMetadata(meta)) return console.log('  details: none — add some with: zai update <id> --description "…" --risk medium');
  if (meta.strategy) console.log(`  strategy: ${meta.strategy}`);
  if (meta.risk) console.log(`  risk: ${meta.risk}`);
  if (meta.description) console.log(`  description: ${meta.description}`);
  for (const [k, v] of Object.entries(meta.links ?? {})) console.log(`  ${k}: ${v}`);
  console.log(`  markets: ${(meta.markets ?? []).map(formatMarket).join(", ") || `${formatMarket(deployment().markets[0])} (default)`}`);
}

/** The operator pays gas for every open/close, so it needs native tokens. */
async function checkOperatorGas(operator: Address) {
  const balance = await publicClient.getBalance({ address: operator });
  if (balance > 0n) return;
  if (network === "local") {
    const wallet = walletFor("seller");
    await send(await wallet.sendTransaction({ to: operator, value: OPERATOR_GAS_FUNDING }));
    console.log(`funded operator with ${formatEther(OPERATOR_GAS_FUNDING)} ETH for gas (local only)`);
  } else {
    console.log(`\n⚠ operator ${operator} has no ZIL. Send it some for gas before starting the bot.`);
  }
}

async function register(opts: Opts) {
  const wallet = walletFor("seller");
  const me = wallet.account.address;
  if (!opts.name) throw new Error("--name is required");
  if (opts.fee === undefined) throw new Error("--fee is required (percent of profit, 0-10)");
  if (opts.operator && opts["new-operator"]) throw new Error("use either --operator or --new-operator, not both");
  const fee = feeBps(opts.fee);
  const metadataURI = (await metadataFromArgs(opts)) ?? "";
  if (!metadataURI) console.log("tip: add --description, --strategy, --risk and --source so buyers know what they're hiring");

  let operator: Address = me;
  let operatorKey: string | undefined;
  if (opts["new-operator"]) {
    operatorKey = generatePrivateKey();
    operator = privateKeyToAccount(operatorKey as `0x${string}`).address;
  } else if (opts.operator) {
    operator = getAddress(opts.operator);
  }
  if (operator === me) {
    console.log("note: your seller wallet is also the operator. A separate --new-operator key is safer: a compromised bot server then can't touch your fee income.");
  }

  const receipt = await send(
    await wallet.writeContract({
      address: deployment().marketplace, abi: marketplaceAbi, functionName: "listAgent",
      args: [opts.name, operator, fee, metadataURI],
    }),
  );
  const [ev] = parseEventLogs({ abi: marketplaceAbi, eventName: "AgentListed", logs: receipt.logs });
  const id = ev.args.id;

  console.log(`\n✓ listed agent #${id} "${opts.name}" at ${fee / 100}% of profit on ${network}`);
  console.log(`  seller (earns fees): ${me}`);
  console.log(`  operator (bot key):  ${operator}`);
  if (operatorKey) {
    console.log(`\n  operator private key: ${operatorKey}`);
    console.log("  Store it in your bot's secret manager (or .env as OPERATOR_KEY) now — it isn't saved anywhere.");
  }
  await checkOperatorGas(operator);

  const net = network === "local" ? "" : ` --network ${network}`;
  console.log(`\nNext:\n  ./zai init my-strategy\n  ${operatorKey ? `OPERATOR_KEY=${operatorKey} ` : ""}./zai run --agent ${id} --strategy my-strategy${net}`);
}

async function update(opts: Opts, idArg: string | undefined) {
  if (idArg === undefined) throw new Error("usage: zai update <agentId> [--fee pct] [--operator addr] [--pause|--resume] [details]");
  const wallet = walletFor("seller");
  const me = wallet.account.address;
  const id = BigInt(idArg);
  const a = await readAgent(id);
  if (a.seller === zeroAddress) throw new Error(`agent #${id} doesn't exist`);
  if (a.seller !== me) throw new Error(`agent #${id} belongs to ${a.seller}, not ${me}`);
  if (opts.pause && opts.resume) throw new Error("use either --pause or --resume");

  const operator = opts.operator ? getAddress(opts.operator) : a.operator;
  const fee = opts.fee !== undefined ? feeBps(opts.fee) : a.feeBps;
  const active = opts.pause ? false : opts.resume ? true : a.active;
  const current = await loadMetadata(a.metadataURI).catch(() => null);
  const metadataURI = await metadataFromArgs(opts, current);

  const settingsChanged = operator !== a.operator || fee !== a.feeBps || active !== a.active;
  if (!settingsChanged && metadataURI === undefined) throw new Error("nothing to update — pass --fee, --operator, --pause/--resume, or details");

  const { marketplace } = deployment();
  if (settingsChanged) {
    await send(await wallet.writeContract({ address: marketplace, abi: marketplaceAbi, functionName: "updateAgent", args: [id, operator, fee, active] }));
    console.log(`✓ agent #${id} "${a.name}": fee ${fee / 100}%, operator ${operator}, ${active ? "active" : "paused"}`);
    if (fee !== a.feeBps) console.log("  (fee changes apply to new trades; existing trades keep the fee they were hired at)");
    if (operator !== a.operator) await checkOperatorGas(operator);
  }
  if (metadataURI !== undefined && metadataURI !== a.metadataURI) {
    await send(await wallet.writeContract({ address: marketplace, abi: marketplaceAbi, functionName: "setAgentMetadata", args: [id, metadataURI] }));
    console.log(`✓ agent #${id} details updated`);
    printMetadata(await loadMetadata(metadataURI).catch(() => null));
  }
}

async function show(idArg: string | undefined) {
  if (idArg === undefined) throw new Error("usage: zai show <agentId>");
  const a = await readAgent(BigInt(idArg));
  if (a.seller === zeroAddress) throw new Error(`agent #${idArg} doesn't exist`);
  console.log(`agent #${a.id} "${a.name}" — ${a.feeBps / 100}% of profit, ${a.active ? "active" : "paused"} (${network})`);
  console.log(`  seller: ${a.seller}\n  operator: ${a.operator}`);
  if (a.metadataURI && !a.metadataURI.startsWith("data:")) console.log(`  metadataURI: ${a.metadataURI}`);
  try {
    printMetadata(await loadMetadata(a.metadataURI));
  } catch (err) {
    console.log(`  details: couldn't load (${(err as Error).message})`);
  }
}

async function list(opts: Opts) {
  const me = opts.mine ? walletFor("seller").account.address : undefined;
  const rows = [];
  for (let i = 0n, n = await agentCount(); i < n; i++) {
    const a = await readAgent(i);
    if (me && a.seller !== me) continue;
    const meta = await loadMetadata(a.metadataURI).catch(() => null);
    const markets = meta?.markets?.length ? meta.markets : [deployment().markets[0]];
    rows.push({ id: Number(a.id), name: a.name, fee: `${a.feeBps / 100}%`, active: a.active, markets: markets.map(formatMarket).join(" "), strategy: meta?.strategy ?? "", risk: meta?.risk ?? "" });
  }
  console.log(me ? `agents owned by ${me} on ${network}` : `agents on ${network}`);
  if (rows.length) console.table(rows);
  else console.log("  none yet — try: ./zai register --name MyBot --fee 5 --new-operator");
}

export default async function agents(cmd: string, args: string[]) {
  const { values: opts, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true });
  await requireMarketplace();
  if (cmd === "register") return register(opts);
  if (cmd === "update") return update(opts, positionals[0]);
  if (cmd === "show") return show(positionals[0]);
  return list(opts);
}
