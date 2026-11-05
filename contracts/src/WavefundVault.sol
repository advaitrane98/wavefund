// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {MockPriceOracle} from "./MockPriceOracle.sol";
import {Resolver} from "./Resolver.sol";
import {IAllocationSource, IQuantumRoundControl, RoundStatus} from "./interfaces/IQuantumRoundControl.sol";

/// @title WavefundVault
/// @notice Holds USDC and tETH, issues WAVE shares, and moves the portfolio to each round's winning allocation.
/// @dev Deposits and withdrawals are queued and processed only inside `executeTrade`, all at the same pre-flow NAV
///      and share supply. NAV is marked at the oracle and uses ACCOUNTED balances (never `balanceOf`), so donations
///      cannot move the share price. USDC has 6 decimals, tETH and WAVE 18, the oracle 8 (USD per ETH).
/// @custom:upgrade-strategy Immutable, non-upgradeable code keeps share accounting fixed; live role administration is not an upgrade mechanism.
contract WavefundVault is ERC20, AccessControl, ReentrancyGuard, IUnlockCallback, IAllocationSource {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @dev A queued request belongs to `epoch`: the flow batch (one per processed `executeTrade`) that prices it.
    struct Request {
        uint256 epoch;
        uint256 amount;
    }

    /// @dev Aggregate result of one flow batch; individual claims are pro rata of these totals.
    struct Epoch {
        uint256 depositUsdc;
        uint256 depositShares;
        uint256 withdrawShares;
        uint256 withdrawUsdc;
        // Not yet collected portions. The last claimant receives whatever rounding left, so nothing stays locked.
        uint256 depositUsdcLeft;
        uint256 depositSharesLeft;
        uint256 withdrawSharesLeft;
        uint256 withdrawUsdcLeft;
    }

    struct RoundState {
        uint256 startValueUsdc;
        uint256 tEthAtStart;
        uint256 usdcAtStart;
        uint256 startPriceUsdc;
        uint256 navTimestamp;
        bool executed;
        bool reported;
        bool cancelled;
    }

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 public constant MAX_ORACLE_AGE = 5 minutes;
    /// @notice A swap whose output is more than this many bps worse than the oracle-implied output is rolled back.
    uint256 public constant maxSlippageBps = 500;
    uint256 public constant MIN_DEPOSIT_REQUEST = 1e6;
    /// @notice A return can be reported only this long after evaluationEnd (afterwards the round's emergency settle applies).
    uint256 public constant REPORT_WINDOW = 1 days;

    uint256 private constant BPS = 10_000;
    uint256 private constant ONE = 1e18;
    /// @dev tETH (1e18) * oracle answer (1e8) / PRICE_DIVISOR = raw USDC (1e6).
    uint256 private constant PRICE_DIVISOR = 1e20;
    uint256 private constant INITIAL_SHARES_PER_USDC = 1e12;

    IERC20 public immutable usdc;
    IERC20 public immutable tEth;
    MockPriceOracle public immutable oracle;
    IPoolManager public immutable poolManager;
    bool public immutable usdcIsCurrency0;
    PoolKey public poolKey;

    IQuantumRoundControl public quantumRound;
    Resolver public resolver;

    /// @notice Accounted shareholder assets (donations are ignored).
    uint256 public totalVaultUsdc;
    uint256 public totalVaultTEth;
    uint256 public queuedDepositsUsdc;
    uint256 public queuedWithdrawShares;
    uint256 public claimableUsdcTotal;
    uint256 public unreportedRound;
    /// @notice Index of the flow batch that new requests join (incremented each time a batch is processed).
    uint256 public currentEpoch;
    /// @notice Shares minted to this vault for processed deposits that their owners have not collected yet.
    uint256 public unclaimedDepositShares;

    mapping(address user => uint256) public claimableUsdc;
    mapping(address user => Request) private _depositRequests;
    mapping(address user => Request) private _withdrawRequests;
    mapping(uint256 epoch => Epoch) public epochs;
    mapping(uint256 roundId => RoundState) private _rounds;

    error ZeroAddress();
    error AlreadyWired();
    error ResolverMismatch();
    error InvalidAsset();
    error NotWired();
    error NotPoolManager();
    error NotSelf();
    error ZeroAmount();
    error NotBootstrapped();
    error BelowMinimum(uint256 amount, uint256 minimum);
    error ExecutionWindowClosed(uint256 roundId);
    error ExecutionWindowOpen(uint256 roundId);
    error ReportWindowClosed(uint256 roundId);
    error OracleStale(uint256 updatedAt);
    error NoRequest();
    error AlreadyProcessed(uint256 roundId);
    error RoundNotCollapsed(uint256 roundId);
    error WinnerMismatch(uint256 expectedBps, uint256 givenBps);
    error NotExecuted(uint256 roundId);
    error AlreadyReported(uint256 roundId);
    error EvaluationNotEnded(uint256 roundId);
    error OracleNotUpdated(uint256 updatedAt, uint256 required);
    error SlippageBreached(uint256 limit, uint256 actual);
    error RoundPendingReport(uint256 roundId);
    error ExceedsRescuable(uint256 requested, uint256 available);
    error NothingToClaim();
    error UnexpectedSwapDelta();

    event Wired(address indexed quantumRound, address indexed resolver);
    event VaultFunded(address indexed receiver, uint256 usdcAmount, uint256 tEthAmount, uint256 shares);
    event DepositRequested(address indexed user, uint256 amount, uint256 totalRequested);
    event DepositCancelled(address indexed user, uint256 amount);
    event WithdrawRequested(address indexed user, uint256 shares, uint256 totalRequested);
    event WithdrawCancelled(address indexed user, uint256 shares);
    event FlowsProcessed(
        uint256 indexed roundId,
        uint256 indexed epoch,
        uint256 depositUsdc,
        uint256 depositShares,
        uint256 withdrawShares,
        uint256 withdrawUsdc
    );
    event DepositClaimed(address indexed user, uint256 indexed epoch, uint256 usdcAmount, uint256 shares);
    event WithdrawClaimed(address indexed user, uint256 indexed epoch, uint256 shares, uint256 usdcAmount);
    event UsdcClaimable(address indexed user, uint256 amount);
    event UsdcClaimed(address indexed user, uint256 amount);
    event Swapped(uint256 indexed roundId, bool usdcToTEth, uint256 amountIn, uint256 amountOut);
    event TradeExecuted(uint256 indexed roundId, uint256 tEthBps, uint256 amountIn, uint256 amountOut);
    event TradeCancelled(uint256 indexed roundId);
    event ReturnReported(uint256 indexed roundId, uint256 navNow, uint256 startValue, uint256 realisedReturn);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    constructor(address admin, IERC20 usdc_, IERC20 tEth_, MockPriceOracle oracle_, IPoolManager poolManager_)
        ERC20("Wavefund Share", "WAVE")
    {
        if (
            admin == address(0) || address(usdc_) == address(0) || address(tEth_) == address(0)
                || address(oracle_) == address(0) || address(poolManager_) == address(0)
        ) revert ZeroAddress();
        if (
            address(usdc_) == address(tEth_) || IERC20Metadata(address(usdc_)).decimals() != 6
                || IERC20Metadata(address(tEth_)).decimals() != 18
        ) revert InvalidAsset();
        usdc = usdc_;
        tEth = tEth_;
        oracle = oracle_;
        poolManager = poolManager_;
        bool usdc0 = address(usdc_) < address(tEth_);
        usdcIsCurrency0 = usdc0;
        poolKey = PoolKey({
            currency0: Currency.wrap(usdc0 ? address(usdc_) : address(tEth_)),
            currency1: Currency.wrap(usdc0 ? address(tEth_) : address(usdc_)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ admin

    /// @notice One-time wiring of the round engine and resolver (they are deployed after the vault).
    function setRound(IQuantumRoundControl quantumRound_, Resolver resolver_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(quantumRound) != address(0)) revert AlreadyWired();
        if (address(quantumRound_) == address(0) || address(resolver_) == address(0)) revert ZeroAddress();
        if (address(resolver_.quantumRound()) != address(quantumRound_)) revert ResolverMismatch();
        quantumRound = quantumRound_;
        resolver = resolver_;
        emit Wired(address(quantumRound_), address(resolver_));
    }

    /// @notice Initialises the USDC/tETH pool at `sqrtPriceX96` (reverts if it already exists).
    function initializePool(uint160 sqrtPriceX96) external onlyRole(DEFAULT_ADMIN_ROLE) {
        poolManager.initialize(poolKey, sqrtPriceX96);
    }

    /// @notice Bootstrap: pulls USDC and/or tETH from the admin and mints shares to `receiver` at oracle-marked NAV.
    ///         The first mint is 1 USDC per share. Blocked while a decided round still awaits its return report.
    function fundVault(uint256 usdcAmount, uint256 tEthAmount, address receiver)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
        returns (uint256 shares)
    {
        if (receiver == address(0)) revert ZeroAddress();
        if (usdcAmount == 0 && tEthAmount == 0) revert ZeroAmount();
        _requireNoPendingReport();
        uint256 answer = _freshAnswer();
        uint256 nav = totalVaultUsdc + _valueOf(totalVaultTEth, answer);
        uint256 supply = totalSupply();
        uint256 value = usdcAmount + _valueOf(tEthAmount, answer);
        if (supply == 0) {
            shares = value * INITIAL_SHARES_PER_USDC;
        } else {
            if (nav == 0) revert NotBootstrapped();
            shares = Math.mulDiv(value, supply, nav);
        }
        if (shares == 0) revert ZeroAmount();
        totalVaultUsdc += usdcAmount;
        totalVaultTEth += tEthAmount;
        if (usdcAmount != 0) usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        if (tEthAmount != 0) tEth.safeTransferFrom(msg.sender, address(this), tEthAmount);
        _mint(receiver, shares);
        emit VaultFunded(receiver, usdcAmount, tEthAmount, shares);
    }

    /// @notice Rescues only what no one is owed: balances above queued deposits, claimable USDC and accounted
    ///         shareholder assets (USDC/tETH), and escrowed WAVE for withdrawal requests.
    function rescue(IERC20 token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 locked;
        if (address(token) == address(usdc)) locked = totalVaultUsdc + queuedDepositsUsdc + claimableUsdcTotal;
        else if (address(token) == address(tEth)) locked = totalVaultTEth;
        else if (address(token) == address(this)) locked = queuedWithdrawShares + unclaimedDepositShares;
        uint256 balance = token.balanceOf(address(this));
        uint256 available = balance > locked ? balance - locked : 0;
        if (amount > available) revert ExceedsRescuable(amount, available);
        emit Rescued(address(token), to, amount);
        token.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------ queues

    /// @notice Escrows USDC until the next `executeTrade` converts it to shares at the pre-flow NAV.
    ///         Collect the shares afterwards with `claimFor` (anyone may trigger it for you).
    function requestDeposit(uint256 amount) external nonReentrant {
        if (totalSupply() == 0) revert NotBootstrapped();
        if (amount < MIN_DEPOSIT_REQUEST) revert BelowMinimum(amount, MIN_DEPOSIT_REQUEST);
        _syncDeposit(msg.sender);
        Request storage q = _depositRequests[msg.sender];
        q.epoch = currentEpoch;
        q.amount += amount;
        queuedDepositsUsdc += amount;
        emit DepositRequested(msg.sender, amount, q.amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Cancels the caller's whole pending deposit request and refunds the USDC.
    function cancelDepositRequest() external nonReentrant {
        _syncDeposit(msg.sender);
        uint256 amount = _depositRequests[msg.sender].amount;
        if (amount == 0) revert NoRequest();
        delete _depositRequests[msg.sender];
        queuedDepositsUsdc -= amount;
        emit DepositCancelled(msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
    }

    /// @notice Escrows WAVE shares until the next `executeTrade` redeems them for USDC at the pre-flow NAV.
    function requestWithdraw(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        _syncWithdraw(msg.sender);
        Request storage q = _withdrawRequests[msg.sender];
        q.epoch = currentEpoch;
        q.amount += shares;
        queuedWithdrawShares += shares;
        _transfer(msg.sender, address(this), shares);
        emit WithdrawRequested(msg.sender, shares, q.amount);
    }

    /// @notice Cancels the caller's whole pending withdrawal request and returns the escrowed shares.
    function cancelWithdrawRequest() external nonReentrant {
        _syncWithdraw(msg.sender);
        uint256 shares = _withdrawRequests[msg.sender].amount;
        if (shares == 0) revert NoRequest();
        delete _withdrawRequests[msg.sender];
        queuedWithdrawShares -= shares;
        _transfer(address(this), msg.sender, shares);
        emit WithdrawCancelled(msg.sender, shares);
    }

    /// @notice Collects `user`'s processed deposit shares and withdrawal USDC. Permissionless: it only ever pays `user`.
    function claimFor(address user) external nonReentrant {
        _syncDeposit(user);
        _syncWithdraw(user);
    }

    /// @notice Pulls USDC whose direct transfer failed (for example a blocklisted recipient).
    function claimUsdc() external nonReentrant {
        uint256 amount = claimableUsdc[msg.sender];
        if (amount == 0) revert NothingToClaim();
        delete claimableUsdc[msg.sender];
        claimableUsdcTotal -= amount;
        emit UsdcClaimed(msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
    }

    /// @notice Pending (not yet processed) deposit request in raw USDC.
    function depositRequest(address user) external view returns (uint256) {
        Request storage q = _depositRequests[user];
        return q.epoch == currentEpoch ? q.amount : 0;
    }

    /// @notice Pending (not yet processed) withdrawal request in shares.
    function withdrawRequest(address user) external view returns (uint256) {
        Request storage q = _withdrawRequests[user];
        return q.epoch == currentEpoch ? q.amount : 0;
    }

    /// @notice Shares and USDC `claimFor(user)` would pay right now.
    function claimable(address user) external view returns (uint256 shares, uint256 usdcAmount) {
        Request storage d = _depositRequests[user];
        if (d.amount != 0 && d.epoch < currentEpoch) {
            Epoch storage e = epochs[d.epoch];
            shares = d.amount == e.depositUsdcLeft
                ? e.depositSharesLeft
                : Math.mulDiv(d.amount, e.depositShares, e.depositUsdc);
        }
        Request storage w = _withdrawRequests[user];
        if (w.amount != 0 && w.epoch < currentEpoch) {
            Epoch storage e = epochs[w.epoch];
            usdcAmount = w.amount == e.withdrawSharesLeft
                ? e.withdrawUsdcLeft
                : Math.mulDiv(w.amount, e.withdrawUsdc, e.withdrawShares);
        }
    }

    // ------------------------------------------------------------------ decision and reporting

    /// @notice KEEPER_ROLE, after the round collapsed. Needs an oracle update from the last 5 minutes. Marks NAV,
    ///         processes queued flows, then (unless proposal 0 won) swaps toward the winning allocation. If a swap's
    ///         output is more than `maxSlippageBps` worse than the oracle-implied output, the whole step is rolled
    ///         back (flows stay queued) and the round is cancelled so it redeems at par.
    function executeTrade(uint256 roundId, uint256 winnerTEthBps) external onlyRole(KEEPER_ROLE) nonReentrant {
        if (address(quantumRound) == address(0)) revert NotWired();
        RoundState storage rs = _rounds[roundId];
        if (rs.executed || rs.cancelled) revert AlreadyProcessed(roundId);
        if (quantumRound.roundStatus(roundId) != RoundStatus.Collapsed) revert RoundNotCollapsed(roundId);
        if (block.timestamp >= quantumRound.evaluationEnd(roundId)) revert ExecutionWindowClosed(roundId);
        (uint256 winnerId, uint16 bps) = quantumRound.winningAllocation(roundId);
        if (bps != winnerTEthBps) revert WinnerMismatch(bps, winnerTEthBps);
        uint256 answer = _freshAnswer();
        try this.processRound(roundId, winnerId == 0, bps, answer) {}
        catch (bytes memory reason) {
            if (reason.length < 4 || bytes4(reason) != SlippageBreached.selector) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            rs.cancelled = true;
            emit TradeCancelled(roundId);
            quantumRound.cancelRound(roundId);
        }
    }

    /// @notice Permissionless: once a collapsed round's evaluation period has ended without an execution, the round can
    ///         no longer be traded fairly, so it is cancelled and redeems at par.
    function cancelUnexecutedRound(uint256 roundId) external nonReentrant {
        if (address(quantumRound) == address(0)) revert NotWired();
        RoundState storage rs = _rounds[roundId];
        if (rs.executed || rs.cancelled) revert AlreadyProcessed(roundId);
        if (quantumRound.roundStatus(roundId) != RoundStatus.Collapsed) revert RoundNotCollapsed(roundId);
        if (block.timestamp < quantumRound.evaluationEnd(roundId)) revert ExecutionWindowOpen(roundId);
        rs.cancelled = true;
        emit TradeCancelled(roundId);
        quantumRound.cancelRound(roundId);
    }

    /// @dev Only callable by this contract through `executeTrade`, so a reverting swap rolls back every effect.
    function processRound(uint256 roundId, bool statusQuo, uint16 targetBps, uint256 answer) external {
        if (msg.sender != address(this)) revert NotSelf();
        _processFlows(roundId, answer);
        uint256 amountIn;
        uint256 amountOut;
        uint256 reportedBps;
        if (statusQuo) {
            reportedBps = _bpsAt(answer);
        } else {
            reportedBps = targetBps;
            (amountIn, amountOut) = _rebalance(roundId, targetBps, answer);
        }
        emit TradeExecuted(roundId, reportedBps, amountIn, amountOut);
        RoundState storage rs = _rounds[roundId];
        rs.usdcAtStart = totalVaultUsdc;
        rs.tEthAtStart = totalVaultTEth;
        rs.startPriceUsdc = answer / 100;
        rs.startValueUsdc = totalVaultUsdc + _valueOf(totalVaultTEth, answer);
        rs.navTimestamp = block.timestamp;
        rs.executed = true;
        unreportedRound = roundId;
    }

    /// @notice After evaluationEnd, with an oracle update published at or after it and still fresh, and within
    ///         REPORT_WINDOW: R = NAV now / NAV at decision. Later, the round's emergency settle applies.
    function reportReturn(uint256 roundId) external nonReentrant {
        RoundState storage rs = _rounds[roundId];
        if (!rs.executed) revert NotExecuted(roundId);
        if (rs.reported) revert AlreadyReported(roundId);
        uint256 end = quantumRound.evaluationEnd(roundId);
        if (block.timestamp < end) revert EvaluationNotEnded(roundId);
        (int256 answer, uint256 updatedAt) = oracle.latestPrice();
        if (updatedAt < end) revert OracleNotUpdated(updatedAt, end);
        if (block.timestamp > end + REPORT_WINDOW) revert ReportWindowClosed(roundId);
        if (block.timestamp - updatedAt > MAX_ORACLE_AGE) revert OracleStale(updatedAt);
        uint256 navNow = totalVaultUsdc + _valueOf(totalVaultTEth, uint256(answer));
        uint256 start = rs.startValueUsdc;
        uint256 r = start == 0 ? ONE : Math.mulDiv(navNow, ONE, start);
        rs.reported = true;
        emit ReturnReported(roundId, navNow, start, r);
        resolver.submitReturn(roundId, r);
    }

    // ------------------------------------------------------------------ views

    /// @notice Oracle-marked NAV in raw USDC. Uses the last oracle price even if stale (view only).
    function navUsdc() public view returns (uint256) {
        return totalVaultUsdc + _valueOf(totalVaultTEth, _latestAnswer());
    }

    /// @inheritdoc IAllocationSource
    function currentTEthBps() public view returns (uint256) {
        return _bpsAt(_latestAnswer());
    }

    /// @notice Raw USDC (6 decimals) per 1 tETH at the oracle.
    function oraclePriceTEthInUsdc() external view returns (uint256) {
        return _latestAnswer() / 100;
    }

    /// @notice Raw USDC (6 decimals) per 1 tETH at the pool's current price; 0 if the pool is not initialised.
    function spotPriceTEthInUsdc() external view returns (uint256) {
        (uint160 sqrtP,,,) = poolManager.getSlot0(poolKey.toId());
        if (sqrtP == 0) return 0;
        uint256 sq = sqrtP;
        if (sq <= type(uint128).max) {
            return usdcIsCurrency0 ? FullMath.mulDiv(1 << 192, ONE, sq * sq) : FullMath.mulDiv(sq * sq, ONE, 1 << 192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sq, sq, 1 << 64);
        return usdcIsCurrency0 ? FullMath.mulDiv(1 << 128, ONE, ratioX128) : FullMath.mulDiv(ratioX128, ONE, 1 << 128);
    }

    /// @notice Raw USDC per 1e18 shares (1e6 at launch).
    function sharePriceUsdc() external view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? 1e6 : Math.mulDiv(navUsdc(), ONE, supply);
    }

    function roundState(uint256 roundId)
        external
        view
        returns (
            uint256 startValueUsdc,
            uint256 tEthAtStart,
            uint256 usdcAtStart,
            uint256 startPriceUsdc,
            uint256 navTimestamp,
            bool executed,
            bool reported,
            bool cancelled
        )
    {
        RoundState storage rs = _rounds[roundId];
        return (
            rs.startValueUsdc,
            rs.tEthAtStart,
            rs.usdcAtStart,
            rs.startPriceUsdc,
            rs.navTimestamp,
            rs.executed,
            rs.reported,
            rs.cancelled
        );
    }

    // ------------------------------------------------------------------ flows

    /// @dev Prices the whole queue as one batch at the same pre-flow NAV and share supply. Individual users are
    ///      settled lazily, pro rata of the batch totals, so the cost of processing does not depend on queue length.
    function _processFlows(uint256 roundId, uint256 answer) private {
        uint256 supply0 = totalSupply();
        uint256 nav0 = totalVaultUsdc + _valueOf(totalVaultTEth, answer);
        uint256 deposited = queuedDepositsUsdc;
        uint256 withdrawing = queuedWithdrawShares;
        if (supply0 == 0 || nav0 == 0 || (deposited == 0 && withdrawing == 0)) return;

        Epoch storage e = epochs[currentEpoch];
        uint256 mintedShares;
        uint256 paidUsdc;
        if (deposited != 0) {
            mintedShares = Math.mulDiv(deposited, supply0, nav0);
            e.depositUsdc = deposited;
            e.depositShares = mintedShares;
            e.depositUsdcLeft = deposited;
            e.depositSharesLeft = mintedShares;
            totalVaultUsdc += deposited;
            queuedDepositsUsdc = 0;
            unclaimedDepositShares += mintedShares;
            _mint(address(this), mintedShares);
        }
        if (withdrawing != 0) {
            paidUsdc = Math.mulDiv(withdrawing, nav0, supply0);
            if (paidUsdc > totalVaultUsdc) paidUsdc = _fundWithdrawals(roundId, paidUsdc, answer, withdrawing);
            e.withdrawShares = withdrawing;
            e.withdrawUsdc = paidUsdc;
            e.withdrawSharesLeft = withdrawing;
            e.withdrawUsdcLeft = paidUsdc;
            queuedWithdrawShares = 0;
            _burn(address(this), withdrawing);
            totalVaultUsdc -= paidUsdc;
            claimableUsdcTotal += paidUsdc;
        }
        emit FlowsProcessed(roundId, currentEpoch, deposited, mintedShares, withdrawing, paidUsdc);
        currentEpoch += 1;
    }

    /// @dev Raises USDC for withdrawals by selling tETH. Normally the exact shortfall is bought with an exact-output
    ///      swap and the cost falls on the vault. If even the guarded price needs more tETH than the vault holds
    ///      (near-total exits), all tETH is sold and the liquidation loss is shared by ALL shares, exiting and
    ///      remaining alike, so a partial exit can never wipe out the holders who stay.
    /// @return payable_ The USDC that can be paid to withdrawers (equal to `owed` unless the exit is haircut).
    function _fundWithdrawals(uint256 roundId, uint256 owed, uint256 answer, uint256 withdrawing)
        private
        returns (uint256 payable_)
    {
        uint256 shortfall = owed - totalVaultUsdc;
        uint256 expectedIn = Math.mulDiv(shortfall, PRICE_DIVISOR, answer, Math.Rounding.Ceil);
        uint256 maxIn = Math.mulDiv(expectedIn, BPS + maxSlippageBps, BPS);
        if (maxIn <= totalVaultTEth) {
            (uint256 amountIn, uint256 amountOut) = _swap(false, false, shortfall, maxIn);
            totalVaultTEth -= amountIn;
            totalVaultUsdc += amountOut;
            emit Swapped(roundId, false, amountIn, amountOut);
            return owed;
        }
        uint256 all = totalVaultTEth;
        if (all != 0) {
            (uint256 spent, uint256 got) =
                _swap(false, true, all, Math.mulDiv(_valueOf(all, answer), BPS - maxSlippageBps, BPS));
            totalVaultTEth -= spent;
            totalVaultUsdc += got;
            emit Swapped(roundId, false, spent, got);
        }
        return Math.min(owed, Math.mulDiv(withdrawing, totalVaultUsdc, totalSupply()));
    }

    function _rebalance(uint256 roundId, uint256 targetBps, uint256 answer)
        private
        returns (uint256 amountIn, uint256 amountOut)
    {
        uint256 tEthValue = _valueOf(totalVaultTEth, answer);
        uint256 targetValue = Math.mulDiv(totalVaultUsdc + tEthValue, targetBps, BPS);
        if (targetValue > tEthValue) {
            uint256 spend = Math.min(targetValue - tEthValue, totalVaultUsdc);
            if (spend == 0) return (0, 0);
            uint256 expected = Math.mulDiv(spend, PRICE_DIVISOR, answer);
            (amountIn, amountOut) = _swap(true, true, spend, Math.mulDiv(expected, BPS - maxSlippageBps, BPS));
            totalVaultUsdc -= amountIn;
            totalVaultTEth += amountOut;
            emit Swapped(roundId, true, amountIn, amountOut);
        } else if (tEthValue > targetValue) {
            uint256 sell = Math.min(Math.mulDiv(tEthValue - targetValue, PRICE_DIVISOR, answer), totalVaultTEth);
            if (sell == 0) return (0, 0);
            uint256 expected = _valueOf(sell, answer);
            (amountIn, amountOut) = _swap(false, true, sell, Math.mulDiv(expected, BPS - maxSlippageBps, BPS));
            totalVaultTEth -= amountIn;
            totalVaultUsdc += amountOut;
            emit Swapped(roundId, false, amountIn, amountOut);
        }
    }

    // ------------------------------------------------------------------ pool access

    /// @dev `limit` is the minimum output for exact-input swaps and the maximum input for exact-output swaps.
    function _swap(bool usdcToTEth, bool exactIn, uint256 amount, uint256 limit)
        private
        returns (uint256 amountIn, uint256 amountOut)
    {
        bool zeroForOne = usdcToTEth == usdcIsCurrency0;
        bytes memory result = poolManager.unlock(abi.encode(zeroForOne, exactIn, amount, limit));
        (amountIn, amountOut) = abi.decode(result, (uint256, uint256));
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (bool zeroForOne, bool exactIn, uint256 amount, uint256 limit) = abi.decode(data, (bool, bool, uint256, uint256));
        PoolKey memory key = poolKey;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: exactIn ? -int256(amount) : int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        (int128 spent, int128 got) = zeroForOne ? (a0, a1) : (a1, a0);
        if (spent > 0 || got < 0) revert UnexpectedSwapDelta();
        uint256 amountIn = uint256(uint128(-spent));
        uint256 amountOut = uint256(uint128(got));
        if (exactIn) {
            if (amountIn < amount) revert SlippageBreached(amount, amountIn);
            if (amountOut < limit) revert SlippageBreached(limit, amountOut);
        } else {
            if (amountOut < amount) revert SlippageBreached(amount, amountOut);
            if (amountIn > limit) revert SlippageBreached(limit, amountIn);
        }
        Currency inCurrency = zeroForOne ? key.currency0 : key.currency1;
        Currency outCurrency = zeroForOne ? key.currency1 : key.currency0;
        poolManager.sync(inCurrency);
        IERC20(Currency.unwrap(inCurrency)).safeTransfer(address(poolManager), amountIn);
        poolManager.settle();
        poolManager.take(outCurrency, address(this), amountOut);
        return abi.encode(amountIn, amountOut);
    }

    // ------------------------------------------------------------------ helpers

    function _syncDeposit(address user) private {
        Request storage q = _depositRequests[user];
        uint256 amount = q.amount;
        uint256 epoch = q.epoch;
        if (amount == 0 || epoch >= currentEpoch) return;
        Epoch storage e = epochs[epoch];
        uint256 shares = amount == e.depositUsdcLeft
            ? e.depositSharesLeft
            : Math.mulDiv(amount, e.depositShares, e.depositUsdc);
        e.depositUsdcLeft -= amount;
        e.depositSharesLeft -= shares;
        delete _depositRequests[user];
        unclaimedDepositShares -= shares;
        _transfer(address(this), user, shares);
        emit DepositClaimed(user, epoch, amount, shares);
    }

    function _syncWithdraw(address user) private {
        Request storage q = _withdrawRequests[user];
        uint256 shares = q.amount;
        uint256 epoch = q.epoch;
        if (shares == 0 || epoch >= currentEpoch) return;
        Epoch storage e = epochs[epoch];
        uint256 amount = shares == e.withdrawSharesLeft
            ? e.withdrawUsdcLeft
            : Math.mulDiv(shares, e.withdrawUsdc, e.withdrawShares);
        e.withdrawSharesLeft -= shares;
        e.withdrawUsdcLeft -= amount;
        delete _withdrawRequests[user];
        emit WithdrawClaimed(user, epoch, shares, amount);
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (user, amount)));
        if (ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (uint256)) == 1))) {
            claimableUsdcTotal -= amount;
        } else {
            claimableUsdc[user] += amount;
            emit UsdcClaimable(user, amount);
        }
    }

    function _requireNoPendingReport() private view {
        uint256 u = unreportedRound;
        if (u != 0 && !_rounds[u].reported && quantumRound.roundStatus(u) == RoundStatus.Collapsed) {
            revert RoundPendingReport(u);
        }
    }

    function _latestAnswer() private view returns (uint256) {
        (int256 answer,) = oracle.latestPrice();
        return uint256(answer);
    }

    function _freshAnswer() private view returns (uint256) {
        return uint256(oracle.latestFreshPrice());
    }

    function _valueOf(uint256 tEthAmount, uint256 answer) private pure returns (uint256) {
        return Math.mulDiv(tEthAmount, answer, PRICE_DIVISOR);
    }

    function _bpsAt(uint256 answer) private view returns (uint256) {
        uint256 tEthValue = _valueOf(totalVaultTEth, answer);
        uint256 nav = totalVaultUsdc + tEthValue;
        return nav == 0 ? 0 : Math.mulDiv(tEthValue, BPS, nav);
    }
}
