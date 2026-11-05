// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IQuantumRound
/// @notice The part of QuantumRound that the market adapter reads. QuantumRound itself is not part of this task.
interface IQuantumRound {
    /// @notice Trading schedule of a proposal's market.
    /// @return tradingStart First second trading is allowed (inclusive).
    /// @return tradingEnd First second trading is closed (exclusive); liquidity may be removed from here on.
    /// @return finalWindowSeconds Length of the TWAP window that ends at `tradingEnd`.
    function marketTiming(uint256 roundId, uint256 proposalId)
        external
        view
        returns (uint64 tradingStart, uint64 tradingEnd, uint64 finalWindowSeconds);
}
