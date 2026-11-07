# Demo day

**Status, 7 November 2026: live testing is deferred by the operator.** This is the runbook for the next approved rehearsal,
not evidence that a full or judge round has passed. Results and the best recorded round links belong in [demo-round.md](demo-round.md).

## Before any live run

Use Node 22.9+ and the existing `.env`; never put keys in commands, recordings or Git. Check the deployment book is the intended
Arc Testnet deployment (chain 5042002). The five agent wallets must be separate from deployer and keeper. Fund only after the
operator approves the actual amounts. USDC ERC-20 (6 decimals) and native gas balance (18 decimals) are the same money.

```bash
npm run agents:test
npm run agents:mutation
npm run agents:fund -- --plan-only
```

The plan-only command requires the funding wallet in `.env` but sends nothing. Its default targets total 9.5 USDC if all five
agent wallets start empty: three proposers at 1 bond + 0.5 gas, two forecasters at 2 deposit + 0.5 gas. This excludes the protocol
seed reserve, vault capital, pool liquidity, deployer strike, keeper gas and later replenishment. Review balances again between
rehearsals; gas and reserve losses are real. A 2 USDC forecaster deposit is reused across proposal branches, not spent again in each.

After approval, `npm run agents:fund` prints the actual top-ups and asks for `fund`. Fund the vault and reserve only to the separately
approved amounts using `fund:vault` and `fund:protocol`. Do not treat their defaults as an approved budget.

## Demo-day commands, in order

1. Readiness:

```bash
npm run demo:preflight
```

If it reports pool price/depth problems, inspect and, only within the approved liquidity budget, recenter:

```bash
npm run pool:recenter -- --measure
npm run pool:recenter -- --max-new-usdc 1
npm run demo:preflight
```

The recenter command broadcasts after its confirmation; the measure command only reads. A fresh oracle may be needed first
(`npm run oracle:update`, a keeper transaction). Do not proceed until preflight says READY.

2. Terminal A, exactly one keeper (it owns the oracle watcher):

```bash
npm run keeper:run -- --preset judge
```

3. Terminal B, exactly one five-agent process:

```bash
npm run agents:run -- --preset judge --execute
```

4. Terminal C, open the round:

```bash
npm run demo:open-round -- --preset judge
```

Without `--open-every`, keeper waits for a round; `--preset judge` alone does not open one. Agent and keeper locks reject duplicate
instances. Do not start a separate oracle watcher alongside keeper. Keep the two terminals and their logs available throughout.

## Full-preset rehearsal, after approval

Start one keeper with `--preset full`, then open a round with `npm run demo:open-round -- --preset full`. Full means 1200 seconds
trading, 600 seconds final TWAP and 600 seconds evaluation. Before opening, retain the preflight output and starting wallet
balances/block in the record. Before starting the persistent agents process, run the required A3 read-only check:

```bash
npm run agents:run -- --dry-run --once --only quant,guardian --evaluate-now
```

Do this **before** starting the persistent agents process: the agent lock intentionally prevents a simultaneous second process.
Inspect the available proposals' pMarket, pFair, gap and intended action in `.run/agents/logs/<UTC-date>.jsonl`, then start
`npm run agents:run -- --preset full --execute` promptly enough for the early proposer windows. If you miss them, record a failed
rehearsal; do not claim all five acted. Once all three agents have proposed, cleanly stop only the agent process, repeat the
one-shot dry-run so it covers **every** proposal, then restart the same five-agent command with its ledger intact. Keeper stays
running. Never start a second agent process alongside the first; its lock prevents that.

Select an existing non-status-quo proposal after the three proposer agents have submitted. Record the selected id and Guardian's
remaining per-proposal budget. From Terminal C, with the approved deployer budget, schedule the 1-credit LONG strike:

```bash
npm run demo:manipulate -- --deployer --proposal 1 --side long --credits 1 --at-seconds-before-end 45
```

Replace `1` with the selected proposal id. Run early: it prepares deposit/claim first, then waits until the strike time. It asks for
`strike`; do not use `--yes` during rehearsal. Record the actual landing time/hash, not only the requested T-45. Observe Guardian's
decision and mined correction; a capped/unfunded agent or a trade too late to land is a failed intervention, not proof of resistance.
Let keeper collapse, execute the vault trade, evaluate and settle. Leave agents running long enough to redeem before capturing P&L.

## Two consecutive judge rounds

Stop the full-run processes cleanly first. With preflight READY, sufficient approved reserve and agent gas, Terminal A:

```bash
npm run keeper:run -- --preset judge --open-every 1 --max-rounds 2
```

Terminal B:

```bash
npm run agents:run -- --preset judge --execute
```

Judge is 480 seconds trading, a 240-second TWAP and 120 seconds evaluation. `--open-every 1` is an opening interval gate, not a
one-minute round; the next round opens only after the previous one finishes and preflight passes. `--max-rounds 2` stops cycling
after the two rounds opened by that keeper process settle/cancel, preventing an unintended third. A cancellation is not a successful
demo. After both settlements and redemption, stop agents. If keeper is restarted, count the remaining rounds explicitly.

