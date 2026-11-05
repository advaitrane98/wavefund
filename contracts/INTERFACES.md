# QuantumRound integration contract (C1 + C2 as implemented)

This file lists exactly what QuantumRound (C3) must call and handle. It describes the code in `contracts/src` as it is now, not a wish list. Where a number or revert is stated, it comes from the source. If the code and this file ever disagree, the code wins and this file is a bug.

Chain: Arc Testnet (5042002). No contract in C1 or C2 accepts or sends native value. USDC (ERC-20, 6 decimals) is used only by `ProposerRegistry`. The market contracts move only LONG and SHORT proposal tokens.

## 0. Units and constants

| Item | Value |
|---|---|
| CREDIT decimals | 6 (required, see 2.2) |
| LONG / SHORT decimals | 18 |
| One credit = one complete set | 1e12 raw LONG + 1e12 raw SHORT (`COMPLETE_SET_SCALE`) |
| Probabilities, prices, TWAPs | 1e18 fixed point |
| Spot price | SHORT per LONG, 1e18 |
| Probability bounds | `[0.01e18, 0.99e18]`; at the position edges pLong is about 0.98994 / 0.01006 |
| Pool | fee 3000 (0.3%), tick spacing 60, one position over ticks -45900..45900, starts at 1:1 (pLong 0.5) |
| Trading window | open when `tradingStart <= block.timestamp < tradingEnd` |
| `DEFAULT_BOND` | 1_000_000 (1 USDC); a constant, not enforced as a minimum |

## 1. Roles and wiring QuantumRound depends on

