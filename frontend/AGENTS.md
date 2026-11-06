# Frontend rules

The global rules in the repo-root `AGENTS.md` apply here too. This file adds only what is specific to `frontend/`.

- Next.js 15 (App Router), TypeScript, Tailwind. Deployed on Vercel.
- Plain viem for all chain access. Do NOT use wagmi.
- RPC: `NEXT_PUBLIC_ARC_RPC_URL` overrides the default Arc Testnet RPC. It is public, so never put a secret in it.
- USDC balances use the ERC-20 view (6 decimals). Never show or sum the native 18-decimal balance as a separate amount.
- Addresses live only in `src/config/deployment.json` (read through `src/config/contracts.ts`); ABIs live only in `src/abis/`. Both are written by `npm run gen:abis`: never edit them by hand and never invent an address.
- Mock data is always labelled as mock in the UI.
- Design: dark and light themes; dark green/black base; green for live and positive; soft violet for USDC in charts; amber for evaluating and settled. Fonts: Newsreader (headlines), IBM Plex Sans (UI), IBM Plex Mono (numbers and addresses).
- Check: `npm run build` (in this sandbox: `bun run build`).

Task prompts live in `docs/tasks/` at the repo root.
