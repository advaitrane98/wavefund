# Wavefund ground rules (apply to every task)

These rules are global. They cover the contracts and the frontend.

## Network

- Project: "Wavefund", on Arc Testnet.
- Chain ID `5042002`.
- RPC `https://rpc.testnet.arc.io`.
- Explorer `https://explorer.testnet.arc.io`.
- USDC is the gas token.

## USDC and decimals

- USDC ERC-20: `0x3600000000000000000000000000000000000000` (6 decimals).
- Arc's native balance is an 18-decimal view of the same USDC. Never add the two together, and never send native value to or from contracts.
- Decimals: USDC 6, credits 6, LONG/SHORT 18, WAVE shares 18, tETH 18.
- One credit = one complete set = 1e12 raw units of LONG plus 1e12 of SHORT.

## Contracts toolchain

- Solidity 0.8.26, `via_ir = true`, `evm_version = osaka`, optimizer 200 runs.
- Foundry.
- Uniswap v4-core 1.0.2 and v4-periphery (BaseHook, HookMiner), OpenZeppelin.

## Deployed infrastructure on Arc Testnet

- Uniswap v4 PoolManager: `0x2756F3F7bFAf103F4c550f4d24CdCa82B093240A`
- Multicall3: `0xcA11bde05977b3631167028862bE2a173976CA11`
- Permit2: `0x000000000022D473030F116dDEE9F6B43aC78BA3`

## Foundry and USDC

Foundry simulation fails on USDC transfers (Arc blocklist precompile). Use forge for builds, tests and deployments that move no USDC. Move USDC with viem scripts against the real RPC.

## Gas policy for broadcasts

Priority fee 1 gwei, max fee about 2x the current base fee.

## Secrets

Secrets live only in `.env`. Never commit them and never print them.

- `DEPLOYER_PK`
- `KEEPER_PK`
- `ARC_TESTNET_RPC`
- Frontend override: `NEXT_PUBLIC_ARC_RPC_URL`

## Workflow

- Work one task at a time.
- Make small, focused commits. One logical change per commit.
- At the end of a task, run the checks listed for it, report what you built and anything uncertain, then stop.

## Where things live

- `frontend/`: Next.js app. See `frontend/AGENTS.md` for frontend-only rules.
- `docs/tasks/`: one file per task prompt (for example `U1-frontend-ui.md`). Task prompts are not rules.
