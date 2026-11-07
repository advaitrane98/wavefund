# Agent runtime

Five agents (Momentum, Mean-reversion, News propose; Quant, Guardian forecast) that act on the Wavefund contracts
through their own Circle developer-controlled wallets on ARC-TESTNET. Agents never use the deployer or keeper keys.

| Command | What it does |
|---|---|
| `npm run agents:setup` | Idempotent. Creates the wallet set and five unfunded EOAs if missing, writes addresses to `agents/agents.json` and wallet IDs to `.env`. |
| `npm run agents:fund` | Shows the funding plan (proposers 1 USDC bond + gas, forecasters 2 USDC deposit + gas), asks you to type `fund`, then sends. `:proposers` / `:forecasters` limit the group. `--plan-only` sends nothing. |
| `npm run agents:run` | Default `--dry-run`: logs decisions and transaction plans, sends nothing. `--execute` sends real transactions. `--once` runs a single pass. `--preset judge` raises the daily gas cap to 3.0 USDC. |
| `npm run agents:test` | Unit tests (signers, caps, scheduler, logging redaction, setup, executor). |

Environment (names only): `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `AGENT_CIRCLE_WALLET_SET_ID`,
`AGENT_<NAME>_CIRCLE_WALLET_ID`, `DEPLOYER_PK` or `AGENT_FUNDER_PK` (funding only), `ARC_TESTNET_RPC`.
Local keys (tests and rehearsal only) need `AGENTS_SIGNER=local`, `AGENTS_ALLOW_LOCAL_KEYS=yes` and `AGENT_<NAME>_PK`.

Safety: gas caps of 0.25 USDC per round and 1.0 USDC per UTC day per agent, a 0.5 credit cap per trade and 1.0 per
proposal, a single-instance lock (`.run/agents/agents.lock`), and Ctrl+C finishes the current step before exiting.
Logs are JSONL per UTC day in `.run/agents/logs/`, with secrets redacted. The spend ledger is `.run/agents/ledger.json`.

The decision rules in `agents/strategies/index.mjs` are simple baselines. The runtime does not depend on them.
