# Agent runtime

Five agents (Momentum, Mean-reversion, News propose; Quant, Guardian forecast) that act on the Wavefund contracts
through their own Circle developer-controlled wallets on ARC-TESTNET. Agents never use the deployer or keeper keys.

| Command | What it does |
|---|---|
| `npm run agents:setup` | Idempotent. Creates the wallet set and five unfunded EOAs if missing, writes addresses to `agents/agents.json` and wallet IDs to `.env`. |
| `npm run agents:fund` | Shows the funding plan (proposers 1 USDC bond + gas, forecasters 2 USDC deposit + gas), asks you to type `fund`, then sends. `:proposers` / `:forecasters` limit the group. `--plan-only` sends nothing. |
| `npm run agents:run` | Default `--dry-run`: logs decisions and transaction plans, sends nothing. `--execute` sends real transactions. `--once` runs a single pass. `--preset judge` raises the daily gas cap to 3.0 USDC. |
| `npm run agents:test` | Unit tests (signers, caps, scheduler, logging redaction, setup, executor). |

Environment (names only): `ANTHROPIC_API_KEY` (News proposer; optional `ANTHROPIC_MODEL`, default `claude-haiku-5-5`), `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `AGENT_CIRCLE_WALLET_SET_ID`,
`AGENT_<NAME>_CIRCLE_WALLET_ID`, `DEPLOYER_PK` or `AGENT_FUNDER_PK` (funding only), `ARC_TESTNET_RPC`.
Local keys (tests and rehearsal only) need `AGENTS_SIGNER=local`, `AGENTS_ALLOW_LOCAL_KEYS=yes` and `AGENT_<NAME>_PK`.

Safety: gas caps of 0.25 USDC per round and 1.0 USDC per UTC day per agent, a 1 credit cap per buy and 2 credits spent per
proposal per round, a single-instance lock (`.run/agents/agents.lock`), and Ctrl+C requests a clean stop.
Logs are JSONL per UTC day in `.run/agents/logs/`, with secrets redacted. The spend ledger is `.run/agents/ledger.json`.

Proposers (`agents/proposer-strategies.mjs`): Momentum and Mean-reversion use 30 contiguous 1-minute closes; News reads CoinDesk
headlines and asks Claude for strict JSON, with a keyword fallback ("fallback used" appears in the rationale). A diversity step keeps
every proposal 500+ bps from the status quo and from each other. For a dry-run without an open round use
`--simulate-round judge --simulate-status-quo 5000` (dry-run only).

## Quant and Guardian (A3)

Quant evaluates every proposal, including proposal 0 (status quo). From the last 120 one-minute candles it estimates
log drift and volatility, halves drift toward zero, and caps it at +/-0.00005 per minute. For the round's evaluation
horizon `T` in minutes, expected tETH gross return is `exp(drift*T + sigma*sigma*T/2)`. A proposal with tETH weight `w`
has expected vault return `1 + w*(gross-1)`. The round's own `rMin/rMax` map that to pFair, clamped to `[0.02, 0.98]`.
This is an estimate from candle closes, not a guaranteed return or a live tick-price feed.

Quant buys LONG when market price is more than 0.005 below fair, buys SHORT when more than 0.005 above, and prefers selling
an overpriced position it already holds. Buys spend at most 1 credit per trade and 2 per proposal per round. Sales unwind
existing exposure and do not replenish the buy budget; each sale is conservatively limited to 1 token (one complete-set
leg), at most 1 credit of proceeds. A wallet makes one 2 USDC deposit per round and claims its credit entitlement independently
in each traded proposal. It redeems tracked settled/cancelled rounds, including older rounds after a new round opens.

Guardian has its own loop, independent of Quant transactions and proposer/news work. It uses the same model, valid for
60 seconds; an expired reference is skipped while refresh runs. One Multicall3 call reads all spot prices, projected
probability TWAPs and proposal allocations. It evaluates the projected winner first, then proposals spot-priced at or
above status quo (including status quo itself). A round/proposal change defers evaluation to the next pass rather than
reading prices twice. Guardian only pushes overpriced markets down: deviation must exceed 0.03 normally or 0.01 inside the
final TWAP window. It checks every 5 seconds in that window (15 seconds outside). Evaluation duration is logged against
the <3 second target; quote sizing and transaction receipts run outside the timed pass. Actual live latency remains unproven.

Both use adapter `quoteBuy*`/`quoteSell*` views for sizing and `quote * 995 / 1000` for minimum outputs. The adapter returns
output, not post-trade price: sizing estimates the terminal marginal probability from quote finite differences, calibrating
fees with micro quotes. It searches to fair value within a bracket of at most `cap/5000` (or one raw unit), unless the credit
cap or available depth stops it. The derivative is approximate, tested against a non-constant-product curve; mock tests use
a probability tolerance of up to 0.002. Each search is pinned to one block. After deposit/claim transactions it sizes again;
a further spot move greater than 0.0001 or an expired/changed model defers the trade. This cannot prevent movement after broadcast.

Trade budget is reserved before submitting prerequisites. Ambiguous broadcasts keep their budget and block further wallet
operations until reconciled; never clear the ledger just to retry. Failed required balance or chain-clock reads stop the
action. A late `TradingClosed` is logged and ends interventions for that round without crashing the runtime.

```bash
npm run agents:test
node agents/tools/mutation-check.mjs

# Read-only; run later, in an OPEN round. No credentials are needed for address-only dry-run planning.
npm run agents:run -- --dry-run --once --only quant,guardian --evaluate-now
```

Decisions are JSONL in `.run/agents/logs/YYYY-MM-DD.jsonl`: Quant logs `inputs.proposals` with pMarket, pFair, gap and action
for every proposal; Guardian logs candidates, projected leader, duration, threshold and each intervention transaction.
Console output is deliberately brief. `--evaluate-now` bypasses Quant scheduling only in dry-run mode; `--execute` refuses it.
No open round means an idle report, not a successful open-round validation. Live A3/A4 testing is deferred by the operator.

`agents/strategies/index.mjs` preserves the legacy baseline as a reference. Production uses `lib/forecasters.mjs`,
`lib/fair.mjs`, `lib/sizing.mjs` and `lib/trader.mjs`.
