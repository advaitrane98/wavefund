// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title WavefundPoolHelper
/// @notice Owner-only Uniswap v4 unlock-callback contract for the vault's USDC/tETH pool (no hook, fee 3000,
///         spacing 60). The owner initialises the pool, adds and removes a concentrated position, and performs
///         alignment swaps. It never holds funds: owed tokens are pulled from the owner (who must approve this
///         contract) straight into the PoolManager, and everything owed to the owner is sent straight to the owner.
/// @custom:upgrade-strategy Immutable, non-upgradeable code; ownership is the only administrative surface.
contract WavefundPoolHelper is Ownable, IUnlockCallback {
    using SafeERC20 for IERC20;

    enum Action {
        MODIFY,
        SWAP
    }

    IPoolManager public immutable poolManager;
    PoolKey public poolKey;

    error NotPoolManager();
    error InvalidAsset();
    error ZeroAddress();

    event PoolInitialized(uint160 sqrtPriceX96, int24 tick);
    event LiquidityModified(int24 tickLower, int24 tickUpper, int256 liquidityDelta, int256 amount0, int256 amount1);
    event Swapped(bool zeroForOne, int256 amount0, int256 amount1);

    constructor(address owner_, IPoolManager poolManager_, IERC20 usdc, IERC20 tEth) Ownable(owner_) {
        if (address(poolManager_) == address(0) || address(usdc) == address(0) || address(tEth) == address(0)) {
            revert ZeroAddress();
        }
        if (address(usdc) == address(tEth)) revert InvalidAsset();
        poolManager = poolManager_;
        bool usdc0 = address(usdc) < address(tEth);
        poolKey = PoolKey({
            currency0: Currency.wrap(usdc0 ? address(usdc) : address(tEth)),
            currency1: Currency.wrap(usdc0 ? address(tEth) : address(usdc)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }

    /// @notice Initialises the pool at `sqrtPriceX96` (reverts if it already exists).
    function initializePool(uint160 sqrtPriceX96) external onlyOwner returns (int24 tick) {
        tick = poolManager.initialize(poolKey, sqrtPriceX96);
        emit PoolInitialized(sqrtPriceX96, tick);
    }

    /// @notice Adds (positive) or removes (negative) liquidity for this helper's position at the given ticks.
    /// @return amount0 Owner's balance change in currency0 (negative = paid by the owner).
    /// @return amount1 Owner's balance change in currency1.
    function modifyLiquidity(int24 tickLower, int24 tickUpper, int256 liquidityDelta)
        external
        onlyOwner
        returns (int256 amount0, int256 amount1)
    {
        bytes memory result =
            poolManager.unlock(abi.encode(Action.MODIFY, abi.encode(tickLower, tickUpper, liquidityDelta)));
        (amount0, amount1) = abi.decode(result, (int256, int256));
        emit LiquidityModified(tickLower, tickUpper, liquidityDelta, amount0, amount1);
    }

    /// @notice Swaps with the owner's tokens. Negative `amountSpecified` is exact input. The swap stops at
    ///         `sqrtPriceLimitX96`; with no liquidity in range this moves the price without moving any tokens.
    function swap(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96)
        external
        onlyOwner
        returns (int256 amount0, int256 amount1)
    {
        bytes memory result =
            poolManager.unlock(abi.encode(Action.SWAP, abi.encode(zeroForOne, amountSpecified, sqrtPriceLimitX96)));
        (amount0, amount1) = abi.decode(result, (int256, int256));
        emit Swapped(zeroForOne, amount0, amount1);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, bytes memory payload) = abi.decode(data, (Action, bytes));
        BalanceDelta delta;
        PoolKey memory key = poolKey;
        if (action == Action.MODIFY) {
            (int24 lower, int24 upper, int256 liquidityDelta) = abi.decode(payload, (int24, int24, int256));
            (delta,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liquidityDelta, 0), "");
        } else {
            (bool zeroForOne, int256 amountSpecified, uint160 limit) = abi.decode(payload, (bool, int256, uint160));
            if (limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;
            if (limit >= TickMath.MAX_SQRT_PRICE) limit = TickMath.MAX_SQRT_PRICE - 1;
            delta = poolManager.swap(key, SwapParams(zeroForOne, amountSpecified, limit), "");
        }
        int256 a0 = delta.amount0();
        int256 a1 = delta.amount1();
        _settle(key.currency0, a0);
        _settle(key.currency1, a1);
        return abi.encode(a0, a1);
    }

    function _settle(Currency currency, int256 amount) private {
        if (amount < 0) {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransferFrom(owner(), address(poolManager), uint256(-amount));
            poolManager.settle();
        } else if (amount > 0) {
            poolManager.take(currency, owner(), uint256(amount));
        }
    }
}
