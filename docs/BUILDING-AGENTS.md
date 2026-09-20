# Building an agent

This guide takes you from an idea to a listed agent that buyers can hire. You'll write a trading strategy in one TypeScript file, test it against a local chain in about 10 minutes, then list it on testnet.

## How agents work

An agent has three parts:

| Part | What it is | Where it lives |
|---|---|---|
| **Seller** | Your wallet. It lists the agent and receives your fee (up to 8% of profit) on each profitable trade. | A wallet you keep safe |
| **Operator** | The key your bot signs trades with. It can only swap buyers' escrowed funds through owner-approved DEXes, with the proceeds going back to the contract. | Your bot's server |
| **Strategy** | Your code. It decides when to buy and when to sell. | One `.ts` file, run by `./zai run` |

When a buyer hires your agent, their tokens go into escrow in the marketplace contract. Your bot sees the trade, and your strategy decides when to **open** (swap the buyer's base token into the asset) and when to **close** (swap back). On close, the contract measures the result itself and pays out automatically:

- **Profit:** 4% of the profit goes to the protocol, your fee (up to 8%) goes to you, and the rest — at least 88% — goes to the buyer.
- **Loss:** the buyer gets everything back and nobody takes a fee.

If your bot goes offline, buyers aren't stuck:

- **Pending trades** (not yet opened) can be cancelled at any time for a full refund.
- **Open trades** can be exited by the buyer at any time. The contract sells back through the approved DEX and settles as if you'd closed it, so your fee still applies to any profit.
- **After the deadline**, the buyer can reclaim whatever the trade holds.

**Only live agents are offered for hire.** Once a minute, a running bot tells the marketplace website it is alive by posting a *heartbeat*: a short message signed with the operator key (it proves the key is online and nothing else — it can't move funds). The web app lists your agent as **live** and offers it in the hire form while its last heartbeat is under 3 minutes old; when your bot stops, it shows as **offline** and can't be hired until the bot is back. The runner does this for you; set `HEARTBEAT_URL=off` to opt out (your agent then never shows as live). The app also marks an agent **may be offline** when a hired trade sits unopened for more than 5 minutes.

## Quickstart: run a strategy locally

Everything you need is in the [agent kit](https://github.com/jactheman/zilliqa-ai-agent-kit). You need Node 20.12 or newer, and `anvil` from [Foundry](https://book.getfoundry.sh/getting-started/installation) for the local test chain.

```bash
git clone https://github.com/jactheman/zilliqa-ai-agent-kit
cd zilliqa-ai-agent-kit
npm install

anvil                # terminal 1: a local chain (leave it running)
./zai dev up         # terminal 2: deploys a test marketplace, mock tokens and a mock DEX
```

Anvil starts empty every time it restarts, so run `./zai dev up` again after each restart.

**1. Register your agent.** Locally, this signs with a funded test wallet:

```bash
./zai markets              # what this marketplace offers: mZIL/mUSD, mSEED/mUSD
./zai register --name "MyFirstBot" --fee 5 --new-operator \
  --market mZIL/mUSD --market mSEED/mUSD \
  --description "Buys as soon as it's hired, sells at +5% or -3%." \
  --strategy "Take-profit" --risk medium
```

This prints your agent id and a freshly generated operator key. Locally, it also funds that key with gas. The description, strategy and risk are what buyers see on your agent's card (see [Agent details](#agent-details)).

**2. Write your strategy.** Create one from the template:

```bash
./zai init my-strategy     # creates strategies/my-strategy.ts
```

**3. Run it** with the operator key from step 1:

```bash
OPERATOR_KEY=0x... ./zai run --agent 1 --strategy my-strategy
```

**4. Hire it and move the market.** In another terminal, act as a buyer and push the mock price around, then watch your bot react:

```bash
./zai dev hire 100 --agent 1    # a test buyer escrows 100 mUSD (default market)
./zai dev hire 50 --agent 1 --market mSEED/mUSD
./zai dev price -4%             # the asset drops 4%
./zai dev price +9%             # and recovers
./zai status                    # trades and P&L
```

## Writing a strategy

A strategy is one file that default-exports `defineStrategy(...)` with a `decide` function. The runner calls `decide` on every tick (every 2 seconds by default) for every pending or open trade hired to your agent:

```ts
import { defineStrategy, param } from "../src/strategy";

const TARGET_BPS = param("TARGET_BPS", 500); // configurable via env, default +5%

export default defineStrategy({
  name: "my-strategy",
  describe: () => `sell at +${TARGET_BPS / 100}%`,

  decide(position, market) {
    if (position.phase === "pending") return { action: "open" };
    if (position.pnlBps >= TARGET_BPS) return { action: "close", reason: "target hit" };
    return { action: "wait" };
  },
});
```

### What `decide` receives

`position` is one trade:

| Field | Meaning |
|---|---|
| `phase` | `"pending"` (buyer's funds escrowed, you haven't opened yet) or `"open"` (you hold the asset) |
| `amountIn` | Base tokens the buyer escrowed |
| `assetAmount` | Asset tokens held (0 while pending) |
| `value` | What the position is worth in base tokens right now |
| `pnlBps` | Unrealized P&L in basis points (100 = 1%) |
| `heldSec` | Seconds since the position was opened |
| `secsToDeadline` | Seconds until the buyer may reclaim |
| `baseToken`, `assetToken`, `buyer`, `id` | Identifiers |

`market` holds prices:

| Field | Meaning |
|---|---|
| `price` | Latest price of 1 asset in base (1e18-scaled bigint) |
| `history` | Price samples, oldest first, one per tick, capped at 1,000. Starts empty when the runner starts. |
| `now` | Chain timestamp |

### What `decide` returns

| Decision | When it's valid | Effect |
|---|---|---|
| `{ action: "open" }` | pending | Swap all escrowed base into the asset |
| `{ action: "close", reason }` | open | Swap back to base and settle |
| `{ action: "wait", note? }` | always | Do nothing this tick. The note is logged when it changes. |

### Helpers in `src/strategy.ts`

- `param(name, fallback)`: reads a numeric parameter from env, so one strategy file can run with different settings.
- `sma(history, n)`: simple moving average of the last `n` prices, or `null` while there's too little history.
- `diffBps(a, b)`: `(a − b) / b` in basis points.

[`strategies/mean-reversion.ts`](../strategies/mean-reversion.ts) shows a strategy that uses price history.

### What the runner does for you

These rules apply whatever your strategy returns:

- **Best route:** every swap uses the best quote across approved DEXes, directly or through one middle token.
- **Declared markets only:** it opens trades only on markets your agent declares.
- **Slippage limit:** every swap sets a minimum output 1% below the quote (`SLIPPAGE_BPS`). The contract itself rejects any operator swap whose minimum is more than 3% below the router's own quote.
- **No late opens:** a pending trade isn't opened within 120 seconds of its deadline (`DEADLINE_BUFFER_SEC`).
- **Buyer exits are handled:** if a buyer exits an open trade themselves, the runner sees it settled and stops tracking it.
- **Always closes before the deadline:** an open trade is closed before the buyer could reclaim it, so buyers get settled in base tokens, not handed back the asset.
- **Startup checks:** the runner refuses to start if `OPERATOR_KEY` isn't your agent's operator, and warns if the agent is paused.
- **Error isolation:** an error on one trade is logged and doesn't stop the others.

### Tips

- Keep `decide` fast and free of side effects. If you need external data (an API, an indexer), cache it outside `decide` and refresh it on your own timer.
- The runner keeps state in memory, so a restart clears price history and hold times. Prefer strategies that recover sensibly from a cold start.
- `--strategy` takes a name from `strategies/` or a path to any file (`--strategy ./bots/v2.ts`). Keep the `../src/strategy` import pointing at the kit's `src/strategy.ts`.
- Use `--poll 500` locally for faster feedback (the default is 2000 ms).

## Markets

A market is a pair written **ASSET/BASE**. For example, `WZIL/USDC` means buyers deposit and are paid out in USDC, and your agent trades WZIL.

- `./zai markets` lists the markets on a network, with their current price and the DEX route.
- **Your agent declares the markets it trades** with `--market` (repeatable) on `register` or `update`. Buyers can only hire it on those. If you don't declare any, your agent trades only the marketplace's default market.
- **Routing is automatic.** The runner quotes every approved DEX, both directly and through each middle token, and uses the best route. For example, SEED/USDC on testnet goes USDC → WZIL → SEED. Each extra hop costs another swap fee.
- **Stay safe on markets you don't trade.** If a buyer hires you on a market you don't declare, the runner won't open it. The trade stays pending for the buyer to cancel.
- **Your strategy sees the market.** `position.baseToken` and `position.assetToken` tell it which market a trade is on. `market.price` and `market.history` are for that market.

Testnet markets today: **WZIL/USDC** and **SEED/USDC**, both on PlunderSwap.

## Agent details

Your agent's card shows a description, a strategy label, a risk level and links, next to the on-chain name and fee. The contract stores these as a `metadataURI` pointing to a small JSON document:

```json
{
  "description": "Buys 3% dips below the 20-tick average and sells at the mean.",
  "strategy": "Mean reversion",
  "risk": "medium",
  "links": {
    "source": "https://github.com/you/dip-buyer",
    "website": "https://example.com",
    "twitter": "https://x.com/you"
  },
  "markets": [
    { "base": "0x1fD0…USDC", "asset": "0x878c…WZIL" },
    { "base": "0x1fD0…USDC", "asset": "0x28e8…SEED" }
  ]
}
```

`markets` is written for you by `--market`. All fields are optional. Limits: description 280 characters, strategy 60, links must be `http(s)` and at most 200 characters, document at most 16 KB. Unknown fields are ignored. The `name` shown is always the on-chain name, not anything in this file.

You can store this document in three ways:

| URI | Hosting | Can it change? |
|---|---|---|
| `data:application/json,{…}` | None: stored on-chain (up to 2,048 bytes) | Only through `setAgentMetadata` |
| `ipfs://<cid>` | Pin it on IPFS | No: new content means a new CID |
| `https://…/agent.json` | Your server, which must allow CORS | Yes, whenever you edit the file |

The CLI and the web form use the on-chain `data:` option unless you give them a URI. For buyers, `data:` and `ipfs://` details can't change without a transaction or a new CID, which makes them more trustworthy than an `https://` file.

```bash
# set or edit details with flags (edits on top of what's there)
./zai update 1 --description "…" --strategy "Mean reversion" --risk low --source https://github.com/you/bot

# or from a JSON file (stored on-chain), or point at a hosted document
./zai update 1 --metadata ./agent.json
./zai update 1 --metadata ipfs://bafy…

# see exactly what buyers will see
./zai show 1
```

Once the marketplace is live you can also use **Edit** on your agent's card in the web app.

## Trust model

What the contract guarantees, and what it relies on:

- **Operators can't send funds anywhere.** Swaps go through a router the owner approved, the output always returns to the contract, and the contract measures what it actually received.
- **Operators can't accept a bad fill.** Every operator swap must accept at least the router's own quote minus 3%. Buyers exiting choose their own floor.
- **Routes are restricted.** Multi-hop routes may only pass through owner-approved "hub" tokens, at most two per route.
- **Approvals are time-delayed.** A newly approved router or hub only becomes usable after the marketplace's `approvalDelay`, and revoking is immediate. Anyone can see a pending approval on-chain (`RouterAllowed` / `HubAllowed` events, `routerActiveFrom`) and exit before it goes live.
- **What it relies on:** routers are trusted. A malicious router approved by the owner could, once its delay passes, pay out less than it takes. That's why the owner key should be a multisig on mainnet, with a delay of days.

## Managing your agent

```bash
./zai agents --mine                   # your agents
./zai update 1 --fee 3                # new trades only; existing trades keep their fee
./zai update 1 --operator 0xNEW       # rotate the bot key (e.g. if a server was compromised)
./zai update 1 --pause                # stop receiving new trades
./zai update 1 --resume
```

Once the marketplace is live, you can also list, edit, pause and resume agents from the web app.

## Going to testnet

Once the marketplace is deployed on Zilliqa EVM testnet, `git pull` the kit to get its address. Then:

1. Put your keys in `.env` (it's gitignored; see `.env.example`):
   ```bash
   NETWORK=testnet
   SELLER_KEY=0x...      # your wallet
   ```
2. Fund your seller wallet with testnet ZIL from https://faucet.testnet.zilliqa.com, then register:
   ```bash
   ./zai register --name "MyBot" --fee 5 --new-operator --description "…" --risk medium
   ```
3. Send the new operator address some ZIL. It pays gas for every open and close.
4. Run the bot somewhere always-on (a VPS, Fly.io, Railway), with the operator key in the host's secret store:
   ```bash
   NETWORK=testnet OPERATOR_KEY=<secret> ./zai run --agent <id> --strategy my-strategy
   ```
   Within a minute the app shows your agent as **live**. If it stays **offline**, check the bot's log for `heartbeat failed` — buyers can't hire an agent whose bot isn't reporting in.

### Deploy to Railway (or any container host)

The kit ships a `Dockerfile` and a `railway.json`, so a fork of it deploys as-is. Everything is configured with environment variables; `.env` is never copied into the image.

1. Fork the kit on GitHub, add your strategy under `strategies/`, commit and push. (`.env` is gitignored — never commit keys.)
2. On [Railway](https://railway.com): **New Project → Deploy from GitHub repo** and pick your fork. Railway detects the `Dockerfile`. From the CLI instead: `railway init` then `railway up` in your checkout.
3. In the service's **Variables**, set:

   | Variable | Value |
   |---|---|
   | `NETWORK` | `testnet` |
   | `OPERATOR_KEY` | your operator's private key (mark it sealed/secret) |
   | `AGENT_ID` | the id `./zai register` printed |
   | `STRATEGY` | your strategy's file name without `.ts`, e.g. `my-strategy` |
   | `POLL_MS` | optional, default `4000` |

4. Deploy and open the logs. You should see the `agent #<id> "<name>"` line, then `heartbeat: reporting live` within a minute, and the app lists your agent as **live**.

Keep it to **one replica**: two copies of the same bot would both try to sign the same trades. The bot needs no public port, so ignore Railway's networking settings. The same image runs anywhere Docker does: `docker build -t my-bot . && docker run -e NETWORK=testnet -e OPERATOR_KEY=0x… -e AGENT_ID=1 -e STRATEGY=my-strategy my-bot`.

### Key safety

- **Never reuse the seller key as the operator.** A leaked operator key can make bad trades but can't take funds. A leaked seller key gives away your fee income and control of the agent.
- **If the operator key leaks,** rotate it right away with `update <id> --operator <new address>`.
- **The marketplace owner can pause any agent** that misbehaves.

## What buyers see

Buyers see your agent's name, fee, number of settled trades and cumulative buyer P&L, all read straight from the chain, so there's no way to fake a track record. Before they hire, the app spells out the full cost of a winning trade: 4% of profit to the protocol plus your fee, with the total never above 12%. Next to those they see your [agent details](#agent-details).

Neither the name nor the details are verified. The web app refuses a name that's already taken (ignoring case), but the contract itself doesn't check. Linking your strategy's source code is the best way to earn buyers' trust.
