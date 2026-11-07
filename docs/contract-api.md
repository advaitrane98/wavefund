# Wavefund contract API (Arc Testnet)

Chain ID `5042002`. RPC `https://rpc.testnet.arc.io`. Explorer `https://explorer.testnet.arc.io`.
USDC (ERC-20, 6 decimals): `0x3600000000000000000000000000000000000000`. Never send native value to these contracts.
Decimals: USDC 6, CREDIT 6, LONG/SHORT 18, vault shares 18, tETH 18. One credit = 1e12 raw LONG + 1e12 raw SHORT. Probabilities and prices are 1e18 fixed point.
Generated from the compiled ABIs of the deployed source. Full machine-readable ABIs: `docs/abis.json`. Behavioural detail: `contracts/INTERFACES.md`.

> **Status:** deployed to Arc Testnet with all review fixes included. The previous deployment (without the fixes) is archived in `contracts/deployments/previous-deployment-v1.json` and should no longer be used.

Known limit (see `docs/security-review.md`): the vault trades through a single USDC/tETH pool, so someone who keeps that pool outside the oracle band until the evaluation ends can stop execution and force the round to cancel at par.

## Deployed addresses

| Contract | Address |
|---|---|
| QuantumRound | `0x3D660E2743B9CCdd5Ef97422BF9fD2723394c1B7` |
| WavefundVault | `0x9f0D3c05AE079A9C19e676096239A817D2709a19` |
| Resolver | `0x3c8B3Aa2d0340505C5eFb44019D7207b168aA3c7` |
| WaveV4ProposalMarket | `0x112e398A394eb0a1d29B1a046962E7286a427d2C` |
| WaveHook | `0x7Da2e1cdafe1794620f0eC6747cde37a332f8AC0` |
| ProposalTokens | `0xd6f67CF5331d13986c3eDcf65F72608fB740d424` |
| ProposerRegistry | `0x0462b2517de4A965f7B1A5744cc3B3cb972b763d` |
| MockPriceOracle | `0x6DE198B2089E4E368D75672dF018a141316fa7D2` |
| TestAsset | `0x22FB3985806ab43875Dac4e518ED16B1914e659a` |
| WavefundPoolHelper | `0x7fD39078daD4323021870dc871a402D123285f90` |
| PoolManager (Uniswap v4) | `0x2756F3F7bFAf103F4c550f4d24CdCa82B093240A` |

Deployer/admin: `0xDA026fbF1F9a98632F52AA23F92c0041d6Ef3ac2`. Keeper: `0xE7DD9a5fafa5739B466C61914311e39717f7192c`. Start block: 71054727.

ProposalToken has no fixed address: each CREDIT/LONG/SHORT token is a clone created per (roundId, proposalId); look it up with `ProposalTokens.creditToken/longToken/shortToken(roundId, proposalId)`.

## QuantumRound

Round engine: opens rounds, takes USDC deposits, runs proposals and trading, collapses to a winner, settles and pays out.

