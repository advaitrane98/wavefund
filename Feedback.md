# Uniswap v4 developer feedback (Wavefund)

Wavefund uses Uniswap v4 on Arc testnet for two things: per-proposal USDC/outcome-token pools gated by a custom hook (`WaveHook`), and the vault's USDC/tETH swap. These notes come from building and deploying that integration. File and line pointers are in the README's "Uniswap v4 integration" section.

## What worked well

- Hooks as permission bits in the address are a strong primitive. Gating `beforeSwap`, `beforeAddLiquidity` and `beforeRemoveLiquidity` per pool let us enforce trading windows and adapter-only liquidity with very little code.
- The singleton `PoolManager` plus `unlock` callback gives one atomic place to settle several token movements. Our complete-set sell (swap part of one side, burn matched sets) fits it well.
- `afterSwap` made a time-weighted price (TWAP) for the final window cheap to maintain.

## Pain points

### 1. Arc compatibility and the RC2 PoolManager
- We could not assume a canonical deployment on Arc testnet. We deployed and tested against the v4-core `1.0.2` sources and ran a throwaway compatibility hook first to confirm initialisation, liquidity, swap and hook callbacks worked before committing to the design.
- A short "known good" list of PoolManager, PositionManager and Quoter addresses per new chain, with the exact commit they were built from, would have saved that spike.

### 2. Hook address mining
- The permission flags must match the low bits of the hook address, so deployment needs CREATE2 salt mining. For the v2 hook this took salt `8953` with `HookMiner`.
- Pain: the miner's result depends on the exact creation code and constructor args. Any change to the contract or an argument invalidates the salt, so mining has to be part of the deploy script, not a manual step. The deployer used for CREATE2 also has to be the deterministic factory, which is easy to get wrong with Foundry scripts.
- A documented, tested script pattern in the template repo for "mine then deploy then assert flags" would help.

### 3. `unlock`, `sync`, `settle` and `take`
- The order `sync(currency)`, transfer, `settle()` is easy to get wrong with ERC-20s, and the reverts (`CurrencyNotSettled`, `ManagerLocked`) do not say which currency is outstanding.
- Settling when the amount owed is zero, or taking when the delta is zero, needs special handling. We wrapped both in one helper (`_settleOrTake`).
- On Arc, USDC is an ERC-20 view of the native asset with a blocklist precompile. It behaved like a normal ERC-20 inside the manager once we used the real RPC, but see the Foundry section below.
- Better revert data (currency and delta in the error) would make unlock-callback debugging much faster.

### 4. Quoting with a single position
- The periphery quoter did not fit our setup: pools are hook-gated and only the adapter may add liquidity. We replicate the swap with `SwapMath` against the pool's slot0 and liquidity (`_simulate`) to produce `quoteBuy*` and `quoteSell*`.
- This works because each pool holds a single concentrated position, and we must guard the case where a swap would cross the range edge (we clamp at the 0.01 and 0.99 probability boundary). With several positions this would not be exact.
- A library helper that quotes a swap against current state without the full quoter and without a state-changing call would be valuable, especially for hook-gated pools.

### 5. Tick range and price bounds
- Probability markets need a bounded price. We use tick spacing 60, a 0.3% fee and a range of `[-45900, 45900]`. Mapping a price in `[0.01, 0.99]` to ticks and sqrt prices, and keeping token ordering straight (currency0 versus currency1), was a recurring source of off-by-one and inversion bugs.
- Helpers for "price to tick with spacing" and "token order independent" price conversion in the SDK-side Solidity libraries would help.

### 6. Foundry simulation on Arc
- Foundry's local simulation fails on any USDC transfer because of Arc's blocklist precompile. `forge script` is only usable for deployments that do not move USDC. Funding, deposits, trades and rounds are therefore done with viem scripts against the real RPC, which means we lost the fork-test loop for the most important flows.
- Fork dry-runs help for deployments, but cannot replace testing the settle paths on a real chain.

### 7. Tooling and infrastructure
- The public RPC rate limits aggressively. The frontend needed Multicall3 batching, a wallet-first fallback transport and backoff.
- Blockscout verification of contracts with via-IR and many constructor args was rate limited and needed retries. Sourcify matching alone did not make the explorer show verified source.

## Suggestions

1. A hook-development guide covering address mining as a deploy-script recipe, with a flag-assertion test.
2. More descriptive errors from `PoolManager` for settlement failures.
3. A stateless quote helper that works for hook-gated pools.
4. Published, versioned deployment addresses and build commits for new chains.
5. Documentation of how fee-on-transfer-like or blocklist-style tokens (as on Arc) interact with `settle` and `take`.
