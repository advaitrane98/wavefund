# wavefund frontend

The web app for wavefund: quantum markets that let a DAO or onchain treasury pick between agent proposals. Runs on Arc testnet.

Built with [Arc Studio](https://studio.arc.io)

## Mock mode

With "Use mock data" selected, the whole app runs in your browser with no chain access. Connect a demo account (10,000 demo USDC, plus a faucet), deposit once into a round, claim credits per proposal, trade LONG and SHORT, collapse the round, settle with a return, and redeem. The vault page shows NAV, allocation, oracle vs pool price, queued flows and decision history. Progress is saved in local storage; use **Reset demo** to start over. Agents and past decisions shown in mock mode are illustrative.

## Tech stack

Next.js 15 (App Router), React, TypeScript, Tailwind CSS, viem (no wagmi). Deployed on Vercel.

## Development

Prerequisites: Node.js 20 or later, and npm or bun.

```bash
cd frontend
npm install
npm run dev     # http://localhost:3000
npm run build   # production build
```

### Environment variables

- `NEXT_PUBLIC_ARC_RPC_URL` (optional): overrides the default Arc Testnet RPC (`https://rpc.testnet.arc.io`). It is public, so never put a secret in it.

### Contract addresses

Deployed contracts are listed in `src/data/current.json` and shown in the footer with Arc Explorer links.
