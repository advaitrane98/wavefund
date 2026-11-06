# wavefund

Wavefund lets a treasury choose its next allocation by market, not by vote. AI agents propose allocations, a prediction market for each proposal prices the expected return, and the vault only moves when the market expects an improvement over the status quo. It runs on Arc Testnet (chain ID 5042002), where USDC is the gas token.

- Live demo: https://arc-studio-f77d519d61f4468abc0821ef.vercel.app
- Contracts: [`contracts/`](contracts) (Solidity 0.8.26, Foundry)
- Frontend: [`frontend/`](frontend) (Next.js 15, viem)
- Agent roster: [`agents/agents.json`](agents/agents.json)

Built with [Arc Studio](https://studio.arc.io)

## Built and live

Built and running on Arc Testnet:

- **Round engine.** `QuantumRound` runs the round lifecycle: open, propose, deposit once, claim credits in every proposal, trade, collapse onto the best final-window TWAP versus the status quo plus 0.005, execute, evaluate, settle, redeem.
- **Proposal markets on Uniswap v4.** One LONG/SHORT pool per proposal, with a hook that records the final-window TWAP (see [Uniswap v4 integration](#uniswap-v4-integration)).
- **Treasury vault.** `WavefundVault` holds USDC and tETH, queues deposits and withdrawals until the next decision, and rebalances on a Uniswap v4 pool.
- **Agent registry.** `ProposerRegistry` records each proposer's name, bond, proposals made and rounds won.
- **Deployed contracts.** Ten contracts are deployed; the addresses are in [`frontend/src/config/deployment.json`](frontend/src/config/deployment.json) and listed in the app footer with explorer links.
- **Agents.** Five agents with Circle developer-controlled wallets: three proposers and two forecasters (see [Agents](#agents)).
- **Web app.** A landing page and a demo with Markets, Vault, Portfolio, Agents and How it works. It has a mock mode that runs entirely in the browser, and a live mode that reads and writes the deployed contracts through your wallet.
- **Checks.** `npm run check:contracts` checks code, selectors, wiring and roles at every address. `npm run check:live` (in `frontend/`) reads the deployment with the app's own code. `npm run e2e:live` (in `frontend/`) smoke-tests the production site in both modes.

Not live yet: the shared deployment has no open round or funded vault until the operators run one, so live mode shows "No round yet" and an empty vault until then.

## Agents

Agents are the actors that make the markets. Their public addresses and descriptions live in [`agents/agents.json`](agents/agents.json). The file holds no keys. Every agent signs from a Circle developer-controlled wallet.

| Agent | Type | Address |
| --- | --- | --- |
| Momentum | Proposer | [`0x9277…bc0D`](https://explorer.testnet.arc.io/address/0x927751387951B69390151f34f3dD756A624Abc0D) |
| Mean Reversion | Proposer | [`0x2901…0E25`](https://explorer.testnet.arc.io/address/0x2901AB7721217a1733B744009847DFE3d9f70E25) |
| News | Proposer | [`0x324E…c455`](https://explorer.testnet.arc.io/address/0x324EC3C47f7c28C254977a14CA0ECec05524c455) |
| Quant | Forecaster | [`0x6661…439e`](https://explorer.testnet.arc.io/address/0x66617018c7d91e1345eA9F51b44a062aad2D439e) |
| Guardian | Forecaster | [`0x4A1b…1d5f`](https://explorer.testnet.arc.io/address/0x4A1bA43Da2b795D68f63f34fba185D92A08f1d5f) |

The Agents page shows, per agent, only what is on-chain:

- **Proposers:** proposals made and rounds won (from `ProposerRegistry`), the average realised return of their winning proposals, and their latest rationale (from `QuantumRound` events read through the chain explorer API).
- **Forecasters (Quant, Guardian):** P&L on settled rounds (redeemed minus deposited), rounds participated and trades (labelled "Trades").

On the Markets page each proposal card shows the agent's name, a "Proposer agent" pill, the rationale (clamped, with a toggle) and the proposer address.

To refresh the roster after changing wallets, set the Circle variables in `.env` and run `node --env-file=.env scripts/export-agents.mjs`, then `npm run gen:abis` in `frontend/`.

## Uniswap v4 integration

Wavefund uses Uniswap v4's `PoolManager` on Arc Testnet (`0x2756F3F7bFAf103F4c550f4d24CdCa82B093240A`) in two ways. Links point to the exact lines at commit [`68456c9`](https://github.com/advaitrane98/wavefund/commit/68456c951ac409470b397e50d4c3a485e9978cb2).

**1. A LONG/SHORT pool for every proposal, with a hook.**

- The hook enables four permissions: before adding liquidity, before removing liquidity, before swap and after swap. [`WaveHook.sol` L90-L96](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WaveHook.sol#L90-L96)
- The hook address must carry those permission bits, so it is mined off-chain at deployment. [`WaveHook.sol` L18-L23](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WaveHook.sol#L18-L23)
- The market builds the pool key (fee 3000, hook set), registers the pool with the hook and initialises it. [`WaveV4ProposalMarket.sol` L218-L230](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WaveV4ProposalMarket.sol#L218-L230)
- It seeds the pool with liquidity through `unlock`. [`WaveV4ProposalMarket.sol` L233-L236](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WaveV4ProposalMarket.sol#L233-L236)
- Trades run in the market's unlock callback, which calls `poolManager.swap`. [`WaveV4ProposalMarket.sol` L376-L399](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WaveV4ProposalMarket.sol#L376-L399)
- Before each swap the hook checks that the caller is the adapter, trading is open and the price is in bounds. [`WaveHook.sol` L223-L237](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WaveHook.sol#L223-L237)
- After each swap it integrates the previous price over the elapsed time and records the new spot. This is the final-window TWAP that decides the winner. [`WaveHook.sol` L239-L269](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WaveHook.sol#L239-L269)

**2. The vault's USDC/tETH pool, to execute the winning allocation.**

- The vault defines a plain USDC/tETH pool (fee 3000, tick spacing 60, no hook) and an admin-only initialiser. [`WavefundVault.sol` L178-L184](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WavefundVault.sol#L178-L184), [L200-L203](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WavefundVault.sol#L200-L203)
- It rebalances by calling `unlock`, then swapping in its callback. [`WavefundVault.sol` L592-L599](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WavefundVault.sol#L592-L599)
- The callback swaps, enforces the slippage limits, then settles the input and takes the output. [`WavefundVault.sol` L602-L635](https://github.com/advaitrane98/wavefund/blob/68456c951ac409470b397e50d4c3a485e9978cb2/contracts/src/WavefundVault.sol#L602-L635)

## Development

Prerequisites: Node 22+, [Foundry](https://book.getfoundry.sh), and `npm install` in the repo root.

```
npm run check:contracts          # verifies code and wiring at every deployed address
cd frontend && npm install
npm run dev                      # the web app
npm run build                    # production build
npm run gen:abis                 # refresh src/abis and src/config from contracts/ and agents/
```

Environment variables go in `.env` (never committed). The web app reads only `NEXT_PUBLIC_ARC_RPC_URL` and `NEXT_PUBLIC_ARC_EXPLORER_URL`, both optional. The root scripts read `DEPLOYER_PK`, `KEEPER_PK` and `ARC_TESTNET_RPC`; the agent export reads `CIRCLE_API_KEY` and the `AGENT_*_CIRCLE_WALLET_ID` values. See [`frontend/README.md`](frontend/README.md) for the web app.
