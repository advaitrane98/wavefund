# TASK U1: frontend UI

Next.js 15 (App Router) app, plain viem (NO wagmi), deployed on Vercel.

## Routes

`/` (landing), `/demo` (overview), `/demo/markets`, `/demo/vault`, `/demo/portfolio`, `/demo/agents`, `/demo/how-it-works`.

## Design

- Dark and light themes (header switcher, saved in browser storage).
- Dark green/black base. Green accents for live and positive states. Soft violet for USDC in charts. Amber for evaluating and settled states.
- Fonts: Newsreader (headlines), IBM Plex Sans (UI), IBM Plex Mono (numbers and addresses).
- Cards with subtle borders. Small uppercase mono eyebrows, for example `ROUND #011 · EVALUATING`.

## Header

Logo "wavefund", nav (Home, Markets, Vault, Portfolio, Agents, How it works), network pill ("Arc testnet · live"), theme toggle, "Use mock data / Use on-chain data" toggle, Connect wallet button (shows short address and USDC balance when connected).

## Landing page

- Hero: "Don't pick an agent. Let the market decide."
- The pitch: DAO and onchain treasuries; agents propose; quantum markets let one deposit count in every proposal; the treasury only acts when the market expects improvement.
- How it works in four steps, participant roles, guardrails.
- Footer "Contracts · verified on Arc Explorer" listing addresses from `current.json` with explorer links.

## How it works page

The round lifecycle: open → propose → deposit once → claim in every proposal → trade → collapse onto the best final-window TWAP vs status quo + 0.005 → vault executes on Uniswap v4 → evaluate → settle. Plus the payout formula and a worked example.

## Checks

`npm run build`. Then stop.
