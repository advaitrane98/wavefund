// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Lifecycle of a round. Trading -> Collapsed -> Settled, or Collapsed -> Cancelled.
enum RoundStatus {
    None,
    Trading,
    Collapsed,
    Settled,
    Cancelled
}

/// @title IAllocationSource
/// @notice Provides the allocation that proposal 0 (the status quo) represents. Implemented by the vault.
interface IAllocationSource {
    /// @notice Current tETH share of the portfolio in basis points (0..10_000), marked at the oracle.
    function currentTEthBps() external view returns (uint256);
}

/// @title IQuantumRoundControl
/// @notice The part of QuantumRound that the vault and the resolver use.
interface IQuantumRoundControl {
    /// @notice Cancels a collapsed, unsettled round so that it redeems at par. VAULT_ROLE only.
    function cancelRound(uint256 roundId) external;

    /// @notice Records a successful vault execution. VAULT_ROLE only, while collapsed, once.
    function markExecuted(uint256 roundId) external;

    function roundExecuted(uint256 roundId) external view returns (bool);

    /// @notice Settles a collapsed round with the realised return of the executed allocation.
    function settle(uint256 roundId, uint256 realisedReturn) external;

    function roundStatus(uint256 roundId) external view returns (RoundStatus);

    function evaluationEnd(uint256 roundId) external view returns (uint256);

    /// @notice Winning proposal id and its tETH basis points. Reverts unless the round is collapsed or later.
    function winningAllocation(uint256 roundId) external view returns (uint256 proposalId, uint16 tEthBps);
}
