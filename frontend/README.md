# wavefund frontend

The web app for wavefund: quantum markets that let a DAO or onchain treasury pick between agent proposals. Runs on Arc testnet.

Built with [Arc Studio](https://studio.arc.io)

## Mock mode

With "Use mock data" selected, the whole app runs in your browser with no chain access. Connect a demo account (10,000 demo USDC, plus a faucet), deposit once into a round, claim credits per proposal, trade LONG and SHORT, collapse the round, settle with a return, and redeem. The vault page shows NAV, allocation, oracle vs pool price, queued flows and decision history. Progress is saved in local storage; use **Reset demo** to start over. Agents and past decisions shown in mock mode are illustrative.

## Live mode

With "Use on-chain data" selected, the app reads and writes the deployed contracts on Arc testnet. Connect a browser wallet (MetaMask preferred); the app switches it to Arc testnet and shows your USDC balance. You can deposit, claim credits, trade LONG and SHORT with a quoted price and 0.5% slippage protection, collapse a closed round, redeem, and queue or cancel vault deposits and withdrawals. Data refreshes every 30 seconds while the tab is visible and after your own transactions. If a refresh fails, the last data stays on screen with a "data may be stale, retrying" notice.

Live mode needs a deployment: until `contracts/deployments/current.json` lists the contracts, live pages say so instead of showing data.

## Tech stack

Next.js 15 (App Router), React, TypeScript, Tailwind CSS, viem (no wagmi). Deployed on Vercel.

## Development

Prerequisites: Node.js 20 or later, and npm or bun.

```bash
cd frontend
npm install
npm run dev     # http://localhost:3000
npm run build   # production build
npm run test:unit   # unit tests (needs bun)
npm run gen:abis    # rebuild contracts and refresh src/abis and src/config (needs Foundry)
npm run check:live  # read the live deployment and print a summary (needs bun)
E2E_BASE_URL=https://your-app.vercel.app npm run e2e:live   # smoke test, live and mock mode
```

The smoke test needs a browser: run `npx playwright install chromium` once. It waits two 30-second refresh cycles per mode, so it takes about two minutes.

### Environment variables

- `NEXT_PUBLIC_ARC_RPC_URL` (optional): overrides the default Arc Testnet RPC (`https://rpc.testnet.arc.io`). It is public, so never put a secret in it.
- `E2E_BASE_URL` (only for `npm run e2e:live`): the URL of the deployed app to test.
- `E2E_CYCLE_MS` (optional, only for `npm run e2e:live`): the refresh cycle to wait for, in milliseconds. Default 30000.

### Contract addresses

Addresses and ABIs are kept apart:

- `src/config/deployment.json`: addresses only (the deployed Wavefund contracts, plus USDC and the Uniswap v4 PoolManager under `external`), the chain id and the deploy block. `src/config/contracts.ts` reads it and is the only place the app gets an address from.
- `src/abis/<Contract>.ts`: one typed ABI per contract, with an `index.ts` that re-exports them.

Both are generated and committed, so Vercel needs no Foundry. Run `npm run gen:abis` to rebuild the contracts and refresh them from `contracts/out` and `contracts/deployments/current.json`. To split a combined file instead (`{ chainId, addresses, abis }`), run `npm run gen:abis -- --from-json path/to/abis.json`. `npm run check:live` reads the live deployment with the app's own code and prints a summary (read-only). The footer lists the addresses with Arc Explorer links.
