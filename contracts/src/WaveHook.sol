// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IWaveHook} from "./interfaces/IWaveHook.sol";

/// @title WaveHook
/// @notice Shared Wavefund LONG/SHORT hook with adapter-only trading and final-window TWAPs.
/// @dev BaseHook validates the deployment address against permission bits 2752. Address mining
///      belongs exclusively in the off-chain deployment workflow. All operations are nonpayable.
/// @custom:upgrade-strategy immutable, not upgradeable
contract WaveHook is BaseHook, IWaveHook {
    using PoolIdLibrary for PoolKey;

    uint256 public constant MIN_PROBABILITY = 0.01e18;
    uint256 public constant MAX_PROBABILITY = 0.99e18;
    int24 public constant MIN_POSITION_TICK = -45900;
    int24 public constant MAX_POSITION_TICK = 45900;
    int24 public constant REQUIRED_TICK_SPACING = 60;
    uint24 public constant REQUIRED_POOL_FEE = 3000;

    uint256 private constant ONE = 1e18;
    uint256 private constant Q192 = 1 << 192;

    /// @inheritdoc IWaveHook
    address public immutable override adapter;

    mapping(PoolId id => PoolData data) private _pools;

    error ZeroAdapter();
    error ZeroPoolManager();
    error OnlyAdapter(address sender);
    error PoolAlreadyRegistered();
    error PoolNotRegistered();
    error InvalidHook();
    error InvalidPoolFee(uint24 actual, uint24 required);
    error InvalidTickSpacing(int24 actual, int24 required);
    error NativeCurrencyNotAllowed();
    error InvalidLongToken();
    error InvalidTradingWindow();
    error InvalidFinalWindow();
    error TradingNotOpen();
    error TradingNotEnded();
    error InvalidLiquidityDelta();
    error InvalidPositionTicks();
    error PriceOutOfRange();
    error ProbabilityOutOfBounds(uint256 pLongX18);

    /// @notice A pool's immutable market metadata and initial observation have been registered.
    event PoolRegistered(
        PoolId indexed id,
        uint256 indexed roundId,
        uint256 indexed proposalId,
        address longToken,
        uint64 tradingStart,
        uint64 tradingEnd,
        uint64 finalWindowSeconds,
        uint256 initialProbabilityX18
    );

    /// @notice Post-swap observation and integrals accumulated so far within the final window.
    event FinalWindowObservation(
        PoolId indexed id,
        uint256 timestamp,
        uint256 pLongX18,
        uint256 priceX18,
        uint256 cumulativeProbability,
        uint256 cumulativePrice
    );

    /// @param manager Uniswap v4 PoolManager used for callbacks and pool-state reads.
    /// @param adapter_ Sole authorized pool registrar and liquidity/swap initiator.
    constructor(IPoolManager manager, address adapter_) BaseHook(manager) {
        if (address(manager) == address(0)) revert ZeroPoolManager();
        if (adapter_ == address(0)) revert ZeroAdapter();
        adapter = adapter_;
    }

    /// @notice Only the four non-delta liquidity/trading permissions are enabled (2752).
    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeAddLiquidity = true;
        permissions.beforeRemoveLiquidity = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
    }

    /// @inheritdoc IWaveHook
    /// @dev Called before initialization; no slot0 read or initialization is performed here.
    ///      The initial observation represents the period from tradingStart until the first swap.
    function registerPool(
        PoolKey calldata key,
        uint256 roundId,
        uint256 proposalId,
        address longToken,
        uint64 tradingStart,
        uint64 tradingEnd,
        uint64 finalWindowSeconds,
        uint256 initialProbabilityX18
    ) external override {
        _requireAdapter(msg.sender);
        PoolId id = key.toId();
        PoolData storage data = _pools[id];
        if (data.registered) revert PoolAlreadyRegistered();
        if (address(key.hooks) != address(this)) revert InvalidHook();
        if (key.fee != REQUIRED_POOL_FEE) revert InvalidPoolFee(key.fee, REQUIRED_POOL_FEE);
        if (key.tickSpacing != REQUIRED_TICK_SPACING) revert InvalidTickSpacing(key.tickSpacing, REQUIRED_TICK_SPACING);
        if (Currency.unwrap(key.currency0) == address(0) || Currency.unwrap(key.currency1) == address(0)) {
            revert NativeCurrencyNotAllowed();
        }
        if (longToken != Currency.unwrap(key.currency0) && longToken != Currency.unwrap(key.currency1)) {
            revert InvalidLongToken();
        }
        if (tradingStart >= tradingEnd || tradingEnd <= block.timestamp) revert InvalidTradingWindow();
        if (finalWindowSeconds == 0 || finalWindowSeconds > tradingEnd - tradingStart) {
            revert InvalidFinalWindow();
        }
        _requireProbability(initialProbabilityX18);

        data.roundId = roundId;
        data.proposalId = proposalId;
        data.longToken = longToken;
        data.tradingStart = tradingStart;
        data.tradingEnd = tradingEnd;
        data.finalWindowSeconds = finalWindowSeconds;
        data.lastObservationTime = tradingStart;
        data.longIsCurrency0 = longToken == Currency.unwrap(key.currency0);
        data.registered = true;
        data.lastProbability = initialProbabilityX18;
        data.finalWindowCumulative = 0;
        data.lastPrice = FullMath.mulDiv(initialProbabilityX18, ONE, ONE - initialProbabilityX18);
        data.finalWindowCumulativePrice = 0;

        emit PoolRegistered(
            id, roundId, proposalId, longToken, tradingStart, tradingEnd, finalWindowSeconds, initialProbabilityX18
        );
    }

    /// @inheritdoc IWaveHook
    function isRegistered(PoolId id) external view override returns (bool) {
        return _pools[id].registered;
    }

    /// @inheritdoc IWaveHook
    function poolDetails(PoolId id) external view override returns (PoolData memory) {
        return _registeredPool(id);
    }

    /// @inheritdoc IWaveHook
    function pLong(PoolId id) public view override returns (uint256 probabilityX18) {
        (probabilityX18,) = _spot(id, _registeredPool(id));
    }

    /// @inheritdoc IWaveHook
    function pShort(PoolId id) external view override returns (uint256) {
        return ONE - pLong(id);
    }

    /// @inheritdoc IWaveHook
    function spotPriceX18(PoolId id) public view override returns (uint256 priceX18) {
        (, priceX18) = _spot(id, _registeredPool(id));
    }

    /// @inheritdoc IWaveHook
    /// @dev Extrapolates the last observation through tradingEnd, even before the window starts.
    function finalWindowTwap(PoolId id) external view override returns (uint256) {
        PoolData storage data = _registeredPool(id);
        return (data.finalWindowCumulative + data.lastProbability * _remainingSeconds(data)) / data.finalWindowSeconds;
    }

    /// @inheritdoc IWaveHook
    /// @dev This is a TWAP of prices, not a conversion of the probability TWAP into a price.
    function finalWindowPriceTwap(PoolId id) external view override returns (uint256) {
        PoolData storage data = _registeredPool(id);
        return (data.finalWindowCumulativePrice + data.lastPrice * _remainingSeconds(data)) / data.finalWindowSeconds;
    }

    /// @dev BaseHook's external entry point enforces onlyPoolManager.
    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata
    ) internal view override returns (bytes4) {
        _requireAdapter(sender);
        PoolData storage data = _registeredPool(key.toId());
        _requireTradingOpen(data);
        if (params.liquidityDelta <= 0) revert InvalidLiquidityDelta();
        if (
            params.tickLower < MIN_POSITION_TICK || params.tickUpper > MAX_POSITION_TICK
                || params.tickLower >= params.tickUpper
        ) revert InvalidPositionTicks();
        return BaseHook.beforeAddLiquidity.selector;
    }

    /// @dev Liquidity is locked until tradingEnd, inclusive of all earlier timestamps.
    function _beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata
    ) internal view override returns (bytes4) {
        _requireAdapter(sender);
        PoolData storage data = _registeredPool(key.toId());
        if (block.timestamp < data.tradingEnd) revert TradingNotEnded();
        if (params.liquidityDelta >= 0) revert InvalidLiquidityDelta();
        return BaseHook.beforeRemoveLiquidity.selector;
    }

    /// @dev Deliberate empty-pool repair path: with zero active liquidity, skip pre-swap bounds.
    ///      This lets the adapter restore a griefer-preinitialized empty pool to 1:1 at zero cost.
    ///      The post-swap checks are NEVER skipped, so even repairs must finish in bounds.
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _requireAdapter(sender);
        PoolId id = key.toId();
        PoolData storage data = _registeredPool(id);
        _requireTradingOpen(data);
        if (StateLibrary.getLiquidity(poolManager, id) != 0) {
            _spot(id, data);
        }
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @dev Integrates the PREVIOUS observation over the elapsed overlap, then records the new spot.
    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        _requireAdapter(sender);
        PoolId id = key.toId();
        PoolData storage data = _registeredPool(id);
        _requireTradingOpen(data);
        (uint256 probabilityX18, uint256 priceX18) = _spot(id, data);
        uint256 t = block.timestamp;
        uint256 fwStart = uint256(data.tradingEnd) - data.finalWindowSeconds;
        uint256 overlapStart = data.lastObservationTime > fwStart ? data.lastObservationTime : fwStart;
        uint256 overlapEnd = t < data.tradingEnd ? t : data.tradingEnd;
        if (overlapEnd > overlapStart) {
            uint256 elapsed = overlapEnd - overlapStart;
            data.finalWindowCumulative += data.lastProbability * elapsed;
            data.finalWindowCumulativePrice += data.lastPrice * elapsed;
        }
        // Trading-open validation ensures t < tradingEnd <= type(uint64).max.
        data.lastObservationTime = uint64(t);
        data.lastProbability = probabilityX18;
        data.lastPrice = priceX18;
        if (t >= fwStart) {
            emit FinalWindowObservation(
                id, t, probabilityX18, priceX18, data.finalWindowCumulative, data.finalWindowCumulativePrice
            );
        }
        return (BaseHook.afterSwap.selector, 0);
    }

    /// @dev Compare sqrt prices, not slot0.tick: downward boundary crossings may report tick-1.
    ///      The checked sqrt-price interval makes squaring and adding Q192 safe in uint256.
    function _spot(PoolId id, PoolData storage data)
        private
        view
        returns (uint256 probabilityX18, uint256 priceX18)
    {
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(poolManager, id);
        if (
            sqrtPriceX96 < TickMath.getSqrtPriceAtTick(MIN_POSITION_TICK)
                || sqrtPriceX96 > TickMath.getSqrtPriceAtTick(MAX_POSITION_TICK)
        ) revert PriceOutOfRange();

        uint256 priceX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        if (data.longIsCurrency0) {
            probabilityX18 = FullMath.mulDiv(priceX192, ONE, priceX192 + Q192);
            priceX18 = FullMath.mulDiv(priceX192, ONE, Q192);
        } else {
            probabilityX18 = FullMath.mulDiv(Q192, ONE, priceX192 + Q192);
            priceX18 = FullMath.mulDiv(Q192, ONE, priceX192);
        }
        _requireProbability(probabilityX18);
    }

    function _registeredPool(PoolId id) private view returns (PoolData storage data) {
        data = _pools[id];
        if (!data.registered) revert PoolNotRegistered();
    }

    function _requireAdapter(address sender) private view {
        if (sender != adapter) revert OnlyAdapter(sender);
    }

    function _requireTradingOpen(PoolData storage data) private view {
        if (block.timestamp < data.tradingStart || block.timestamp >= data.tradingEnd) revert TradingNotOpen();
    }

    function _requireProbability(uint256 probabilityX18) private pure {
        if (probabilityX18 < MIN_PROBABILITY || probabilityX18 > MAX_PROBABILITY) {
            revert ProbabilityOutOfBounds(probabilityX18);
        }
    }

    function _remainingSeconds(PoolData storage data) private view returns (uint256) {
        uint256 fwStart = uint256(data.tradingEnd) - data.finalWindowSeconds;
        uint256 start = data.lastObservationTime > fwStart ? data.lastObservationTime : fwStart;
        return start < data.tradingEnd ? data.tradingEnd - start : 0;
    }
}
