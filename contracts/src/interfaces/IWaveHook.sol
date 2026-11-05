// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @title IWaveHook
/// @notice External surface of the shared Wavefund v4 hook, as used by the market adapter.
interface IWaveHook {
    /// @notice Per-pool state kept by the hook.
    struct PoolData {
        uint256 roundId;
        uint256 proposalId;
        address longToken;
        uint64 tradingStart;
        uint64 tradingEnd;
        uint64 finalWindowSeconds;
        uint64 lastObservationTime;
        bool longIsCurrency0;
        bool registered;
        uint256 lastProbability; // pLong, 1e18
        uint256 finalWindowCumulative; // sum of pLong * seconds over the final window
        uint256 lastPrice; // SHORT per LONG, 1e18
        uint256 finalWindowCumulativePrice; // sum of price * seconds over the final window
    }

    /// @notice The only address allowed to register pools and to add/remove liquidity or swap.
    function adapter() external view returns (address);

    function registerPool(
        PoolKey calldata key,
        uint256 roundId,
        uint256 proposalId,
        address longToken,
        uint64 tradingStart,
        uint64 tradingEnd,
        uint64 finalWindowSeconds,
        uint256 initialProbabilityX18
    ) external;

    function isRegistered(PoolId id) external view returns (bool);
    function pLong(PoolId id) external view returns (uint256);
    function pShort(PoolId id) external view returns (uint256);
    /// @dev SHORT per LONG, 1e18. Reverts like `pLong` when out of bounds.
    function spotPriceX18(PoolId id) external view returns (uint256);
    function finalWindowTwap(PoolId id) external view returns (uint256);
    function finalWindowPriceTwap(PoolId id) external view returns (uint256);
    function poolDetails(PoolId id) external view returns (PoolData memory);
}
