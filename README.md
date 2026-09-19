# Zilliqa AI Marketplace — Agent Kit

Build a trading agent, list it on the [Zilliqa AI Marketplace](https://zilliqa.ai), and earn a share of the profit it makes for buyers.

- **You write a strategy:** one TypeScript file with a `decide()` function.
- **The kit runs it:** it finds trades hired to your agent, prices them, and signs the swaps.
- **Buyers' funds stay in the marketplace contract.** Your bot's key can only swap them through approved DEXes, never withdraw them. Profit is measured on-chain, and you're paid your fee (up to 10% of profit) automatically.

## Quickstart (local, about 10 minutes)

Requirements: Node 20.12+, and `anvil` from [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
git clone https://github.com/jactheman/zilliqa-ai-agent-kit
cd zilliqa-ai-agent-kit
npm install

anvil                                   # terminal 1: local chain
./zai dev up                            # terminal 2: test marketplace, mock tokens, mock DEX

./zai register --name "MyFirstBot" --fee 5 --new-operator --market mZIL/mUSD --market mSEED/mUSD \
  --description "Buys as soon as it's hired, sells at +5% or -3%." --risk medium
./zai init my-strategy                  # strategies/my-strategy.ts
OPERATOR_KEY=0x... ./zai run --agent 1 --strategy my-strategy

./zai dev hire 100 --agent 1            # terminal 3: hire your agent as a test buyer
./zai dev price +6%                     # move the market and watch your bot react
```

**Full guide:** [docs/BUILDING-AGENTS.md](docs/BUILDING-AGENTS.md), also published at [zilliqa.ai/docs/building-agents.html](https://zilliqa.ai/docs/building-agents.html).

## Commands

| Command | What it does |
|---|---|
| `./zai register --name … --fee … --new-operator [details]` | List an agent (signs with `SELLER_KEY`) |
| `./zai update <id> [--fee] [--operator] [--pause/--resume] [details]` | Change an agent |
| `./zai show <id>` / `./zai agents [--mine]` | Inspect agents |
| `./zai markets` | Markets offered, with prices and DEX routes. Declare yours with `--market WZIL/USDC` (repeatable) |
| `./zai init <name>` | Create a strategy from the template |
| `./zai run --agent <id> [--strategy <name or path>] [--poll ms]` | Run your bot (signs with `OPERATOR_KEY`) |
| `./zai keygen` | Generate a key |
| `./zai dev up / hire / price / cancel / exit / reclaim` | Local test marketplace and test buyer (`hire`, `cancel`, `exit` and `reclaim` also work with `--network testnet`) |
| `./zai status` | Trades and P&L |

Add `--network testnet` (or `NETWORK=testnet` in `.env`) to work against Zilliqa EVM testnet once the marketplace is deployed there.

## Keys

Keys are read from the environment or a `.env` file (gitignored; see [.env.example](.env.example)). The local chain uses Anvil's public test keys, so you need none to get started.

- `SELLER_KEY`: your wallet. It lists the agent and receives fees. Keep it off your bot's server.
- `OPERATOR_KEY`: your bot's key. Create it with `--new-operator` or `./zai keygen`. It needs a little ZIL for gas.

Never commit a key. If an operator key leaks, rotate it with `./zai update <id> --operator <new address>`.

## What's in here

- `src/`: the CLI, the agent runner, and the strategy interface (`src/strategy.ts`)
- `strategies/`: example strategies (take-profit, mean-reversion) and yours
- `artifacts/`: the marketplace contract's ABI and bytecode, for the local test chain
- `docs/`: the developer guide

`src/abi.ts`, `src/strategy.ts`, `src/metadata.ts`, `src/networks.ts`, `artifacts/` and `docs/` are synced from the marketplace's main repository, so please don't edit them here.

## License

MIT
