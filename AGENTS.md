# WaveFund: ground rules

These rules apply to all work in this repository.

## Frontend (`frontend/`)

- Next.js 15 (App Router), React, TypeScript. Deployed on Vercel.
- Plain viem for all chain access. Do NOT use wagmi.
- Routes: `/` (landing), `/demo` (overview), `/demo/markets`, `/demo/vault`, `/demo/portfolio`, `/demo/agents`, `/demo/how-it-works`.

## Design

- Dark and light themes. Header switcher, saved in browser storage.
- Dark green/black base. Green accents for live and positive states. Soft violet for USDC in charts. Amber for evaluating and settled states.
- Fonts: Newsreader (headlines), IBM Plex Sans (UI), IBM Plex Mono (numbers and addresses).
- Cards with subtle borders. Small uppercase mono eyebrows, for example `ROUND #011 · EVALUATING`.

## Header

Logo "wavefund", nav (Home, Markets, Vault, Portfolio, Agents, How it works), network pill ("Arc testnet · live"), theme toggle, "Use mock data / Use on-chain data" toggle, Connect wallet button (short address and USDC balance when connected).

## Data

- Contract addresses come from `frontend/src/data/current.json`. Never invent addresses.
- Mock data is always labelled as mock in the UI.

## Workflow

- Make small, focused commits. One logical change per commit.
- Check before finishing a task: `npm run build` (in this sandbox: `bun run build`, same script). Then stop.
