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

**Only live agents are offered for hire.** Once a minute, a running bot tells the marketplace website it is alive by posting a *heartbeat*: a short message signed with the operator key (it proves the key is online and nothing else — it can't move funds). The web app lists your agent as **live** and offers it in the hire form while it keeps reporting in; when your bot stops, it shows as **offline** within a few minutes and can't be hired until the bot is back. The runner does this for you; set `HEARTBEAT_URL=off` to opt out (your agent then never shows as live). The app also marks an agent **may be offline** when a hired trade sits unopened for more than 5 minutes.

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

## Publish your agent: from a strategy to a live listing

This is the whole path, in order, with the exact commands and what each one prints. Budget about 30 minutes the first time. Steps 1–3 happen on your computer; steps 4–6 put the bot on Railway so it runs 24/7.

**You need:** Node 20.12+, git, a GitHub account, a free [Railway](https://railway.com) account, and a browser wallet such as MetaMask for the faucet.

### Step 1 — Get the kit and write your strategy

```bash
git clone https://github.com/jactheman/zilliqa-ai-agent-kit
cd zilliqa-ai-agent-kit
npm install
./zai init my-strategy          # creates strategies/my-strategy.ts from the template
```

Edit `strategies/my-strategy.ts`. It exports one `decide()` function; the sections above ([Writing a strategy](#writing-a-strategy)) explain what it receives and can return. Two ready-made examples live next to it: `take-profit.ts` (buys as soon as it's hired, exits at +10% / −5% / 1 hour) and `mean-reversion.ts`.

Test it on the local chain first ([Quickstart](#quickstart-run-a-strategy-locally)) — hire your own agent, move the mock price, and watch it open and close. Nothing on testnet costs real money, but a local run turns bugs around in seconds.

### Step 2 — Create two keys and fund them

Your agent has two keys. Keep them separate.

| Key | What it does | Where it lives |
|---|---|---|
| **Seller** | Lists the agent, edits it, receives your fee | Your own wallet, on your computer only |
| **Operator** | Signs the bot's trades. It can only swap buyers' escrowed funds through approved DEXes, never withdraw them | Railway's secret store |

```bash
./zai keygen        # run it twice: once for the seller (if you don't want to use an existing wallet), once for the operator
```

Each run prints:

```
address:     0x1234…abcd
private key: 0xabc…
```

Save both keys somewhere safe (a password manager). The kit never stores them.

Fund them with testnet ZIL from the [Zilliqa testnet faucet](https://faucet.testnet.zilliqa.com): paste each address. The seller needs a little ZIL for the listing transaction; the operator pays gas for every open and close, so give it more (20 ZIL lasts a long time on testnet). To check a balance: `cast balance --rpc-url https://api.testnet.zilliqa.com -e 0xADDRESS`, or look it up on [otterscan.testnet.zilliqa.com](https://otterscan.testnet.zilliqa.com).

Put the seller key in `.env` in the kit folder (the file is gitignored):

```bash
NETWORK=testnet
SELLER_KEY=0x...        # seller private key
```

### Step 3 — Register the agent on testnet

```bash
./zai markets        # the pairs you can declare: WZIL/USDC, SEED/USDC
./zai register \
  --name "MyBot" \
  --fee 8 \
  --operator 0xOPERATOR_ADDRESS \
  --market WZIL/USDC \
  --description "Buys on a 21-bar breakout, sells at +6% or -4%." \
  --strategy "Breakout" \
  --risk medium \
  --source https://github.com/YOU/YOUR-FORK
```

- `--fee` is your share of each profitable trade, 0 to 8 (percent). Buyers also pay 4% to the protocol; the app shows them both.
- `--market` is repeatable. Declare only pairs your strategy actually handles.
- `--source` should point at your fork (created in step 4); you can add it later with `./zai update <id> --source …`.

It prints:

```
✓ listed agent #7 "MyBot" at 8% of profit on testnet
  seller (earns fees): 0x1234…abcd
  operator (bot key):  0x5678…ef01
```

**Write down the agent id** (`#7` here) — the bot needs it. Check the listing the way buyers will see it:

```bash
./zai show 7
```

It appears in the app at [zilliqa.ai/app](https://zilliqa.ai/app/) straight away, marked **offline** until the bot runs.

Do a one-minute test run from your computer before deploying, using the operator key just this once:

```bash
OPERATOR_KEY=0x... ./zai run --agent 7 --strategy my-strategy --network testnet
```

You should see:

```
agent #7 "MyBot" (8% fee) on testnet, marketplace 0x8fD4…3B05
operator 0x5678…ef01 · 1 approved DEX router(s)
strategy: my-strategy — …
trading 1 market(s): WZIL/USDC
heartbeat: reporting live to https://zilliqa.ai/api/heartbeat every 60s
```

Refresh the app: your agent now shows **live**. Stop the bot with Ctrl-C (it goes back to **offline** within three minutes) and move on.

### Step 4 — Put your fork on GitHub

Railway builds from a git repository. Create an empty repository on GitHub (for example `my-zilliqa-bot`), then in the kit folder:

```bash
git remote rename origin upstream          # keep the kit as "upstream" so you can pull updates later
git remote add origin git@github.com:YOU/my-zilliqa-bot.git
git add strategies/my-strategy.ts
git commit -m "Add my-strategy"
git push -u origin main
```

`.env` is ignored by git and by the Docker build, so your keys never leave your machine this way. Double-check with `git status` that no `.env` is staged.

### Step 5 — Deploy to Railway

The kit already contains the `Dockerfile` and `railway.json` Railway needs. Everything else is environment variables.

**Option A — from the dashboard**

1. [railway.com](https://railway.com) → **New Project → Deploy from GitHub repo** → pick `my-zilliqa-bot`. Railway detects the Dockerfile and starts a build; it will fail the first time because the variables aren't set yet — that's expected.
2. Open the service → **Variables** → add these five, then click **Deploy**:

   | Variable | Value |
   |---|---|
   | `NETWORK` | `testnet` |
   | `OPERATOR_KEY` | the operator private key from step 2 (use the *sealed* option so it can't be read back) |
   | `AGENT_ID` | the id from step 3, e.g. `7` |
   | `STRATEGY` | your file name without `.ts`, e.g. `my-strategy` |
   | `POLL_MS` | `4000` |

3. Under **Settings**, leave replicas at **1** and don't add a public domain — the bot needs no inbound traffic.

**Option B — from the terminal**

```bash
npm install -g @railway/cli        # or: brew install railway
railway login                      # opens the browser once
railway init                       # creates a project; name it e.g. my-zilliqa-bot
railway variables --set NETWORK=testnet --set OPERATOR_KEY=0x... \
  --set AGENT_ID=7 --set STRATEGY=my-strategy --set POLL_MS=4000 --skip-deploys
railway up --detach                # uploads this folder and builds the Dockerfile
railway logs                       # follow the bot
```

`railway up` uploads your working folder directly, so with Option B the GitHub push in step 4 is only for keeping your code safe and for the `--source` link buyers see. To redeploy after a change, run `railway up --detach` again.

### Step 6 — Confirm it's live

In Railway's **Deployments → View logs** you should see the same five lines as in the local test run, ending with `heartbeat: reporting live`. Within a minute [zilliqa.ai/app](https://zilliqa.ai/app/) shows your agent as **live** and lists it in the hire form. Hire it yourself with a small amount to see a full cycle.

Optional strategy parameters (`TAKE_PROFIT_BPS`, `STOP_LOSS_BPS`, `MAX_HOLD_SEC`, or any `param()` you define) are also plain Railway variables; change one and redeploy.

### Day-to-day

```bash
./zai update 7 --fee 5                 # new trades only; open trades keep the fee they were hired at
./zai update 7 --description "…"       # edit details
./zai update 7 --pause                 # stop accepting trades (the app shows "paused")
./zai update 7 --resume
./zai update 7 --operator 0xNEW        # rotate the bot key: then update OPERATOR_KEY on Railway and redeploy
git pull upstream main                 # pick up kit updates (new marketplace address, fixes), then redeploy
```

### If something's wrong

| Symptom | Cause and fix |
|---|---|
| App shows **offline** although the bot is running | Look for `heartbeat failed (…)` in the logs. `403` — the operator key on Railway isn't the one registered for this agent id. `503` — the marketplace's storage is unavailable; the bot keeps trading and the app recovers when it does. |
| `Agent #7's operator is 0x…, but OPERATOR_KEY belongs to 0x…` at start-up | Wrong key or wrong `AGENT_ID`. Fix the variable and redeploy, or `./zai update 7 --operator <address of the key you have>`. |
| `Agent #7 doesn't exist on this marketplace` | The kit is pointing at an older marketplace address, or the id is wrong. `git pull upstream main`, then check `./zai agents`. |
| `insufficient funds` when a trade should open | The operator ran out of ZIL for gas. Send it more from the faucet. |
| `no route from … on any approved DEX` | You declared a market no approved DEX can route yet. Remove it with `./zai update 7 --market WZIL/USDC`. |
| Trades stay **pending** for a long time while the agent is live | Your strategy hasn't returned `open` yet. That's fine if it's selective; the app tells buyers it's "waiting for signal". |
| Railway build fails | The log shows the failing step. Most often: `package-lock.json` missing from the commit, or Node version — the image uses Node 22. |

### Key safety

- **Never reuse the seller key as the operator.** A leaked operator key can make bad trades but can't take funds. A leaked seller key gives away your fee income and control of the agent.
- **Never commit `.env`** or paste keys into GitHub issues or chat. If a key leaks, rotate it: `./zai update <id> --operator <new address>`, then update Railway.
- **The marketplace owner can pause any agent** that misbehaves.

## What buyers see

Buyers see your agent's name, fee, number of settled trades and cumulative buyer P&L, all read straight from the chain, so there's no way to fake a track record. Before they hire, the app spells out the full cost of a winning trade: 4% of profit to the protocol plus your fee, with the total never above 12%. Next to those they see your [agent details](#agent-details).

Neither the name nor the details are verified. The web app refuses a name that's already taken (ignoring case), but the contract itself doesn't check. Linking your strategy's source code is the best way to earn buyers' trust.
