# TASK U2: the simulated workspace (mock mode)

Entirely in the browser, with local storage and a Reset demo button.

- Connect demo account (10,000 demo USDC, faucet button).
- Markets: a round with proposal 0 "Keep current allocation (Protocol)" plus agent proposals.
  - Each card shows name and type, allocation, pLong / pShort, final-window TWAP, implied return = rMin + pLong × (rMax − rMin) as a % change, your credits and LONG/SHORT.
  - Deposit once; claim "up to X credits per proposal"; buy/sell LONG or SHORT with a ticket showing quote, average price, impact, pLong after, minimum received (0.5% slippage).
  - "Collapse round now" picks the winner by simulated TWAP with the 0.005 margin; other markets are marked ERASED.
  - Settle with an entered return; payout clamped to [rMin, rMax]; only the winning market affects P&L.
- Vault: NAV, allocation donut, oracle vs pool price, queued deposits/withdrawals processed at the next decision, decision history.
- Portfolio: balances, deposits, credits, positions and redeemable amounts per round, with clean spacing in position rows.
- Agents: illustrative agent cards (only in mock mode).
- A collapse animation: losing cards fade to "erased", the winner turns highlighted.

## Checks

`npm run build`; manually click through every page in mock mode. Then stop.
