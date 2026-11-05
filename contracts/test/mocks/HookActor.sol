// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IWaveHook} from "../../src/interfaces/IWaveHook.sol";

contract MockERC20 is ERC20 {
    constructor(string memory n) ERC20(n, n) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal unlock-callback router. Acts as "the adapter" of a second WaveHook instance (hook-level tests),
///         or as an arbitrary non-adapter sender against the real adapter's hook.
contract HookActor is IUnlockCallback {
    enum Op {
        SWAP,
        MODIFY
    }

    struct Data {
        Op op;
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified;
        uint160 limit;
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
    }

    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function register(
        IWaveHook hook,
        PoolKey calldata key,
        uint256 r,
        uint256 p,
        address longToken,
        uint64 start,
        uint64 end,
        uint64 fw,
        uint256 prob
    ) external {
        hook.registerPool(key, r, p, longToken, start, end, fw, prob);
    }

    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 limit)
        external
        returns (BalanceDelta d)
    {
        Data memory data;
        data.op = Op.SWAP;
        data.key = key;
        data.zeroForOne = zeroForOne;
        data.amountSpecified = amountSpecified;
        data.limit = limit;
        d = abi.decode(pm.unlock(abi.encode(data)), (BalanceDelta));
    }

    function modify(PoolKey calldata key, int24 lo, int24 hi, int256 liq) external returns (BalanceDelta d) {
        Data memory data;
        data.op = Op.MODIFY;
        data.key = key;
        data.tickLower = lo;
        data.tickUpper = hi;
        data.liquidityDelta = liq;
        d = abi.decode(pm.unlock(abi.encode(data)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        Data memory d = abi.decode(raw, (Data));
        BalanceDelta delta;
        if (d.op == Op.SWAP) {
            delta = pm.swap(d.key, SwapParams(d.zeroForOne, d.amountSpecified, d.limit), "");
        } else {
            (delta,) = pm.modifyLiquidity(
                d.key, ModifyLiquidityParams(d.tickLower, d.tickUpper, d.liquidityDelta, bytes32(0)), ""
            );
        }
        _settle(d.key.currency0, delta.amount0());
        _settle(d.key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _settle(Currency c, int128 delta) private {
        if (delta < 0) {
            pm.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(pm), uint256(uint128(-delta)));
            pm.settle();
        } else if (delta > 0) {
            pm.take(c, address(this), uint256(uint128(delta)));
        }
    }
}