For each round require actual proposal and trade hashes from the expected agents, a keeper-driven collapse/vault trade/settlement,
and zero-unaccounted reconciliation. Do not mark the test passed merely because the processes stayed alive.

## Four-minute judge script

An entire eight-minute trading round plus evaluation cannot fit into four minutes. Start the judge round beforehand and begin the
presentation with about two minutes left in trading; have a verified recorded round ready as timing fallback.

| Time | Show and say |
| --- | --- |
| 0:00–0:40 | Live Markets, correct chain and real round countdown. “Markets compare an allocation with the status quo; this is not a vote.” Show one agent's actual rationale. |
| 0:40–1:15 | Quant wallet's one `Deposited(2 USDC)` event and separate `CreditsClaimed` events in multiple proposals. “The same collateral backs alternative branches; only the selected branch settles.” |
| 1:15–2:00 | In the connected presenter's wallet, select an existing proposal and buy LONG from the UI with the approved small budget. Show spot change, Guardian deviation/threshold log and the correction transaction. Do not promise it until observed. |
| 2:00–3:15 | Trading closes. Open the actual collapse transaction, winning proposal/TWAP comparison and the vault's execution transaction in the explorer. Winner requires improvement over status quo plus epsilon. |
| 3:15–4:00 | Show vault balances and the settlement/redemption of the best previously verified round. If this round settles within the slot, use its real transaction instead. “Keeper and oracle are trusted today; this is testnet.” |

The presenter needs a funded, connected wallet and existing round deposit/credits or time to approve/claim them. The UI price push
means buying an existing proposal's LONG, not requiring a fourth AI proposal. If Guardian has no remaining budget, skip the claim
of a live correction and use the recorded result with its round id visibly labelled.

## Evidence to retain

For each round run the read-only report and save its output locally:

```bash
npm run round-report -- --round 1
```

Replace the id. The report pins all accounting reads and event bounds to its printed report block; an RPC failure stops the report
rather than silently skipping events. Save the full agent JSONL and keeper output, report block/time, proposal rationale/events, strike/correction hashes,
final TWAPs and the **last valid Quant pFair before trading closed** (model timestamp and horizon included). Do not recompute pFair
with later candles and call it the trading-time forecast. Record whether the struck proposal won.

Guardian reaction time is from the strike's mined block time to the first **responsive** Guardian trade's mined block time; a trade
already pending before the strike is not a reaction. Report detection/submission latency separately if logs support it. Summarize
evaluation pass durations with sample count, median, p95, maximum and passes >=3 seconds, including failed/slow passes.

For all five agents record starting/ending USDC and external top-ups. Use the 18-decimal native view consistently for precise
gas-inclusive P&L: ending minus starting minus external funding plus external withdrawals. Gas-exclusive P&L adds actual transaction
fees back. Bonds returned and round redemptions are internal returns, not fresh funding. Do not add ERC-20 and native balances.

Reconciliation must include QuantumRound, vault USDC and vault tETH, plus pending payouts for all five agents, presenter/test wallets,
deployer and keeper. The report collects those configured holders; add any other known recipients before calling the result complete.
Require each unaccounted amount to be exactly zero in raw units, at a consistent block with no writes racing the report. Record
unclaimed/deferred liabilities and include the report block; a missing holder is not a zero. Never invent an all-clear result.

## If something fails

| Symptom | Action |
| --- | --- |
| Preflight not READY | Fix the named check within approved funding. Do not open another round to bypass it. |
| No round / no proposals | Confirm deployment and keeper mode. Check early proposer windows, per-wallet funding and Circle configuration. |
| Candle/model unavailable | Agents skip safely. Wait for a fresh reference; do not replace it with zero drift or extend the 60-second cache. |
| Guardian quiet after strike | Inspect threshold, candidate/leader, budget, gas, pending transaction and time remaining. Preserve the failed result. |
| Pending/ambiguous wallet operation | Check Circle and explorer; reconcile its hash/state before retrying. Do not delete the ledger or locks to force a send. |
| Late `TradingClosed` | Expected nonfatal log. Record missed reaction; do not retry that closed round. |
| Vault execution fails | Keep one keeper retrying; inspect oracle/pool band and liquidity. Sustained failure may require cancellation, not a success claim. |
| RPC/chain outage or stage timing slips | Show the labelled best recorded round; never present mock mode as live. |
| Nonzero reconciliation | Stop further openings, account for transfers/pending recipients and repeat a consistent-block report before calling it passed. |

## Stop cleanly

For auto-cycling, use the round limit to prevent another opening. After settlement, leave agents long enough to redeem, then Ctrl+C
in agents and keeper terminals; wait for their clean-stop messages. If stopping mid-round, record that it is unfinished and resume
one keeper later to complete/cancel it. Do not `kill -9`, delete `.run/agents/ledger.json`, or remove an apparently live lock.
Keeper stops its own oracle watcher. Only if a separately launched standalone watcher remains, run `npm run oracle:stop`.
