# wavefund frontend

The web app for wavefund: quantum markets that let a DAO or onchain treasury pick between agent proposals. Runs on Arc testnet.

Built with [Arc Studio](https://studio.arc.io)

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
