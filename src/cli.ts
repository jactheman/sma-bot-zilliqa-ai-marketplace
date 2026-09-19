/**
 * zai — the Zilliqa AI Marketplace agent kit CLI.
 * Global option: --network local|testnet|mainnet (or NETWORK in .env). Keys come from .env.
 */
try {
  process.loadEnvFile();
} catch {}

const argv = process.argv.slice(2);
const at = argv.findIndex((a) => a === "--network" || a.startsWith("--network="));
if (at >= 0) {
  const inline = argv[at].includes("=");
  process.env.NETWORK = inline ? argv[at].split("=")[1] : argv[at + 1];
  argv.splice(at, inline ? 1 : 2);
}

const HELP = `zai — build, register and run agents for the Zilliqa AI Marketplace

Agents
  register --name <n> --fee <pct> [--new-operator | --operator <addr>]
           [--description … --strategy … --risk low|medium|high --source <url> --website <url>
            --market WZIL/USDC (repeatable) | --metadata <uri|file.json>]
  update <id> [--fee <pct>] [--operator <addr>] [--pause | --resume] [details flags | --metadata …]
  show <id>                 one agent, with the details buyers see
  agents [--mine]           list agents
  markets                   markets on this network, with routes and prices

Bots
  init <name>               create strategies/<name>.ts from the template
  run --agent <id> [--strategy <name|path>]    run your bot (signs with OPERATOR_KEY)
  keygen                    generate a new key (e.g. for an operator)

Local testing (needs \`anvil\` running)
  dev up                    deploy a local marketplace with mock tokens and a mock DEX
  dev hire <amount> [--agent <id>] [--market WZIL/USDC] [--duration <secs>]    hire an agent as a test buyer
  dev price [+5% | -3% | 0.021]                           show or move the mock price
  dev cancel <tradeId> | dev exit <tradeId> | dev reclaim <tradeId>
  status                    agents, trades, P&L

Options
  --network local|testnet|mainnet   default: local (or NETWORK in .env)

Guide: docs/BUILDING-AGENTS.md`;

const commands: Record<string, () => Promise<{ default: (args: string[]) => Promise<void> } | { [k: string]: unknown }>> = {
  register: () => import("./commands/agents.ts"),
  update: () => import("./commands/agents.ts"),
  show: () => import("./commands/agents.ts"),
  agents: () => import("./commands/agents.ts"),
  init: () => import("./commands/init.ts"),
  run: () => import("./commands/run.ts"),
  keygen: () => import("./commands/keygen.ts"),
  dev: () => import("./commands/dev.ts"),
  status: () => import("./commands/status.ts"),
  markets: () => import("./commands/markets.ts"),
};

const [cmd, ...rest] = argv;
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || !commands[cmd]) {
  console.log(HELP);
  process.exit(cmd && !["help", "--help", "-h"].includes(cmd) ? 1 : 0);
}

try {
  const mod = (await commands[cmd]()) as { default: (cmd: string, args: string[]) => Promise<void> };
  await mod.default(cmd, rest);
} catch (err) {
  console.error(`error: ${(err as Error).message.split("\n")[0]}`);
  process.exit(1);
}

export {};
