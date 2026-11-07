// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IImmutableState} from "@uniswap/v4-periphery/src/interfaces/IImmutableState.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapMath} from "@uniswap/v4-core/src/libraries/SwapMath.sol";
import {ProtocolFeeLibrary} from "@uniswap/v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {IProposalMarket} from "./interfaces/IProposalMarket.sol";
import {IQuantumRound} from "./interfaces/IQuantumRound.sol";
import {IWaveHook} from "./interfaces/IWaveHook.sol";
import {ProposalTokens} from "./ProposalTokens.sol";

/// @title WaveV4ProposalMarket
/// @notice Push-funded LONG/SHORT complete-set market with one immutable-range v4 position per proposal.
/// @dev QuantumRound supplies all tokens before calls and performs all minting/burning outside this adapter.
///      The adapter enforces push funding: only balances above each market's held balances may fund a trade.
///      Held balances protect idle seed inventory, pending sell remainders, and surplus absorbed after trades.
///      InsufficientPushedTokens reports the first underfunded leg; unsolicited surplus is absorbed after a trade
///      and all remaining tokens are returned at finalization.
///      The hook exclusively authorizes this adapter's swaps and liquidity changes. No native currency is used.
/// @custom:upgrade-strategy immutable
contract WaveV4ProposalMarket is IProposalMarket, IUnlockCallback, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using ProtocolFeeLibrary for uint24;
    using ProtocolFeeLibrary for uint16;

    uint256 public constant COMPLETE_SET_SCALE = 1e12;
    int24 private constant LOWER_TICK = -45900;
    int24 private constant UPPER_TICK = 45900;
    int24 private constant TICK_SPACING = 60;
    uint160 private constant INITIAL_SQRT_PRICE = uint160(1 << 96);

    IPoolManager public immutable poolManager;
    ProposalTokens public immutable proposalTokens;
    address public quantumRound;
    address public waveHook;

    struct PendingSell {
        bool active;
        uint256 credits;
        uint256 longDust;
        uint256 shortDust;
    }

    struct Market {
        PoolKey key;
        PoolId id;
        address longToken;
        address shortToken;
        bool longIsCurrency0;
        uint128 positionLiquidity;
        bool seeded;
        bool finalized;
        uint64 tradingStart;
        uint64 tradingEnd;
        PendingSell pending;
        bool closed;
        uint256 pLongTwap;
        uint256 priceTwap;
        /// @dev Accounted idle inventory, pending sell remainders, and absorbed surplus, in token units.
        uint256 heldLong;
        uint256 heldShort;
    }

    enum Action { SWAP, ADD, REMOVE, REPAIR }

    struct CallbackData {
        Action action;
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        uint160 sqrtPriceLimitX96;
        uint128 liquidity;
    }

    struct Simulation {
        uint160 price;
        int24 tick;
        uint128 liquidity;
        uint24 swapFee;
    }

    struct Step {
        uint160 startPrice;
        int24 nextTick;
        bool initialized;
        uint160 nextPrice;
        uint256 amountIn;
        uint256 amountOut;
        uint256 fee;
    }

    struct SellResult {
        uint256 swapInput;
        uint256 swapOutput;
        uint256 credits;
        uint256 longDust;
        uint256 shortDust;
    }

    mapping(uint256 roundId => mapping(uint256 proposalId => Market)) private _markets;

    error ZeroAddress();
    error ZeroAmount();
    error AlreadyWired();
    error WiringIncomplete();
    error InvalidHookAdapter();
    error InvalidQuantumRound(address round);
    error QuantumRoundMarketMismatch(address market);
    error OwnershipLocked();
    error NotQuantumRound();
    error NotPoolManager();
    error MarketNotFound(uint256 roundId, uint256 proposalId);
    error MarketNotSeeded(uint256 roundId, uint256 proposalId);
    error AlreadySeeded(uint256 roundId, uint256 proposalId);
    error AlreadyFinalized(uint256 roundId, uint256 proposalId);
    error PoolNotEmpty();
    error Slippage(uint256 minRequired, uint256 actual);
    error InsufficientDepth(uint256 requestedIn, uint256 consumedIn);
    error PendingRemainder(uint256 roundId, uint256 proposalId);
    error NoPendingSettlement(uint256 roundId, uint256 proposalId);
    error TradingNotEnded();
    error TradingClosed(uint64 start, uint64 end, uint256 currentTime);
    error CreditDecimalsMismatch(uint8 actual);
    error SolverDidNotConverge();
    error HookPoolManagerMismatch(address hookManager);
    error UnexpectedSwapDelta(int256 expected, int256 actual);
    error UnexpectedRepairDelta();
    error UnexpectedCallback();
    /// @notice Newly pushed tokens on the first failing leg do not cover the required trade or seed amount.
    error InsufficientPushedTokens(uint256 roundId, uint256 proposalId, uint256 needed, uint256 received);
    /// @notice A token balance fell below the market's accounted inventory.
    error AccountingViolation(uint256 roundId, uint256 proposalId);

    event QuantumRoundSet(address indexed quantumRound);
    event WaveHookSet(address indexed waveHook);
    event MarketSeeded(uint256 indexed roundId, uint256 indexed proposalId, PoolId indexed poolId, uint256 credits, uint128 liquidity);
    /// @dev Buy: amountIn is credits and amountOut is tokens. Sell: amountIn is tokens and amountOut is credits.
    event Trade(uint256 indexed roundId, uint256 indexed proposalId, bool isBuy, bool isLong, uint256 amountIn, uint256 amountOut, address recipient);
    event SellSettlementConsumed(uint256 indexed roundId, uint256 indexed proposalId, address indexed seller, uint256 credits, uint256 longDust, uint256 shortDust);
    event TwapWindowClosed(uint256 indexed roundId, uint256 indexed proposalId, uint256 pLongTwap, uint256 priceTwap);
    event ProposalFinalized(uint256 indexed roundId, uint256 indexed proposalId, uint256 longReturned, uint256 shortReturned);

    constructor(IPoolManager poolManager_, ProposalTokens proposalTokens_, address initialOwner) Ownable(initialOwner) {
        if (address(poolManager_) == address(0) || address(proposalTokens_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        proposalTokens = proposalTokens_;
    }

    modifier onlyQuantumRound() {
        if (msg.sender != quantumRound) revert NotQuantumRound();
        _;
    }

    /// @notice Sets the sole trading controller once; completes ownership handoff when both wires exist.
    function setQuantumRound(address round) external onlyOwner {
        if (quantumRound != address(0)) revert AlreadyWired();
        if (round == address(0)) revert ZeroAddress();
        if (round.code.length == 0) revert InvalidQuantumRound(round);
        (bool ok, bytes memory result) = round.staticcall(abi.encodeWithSignature("market()"));
        if (!ok || result.length < 32) revert InvalidQuantumRound(round);
        address boundMarket = abi.decode(result, (address));
        if (boundMarket != address(this)) revert QuantumRoundMarketMismatch(boundMarket);
        quantumRound = round;
        emit QuantumRoundSet(round);
        _finishWiring();
    }

    /// @notice Sets the shared hook once, checking its immutable adapter binding.
    function setWaveHook(address hook) external onlyOwner {
        if (waveHook != address(0)) revert AlreadyWired();
        if (hook == address(0)) revert ZeroAddress();
        if (IWaveHook(hook).adapter() != address(this)) revert InvalidHookAdapter();
        address hookManager = address(IImmutableState(hook).poolManager());
        if (hookManager != address(poolManager)) revert HookPoolManagerMismatch(hookManager);
        waveHook = hook;
        emit WaveHookSet(hook);
        _finishWiring();
    }

    /// @notice Explicitly disabled: ownership can move only through the automatic wiring handoff.
    function transferOwnership(address) public pure override { revert OwnershipLocked(); }

    /// @notice Explicitly disabled so wiring cannot be abandoned or the handoff undone.
    function renounceOwnership() public pure override { revert OwnershipLocked(); }

    /// @inheritdoc IProposalMarket
    function completeSetScale() external pure override returns (uint256) { return COMPLETE_SET_SCALE; }

    /// @inheritdoc IProposalMarket
    function seedLiquidity(uint256 roundId, uint256 proposalId, uint256 creditAmount)
        external override onlyQuantumRound nonReentrant
    {
        if (waveHook == address(0)) revert WiringIncomplete();
        if (creditAmount == 0) revert ZeroAmount();
        uint8 decimals = proposalTokens.creditDecimals();
        if (decimals != 6) revert CreditDecimalsMismatch(decimals);
        Market storage m = _markets[roundId][proposalId];
        if (m.seeded) revert AlreadySeeded(roundId, proposalId);
        address long_ = proposalTokens.longToken(roundId, proposalId);
        address short_ = proposalTokens.shortToken(roundId, proposalId);
        if (long_ == address(0) || short_ == address(0)) revert MarketNotFound(roundId, proposalId);
        m.longToken = long_;
        m.shortToken = short_;
        uint256 needed = creditAmount * COMPLETE_SET_SCALE;
        _requirePushed(m, roundId, proposalId, needed, needed);
        m.longIsCurrency0 = long_ < short_;
        m.key = PoolKey({
            currency0: Currency.wrap(m.longIsCurrency0 ? long_ : short_),
            currency1: Currency.wrap(m.longIsCurrency0 ? short_ : long_),
            fee: 3000,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(waveHook)
        });
        m.id = m.key.toId();
        (uint64 start, uint64 end, uint64 window) = IQuantumRound(quantumRound).marketTiming(roundId, proposalId);
        m.tradingStart = start;
        m.tradingEnd = end;
        IWaveHook(waveHook).registerPool(m.key, roundId, proposalId, long_, start, end, window, 0.5e18);
        _initialize(m);
        // Deliberately use complete-set notional as L, NOT the liquidity for depositing every supplied token.
        // modifyLiquidity computes rounded-up LiquidityAmounts-style debts; unused sets remain idle until finalization.
        uint128 liquidity = (creditAmount * COMPLETE_SET_SCALE).toUint128();
        m.positionLiquidity = liquidity;
        poolManager.unlock(abi.encode(CallbackData(Action.ADD, m.key, false, 0, 0, liquidity)));
        _sync(m);
        m.seeded = true;
        emit MarketSeeded(roundId, proposalId, m.id, creditAmount, liquidity);
    }

    /// @inheritdoc IProposalMarket
    function tradeBuyLong(uint256 r, uint256 p, uint256 credits, uint256 minOut, address to)
        external override onlyQuantumRound nonReentrant returns (uint256)
    { return _buy(r, p, credits, minOut, to, true); }

    /// @inheritdoc IProposalMarket
    function tradeBuyShort(uint256 r, uint256 p, uint256 credits, uint256 minOut, address to)
        external override onlyQuantumRound nonReentrant returns (uint256)
    { return _buy(r, p, credits, minOut, to, false); }

    /// @inheritdoc IProposalMarket
    function tradeSellLong(uint256 r, uint256 p, uint256 amountIn, uint256 minCreditsOut)
        external override onlyQuantumRound nonReentrant returns (uint256)
    { return _sell(r, p, amountIn, minCreditsOut, true); }

    /// @inheritdoc IProposalMarket
    function tradeSellShort(uint256 r, uint256 p, uint256 amountIn, uint256 minCreditsOut)
        external override onlyQuantumRound nonReentrant returns (uint256)
    { return _sell(r, p, amountIn, minCreditsOut, false); }

    /// @inheritdoc IProposalMarket
    function consumeSellSettlement(uint256 r, uint256 p, address seller)
        external override onlyQuantumRound nonReentrant returns (uint256 credits, uint256 longDust, uint256 shortDust)
    {
        if (seller == address(0)) revert ZeroAddress();
        Market storage m = _seededMarket(r, p);
        PendingSell memory pending = m.pending;
        if (!pending.active) revert NoPendingSettlement(r, p);
        delete m.pending;
        uint256 burnAmount = pending.credits * COMPLETE_SET_SCALE;
        _transfer(m.longToken, msg.sender, burnAmount);
        _transfer(m.shortToken, msg.sender, burnAmount);
        _transfer(m.longToken, seller, pending.longDust);
        _transfer(m.shortToken, seller, pending.shortDust);
        m.heldLong -= burnAmount + pending.longDust;
        m.heldShort -= burnAmount + pending.shortDust;
        emit SellSettlementConsumed(r, p, seller, pending.credits, pending.longDust, pending.shortDust);
        return (pending.credits, pending.longDust, pending.shortDust);
    }

    /// @inheritdoc IProposalMarket
    function finalizeProposal(uint256 r, uint256 p) external override onlyQuantumRound nonReentrant {
        Market storage m = _liveMarket(r, p);
        if (block.timestamp < m.tradingEnd) revert TradingNotEnded();
        if (m.pending.active) revert PendingRemainder(r, p);
        m.finalized = true;
        uint128 liquidity = m.positionLiquidity;
        m.positionLiquidity = 0;
        poolManager.unlock(abi.encode(CallbackData(Action.REMOVE, m.key, false, 0, 0, liquidity)));
        uint256 longBalance = IERC20(m.longToken).balanceOf(address(this));
        uint256 shortBalance = IERC20(m.shortToken).balanceOf(address(this));
        _transfer(m.longToken, msg.sender, longBalance);
        _transfer(m.shortToken, msg.sender, shortBalance);
        m.heldLong = 0;
        m.heldShort = 0;
        emit ProposalFinalized(r, p, longBalance, shortBalance);
    }

    /// @notice Returns accounted LONG/SHORT inventory in token units, excluding unabsorbed pushes.
    /// @dev Includes idle seed inventory, pending sell remainders, and surplus absorbed after trades.
    ///      Uses the seeded-market validation shared by other market views; finalized markets return zero.
    function accountedBalances(uint256 r, uint256 p) external view returns (uint256 longHeld, uint256 shortHeld) {
        Market storage m = _seededMarket(r, p);
        return (m.heldLong, m.heldShort);
    }

    /// @notice Quotes all LONG received, including the unswapped complete-set leg.
    function quoteBuyLong(uint256 r, uint256 p, uint256 credits) external view returns (uint256) {
        return _quoteBuy(_quotableMarket(r, p), credits, true);
    }

    /// @notice Quotes all SHORT received, including the unswapped complete-set leg.
    function quoteBuyShort(uint256 r, uint256 p, uint256 credits) external view returns (uint256) {
        return _quoteBuy(_quotableMarket(r, p), credits, false);
    }

    /// @notice Quotes the identical bounded bisection and dust rounding used by a LONG sale.
    function quoteSellLong(uint256 r, uint256 p, uint256 amountIn)
        external view returns (uint256 creditsOut, uint256 longDust, uint256 shortDust)
    {
        Market storage m = _quotableMarket(r, p);
        if (m.pending.active) revert PendingRemainder(r, p);
        SellResult memory result = _solveSell(m, amountIn, true);
        return (result.credits, result.longDust, result.shortDust);
    }

    /// @notice Quotes the identical bounded bisection and dust rounding used by a SHORT sale.
    function quoteSellShort(uint256 r, uint256 p, uint256 amountIn)
        external view returns (uint256 creditsOut, uint256 longDust, uint256 shortDust)
    {
        Market storage m = _quotableMarket(r, p);
        if (m.pending.active) revert PendingRemainder(r, p);
        SellResult memory result = _solveSell(m, amountIn, false);
        return (result.credits, result.longDust, result.shortDust);
    }

    /// @inheritdoc IProposalMarket
    function probabilities(uint256 r, uint256 p) external view override returns (uint256 pLong, uint256 pShort) {
        PoolId id = _seededMarket(r, p).id;
        return (IWaveHook(waveHook).pLong(id), IWaveHook(waveHook).pShort(id));
    }

    /// @inheritdoc IProposalMarket
    function spotPrice(uint256 r, uint256 p) external view override returns (uint256) {
        return IWaveHook(waveHook).spotPriceX18(_seededMarket(r, p).id);
    }

    /// @inheritdoc IProposalMarket
    function probabilityTwap(uint256 r, uint256 p) external view override returns (uint256) {
        Market storage m = _seededMarket(r, p);
        return m.closed ? m.pLongTwap : IWaveHook(waveHook).finalWindowTwap(m.id);
    }

    /// @inheritdoc IProposalMarket
    function twap(uint256 r, uint256 p) external view override returns (uint256) {
        Market storage m = _seededMarket(r, p);
        return m.closed ? m.priceTwap : IWaveHook(waveHook).finalWindowPriceTwap(m.id);
    }

    /// @inheritdoc IProposalMarket
    function closeTwapWindow(uint256 r, uint256 p)
        external override nonReentrant returns (uint256 pLongTwapX18, uint256 priceTwapX18)
    {
        Market storage m = _seededMarket(r, p);
        if (block.timestamp < m.tradingEnd) revert TradingNotEnded();
        if (!m.closed) {
            m.pLongTwap = IWaveHook(waveHook).finalWindowTwap(m.id);
            m.priceTwap = IWaveHook(waveHook).finalWindowPriceTwap(m.id);
            m.closed = true;
            emit TwapWindowClosed(r, p, m.pLongTwap, m.priceTwap);
        }
        return (m.pLongTwap, m.priceTwap);
    }

    /// @notice Executes an adapter-initiated unlock and nets both ERC20 currency deltas without native value.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_reentrancyGuardEntered()) revert UnexpectedCallback();
        CallbackData memory c = abi.decode(data, (CallbackData));
        BalanceDelta delta;
        if (c.action == Action.SWAP || c.action == Action.REPAIR) {
            delta = poolManager.swap(c.key, SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: -c.amountIn.toInt256(),
                sqrtPriceLimitX96: c.sqrtPriceLimitX96
            }), "");
            if (c.action == Action.REPAIR && BalanceDelta.unwrap(delta) != 0) revert UnexpectedRepairDelta();
        } else {
            int256 change = int256(uint256(c.liquidity));
            if (c.action == Action.REMOVE) change = -change;
            // callerDelta already includes feesAccrued; never add the second return value again.
            (delta,) = poolManager.modifyLiquidity(c.key, ModifyLiquidityParams({
                tickLower: LOWER_TICK, tickUpper: UPPER_TICK, liquidityDelta: change, salt: bytes32(0)
            }), "");
        }
        _settleOrTake(c.key.currency0, delta.amount0());
        _settleOrTake(c.key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _finishWiring() private {
        if (quantumRound != address(0) && waveHook != address(0)) _transferOwnership(quantumRound);
    }

    function _initialize(Market storage m) private {
        try poolManager.initialize(m.key, INITIAL_SQRT_PRICE) returns (int24) {} catch (bytes memory reason) {
            (uint160 price,,,) = poolManager.getSlot0(m.id);
            // Only tolerate an existing pool, not a failed first initialization (e.g. invalid hook flags).
            if (price == 0) {
                assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
            }
            if (poolManager.getLiquidity(m.id) != 0) revert PoolNotEmpty();
            if (price != INITIAL_SQRT_PRICE) {
                poolManager.unlock(abi.encode(CallbackData(
                    Action.REPAIR, m.key, price > INITIAL_SQRT_PRICE, 1, INITIAL_SQRT_PRICE, 0
                )));
                (uint160 repaired,,,) = poolManager.getSlot0(m.id);
                if (repaired != INITIAL_SQRT_PRICE) revert UnexpectedRepairDelta();
            }
        }
    }

    function _buy(uint256 r, uint256 p, uint256 credits, uint256 minOut, address to, bool buyLong)
        private returns (uint256 totalOut)
    {
        if (to == address(0)) revert ZeroAddress();
        Market storage m = _liveMarket(r, p);
        uint256 input = credits * COMPLETE_SET_SCALE;
        _requirePushed(m, r, p, input, input);
        uint256 heldLongBefore = m.heldLong;
        uint256 heldShortBefore = m.heldShort;
        totalOut = _quoteBuy(m, credits, buyLong);
        if (totalOut < minOut) revert Slippage(minOut, totalOut);
        bool zeroForOne = buyLong != m.longIsCurrency0;
        uint256 output = _executeSwap(m, zeroForOne, input);
        if (output != totalOut - input) revert UnexpectedSwapDelta((totalOut - input).toInt256(), output.toInt256());
        _transfer(buyLong ? m.longToken : m.shortToken, to, totalOut);
        if (IERC20(m.longToken).balanceOf(address(this)) < heldLongBefore
            || IERC20(m.shortToken).balanceOf(address(this)) < heldShortBefore) revert AccountingViolation(r, p);
        _sync(m);
        emit Trade(r, p, true, buyLong, credits, totalOut, to);
    }

    function _quoteBuy(Market storage m, uint256 credits, bool buyLong) private view returns (uint256) {
        if (credits == 0) revert ZeroAmount();
        uint256 input = credits * COMPLETE_SET_SCALE;
        (uint256 consumed, uint256 output) = _simulate(m, _simulationState(m, buyLong != m.longIsCurrency0), buyLong != m.longIsCurrency0, input);
        if (consumed != input) revert InsufficientDepth(input, consumed);
        return input + output;
    }

    function _sell(uint256 r, uint256 p, uint256 amountIn, uint256 minCredits, bool sellLong)
        private returns (uint256)
    {
        Market storage m = _liveMarket(r, p);
        if (m.pending.active) revert PendingRemainder(r, p);
        _requirePushed(m, r, p, sellLong ? amountIn : 0, sellLong ? 0 : amountIn);
        uint256 heldLongBefore = m.heldLong;
        uint256 heldShortBefore = m.heldShort;
        SellResult memory result = _solveSell(m, amountIn, sellLong);
        if (result.credits < minCredits) revert Slippage(minCredits, result.credits);
        uint256 output = _executeSwap(m, sellLong == m.longIsCurrency0, result.swapInput);
        if (output != result.swapOutput) revert UnexpectedSwapDelta(result.swapOutput.toInt256(), output.toInt256());
        m.pending = PendingSell(true, result.credits, result.longDust, result.shortDust);
        if (IERC20(m.longToken).balanceOf(address(this)) < heldLongBefore
            || IERC20(m.shortToken).balanceOf(address(this)) < heldShortBefore) revert AccountingViolation(r, p);
        _sync(m);
        emit Trade(r, p, false, sellLong, amountIn, result.credits, msg.sender);
        return result.credits;
    }

    function _solveSell(Market storage m, uint256 amountIn, bool sellLong) private view returns (SellResult memory result) {
        if (amountIn == 0) revert ZeroAmount();
        bool zeroForOne = sellLong == m.longIsCurrency0;
        Simulation memory initial = _simulationState(m, zeroForOne);
        uint256 lo;
        uint256 hi = amountIn;
        for (uint256 i; hi - lo > 1e6 && i < 64; ++i) {
            uint256 mid = lo + (hi - lo) / 2;
            (uint256 consumed, uint256 output) = _simulate(m, initial, zeroForOne, mid);
            // Equivalent to output + consumed >= amountIn without overflowing the sum.
            if (output >= amountIn - consumed) hi = mid;
            else lo = mid;
        }
        if (hi - lo > 1e6) revert SolverDidNotConverge();
        result.swapInput = hi;
        (uint256 used, uint256 out) = _simulate(m, initial, zeroForOne, hi);
        if (used != hi) revert InsufficientDepth(hi, used);
        result.swapOutput = out;
        uint256 remaining = amountIn - hi;
        uint256 matched = remaining < out ? remaining : out;
        result.credits = matched / COMPLETE_SET_SCALE;
        uint256 burnAmount = result.credits * COMPLETE_SET_SCALE;
        uint256 soldDust = remaining - burnAmount;
        uint256 otherDust = out - burnAmount;
        result.longDust = sellLong ? soldDust : otherDust;
        result.shortDust = sellLong ? otherDust : soldDust;
    }

    function _executeSwap(Market storage m, bool zeroForOne, uint256 amountIn) private returns (uint256 output) {
        (uint160 price,,,) = poolManager.getSlot0(m.id);
        uint160 limit = _priceLimit(zeroForOne);
        if (price == limit) revert InsufficientDepth(amountIn, 0);
        BalanceDelta delta = abi.decode(poolManager.unlock(abi.encode(CallbackData(
            Action.SWAP, m.key, zeroForOne, amountIn, limit, 0
        ))), (BalanceDelta));
        int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
        if (inputDelta > 0) revert UnexpectedSwapDelta(-amountIn.toInt256(), int256(inputDelta));
        if (outputDelta < 0) revert UnexpectedSwapDelta(0, int256(outputDelta));
        if (uint256(-int256(inputDelta)) != amountIn) revert InsufficientDepth(amountIn, uint256(-int256(inputDelta)));
        output = uint256(int256(outputDelta));
    }

    function _simulationState(Market storage m, bool zeroForOne) private view returns (Simulation memory s) {
        uint24 protocolFee;
        uint24 lpFee;
        (s.price, s.tick, protocolFee, lpFee) = poolManager.getSlot0(m.id);
        s.liquidity = poolManager.getLiquidity(m.id);
        uint16 directional = zeroForOne ? protocolFee.getZeroForOneFee() : protocolFee.getOneForZeroFee();
        s.swapFee = directional == 0 ? lpFee : directional.calculateSwapFee(lpFee);
    }

    /// @dev Replays Pool.swap, including empty bitmap-word steps and their independent fee/output rounding.
    ///      Copy scalar state explicitly: internal memory arguments alias; each bisection must start at LIVE state.
    function _simulate(Market storage m, Simulation memory initial, bool zeroForOne, uint256 amount)
        private view returns (uint256 consumed, uint256 output)
    {
        Simulation memory s = Simulation(initial.price, initial.tick, initial.liquidity, initial.swapFee);
        uint160 limit = _priceLimit(zeroForOne);
        uint256 remaining = amount;
        // Same signed exact-input domain as Pool.swap; rejects unsafe uint-to-int conversions.
        amount.toInt256();
        while (remaining != 0 && s.price != limit) {
            Step memory step;
            step.startPrice = s.price;
            (step.nextTick, step.initialized) = _nextTick(s.tick, zeroForOne);
            if (step.nextTick <= TickMath.MIN_TICK) step.nextTick = TickMath.MIN_TICK;
            if (step.nextTick >= TickMath.MAX_TICK) step.nextTick = TickMath.MAX_TICK;
            step.nextPrice = TickMath.getSqrtPriceAtTick(step.nextTick);
            (s.price, step.amountIn, step.amountOut, step.fee) = SwapMath.computeSwapStep(
                s.price, SwapMath.getSqrtPriceTarget(zeroForOne, step.nextPrice, limit),
                s.liquidity, -remaining.toInt256(), s.swapFee
            );
            uint256 used = step.amountIn + step.fee;
            remaining -= used;
            consumed += used;
            output += step.amountOut;
            if (s.price == step.nextPrice) {
                if (step.initialized) {
                    // Lower liquidityNet = +L; upper liquidityNet = -L. Reverse the sign going left.
                    bool addLiquidity = (step.nextTick == LOWER_TICK) != zeroForOne;
                    if (addLiquidity) s.liquidity += m.positionLiquidity;
                    else s.liquidity -= m.positionLiquidity;
                }
                s.tick = zeroForOne ? step.nextTick - 1 : step.nextTick;
            } else if (s.price != step.startPrice) {
                s.tick = TickMath.getTickAtSqrtPrice(s.price);
            }
        }
        // Pool.swap packs both returned deltas as int128; quotes must respect the same domain.
        SafeCast.toInt128(consumed.toInt256());
        SafeCast.toInt128(output.toInt256());
    }

    /// @dev Analytic nextInitializedTickWithinOneWord for exactly {-765, 765} compressed ticks.
    ///      Lower: word -3 / bit 3. Upper: word 2 / bit 253. Empty words are NOT skipped.
    function _nextTick(int24 tick, bool zeroForOne) private pure returns (int24 next, bool initialized) {
        int24 compressed = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) --compressed;
        if (zeroForOne) {
            int24 wordStart = (compressed >> 8) * 256;
            if (compressed >= 765 && wordStart <= 765) return (UPPER_TICK, true);
            if (compressed >= -765 && wordStart <= -765) return (LOWER_TICK, true);
            return (wordStart * TICK_SPACING, false);
        }
        ++compressed;
        int24 wordEnd = (compressed >> 8) * 256 + 255;
        if (compressed <= -765 && wordEnd >= -765) return (LOWER_TICK, true);
        if (compressed <= 765 && wordEnd >= 765) return (UPPER_TICK, true);
        return (wordEnd * TICK_SPACING, false);
    }

    function _priceLimit(bool zeroForOne) private pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(zeroForOne ? LOWER_TICK : UPPER_TICK);
    }

    function _settleOrTake(Currency currency, int128 delta) private {
        address token = Currency.unwrap(currency);
        if (token == address(0)) revert ZeroAddress();
        if (delta < 0) {
            uint256 amount = uint256(-int256(delta));
            poolManager.sync(currency);
            IERC20(token).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        } else if (delta > 0) {
            poolManager.take(currency, address(this), uint256(int256(delta)));
        }
    }

    /// @dev IDs are supplied because Market does not store them, so accounting errors identify the market.
    function _pushed(Market storage m, uint256 r, uint256 p)
        private view returns (uint256 pushedLong, uint256 pushedShort)
    {
        uint256 longBalance = IERC20(m.longToken).balanceOf(address(this));
        uint256 shortBalance = IERC20(m.shortToken).balanceOf(address(this));
        if (longBalance < m.heldLong || shortBalance < m.heldShort) revert AccountingViolation(r, p);
        return (longBalance - m.heldLong, shortBalance - m.heldShort);
    }

    function _requirePushed(Market storage m, uint256 r, uint256 p, uint256 neededLong, uint256 neededShort)
        private view
    {
        (uint256 pushedLong, uint256 pushedShort) = _pushed(m, r, p);
        if (neededLong > 0 && pushedLong < neededLong) revert InsufficientPushedTokens(r, p, neededLong, pushedLong);
        if (neededShort > 0 && pushedShort < neededShort) revert InsufficientPushedTokens(r, p, neededShort, pushedShort);
    }

    /// @dev Absorbs surplus into protected inventory; finalization returns the entire balance.
    function _sync(Market storage m) private {
        m.heldLong = IERC20(m.longToken).balanceOf(address(this));
        m.heldShort = IERC20(m.shortToken).balanceOf(address(this));
    }

    function _transfer(address token, address to, uint256 amount) private {
        if (amount != 0) IERC20(token).safeTransfer(to, amount);
    }

    function _seededMarket(uint256 r, uint256 p) private view returns (Market storage m) {
        m = _markets[r][p];
        if (!m.seeded) revert MarketNotSeeded(r, p);
    }

    function _liveMarket(uint256 r, uint256 p) private view returns (Market storage m) {
        m = _seededMarket(r, p);
        if (m.finalized) revert AlreadyFinalized(r, p);
    }

    function _quotableMarket(uint256 r, uint256 p) private view returns (Market storage m) {
        m = _seededMarket(r, p);
        if (block.timestamp < m.tradingStart || block.timestamp >= m.tradingEnd) {
            revert TradingClosed(m.tradingStart, m.tradingEnd, block.timestamp);
        }
        if (m.finalized) revert AlreadyFinalized(r, p);
    }
}