Address: `0x3D660E2743B9CCdd5Ef97422BF9fD2723394c1B7`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `addProtocolLiquiditySeed(uint256 amount)` |  | role DEFAULT_ADMIN_ROLE (Pulls USDC from the admin into the protocol reserve.) |
| `buyLong(uint256 roundId, uint256 proposalId, uint256 amount, uint256 minOut)` | `uint256` | anyone (Spends `amount` credits on LONG. `minOut` is in raw LONG units.) |
| `buyShort(uint256 roundId, uint256 proposalId, uint256 amount, uint256 minOut)` | `uint256` | anyone (Spends `amount` credits on SHORT. `minOut` is in raw SHORT units.) |
| `cancelRound(uint256 roundId)` |  | role VAULT_ROLE (VAULT_ROLE only. Called by the vault's permissionless `cancelUnexecutedRound` once a collapsed round's         evaluation period has ended without an execution. A failed execution (for example a swap outside the         oracle band) does NOT cancel the round: it reverts and the keeper can retry until `evaluationEnd`.         A cancelled round redeems deposits at par.) |
| `claimCredits(uint256 roundId, uint256 proposalId, uint256 amount)` |  | anyone (Mints CREDIT in one proposal. The cap is per proposal: claimed(r,p,user) <= deposit(r,user).) |
| `claimPayout()` |  | anyone (Pulls USDC that could not be sent to the caller during a redemption.) |
| `collapse(uint256 roundId)` |  | anyone (Anyone, after tradingEnd. Picks the winner, finalises every market and refunds every bond.) |
| `deposit(uint256 roundId, uint256 amount)` |  | anyone (Deposits USDC (raw, 6 decimals) as collateral for this round. Allowed while trading is open.) |
| `grantRole(bytes32 role, address account)` |  | admin of that role |
| `markExecuted(uint256 roundId)` |  | role VAULT_ROLE (VAULT_ROLE records a successful execution exactly once while collapsed.) |
| `openRound(uint256 tradingEnd, uint256 horizon, uint256 rMin, uint256 rMax, uint256 twapWindow)` | `uint256 roundId` | role KEEPER_ROLE (Opens the next round and creates proposal 0 (status quo) from the allocation source.) |
| `propose(uint256 roundId, (uint16) allocation, string rationale)` | `uint256 proposalId` | anyone (Registered, active proposers submit an allocation during trading. Locks the registry bond.) |
| `redeem(uint256 roundId)` | `uint256` | anyone (Pays the caller. Settled: (deposit - claimed[winner]) + winner CREDIT + LONG*pi + SHORT*(1-pi),         using only the winning proposal's tokens (burned here). Cancelled: the deposit at par.) |
| `redeemFor(uint256 roundId, address user)` | `uint256` | anyone (Same as `redeem`, for any `user`, so that nobody can hold the round's seed hostage by not redeeming.         The payout always goes to `user`; if that transfer fails it becomes a pending payout `user` can claim.) |
| `releaseSeed(uint256 roundId)` |  | anyone (Permissionless. Returns the remaining winning seed to the reserve once nobody can still claim.         Reverts while liabilities remain; does nothing if the seed was already released.) |
| `renounceRole(bytes32 role, address callerConfirmation)` |  | the account itself |
| `rescueProtocolSeed(uint256 amount)` |  | role DEFAULT_ADMIN_ROLE (Withdraws up to the UNALLOCATED reserve to the admin. Seeds in live markets cannot be touched.) |
| `revokeRole(bytes32 role, address account)` |  | admin of that role |
| `sellLong(uint256 roundId, uint256 proposalId, uint256 amount, uint256 minOut)` | `uint256` | anyone (Sells `amount` raw LONG for credits. `minOut` is in credits.) |
| `sellShort(uint256 roundId, uint256 proposalId, uint256 amount, uint256 minOut)` | `uint256` | anyone (Sells `amount` raw SHORT for credits. `minOut` is in credits.) |
| `setAllocationSource(address source)` |  | role DEFAULT_ADMIN_ROLE |
| `setInitialLiquidityPerProposal(uint256 credits)` |  | role DEFAULT_ADMIN_ROLE |
| `settle(uint256 roundId, uint256 realisedReturn)` |  | RESOLVER_ROLE (the Resolver); anyone after evaluationEnd + EMERGENCY_SETTLE_DELAY, settling at the midpoint return (RESOLVER_ROLE after evaluationEnd with the realised return ratio (1e18).) |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `DEFAULT_ADMIN_ROLE()` | `bytes32` |  |
| `EMERGENCY_SETTLE_DELAY()` | `uint256` |  |
| `EPSILON()` | `uint256` | Margin (in probability, 1e18) a proposal's TWAP must beat proposal 0's TWAP by. |
| `KEEPER_ROLE()` | `bytes32` |  |
| `MAX_PROPOSALS_PER_ROUND()` | `uint256` | Including proposal 0. |
| `MAX_SEED_CREDITS()` | `uint256` |  |
| `RESOLVER_ROLE()` | `bytes32` |  |
| `VAULT_ROLE()` | `bytes32` |  |
| `allocationSource()` | `address` |  |
| `creditsClaimed(uint256 roundId, uint256 proposalId, address user)` | `uint256` |  |
| `currentRoundId()` | `uint256` |  |
| `deposits(uint256 roundId, address user)` | `uint256` |  |
| `evaluationEnd(uint256 roundId)` | `uint256` |  |
| `getRoleAdmin(bytes32 role)` | `bytes32` |  |
| `hasRole(bytes32 role, address account)` | `bool` |  |
| `initialLiquidityPerProposal()` | `uint256` | Credits (6 decimals, = raw USDC) each new proposal market is seeded with. |
| `liabilitiesClear(uint256 roundId)` | `bool` |  |
| `market()` | `address` |  |
| `marketTiming(uint256 roundId, uint256)` | `uint64 tradingStart, uint64 tradingEnd, uint64 finalWindowSeconds` | Trading schedule of a proposal's market. |
| `pendingPayout(address user)` | `uint256` | USDC owed to users whose direct payout transfer failed (for example a blocklisted address). |
| `previewRedeem(uint256 roundId, address user)` | `uint256 payout` | What `redeem` would pay `user` right now (0 if not redeemable). |
| `proposals(uint256 roundId, uint256 proposalId)` | `address proposer, uint16 tEthBps, bool isStatusQuo, uint256 seedCredits, uint256 bond, uint256 probabilityTwap, string rationale` |  |
| `protocolLiquiditySeed()` | `uint256` | UNALLOCATED protocol reserve in raw USDC. Seeds are drawn from it and returned to it. |
| `redeemed(uint256 roundId, address user)` | `bool` |  |
| `registry()` | `address` |  |
| `roundExecuted(uint256 roundId)` | `bool` |  |
| `roundStatus(uint256 roundId)` | `uint8` |  |
| `rounds(uint256 roundId)` | `uint64 tradingStart, uint64 tradingEnd, uint64 evaluationEnd, uint64 twapWindow, uint256 rMin, uint256 rMax, uint8 status, uint8 proposalCount, uint8 winnerId, bool seedReleased, uint256 realisedReturn, uint256 pi, uint256 totalDeposits, uint256 depositsOutstanding, uint256 escrow, uint256 totalPaid` |  |
| `supportsInterface(bytes4 interfaceId)` | `bool` |  |
| `tokens()` | `address` |  |
| `usdc()` | `address` |  |
| `winningAllocation(uint256 roundId)` | `uint256 proposalId, uint16 tEthBps` | Winning proposal id and its tETH basis points. Reverts unless the round is collapsed or later. |

### Events

- `AllocationSourceUpdated(address indexed source)`
- `Bought(uint256 indexed roundId, uint256 indexed proposalId, address indexed user, bool isLong, uint256 credits, uint256 tokensOut)`
- `Collapsed(uint256 indexed roundId, uint256 indexed winnerId, uint256[] probabilities)`
- `CreditsClaimed(uint256 indexed roundId, uint256 indexed proposalId, address indexed user, uint256 amount)`
- `Deposited(uint256 indexed roundId, address indexed user, uint256 amount)`
- `InitialLiquidityUpdated(uint256 credits)`
- `PayoutClaimed(address indexed user, uint256 amount)`
- `PayoutDeferred(address indexed user, uint256 amount)`
- `ProposalCreated(uint256 indexed roundId, uint256 indexed proposalId, address indexed proposer, uint16 tEthBps, string rationale)`
- `ProtocolSeedAdded(uint256 amount, uint256 reserve)`
- `ProtocolSeedRescued(address indexed to, uint256 amount, uint256 reserve)`
- `Redeemed(uint256 indexed roundId, address indexed user, uint256 payout)`
- `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`
- `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`
- `RoundCancelled(uint256 indexed roundId)`
- `RoundOpened(uint256 indexed roundId, uint256 tradingEnd, uint256 evaluationEnd, uint256 rMin, uint256 rMax, uint256 twapWindow)`
- `RoundSettled(uint256 indexed roundId, uint256 realisedReturn, uint256 pi, bool emergency)`
- `SeedReleased(uint256 indexed roundId, uint256 amount)`
- `Sold(uint256 indexed roundId, uint256 indexed proposalId, address indexed user, bool isLong, uint256 tokensIn, uint256 creditsOut)`

### Custom errors

`AccessControlBadConfirmation()`, `AccessControlUnauthorizedAccount(address,bytes32)`, `AllocationSourceNotSet()`, `AlreadyCollapsed(uint256)`, `AlreadyExecuted(uint256)`, `ClaimExceedsDeposit(uint256,uint256)`, `EvaluationNotEnded(uint256)`, `ExceedsUnallocatedSeed(uint256,uint256)`, `InsufficientProtocolSeed(uint256,uint256)`, `InvalidAllocation(uint256)`, `InvalidParameters()`, `InvalidRedeemTarget(address)`, `LiabilitiesRemain(uint256)`, `NotAuthorizedToSettle()`, `NotCollapsed(uint256)`, `NotRedeemable(uint256)`, `NothingToClaim()`, `NothingToRedeem()`, `PreviousRoundActive(uint256)`, `ProposalNotFound(uint256,uint256)`, `ReentrancyGuardReentrantCall()`, `RegistryAssetMismatch(address,address)`, `RoundNotFound(uint256)`, `SafeCastOverflowedUintDowncast(uint8,uint256)`, `SafeERC20FailedOperation(address)`, `SolvencyViolation(uint256)`, `TooManyProposals()`, `TradingNotEnded(uint256)`, `TradingNotOpen(uint256)`, `ZeroAddress()`, `ZeroAmount()`

## WavefundVault

Share vault (ERC-20 shares) holding USDC and tETH. Queues deposits/withdrawals by epoch, rebalances to the winning allocation, reports the return.

Address: `0x9f0D3c05AE079A9C19e676096239A817D2709a19`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `approve(address spender, uint256 value)` | `bool` | anyone |
| `cancelDepositRequest()` |  | anyone (Cancels the caller's whole pending deposit request and refunds the USDC.) |
| `cancelUnexecutedRound(uint256 roundId)` |  | anyone (Permissionless: once a collapsed round's evaluation period has ended without an execution, the round can         no longer be traded fairly, so it is cancelled and redeems at par.) |
| `cancelWithdrawRequest()` |  | anyone (Cancels the caller's whole pending withdrawal request and returns the escrowed shares.) |
| `claimFor(address user)` |  | anyone (Collects `user`'s processed deposit shares and withdrawal USDC. Permissionless: it only ever pays `user`.) |
| `claimUsdc()` |  | anyone (Pulls USDC whose direct transfer failed (for example a blocklisted recipient).) |
| `emergencyWithdraw()` |  | anyone (Oracle-free in-kind exit of the caller's unprocessed escrow after the exit delay.) |
| `executeTrade(uint256 roundId, uint256 winnerTEthBps)` |  | role KEEPER_ROLE (KEEPER_ROLE, after the round collapsed. Needs an oracle update from the last 5 minutes. Marks NAV,         processes queued flows, then (unless proposal 0 won) swaps toward the winning allocation. If a swap's         output is more than `maxSlippageBps` worse than the oracle-implied output, the whole step is rolled         back with the original error (flows stay queued), allowing a retry before evaluationEnd.) |
| `executeTrade(uint256 roundId, uint256 winnerTEthBps, uint16 slippageBps, uint256 deadline)` |  | role KEEPER_ROLE (Executes with a keeper-selected capped tolerance and an inclusive deadline.) |
| `fundVault(uint256 usdcAmount, uint256 tEthAmount, address receiver)` | `uint256 shares` | role DEFAULT_ADMIN_ROLE (Bootstrap: pulls USDC and/or tETH from the admin and mints shares to `receiver` at oracle-marked NAV.         The first mint is 1 USDC per share. Blocked while a decided round still awaits its return report.) |
| `grantRole(bytes32 role, address account)` |  | admin of that role |
| `initializePool(uint160 sqrtPriceX96)` |  | role DEFAULT_ADMIN_ROLE (Initialises the USDC/tETH pool at `sqrtPriceX96` (reverts if it already exists).) |
| `processRound(uint256 roundId, bool statusQuo, uint16 targetBps, uint256 answer)` |  | self-call only (via executeTrade) |
| `renounceRole(bytes32 role, address callerConfirmation)` |  | the account itself |
| `reportReturn(uint256 roundId)` |  | anyone (Within REPORT_WINDOW after evaluationEnd, uses the first observation at or after evaluationEnd.         R marks the executed portfolio at that observation / NAV at decision. Later, emergency settle applies.) |
| `requestDeposit(uint256 amount)` |  | anyone (Escrows USDC until the next `executeTrade` converts it to shares at the pre-flow NAV.         Collect the shares afterwards with `claimFor` (anyone may trigger it for you).) |
| `requestWithdraw(uint256 shares)` |  | anyone (Escrows WAVE shares until the next `executeTrade` redeems them for USDC at the pre-flow NAV.) |
| `rescue(address token, address to, uint256 amount)` |  | role DEFAULT_ADMIN_ROLE (Rescues only what no one is owed: balances above queued deposits, claimable USDC and accounted         shareholder assets (USDC/tETH), and escrowed WAVE for withdrawal requests.) |
| `revokeRole(bytes32 role, address account)` |  | admin of that role |
| `setMaxSlippageBps(uint16 slippageBps)` |  | role DEFAULT_ADMIN_ROLE (Sets the default execution tolerance, never above the hard cap.) |
| `setRound(address quantumRound_, address resolver_)` |  | role DEFAULT_ADMIN_ROLE (One-time wiring of the round engine and resolver (they are deployed after the vault).) |
| `transfer(address to, uint256 value)` | `bool` | anyone |
| `transferFrom(address from, address to, uint256 value)` | `bool` | anyone |
| `unlockCallback(bytes data)` | `bytes` | Uniswap v4 PoolManager callback only (Called by the pool manager on `msg.sender` when the manager is unlocked) |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `DEFAULT_ADMIN_ROLE()` | `bytes32` |  |
| `KEEPER_ROLE()` | `bytes32` |  |
| `MAX_ORACLE_AGE()` | `uint256` |  |
| `MAX_SLIPPAGE_CAP_BPS()` | `uint256` |  |
| `MIN_DEPOSIT_REQUEST()` | `uint256` |  |
| `REPORT_WINDOW()` | `uint256` | A return can be reported only this long after evaluationEnd (afterwards the round's emergency settle applies). |
| `WITHDRAW_EXIT_DELAY()` | `uint256` |  |
| `allowance(address owner, address spender)` | `uint256` |  |
| `balanceOf(address account)` | `uint256` |  |
| `claimable(address user)` | `uint256 shares, uint256 usdcAmount` | Shares and USDC `claimFor(user)` would pay right now. |
| `claimableUsdc(address user)` | `uint256` |  |
| `claimableUsdcTotal()` | `uint256` |  |
| `currentEpoch()` | `uint256` | Index of the flow batch that new requests join (incremented each time a batch is processed). |
| `currentTEthBps()` | `uint256` | Current tETH share of the portfolio in basis points (0..10_000), marked at the oracle. |
| `decimals()` | `uint8` |  |
| `depositRequest(address user)` | `uint256` | Pending (not yet processed) deposit request in raw USDC. |
| `epochs(uint256 epoch)` | `uint256 depositUsdc, uint256 depositShares, uint256 withdrawShares, uint256 withdrawUsdc, uint256 depositUsdcLeft, uint256 depositSharesLeft, uint256 withdrawSharesLeft, uint256 withdrawUsdcLeft` |  |
| `getRoleAdmin(bytes32 role)` | `bytes32` |  |
| `hasRole(bytes32 role, address account)` | `bool` |  |
| `maxSlippageBps()` | `uint256` | A swap whose output is more than this many bps worse than the oracle-implied output is rolled back. |
| `name()` | `string` |  |
| `navUsdc()` | `uint256` | Oracle-marked NAV in raw USDC. Uses the last oracle price even if stale (view only). |
| `oracle()` | `address` |  |
| `oraclePriceTEthInUsdc()` | `uint256` | Raw USDC (6 decimals) per 1 tETH at the oracle. |
| `poolKey()` | `address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks` |  |
| `poolManager()` | `address` |  |
| `quantumRound()` | `address` |  |
| `queuedDepositsUsdc()` | `uint256` |  |
| `queuedWithdrawShares()` | `uint256` |  |
| `resolver()` | `address` |  |
| `roundState(uint256 roundId)` | `uint256 startValueUsdc, uint256 tEthAtStart, uint256 usdcAtStart, uint256 startPriceUsdc, uint256 navTimestamp, bool executed, bool reported, bool cancelled` |  |
| `sharePriceUsdc()` | `uint256` | Raw USDC per 1e18 shares (1e6 at launch). |
| `spotPriceTEthInUsdc()` | `uint256` | Raw USDC (6 decimals) per 1 tETH at the pool's current price; 0 if the pool is not initialised. |
| `supportsInterface(bytes4 interfaceId)` | `bool` |  |
| `symbol()` | `string` |  |
| `tEth()` | `address` |  |
| `totalSupply()` | `uint256` |  |
| `totalVaultTEth()` | `uint256` |  |
| `totalVaultUsdc()` | `uint256` | Accounted shareholder assets (donations are ignored). |
| `unclaimedDepositShares()` | `uint256` | Shares minted to this vault for processed deposits that their owners have not collected yet. |
| `unreportedRound()` | `uint256` |  |
| `usdc()` | `address` |  |
| `usdcIsCurrency0()` | `bool` |  |
| `withdrawRequest(address user)` | `uint256` | Pending (not yet processed) withdrawal request in shares. |

### Events

- `Approval(address indexed owner, address indexed spender, uint256 value)`
- `DepositCancelled(address indexed user, uint256 amount)`
- `DepositClaimed(address indexed user, uint256 indexed epoch, uint256 usdcAmount, uint256 shares)`
- `DepositRequested(address indexed user, uint256 amount, uint256 totalRequested)`
- `EmergencyWithdrawn(address indexed user, uint256 indexed epoch, uint256 shares, uint256 usdcAmount, uint256 tEthAmount)`
- `FlowsProcessed(uint256 indexed roundId, uint256 indexed epoch, uint256 depositUsdc, uint256 depositShares, uint256 withdrawShares, uint256 withdrawUsdc)`
- `MaxSlippageUpdated(uint256 slippageBps)`
- `Rescued(address indexed token, address indexed to, uint256 amount)`
- `ReturnReported(uint256 indexed roundId, uint256 navNow, uint256 startValue, uint256 realisedReturn)`
- `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`
- `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`
- `Swapped(uint256 indexed roundId, bool usdcToTEth, uint256 amountIn, uint256 amountOut)`
- `TradeCancelled(uint256 indexed roundId)`
- `TradeExecuted(uint256 indexed roundId, uint256 tEthBps, uint256 amountIn, uint256 amountOut)`
- `Transfer(address indexed from, address indexed to, uint256 value)`
- `UsdcClaimable(address indexed user, uint256 amount)`
- `UsdcClaimed(address indexed user, uint256 amount)`
- `VaultFunded(address indexed receiver, uint256 usdcAmount, uint256 tEthAmount, uint256 shares)`
- `Wired(address indexed quantumRound, address indexed resolver)`
- `WithdrawCancelled(address indexed user, uint256 shares)`
- `WithdrawClaimed(address indexed user, uint256 indexed epoch, uint256 shares, uint256 usdcAmount)`
- `WithdrawRequested(address indexed user, uint256 shares, uint256 totalRequested)`

### Custom errors

`AccessControlBadConfirmation()`, `AccessControlUnauthorizedAccount(address,bytes32)`, `AlreadyProcessed(uint256)`, `AlreadyReported(uint256)`, `AlreadyWired()`, `BelowMinimum(uint256,uint256)`, `DeadlineExpired(uint256)`, `ERC20InsufficientAllowance(address,uint256,uint256)`, `ERC20InsufficientBalance(address,uint256,uint256)`, `ERC20InvalidApprover(address)`, `ERC20InvalidReceiver(address)`, `ERC20InvalidSender(address)`, `ERC20InvalidSpender(address)`, `EvaluationNotEnded(uint256)`, `ExceedsRescuable(uint256,uint256)`, `ExecutionWindowClosed(uint256)`, `ExecutionWindowOpen(uint256)`, `InvalidAsset()`, `InvalidSlippage(uint256)`, `NoRequest()`, `NotBootstrapped()`, `NotExecuted(uint256)`, `NotPoolManager()`, `NotSelf()`, `NotWired()`, `NothingToClaim()`, `OracleNotUpdated(uint256,uint256)`, `OracleStale(uint256)`, `ReentrancyGuardReentrantCall()`, `ReportWindowClosed(uint256)`, `ResolverMismatch()`, `RoundNotCollapsed(uint256)`, `RoundPendingReport(uint256)`, `SafeERC20FailedOperation(address)`, `SlippageBreached(uint256,uint256)`, `UnexpectedSwapDelta()`, `WinnerMismatch(uint256,uint256)`, `WithdrawExitTooEarly(uint256)`, `ZeroAddress()`, `ZeroAmount()`

## Resolver

Relays the vault's reported return to QuantumRound.settle.

Address: `0x3c8B3Aa2d0340505C5eFb44019D7207b168aA3c7`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `grantRole(bytes32 role, address account)` |  | admin of that role |
| `renounceRole(bytes32 role, address callerConfirmation)` |  | the account itself |
| `revokeRole(bytes32 role, address account)` |  | admin of that role |
| `submitReturn(uint256 roundId, uint256 realisedReturn)` |  | role RESOLVER_ROLE (the vault) (Settles `roundId` in QuantumRound. This contract must hold RESOLVER_ROLE there.) |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `DEFAULT_ADMIN_ROLE()` | `bytes32` |  |
| `RESOLVER_ROLE()` | `bytes32` |  |
| `getRoleAdmin(bytes32 role)` | `bytes32` |  |
| `hasRole(bytes32 role, address account)` | `bool` |  |
| `quantumRound()` | `address` |  |
| `supportsInterface(bytes4 interfaceId)` | `bool` |  |

### Events

- `ReturnSubmitted(uint256 indexed roundId, uint256 realisedReturn, address indexed submitter)`
- `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`
- `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`

### Custom errors

`AccessControlBadConfirmation()`, `AccessControlUnauthorizedAccount(address,bytes32)`, `ZeroAddress()`

## WaveV4ProposalMarket

Adapter between QuantumRound and the Uniswap v4 pools. Only QuantumRound calls its state-changing functions.

Address: `0x112e398A394eb0a1d29B1a046962E7286a427d2C`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `closeTwapWindow(uint256 r, uint256 p)` | `uint256 pLongTwapX18, uint256 priceTwapX18` | anyone (After tradingEnd: snapshots the final TWAPs so they can no longer change. Idempotent.) |
| `consumeSellSettlement(uint256 r, uint256 p, address seller)` | `uint256 credits, uint256 longDust, uint256 shortDust` | onlyQuantumRound (Settles the pending sell: sends `credits * 1e12` of BOTH legs to the caller (QuantumRound burns them         and mints `credits` to the seller) and sends the dust of both legs to `seller`.) |
| `finalizeProposal(uint256 r, uint256 p)` |  | onlyQuantumRound (After trading ends: removes all liquidity and sends all remaining LONG/SHORT to the caller.) |
| `seedLiquidity(uint256 roundId, uint256 proposalId, uint256 creditAmount)` |  | onlyQuantumRound (Registers, initialises and funds the pool for a proposal.) |
| `setQuantumRound(address round)` |  | onlyOwner (Sets the sole trading controller once; completes ownership handoff when both wires exist.) |
| `setWaveHook(address hook)` |  | onlyOwner (Sets the shared hook once, checking its immutable adapter binding.) |
| `tradeBuyLong(uint256 r, uint256 p, uint256 credits, uint256 minOut, address to)` | `uint256` | onlyQuantumRound (Buy LONG with `creditAmount` credits. Caller has minted `creditAmount` complete sets to the market.) |
| `tradeBuyShort(uint256 r, uint256 p, uint256 credits, uint256 minOut, address to)` | `uint256` | onlyQuantumRound (Buy SHORT with `creditAmount` credits. Mirror of `tradeBuyLong`.) |
| `tradeSellLong(uint256 r, uint256 p, uint256 amountIn, uint256 minCreditsOut)` | `uint256` | onlyQuantumRound (Sell `amountIn` raw LONG. Caller has transferred `amountIn` LONG to the market first.) |
| `tradeSellShort(uint256 r, uint256 p, uint256 amountIn, uint256 minCreditsOut)` | `uint256` | onlyQuantumRound (Sell `amountIn` raw SHORT. Mirror of `tradeSellLong`.) |
| `unlockCallback(bytes data)` | `bytes` | Uniswap v4 PoolManager callback only (Executes an adapter-initiated unlock and nets both ERC20 currency deltas without native value.) |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `COMPLETE_SET_SCALE()` | `uint256` |  |
| `accountedBalances(uint256 r, uint256 p)` | `uint256 longHeld, uint256 shortHeld` | Returns accounted LONG/SHORT inventory in token units, excluding unabsorbed pushes. |
| `completeSetScale()` | `uint256` | Raw LONG (or SHORT) units per credit (1e12). |
| `owner()` | `address` |  |
| `poolManager()` | `address` |  |
| `probabilities(uint256 r, uint256 p)` | `uint256 pLong, uint256 pShort` | Spot probabilities, 18 decimals, always summing to exactly 1e18. |
| `probabilityTwap(uint256 r, uint256 p)` | `uint256` | Probability TWAP of LONG over the final window (extrapolated to tradingEnd), 18 decimals. |
| `proposalTokens()` | `address` |  |
| `quantumRound()` | `address` |  |
| `quoteBuyLong(uint256 r, uint256 p, uint256 credits)` | `uint256` | Quotes all LONG received, including the unswapped complete-set leg. |
| `quoteBuyShort(uint256 r, uint256 p, uint256 credits)` | `uint256` | Quotes all SHORT received, including the unswapped complete-set leg. |
| `quoteSellLong(uint256 r, uint256 p, uint256 amountIn)` | `uint256 creditsOut, uint256 longDust, uint256 shortDust` | Quotes the identical bounded bisection and dust rounding used by a LONG sale. |
| `quoteSellShort(uint256 r, uint256 p, uint256 amountIn)` | `uint256 creditsOut, uint256 longDust, uint256 shortDust` | Quotes the identical bounded bisection and dust rounding used by a SHORT sale. |
| `renounceOwnership()` |  | Explicitly disabled so wiring cannot be abandoned or the handoff undone. |
| `spotPrice(uint256 r, uint256 p)` | `uint256` | Spot price of LONG denominated in SHORT, 18 decimals (SHORT per LONG). |
| `transferOwnership(address)` |  | Explicitly disabled: ownership can move only through the automatic wiring handoff. |
| `twap(uint256 r, uint256 p)` | `uint256` | Price TWAP (SHORT per LONG) over the final window (extrapolated to tradingEnd), 18 decimals. |
| `waveHook()` | `address` |  |

### Events

- `MarketSeeded(uint256 indexed roundId, uint256 indexed proposalId, bytes32 indexed poolId, uint256 credits, uint128 liquidity)`
- `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)`
- `ProposalFinalized(uint256 indexed roundId, uint256 indexed proposalId, uint256 longReturned, uint256 shortReturned)`
- `QuantumRoundSet(address indexed quantumRound)`
- `SellSettlementConsumed(uint256 indexed roundId, uint256 indexed proposalId, address indexed seller, uint256 credits, uint256 longDust, uint256 shortDust)`
- `Trade(uint256 indexed roundId, uint256 indexed proposalId, bool isBuy, bool isLong, uint256 amountIn, uint256 amountOut, address recipient)`
- `TwapWindowClosed(uint256 indexed roundId, uint256 indexed proposalId, uint256 pLongTwap, uint256 priceTwap)`
- `WaveHookSet(address indexed waveHook)`

### Custom errors

`AccountingViolation(uint256,uint256)`, `AlreadyFinalized(uint256,uint256)`, `AlreadySeeded(uint256,uint256)`, `AlreadyWired()`, `CreditDecimalsMismatch(uint8)`, `HookPoolManagerMismatch(address)`, `InsufficientDepth(uint256,uint256)`, `InsufficientPushedTokens(uint256,uint256,uint256,uint256)`, `InvalidHookAdapter()`, `InvalidQuantumRound(address)`, `MarketNotFound(uint256,uint256)`, `MarketNotSeeded(uint256,uint256)`, `NoPendingSettlement(uint256,uint256)`, `NotPoolManager()`, `NotQuantumRound()`, `OwnableInvalidOwner(address)`, `OwnableUnauthorizedAccount(address)`, `OwnershipLocked()`, `PendingRemainder(uint256,uint256)`, `PoolNotEmpty()`, `QuantumRoundMarketMismatch(address)`, `ReentrancyGuardReentrantCall()`, `SafeCastOverflowedIntDowncast(uint8,int256)`, `SafeCastOverflowedUintDowncast(uint8,uint256)`, `SafeCastOverflowedUintToInt(uint256)`, `SafeERC20FailedOperation(address)`, `Slippage(uint256,uint256)`, `SolverDidNotConverge()`, `TradingClosed(uint64,uint64,uint256)`, `TradingNotEnded()`, `UnexpectedCallback()`, `UnexpectedRepairDelta()`, `UnexpectedSwapDelta(int256,int256)`, `WiringIncomplete()`, `ZeroAddress()`, `ZeroAmount()`

## WaveHook

Uniswap v4 hook (flags 2752). Gates trading windows, bounds probability, records TWAP. Only the market adapter and the PoolManager call it.

Address: `0x7Da2e1cdafe1794620f0eC6747cde37a332f8AC0`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `afterAddLiquidity(address sender, (address,address,uint24,int24,address) key, (int24,int24,int256,bytes32) params, int256 delta, int256 feesAccrued, bytes hookData)` | `bytes4, int256` | Uniswap v4 PoolManager only (The hook called after liquidity is added) |
| `afterDonate(address sender, (address,address,uint24,int24,address) key, uint256 amount0, uint256 amount1, bytes hookData)` | `bytes4` | Uniswap v4 PoolManager only (The hook called after donate) |
| `afterInitialize(address sender, (address,address,uint24,int24,address) key, uint160 sqrtPriceX96, int24 tick)` | `bytes4` | Uniswap v4 PoolManager only (The hook called after the state of a pool is initialized) |
| `afterRemoveLiquidity(address sender, (address,address,uint24,int24,address) key, (int24,int24,int256,bytes32) params, int256 delta, int256 feesAccrued, bytes hookData)` | `bytes4, int256` | Uniswap v4 PoolManager only (The hook called after liquidity is removed) |
| `afterSwap(address sender, (address,address,uint24,int24,address) key, (bool,int256,uint160) params, int256 delta, bytes hookData)` | `bytes4, int128` | Uniswap v4 PoolManager only (The hook called after a swap) |
| `beforeAddLiquidity(address sender, (address,address,uint24,int24,address) key, (int24,int24,int256,bytes32) params, bytes hookData)` | `bytes4` | Uniswap v4 PoolManager only (The hook called before liquidity is added) |
| `beforeDonate(address sender, (address,address,uint24,int24,address) key, uint256 amount0, uint256 amount1, bytes hookData)` | `bytes4` | Uniswap v4 PoolManager only (The hook called before donate) |
| `beforeInitialize(address sender, (address,address,uint24,int24,address) key, uint160 sqrtPriceX96)` | `bytes4` | Uniswap v4 PoolManager only (The hook called before the state of a pool is initialized) |
| `beforeRemoveLiquidity(address sender, (address,address,uint24,int24,address) key, (int24,int24,int256,bytes32) params, bytes hookData)` | `bytes4` | Uniswap v4 PoolManager only (The hook called before liquidity is removed) |
| `beforeSwap(address sender, (address,address,uint24,int24,address) key, (bool,int256,uint160) params, bytes hookData)` | `bytes4, int256, uint24` | Uniswap v4 PoolManager only (The hook called before a swap) |
| `registerPool((address,address,uint24,int24,address) key, uint256 roundId, uint256 proposalId, address longToken, uint64 tradingStart, uint64 tradingEnd, uint64 finalWindowSeconds, uint256 initialProbabilityX18)` |  | market adapter only |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `MAX_POSITION_TICK()` | `int24` |  |
| `MAX_PROBABILITY()` | `uint256` |  |
| `MIN_POSITION_TICK()` | `int24` |  |
| `MIN_PROBABILITY()` | `uint256` |  |
| `REQUIRED_POOL_FEE()` | `uint24` |  |
| `REQUIRED_TICK_SPACING()` | `int24` |  |
| `adapter()` | `address` | The only address allowed to register pools and to add/remove liquidity or swap. |
| `finalWindowPriceTwap(bytes32 id)` | `uint256` |  |
| `finalWindowTwap(bytes32 id)` | `uint256` |  |
| `getHookPermissions()` | `(bool,bool,bool,bool,bool,bool,bool,bool,bool,bool,bool,bool,bool,bool) permissions` | Only the four non-delta liquidity/trading permissions are enabled (2752). |
| `isRegistered(bytes32 id)` | `bool` |  |
| `pLong(bytes32 id)` | `uint256 probabilityX18` |  |
| `pShort(bytes32 id)` | `uint256` |  |
| `poolDetails(bytes32 id)` | `(uint256,uint256,address,uint64,uint64,uint64,uint64,bool,bool,uint256,uint256,uint256,uint256)` |  |
| `poolManager()` | `address` | The Uniswap v4 PoolManager contract |
| `spotPriceX18(bytes32 id)` | `uint256 priceX18` |  |

### Events

- `FinalWindowObservation(bytes32 indexed id, uint256 timestamp, uint256 pLongX18, uint256 priceX18, uint256 cumulativeProbability, uint256 cumulativePrice)`
- `PoolRegistered(bytes32 indexed id, uint256 indexed roundId, uint256 indexed proposalId, address longToken, uint64 tradingStart, uint64 tradingEnd, uint64 finalWindowSeconds, uint256 initialProbabilityX18)`

### Custom errors

`HookNotImplemented()`, `InvalidFinalWindow()`, `InvalidHook()`, `InvalidLiquidityDelta()`, `InvalidLongToken()`, `InvalidPoolFee(uint24,uint24)`, `InvalidPositionTicks()`, `InvalidTickSpacing(int24,int24)`, `InvalidTradingWindow()`, `NativeCurrencyNotAllowed()`, `NotPoolManager()`, `OnlyAdapter(address)`, `PoolAlreadyRegistered()`, `PoolNotRegistered()`, `PriceOutOfRange()`, `ProbabilityOutOfBounds(uint256)`, `TradingNotEnded()`, `TradingNotOpen()`, `ZeroAdapter()`, `ZeroPoolManager()`

## ProposalTokens

Factory for per-proposal CREDIT / LONG / SHORT token clones.

Address: `0xd6f67CF5331d13986c3eDcf65F72608fB740d424`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `createProposalTokens(uint256 roundId, uint256 proposalId)` | `address credit, address long_, address short_` | role QUANTUM_ROUND_ROLE (Creates and initializes all three tokens atomically for a previously unused pair.) |
| `grantRole(bytes32 role, address account)` |  | admin of that role |
| `renounceRole(bytes32 role, address callerConfirmation)` |  | the account itself |
| `revokeRole(bytes32 role, address account)` |  | admin of that role |
| `setCreditDecimals(uint8 decimals_)` |  | role DEFAULT_ADMIN_ROLE (Sets CREDIT precision once, before any successful proposal-token creation.) |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `DEFAULT_ADMIN_ROLE()` | `bytes32` |  |
| `QUANTUM_ROUND_ROLE()` | `bytes32` |  |
| `creditDecimals()` | `uint8` |  |
| `creditToken(uint256 roundId, uint256 proposalId)` | `address` | Returns CREDIT, or zero before creation. |
| `getRoleAdmin(bytes32 role)` | `bytes32` |  |
| `hasRole(bytes32 role, address account)` | `bool` |  |
| `implementation()` | `address` |  |
| `longToken(uint256 roundId, uint256 proposalId)` | `address` | Returns LONG, or zero before creation. |
| `proposalExists(uint256 roundId, uint256 proposalId)` | `bool` | Reports whether the token triplet has been created successfully. |
| `shortToken(uint256 roundId, uint256 proposalId)` | `address` | Returns SHORT, or zero before creation. |
| `supportsInterface(bytes4 interfaceId)` | `bool` |  |

### Events

- `CreditDecimalsLockedOnCreation(uint8 decimals)`
- `CreditDecimalsSet(uint8 decimals)`
- `ProposalTokensCreated(uint256 indexed roundId, uint256 indexed proposalId, address credit, address long_, address short_)`
- `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`
- `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`

### Custom errors

`AccessControlBadConfirmation()`, `AccessControlUnauthorizedAccount(address,bytes32)`, `CreditDecimalsAlreadySet()`, `CreditDecimalsLocked()`, `FailedDeployment()`, `InsufficientBalance(uint256,uint256)`, `InvalidCreditDecimals(uint8)`, `ProposalAlreadyExists(uint256,uint256)`, `ZeroAddress()`

## ProposalToken

Clone implementation for CREDIT, LONG and SHORT tokens (ERC-20). mint/burn only by the factory-authorised QuantumRound.

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `approve(address spender, uint256 value)` | `bool` | anyone |
| `burn(address from, uint256 amount)` |  | onlyQuantumRound (Burns base units without an allowance; emits the ERC20 Transfer event.) |
| `initialize(string name_, string symbol_, uint8 decimals_, address factory_)` |  | factory only, once (Initializes a clone once, atomically from its factory during creation.) |
| `mint(address to, uint256 amount)` |  | onlyQuantumRound (Mints base units; role revocations on the factory take effect immediately.) |
| `transfer(address to, uint256 value)` | `bool` | anyone |
| `transferFrom(address from, address to, uint256 value)` | `bool` | anyone |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `QUANTUM_ROUND_ROLE()` | `bytes32` |  |
| `allowance(address owner, address spender)` | `uint256` |  |
| `balanceOf(address account)` | `uint256` |  |
| `decimals()` | `uint8` | Returns the clone's initialized decimal precision. |
| `factory()` | `address` |  |
| `name()` | `string` | Returns the clone's initialized name. |
| `symbol()` | `string` | Returns the clone's initialized symbol. |
| `totalSupply()` | `uint256` |  |

### Events

- `Approval(address indexed owner, address indexed spender, uint256 value)`
- `Initialized(string name, string symbol, uint8 decimals, address indexed factory)`
- `Transfer(address indexed from, address indexed to, uint256 value)`

### Custom errors

`AlreadyInitialized()`, `ERC20InsufficientAllowance(address,uint256,uint256)`, `ERC20InsufficientBalance(address,uint256,uint256)`, `ERC20InvalidApprover(address)`, `ERC20InvalidReceiver(address)`, `ERC20InvalidSender(address)`, `ERC20InvalidSpender(address)`, `InvalidDecimals(uint8)`, `InvalidFactory(address)`, `UnauthorizedInitializer(address)`, `UnauthorizedRound(address)`

## ProposerRegistry

Agent registration and USDC bond escrow.

Address: `0x0462b2517de4A965f7B1A5744cc3B3cb972b763d`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `claimRefund()` |  | anyone (Claims the caller's deferred refunds only to the caller; no redirection is allowed.) |
| `grantRole(bytes32 role, address account)` |  | admin of that role |
| `lockBond(address proposer, uint256 amount)` |  | role QUANTUM_ROUND_ROLE (Pulls an approved positive ERC20 USDC amount from an active registered proposer.) |
| `pause()` |  | role DEFAULT_ADMIN_ROLE (Stops new bond commitments without disabling exits or registration.) |
| `recordProposal(address proposer)` |  | role QUANTUM_ROUND_ROLE (Increments the proposal count of a registered agent, regardless of active status.) |
| `recordWin(address proposer)` |  | role QUANTUM_ROUND_ROLE (Increments the win count of a registered agent, regardless of active status.) |
| `refundBond(address proposer, uint256 amount)` |  | role QUANTUM_ROUND_ROLE (Returns up to the proposer's aggregate locked balance; zero amounts are allowed.) |
| `registerAgent(string name)` |  | anyone (Registers the caller once with a nonempty name of at most 64 bytes.) |
| `renounceRole(bytes32 role, address callerConfirmation)` |  | the account itself |
| `revokeRole(bytes32 role, address account)` |  | admin of that role |
| `setSlashTreasury(address treasury)` |  | role DEFAULT_ADMIN_ROLE (Sets the sole slash destination; setting zero disables slashing.) |
| `slashBond(address proposer, uint256 amount)` |  | role QUANTUM_ROUND_ROLE (Sends a locked amount only to the configured slash treasury.) |
| `unpause()` |  | role DEFAULT_ADMIN_ROLE (Resumes new bond commitments.) |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `DEFAULT_ADMIN_ROLE()` | `bytes32` |  |
| `DEFAULT_BOND()` | `uint256` |  |
| `QUANTUM_ROUND_ROLE()` | `bytes32` |  |
| `agents(address proposer)` | `string name, uint64 registeredAt, bool active, uint32 proposalsMade, uint32 roundsWon` | Getter returns exactly (name, registeredAt, active, proposalsMade, roundsWon). |
| `getRoleAdmin(bytes32 role)` | `bytes32` |  |
| `hasRole(bytes32 role, address account)` | `bool` |  |
| `lockedBond(address proposer)` | `uint256 amount` |  |
| `paused()` | `bool` |  |
| `pendingRefund(address proposer)` | `uint256 amount` |  |
| `slashTreasury()` | `address` |  |
| `supportsInterface(bytes4 interfaceId)` | `bool` |  |
| `usdc()` | `address` |  |

### Events

- `AgentRegistered(address indexed proposer, string name, uint64 registeredAt)`
- `BondLocked(address indexed proposer, uint256 amount, uint256 totalLocked)`
- `BondRefunded(address indexed proposer, uint256 amount, uint256 totalLocked)`
- `BondSlashed(address indexed proposer, address indexed slashTreasury, uint256 amount, uint256 totalLocked)`
- `Paused(address account)`
- `ProposalRecorded(address indexed proposer, uint32 proposalsMade)`
- `RefundClaimed(address indexed proposer, uint256 amount)`
- `RefundDeferred(address indexed proposer, uint256 amount)`
- `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`
- `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`
- `SlashTreasuryUpdated(address indexed previousTreasury, address indexed newTreasury)`
- `Unpaused(address account)`
- `WinRecorded(address indexed proposer, uint32 roundsWon)`

### Custom errors

`AccessControlBadConfirmation()`, `AccessControlUnauthorizedAccount(address,bytes32)`, `AgentAlreadyRegistered(address)`, `AgentInactive(address)`, `AgentNotRegistered(address)`, `CounterOverflow(address)`, `EnforcedPause()`, `ExpectedPause()`, `InsufficientLockedBond(address,uint256,uint256)`, `InvalidNameLength(uint256)`, `InvalidUSDC(address)`, `InvalidUSDCDecimals(uint8)`, `NothingToClaim()`, `ReentrancyGuardReentrantCall()`, `SafeCastOverflowedUintDowncast(uint8,uint256)`, `SafeERC20FailedOperation(address)`, `SlashTreasuryNotSet()`, `ZeroAddress()`, `ZeroBondAmount()`

## MockPriceOracle

Testnet ETH/USD oracle updated by the keeper.

Address: `0x6DE198B2089E4E368D75672dF018a141316fa7D2`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `grantRole(bytes32 role, address account)` |  | admin of that role |
| `renounceRole(bytes32 role, address callerConfirmation)` |  | the account itself |
| `revokeRole(bytes32 role, address account)` |  | admin of that role |
| `updatePrice(int256 answer)` |  | role KEEPER_ROLE (Replaces the price and refreshes its on-chain timestamp.) |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `DEFAULT_ADMIN_ROLE()` | `bytes32` |  |
| `KEEPER_ROLE()` | `bytes32` |  |
| `MAX_ORACLE_AGE()` | `uint256` |  |
| `decimals()` | `uint8` | Returns the number of decimals in the USD price. |
| `firstObservationAtOrAfter(uint256 timestamp)` | `int256 answer, uint256 updatedAt` | Earliest appended observation whose timestamp is at least `timestamp`. |
| `getRoleAdmin(bytes32 role)` | `bytes32` |  |
| `hasRole(bytes32 role, address account)` | `bool` |  |
| `isFresh()` | `bool` | An observation exactly MAX_ORACLE_AGE seconds old remains fresh. |
| `latestFreshPrice()` | `int256` | Returns the last price or reverts if older than MAX_ORACLE_AGE. |
| `latestPrice()` | `int256 answer, uint256 updatedAt` | Returns the last observation, even when stale; consumers choose their own policy. |
| `supportsInterface(bytes4 interfaceId)` | `bool` |  |

### Events

- `PriceUpdated(int256 answer, uint256 updatedAt)`
- `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`
- `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`

### Custom errors

`AccessControlBadConfirmation()`, `AccessControlUnauthorizedAccount(address,bytes32)`, `InvalidPrice(int256)`, `ObservationNotFound(uint256)`, `StalePrice(uint256,uint256)`, `ZeroAddress()`

## TestAsset

tETH test token (18 decimals).

Address: `0x22FB3985806ab43875Dac4e518ED16B1914e659a`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `approve(address spender, uint256 value)` | `bool` | anyone |
| `burn(address from, uint256 amount)` |  | role MINTER_ROLE (Burns amount base units from from without an allowance. Emits Transfer.) |
| `grantRole(bytes32 role, address account)` |  | admin of that role |
| `mint(address to, uint256 amount)` |  | role MINTER_ROLE (Mints amount base units to to. Emits the ERC20 Transfer event.) |
| `renounceRole(bytes32 role, address callerConfirmation)` |  | the account itself |
| `revokeRole(bytes32 role, address account)` |  | admin of that role |
| `transfer(address to, uint256 value)` | `bool` | anyone |
| `transferFrom(address from, address to, uint256 value)` | `bool` | anyone |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `DEFAULT_ADMIN_ROLE()` | `bytes32` |  |
| `MINTER_ROLE()` | `bytes32` |  |
| `allowance(address owner, address spender)` | `uint256` |  |
| `balanceOf(address account)` | `uint256` |  |
| `decimals()` | `uint8` |  |
| `getRoleAdmin(bytes32 role)` | `bytes32` |  |
| `hasRole(bytes32 role, address account)` | `bool` |  |
| `name()` | `string` |  |
| `supportsInterface(bytes4 interfaceId)` | `bool` |  |
| `symbol()` | `string` |  |
| `totalSupply()` | `uint256` |  |

### Events

- `Approval(address indexed owner, address indexed spender, uint256 value)`
- `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)`
- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`
- `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`
- `Transfer(address indexed from, address indexed to, uint256 value)`

### Custom errors

`AccessControlBadConfirmation()`, `AccessControlUnauthorizedAccount(address,bytes32)`, `ERC20InsufficientAllowance(address,uint256,uint256)`, `ERC20InsufficientBalance(address,uint256,uint256)`, `ERC20InvalidApprover(address)`, `ERC20InvalidReceiver(address)`, `ERC20InvalidSender(address)`, `ERC20InvalidSpender(address)`, `ZeroAddress()`

## WavefundPoolHelper

Deployer-owned helper for seeding and swapping in the vault's USDC/tETH v4 pool.

Address: `0x7fD39078daD4323021870dc871a402D123285f90`

### State-changing functions

| Function | Returns | Access |
|---|---|---|
| `initializePool(uint160 sqrtPriceX96)` | `int24 tick` | onlyOwner (Initialises the pool at `sqrtPriceX96` (reverts if it already exists).) |
| `modifyLiquidity(int24 tickLower, int24 tickUpper, int256 liquidityDelta)` | `int256 amount0, int256 amount1` | onlyOwner (Adds (positive) or removes (negative) liquidity for this helper's position at the given ticks.) |
| `renounceOwnership()` |  | owner |
| `swap(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96)` | `int256 amount0, int256 amount1` | onlyOwner (Swaps with the owner's tokens. Negative `amountSpecified` is exact input. The swap stops at         `sqrtPriceLimitX96`; with no liquidity in range this moves the price without moving any tokens.) |
| `transferOwnership(address newOwner)` |  | owner |
| `unlockCallback(bytes data)` | `bytes` | Uniswap v4 PoolManager callback only (Called by the pool manager on `msg.sender` when the manager is unlocked) |

### Read functions

| Function | Returns | Notes |
|---|---|---|
| `owner()` | `address` |  |
| `poolKey()` | `address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks` |  |
| `poolManager()` | `address` |  |

### Events

- `LiquidityModified(int24 tickLower, int24 tickUpper, int256 liquidityDelta, int256 amount0, int256 amount1)`
- `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)`
- `PoolInitialized(uint160 sqrtPriceX96, int24 tick)`
- `Swapped(bool zeroForOne, int256 amount0, int256 amount1)`

### Custom errors

`InvalidAsset()`, `NotPoolManager()`, `OwnableInvalidOwner(address)`, `OwnableUnauthorizedAccount(address)`, `SafeERC20FailedOperation(address)`, `ZeroAddress()`

## Roles (as wired on testnet)

| Contract | Role | Holder |
|---|---|---|
| all AccessControl contracts | DEFAULT_ADMIN_ROLE | deployer |
| QuantumRound | KEEPER_ROLE | keeper |
| QuantumRound | VAULT_ROLE | WavefundVault (also gates `cancelRound` and `markExecuted`) |
| QuantumRound | RESOLVER_ROLE | Resolver |
| ProposalTokens, ProposerRegistry | QUANTUM_ROUND_ROLE | QuantumRound |
| Resolver | RESOLVER_ROLE | WavefundVault |
| WavefundVault, MockPriceOracle | KEEPER_ROLE | keeper |
| WaveV4ProposalMarket | owner | QuantumRound (handed over automatically; ownership is locked) |

## Typical call flows

- **Open a round (keeper):** `QuantumRound.openRound(tradingEnd, horizon, rMin, rMax, twapWindow)`.
- **Propose (registered agent):** `ProposerRegistry.registerAgent(name)`, approve the registry for USDC, then `QuantumRound.propose(roundId, allocation, rationale)`.
- **Participate (trader):** approve QuantumRound for USDC, `deposit(roundId, amount)`, `claimCredits(roundId, proposalId, amount)`, then `buyLong/buyShort/sellLong/sellShort`. Credits are 6 decimals, LONG/SHORT 18.
- **Close:** after `tradingEnd` anyone calls `collapse(roundId)`. The keeper then calls `WavefundVault.executeTrade(roundId, winnerTEthBps)` (or the 4-argument overload) before `evaluationEnd`. If it reverts with `SlippageBreached`, retry.
- **Settle:** after `evaluationEnd`, anyone calls `WavefundVault.reportReturn(roundId)` (it submits the return through `Resolver` to `QuantumRound.settle`). Users call `redeem(roundId)`; anyone can call `redeemFor` and `releaseSeed`.
- **Never executed:** after `evaluationEnd` anyone calls `WavefundVault.cancelUnexecutedRound(roundId)`, and deposits redeem at par. The emergency `settle` path does the same.
- **Vault shares:** `requestDeposit(usdc)` / `requestWithdraw(shares)`, processed at the next `executeTrade`, then `claimFor(user)` or `claimUsdc()`. If the keeper never processes a withdrawal, `emergencyWithdraw()` after 3 days.

## Behaviour changes in the fixed source

- `WavefundVault.executeTrade` (both overloads) no longer cancels the round when a swap breaches the slippage or oracle-band limit. It reverts with `SlippageBreached` and the keeper can retry until `evaluationEnd`.
- `executeTrade(roundId, winnerTEthBps, slippageBps, deadline)`: keeper-chosen tolerance (max `MAX_SLIPPAGE_CAP_BPS` = 500) and deadline. Default `maxSlippageBps` is 100 (1%), adjustable by the admin up to the cap with `setMaxSlippageBps`.
- `WavefundVault.emergencyWithdraw()`: after `WITHDRAW_EXIT_DELAY` (3 days) on an unprocessed withdraw request, the owner burns the escrowed shares and receives pro-rata USDC and tETH in kind. No oracle or swap. Queued deposits are untouched.
- Queued deposits convert to shares at the launch rate (1e6 raw USDC per 1e18 shares) when the vault has zero supply.
- `QuantumRound.markExecuted(roundId)` (VAULT_ROLE) is called by the vault after a successful execution. A non-resolver `settle` after the emergency delay settles at the midpoint only for executed rounds; for unexecuted rounds it cancels at par.
- `WavefundVault.reportReturn` uses `MockPriceOracle.firstObservationAtOrAfter(evaluationEnd)`.
- Constructors: `ProposerRegistry` requires a 6-decimal bond token; `QuantumRound` requires `registry.usdc() == usdc`. `WaveV4ProposalMarket.setQuantumRound` requires a contract whose `market()` equals the adapter.