QuantumRound must hold `QUANTUM_ROUND_ROLE` on:
- `ProposalTokens` (to create tokens, and for the tokens' `mint` / `burn`)
- `ProposerRegistry`

The role is granted by each contract's `DEFAULT_ADMIN_ROLE` holder (the deployer). It can be revoked at any time and the tokens re-check it on every mint/burn.

`WaveV4ProposalMarket` (the "adapter") holds NO role anywhere. It never mints or burns.

Adapter wiring (done once by the deployer, who is the adapter's initial owner):
1. `setQuantumRound(address)`: once only.
2. `setWaveHook(address)`: once only; requires `hook.adapter() == adapter` and the hook's PoolManager equals the adapter's.
3. When both are set, ownership moves to QuantumRound automatically. `transferOwnership` and `renounceOwnership` always revert `OwnershipLocked`. The adapter has no owner-only function left after wiring, so QuantumRound has nothing to call as owner.
4. Every adapter state-changing function except `closeTwapWindow` reverts `NotQuantumRound` for any other caller.

## 2. ProposalTokens

### 2.1 Calls QuantumRound makes
| Function | Access | Notes |
|---|---|---|
| `createProposalTokens(uint256 roundId, uint256 proposalId) returns (address credit, address long_, address short_)` | `QUANTUM_ROUND_ROLE` | Reverts `ProposalAlreadyExists(roundId, proposalId)` if the pair exists. The first successful call locks CREDIT decimals. Must run BEFORE `seedLiquidity` for that pair. |
| `creditToken(r,p)`, `longToken(r,p)`, `shortToken(r,p)`, `proposalExists(r,p)`, `creditDecimals()` | view | Zero address if not created. |
| On each clone: `mint(address to, uint256 amount)` and `burn(address from, uint256 amount)` | caller must currently hold `QUANTUM_ROUND_ROLE` on the factory | Revert `UnauthorizedRound(caller)` otherwise. `burn` needs no allowance. |

### 2.2 The 6-decimal credit requirement
- `ProposalTokens.setCreditDecimals(6)` (admin only, once, before the first `createProposalTokens`) must have been called. The default is 18.
- `seedLiquidity` reverts `CreditDecimalsMismatch(actual)` if `creditDecimals() != 6`. There is no way to fix this after the first clone exists (`CreditDecimalsLocked`).

## 3. ProposerRegistry

Constructor: `(address admin, IERC20 usdc)`. `usdc` must have code. USDC is the ERC-20 at `0x3600000000000000000000000000000000000000` on Arc Testnet, never the native balance.

### 3.1 Functions QuantumRound calls (all require `QUANTUM_ROUND_ROLE`)

| Function | Reverts | Effect |
|---|---|---|
| `lockBond(address proposer, uint256 amount)` | `EnforcedPause()` while paused; `AgentNotRegistered(proposer)`; `AgentInactive(proposer)` (cannot happen today, nothing deactivates an agent); `ZeroBondAmount()`; and any USDC `transferFrom` failure (no allowance, low balance, blocklisted) | `lockedBond[proposer] += amount`; pulls USDC from `proposer` into the registry. The PROPOSER must have approved the REGISTRY (not QuantumRound) for at least `amount`. Event `BondLocked`. |
| `refundBond(address proposer, uint256 amount)` | `InsufficientLockedBond(proposer, available, requested)` if `amount > lockedBond[proposer]`. Never reverts because of a failed USDC transfer. Zero amount is allowed. | `lockedBond[proposer] -= amount`, then tries `usdc.transfer(proposer, amount)`. See 3.2. Not affected by pause. |
| `slashBond(address proposer, uint256 amount)` | `SlashTreasuryNotSet()` (checked first); `InsufficientLockedBond(...)`; reverts if the USDC transfer to the treasury fails | Reduces `lockedBond`, sends USDC only to `slashTreasury`. See 3.3. v1 rounds never call it. |
| `recordProposal(address proposer)` | `AgentNotRegistered(proposer)`; `CounterOverflow(proposer)` at uint32 max | `proposalsMade += 1`. Works while paused. |
| `recordWin(address proposer)` | same as above | `roundsWon += 1`. Works while paused. |

Views QuantumRound can use: `agents(address)` returns `(string name, uint64 registeredAt, bool active, uint32 proposalsMade, uint32 roundsWon)`; `lockedBond(address)`; `pendingRefund(address)`; `slashTreasury()`; `paused()`; `DEFAULT_BOND()`; `usdc()`.

Proposers (not QuantumRound) call `registerAgent(string name)` (name 1..64 bytes, one registration per address) and `claimRefund()`.

### 3.2 How refunds work now
- `refundBond` first lowers `lockedBond`, then attempts `usdc.transfer(proposer, amount)` with a low-level call.
- Success: USDC goes to the proposer at once; event `BondRefunded`.
- Failure (for example the proposer is blocklisted by the USDC issuer, or the call returns false): NO revert. The amount is saved in `pendingRefund[proposer]` and event `RefundDeferred` is emitted. The round can always finish.
- The proposer later calls `claimRefund()` themselves. It pays only `msg.sender`, never anyone else, and reverts `NothingToClaim()` if nothing is pending. If the transfer fails again it reverts and the pending amount is kept.
- QuantumRound should treat a refund as done once `refundBond` returns, and must not assume the USDC arrived. Read `pendingRefund(proposer)` if it needs to know.
- If the USDC issuer blocklists the registry itself, nothing in the registry can get around it.

### 3.3 Slashing treasury
- `slashTreasury` is zero at deployment, so slashing is OFF. `setSlashTreasury(address)` (admin only) turns it on; setting zero turns it off again.
- `slashBond` pays only `slashTreasury`; the caller cannot choose a recipient.
- v1 never slashes: bonds are always refunded.

### 3.4 Deposit pause
- `pause()` / `unpause()` (admin only) affect ONLY `lockBond`, which then reverts `EnforcedPause()`.
- `refundBond`, `claimRefund`, `slashBond`, `recordProposal`, `recordWin` and `registerAgent` keep working while paused.

## 4. WaveV4ProposalMarket (the market adapter, `IProposalMarket`)

### 4.1 General rules for every call
- **Push model.** QuantumRound sends tokens to the adapter BEFORE calling. The adapter never pulls from anyone and never mints or burns.
- **The market enforces the push.** For every market it keeps accounted ("held") LONG and SHORT balances: the idle seed sets, any pending sell remainder, and any surplus it has absorbed. The tokens QuantumRound has newly pushed are `balanceOf(adapter) - held`, per leg. At the start of every seed, buy and sell, the market requires the newly pushed amount to cover what the call needs:
  - seed: `creditAmount * 1e12` of BOTH legs
  - buy: `credits * 1e12` of BOTH legs
  - sell: `amountIn` of the SOLD leg only (pushing the other leg does not count)

  Otherwise the call reverts `InsufficientPushedTokens(roundId, proposalId, needed, received)` (it reports the first failing leg; the LONG leg is checked first). Nothing has changed at that point.
- **Only newly pushed tokens fund a call.** The idle seed sets and pending sell remainders are never spent by a trade; each trade also re-checks that the balances did not fall below the held amounts (`AccountingViolation(roundId, proposalId)`, which should be unreachable in normal use).
- **Extra tokens are ignored, not lost.** Tokens sent to the market beyond what a call needs (by QuantumRound or by anyone else) do not break anything. They count as "pushed" for the next call's check, are absorbed into the held balances after that call, and come back with everything else at `finalizeProposal`. A donation can fund only itself; it can never fund more than its own amount.
- The check runs after the cheap validations (zero `to`, market seeded and not finalized, no pending sell) and before the quote, slippage and depth logic. A zero amount still reverts `ZeroAmount`.
- Read the held balances with `accountedBalances(r, p) returns (uint256 longHeld, uint256 shortHeld)`.
- **No partial trades.** If the pool cannot absorb a trade completely (the price would pass the position edge), the call reverts `InsufficientDepth(requestedIn, consumedIn)`. Nothing is filled partly.
- **Trading window.** Swaps and liquidity adds revert outside `tradingStart <= now < tradingEnd`. The revert comes from the hook and is wrapped by the PoolManager (`WrappedError` ... `TradingNotOpen`). Quote functions revert `TradingClosed(start, end, now)` instead.
- `r` = roundId, `p` = proposalId (both `uint256`). A market is one (r, p) pair.

### 4.2 seedLiquidity
`seedLiquidity(uint256 r, uint256 p, uint256 creditAmount)`: `onlyQuantumRound`, nonReentrant. Returns nothing.

Before the call QuantumRound must have: created the tokens (2.1), minted `creditAmount * 1e12` of BOTH LONG and SHORT to the adapter, and be able to answer `marketTiming(r, p)` (section 6). It must be called while the window is open (`tradingStart <= now < tradingEnd`).

Revert order: `WiringIncomplete()`, `ZeroAmount()`, `CreditDecimalsMismatch(actual)`, `AlreadySeeded(r,p)`, `MarketNotFound(r,p)` (tokens missing), `InsufficientPushedTokens(r,p,needed,received)` (fewer than `creditAmount * 1e12` of either leg newly pushed), then failures from `marketTiming`, from the hook's `registerPool` (`InvalidTradingWindow`, `InvalidFinalWindow`, bad config) and from the liquidity add (window closed). `creditAmount * 1e12` must fit in uint128.

What it does: reads `marketTiming` once (the timing is then fixed for that market), registers the pool in the hook, initialises the pool at 1:1 (if someone pre-initialised it at another price while empty, it is moved back to 1:1), and adds liquidity `L = creditAmount * 1e12`.

Important for the reserve: at 1:1 over this range the pool takes only about 0.8992 x L of each leg. The remaining ABOUT 10.08% of the minted sets (each leg) stays idle inside the adapter until `finalizeProposal`.

### 4.3 Buy
`tradeBuyLong(r, p, creditAmount, minOut, to) returns (uint256 totalOut)` and `tradeBuyShort(...)` (same signature): `onlyQuantumRound`.

Before the call QuantumRound must have taken `creditAmount` credits from the buyer (burn or hold) and minted `creditAmount * 1e12` of BOTH LONG and SHORT to the adapter.

- The opposite leg (SHORT for a LONG buy) is swapped, exact input `creditAmount * 1e12`, for the wanted leg.
- `totalOut = creditAmount * 1e12 + swapOutput`, in raw units of the wanted token, sent directly to `to`.
- `minOut` is in raw units of the wanted token and is compared with `totalOut`; below it reverts `Slippage(minOut, totalOut)`.
- Reverts: `ZeroAddress` (`to == 0`), `ZeroAmount` (`creditAmount == 0`), `MarketNotSeeded(r,p)`, `AlreadyFinalized(r,p)`, `InsufficientPushedTokens(r,p,needed,received)` (fewer than `creditAmount * 1e12` of either leg newly pushed), `InsufficientDepth`, `Slippage`, and the wrapped hook error outside the window. A pending sell does NOT block a buy, and the pending remainder cannot fund it.
- Event `Trade(r, p, isBuy=true, isLong, amountIn = creditAmount, amountOut = totalOut, to)`.

### 4.4 Sell (two calls, one transaction)
`tradeSellLong(r, p, amountIn, minCreditsOut) returns (uint256 creditsOut)` and `tradeSellShort(...)`: `onlyQuantumRound`.

Before the call QuantumRound must have moved `amountIn` raw units of the SOLD token (LONG for `tradeSellLong`) from the seller to the adapter, by transfer, or by burning from the seller and minting to the adapter.

- The adapter swaps only part of the input (found by an exact bisection) so that the unswapped remainder pairs with the swap output into complete sets.
- `creditsOut` = whole credits matched = `floor(min(remaining, swapOutput) / 1e12)`.
- `minCreditsOut` is in credits; below it reverts `Slippage(minCreditsOut, creditsOut)`.
- It stores ONE pending settlement for this market and returns. Reverts also: `ZeroAmount`, `MarketNotSeeded`, `AlreadyFinalized`, `PendingRemainder(r,p)` (an earlier sell was not consumed), `InsufficientPushedTokens(r,p,needed,received)` (fewer than `amountIn` of the sold leg newly pushed), `InsufficientDepth`, `SolverDidNotConverge()` (amountIn above 1e6 x 2^64 raw units), wrapped hook error outside the window.
- Event `Trade(r, p, isBuy=false, isLong, amountIn, amountOut = creditsOut, msg.sender)`.

`consumeSellSettlement(uint256 r, uint256 p, address seller) returns (uint256 credits, uint256 longDust, uint256 shortDust)`: `onlyQuantumRound`.
- Reverts `ZeroAddress` (`seller == 0`), `MarketNotSeeded`, `NoPendingSettlement(r,p)`.
- Sends `credits * 1e12` of LONG and `credits * 1e12` of SHORT to the CALLER (QuantumRound). QuantumRound must then burn exactly those two amounts and mint `credits` CREDIT to the seller.
- Sends `longDust` LONG and `shortDust` SHORT (each less than 1 credit's worth, 1e12, plus a small bisection residue; see the fuzz tests) to `seller`.
- Clears the pending settlement. Event `SellSettlementConsumed`.

**Every sell must be settled with `consumeSellSettlement` in the same transaction.** While a settlement is pending, the same market rejects further sells and `finalizeProposal` (`PendingRemainder`), and the sell quotes also revert `PendingRemainder`. Between the two calls the pool price has already moved, and buys are still allowed.

### 4.5 finalizeProposal
`finalizeProposal(uint256 r, uint256 p)`: `onlyQuantumRound`, nonReentrant. **Returns nothing.**

- Reverts: `MarketNotSeeded`, `AlreadyFinalized`, `TradingNotEnded()` (needs `now >= tradingEnd`), `PendingRemainder`.
- Removes all liquidity from the pool, then transfers the adapter's ENTIRE balance of LONG and of SHORT for this market to the caller. Emits `ProposalFinalized(r, p, longReturned, shortReturned)`; read those two numbers from the event (or from balance changes).
- The returned amounts are one lump per leg and are NOT split. This is the market's entire LONG and SHORT balance, so any unsolicited tokens sent to the market are included. The held balances are zero afterwards. They contain: the pool position at the final price, the 0.3% trading fees earned, and the idle seed sets (about 10.08% of the seed per leg). The unused seed portion is therefore not a separate amount: it must be recovered from these totals.
- The two legs generally differ in size. The part that can be turned back into reserve right away is the complete sets `min(longReturned, shortReturned)` (burn that many of each; each 1e12 of both legs is 1 credit). The rest is a one-sided LONG or SHORT amount whose value depends on the round outcome. How this goes back to the reserve is a C3 decision.
- After finalization no further trading or liquidity actions are possible for that market.

### 4.6 TWAP and price views
| Function | Access | Behaviour |
|---|---|---|
| `closeTwapWindow(r, p) returns (uint256 pLongTwapX18, uint256 priceTwapX18)` | anyone | Needs `now >= tradingEnd` (`TradingNotEnded`) and a seeded market. Freezes both TWAPs; calling again returns the same values. Still works after `finalizeProposal`. |
| `probabilityTwap(r, p) returns (uint256)` | view | Final-window TWAP of pLong. Before the window is closed it is the live value with the last price extrapolated to `tradingEnd`; after `closeTwapWindow` it is frozen. |
| `twap(r, p) returns (uint256)` | view | Same, for the price (SHORT per LONG). |
| `probabilities(r, p) returns (uint256 pLong, uint256 pShort)` | view | Spot; always sum to exactly 1e18; each within `[0.01e18, 0.99e18]`. |
| `spotPrice(r, p) returns (uint256)` | view | SHORT per LONG, 1e18. |
| `completeSetScale()` | view | 1e12. |

All revert `MarketNotSeeded(r,p)` before seeding. The final window is the last `finalWindowSeconds` before `tradingEnd` (from `marketTiming`). Time before the first trade counts at the initial 0.5.

### 4.7 Quotes (optional for QuantumRound; they are views)
`quoteBuyLong(r,p,creditAmount)` and `quoteBuyShort` return `totalOut`; `quoteSellLong(r,p,amountIn)` and `quoteSellShort` return `(creditsOut, longDust, shortDust)`. They equal execution to the unit if the pool state has not changed. They revert `TradingClosed(start,end,now)` outside the window, plus the same depth and pending errors as execution.

## 5. WaveHook

QuantumRound calls NOTHING on `WaveHook` directly.
- `registerPool` and every PoolManager callback (`beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `afterSwap`) accept only the adapter as sender.
- Probabilities, prices and TWAPs are reached through the adapter views in 4.6.
- What QuantumRound can observe from the hook: reverts wrapped by the PoolManager (`TradingNotOpen`, `ProbabilityOutOfBounds`, `PriceOutOfRange`, `OnlyAdapter`, `PoolNotRegistered`) and the event `FinalWindowObservation(poolId, timestamp, pLong, price, cumulativeProbability, cumulativePrice)` emitted on swaps inside the final window.
- Liquidity can be added only inside the window and removed only at or after `tradingEnd`. The pool probability can never be moved outside `[0.01, 0.99]`.
- The hook address must have the flag bits 2752 (mined off-chain). The adapter checks the hook's `adapter()` and PoolManager when wired.

## 6. What QuantumRound must expose: marketTiming

```solidity
function marketTiming(uint256 roundId, uint256 proposalId)
    external view
    returns (uint64 tradingStart, uint64 tradingEnd, uint64 finalWindowSeconds);
```
- The adapter calls it once, inside `seedLiquidity`, and caches the result. Later changes in QuantumRound do not affect an already seeded market.
- Required: `tradingStart < tradingEnd`, `tradingEnd > now` at seed time, `0 < finalWindowSeconds <= tradingEnd - tradingStart`. Violations make `seedLiquidity` revert from the hook.
- Meaning: trading is open for `tradingStart <= now < tradingEnd`; liquidity removal and `finalizeProposal` open at `now >= tradingEnd`.
- The market can only be seeded while the window is open (`now >= tradingStart`).

## 7. Standard call sequences (each inside one transaction)

Seed: `createProposalTokens(r,p)` -> mint `creditAmount*1e12` LONG and SHORT to adapter -> `seedLiquidity(r,p,creditAmount)`.

Buy: take `credits` from buyer -> mint `credits*1e12` LONG and SHORT to adapter -> `tradeBuyLong/Short(r,p,credits,minOut,buyer)`.

Sell: move `amountIn` of the sold token from seller to adapter -> `tradeSellLong/Short(r,p,amountIn,minCredits)` -> `consumeSellSettlement(r,p,seller)` -> burn the returned `credits*1e12` of LONG and of SHORT held by QuantumRound -> mint `credits` CREDIT to seller.

Close: after `tradingEnd`: `closeTwapWindow(r,p)` -> settle outcome -> `finalizeProposal(r,p)` -> handle the two lumps (4.5).

Bonds: proposer approves the registry for USDC -> `lockBond(proposer, amount)` -> later `refundBond(proposer, amount)` (never `slashBond` in v1) -> `recordProposal` / `recordWin`.

## 8. Hazards to design around

1. An under-funded push now reverts `InsufficientPushedTokens` and spends nothing (4.1). Still push exactly the required tokens before every call; surplus is locked in the market until `finalizeProposal`.
2. A forgotten `consumeSellSettlement` locks the market's sells and finalization (4.4).
3. Buys can happen while a sell is pending, with the pool already moved.
4. Refunds may be deferred (3.2); a proposer's bond can sit in `pendingRefund`.
5. Any trade reverting `InsufficientDepth` is normal near the price edges; QuantumRound should let it revert or catch it.
6. The idle seed sets and the fees come back only at `finalizeProposal` (4.5).
7. Quotes are views and only valid for the current pool state.
8. Probabilities can never reach 0 or 1 (bounds 0.01 and 0.99); outcome settlement must not depend on the market reaching an extreme.

## 9. Possible conflicts with the C3 spec: NOT YET COMPARED

The original C3 spec is not in this repository or in my working notes, so I could not compare against it. Do not read this section as a finished comparison. Below are the behaviours of C1 and C2 that a spec could plausibly assume differently. Each one must be checked by hand against the C3 spec:

1. Bond refunds are not guaranteed to pay out immediately (3.2).
2. `slashBond` is disabled until an admin sets a treasury, and takes no recipient argument (3.3).
3. `lockBond` can be paused and requires the proposer's USDC approval to the registry (3.1, 3.4).
4. CREDIT must be 6 decimals and fixed before the first token is created (2.2).
5. Only about 89.9% of the seed enters the pool; about 10.1% per leg returns at finalize, mixed into totals (4.2, 4.5).
6. `finalizeProposal` returns nothing and sends one lump per leg to the caller (4.5).
7. Sells are two steps and must be completed in one transaction, with the dust returned to the seller (4.4).
8. No partial fills: large trades revert (4.1).
9. Tokens must be pushed to the adapter beforehand, and the market enforces it with `InsufficientPushedTokens` (4.1).
10. The trading window is half-open `[start, end)`, the seed must happen inside it, and timing is read from `marketTiming` only once (6).
11. pLong is confined to `[0.01, 0.99]` (5).
12. The adapter's ownership goes to QuantumRound after wiring, but no owner function remains (1).
13. TWAP is fixed only after `closeTwapWindow`; before that it is a live extrapolated value (4.6).
14. Counters in the registry revert at uint32 max (3.1).

Please paste the C3 spec so I can turn this section into a precise conflict list.

## 10. C3 as implemented (QuantumRound, Resolver, WavefundVault)

Describes `QuantumRound.sol`, `Resolver.sol` and `WavefundVault.sol` as they are in `contracts/src`. If the code and this section disagree, the code wins.

### 10.1 Wiring
- Deploy order: PoolManager, ProposalTokens (`setCreditDecimals(6)`), ProposerRegistry, adapter + hook, QuantumRound, oracle, vault, Resolver.
- Grant `QUANTUM_ROUND_ROLE` to QuantumRound on ProposalTokens and ProposerRegistry. Call `adapter.setQuantumRound` and `adapter.setWaveHook`.
- QuantumRound roles: `KEEPER_ROLE` (keeper), `VAULT_ROLE` (vault), `RESOLVER_ROLE` (Resolver). Then `setAllocationSource(vault)`.
- Resolver: grant its `RESOLVER_ROLE` to the vault. Vault: `setRound(quantumRound, resolver)` (once, checks `resolver.quantumRound()`), `grantRole(KEEPER_ROLE, keeper)`, `initializePool(sqrtPriceX96)` (or initialise the pool elsewhere).
- Admin funds the reserve with `addProtocolLiquiditySeed` (USDC approval to QuantumRound) and bootstraps the vault with `fundVault`.

### 10.2 Round lifecycle (QuantumRound)
Trading, then Collapsed, then Settled; or Collapsed, then Cancelled. Credits are 6 decimals and equal raw USDC.
- `openRound(tradingEnd, horizon, rMin, rMax, twapWindow)`: all `uint256`. Round ids start at 1. Proposal 0 takes `allocationSource.currentTEthBps()`.
- `propose(roundId, Allocation{uint16 tEthBps}, rationale)`: locks `registry.DEFAULT_BOND()` (1 USDC). The proposer approves the REGISTRY, not QuantumRound.
- `marketTiming(roundId, proposalId)` returns `(tradingStart, tradingEnd, twapWindow)`, the signature the adapter calls. It is not the one-argument form.
- `claimCredits` is capped per proposal: `creditsClaimed[r][p][user] <= deposits[r][user]`.
- `collapse`: the best proposal (lowest id on ties) wins only if its TWAP is strictly above proposal 0's plus `EPSILON`. Every market is finalised, losing seeds return to `protocolLiquiditySeed`, and every bond is refunded (a failed refund transfer becomes a pending refund in the registry).
- `settle`: `RESOLVER_ROLE` after `evaluationEnd`. Anyone after `evaluationEnd + 2 days`, but then the supplied value is IGNORED and the round settles at the midpoint of `[rMin, rMax]`.
- `redeem` and `redeemFor(roundId, user)`: only the winning proposal's tokens count and they are burned. The payout always goes to `user`. A failed transfer becomes `pendingPayout`, collected with `claimPayout()`. `redeemFor(address(quantumRound))` reverts.
- `releaseSeed`: reverts until nobody can still claim, and does nothing if already released. LONG/SHORT below 1e12 raw (the pool manager's rounding dust) is not a liability. Anyone can clear a depositor with `redeemFor`.

### 10.3 Vault
- Shares: WAVE, 18 decimals. NAV uses ACCOUNTED balances (`totalVaultUsdc`, `totalVaultTEth`), so donations do not move the share price and can be rescued.
- Queue: `requestDeposit`, `requestWithdraw` and their cancels join the current epoch. `executeTrade` prices the whole epoch as one batch at the pre-flow NAV and supply. Users then collect with `claimFor(user)`, which anyone can call and which only ever pays `user`. A failed USDC transfer becomes `claimableUsdc`, collected with `claimUsdc()`.
- `executeTrade(roundId, winnerTEthBps)`: keeper only, round collapsed, before `evaluationEnd`, oracle at most 5 minutes old, and the given bps must equal the winner's. Proposal 0 winning means no rebalance swap. A swap more than 500 bps worse than the oracle-implied output rolls back everything in the step, leaves the queues untouched and cancels the round.
- `cancelUnexecutedRound(roundId)`: anyone, once `evaluationEnd` has passed without an execution.
- Withdrawals that need tETH are bought with an exact-output swap. If even the guarded price needs more tETH than the vault holds, all tETH is sold and the loss is shared by all shares.
- `reportReturn(roundId)`: after `evaluationEnd`, with an oracle update at or after it that is still fresh, and within one day. `R = NAV now / NAV at decision`. After the window, the round's emergency settle applies. `fundVault` is blocked while a decided round awaits its report.

### 10.4 Known limits
- Keepers must call `redeemFor` and `claimFor` for users who do not act, if they want the seed back promptly.
- A single batch keeps tETH exposure only up to the guarded price: near-total exits sell all tETH.
- The keeper chooses when to execute inside the window, so the evaluation horizon can be shortened by up to its length.
