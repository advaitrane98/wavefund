// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IProposalMarket
/// @notice Market adapter used by QuantumRound. One LONG/SHORT market per (roundId, proposalId).
/// @dev Units: a credit has 6 decimals, LONG/SHORT have 18, so one credit = one complete set =
///      `completeSetScale()` (1e12) raw units of LONG plus 1e12 raw units of SHORT.
///      Token flow (push model): QuantumRound mints / transfers the tokens to the market BEFORE it calls
///      a seed, buy or sell function. The market never pulls tokens and never mints or burns anything.
interface IProposalMarket {
    /// @notice Raw LONG (or SHORT) units per credit (1e12).
    function completeSetScale() external view returns (uint256);

    /// @notice Registers, initialises and funds the pool for a proposal.
    /// @dev Caller must have minted `creditAmount * completeSetScale()` of both LONG and SHORT to the market first.
    function seedLiquidity(uint256 roundId, uint256 proposalId, uint256 creditAmount) external;

    /// @notice Buy LONG with `creditAmount` credits. Caller has minted `creditAmount` complete sets to the market.
    /// @return totalOut LONG sent to `to`: creditAmount * 1e12 plus the swap output. Reverts below `minOut`.
    function tradeBuyLong(uint256 roundId, uint256 proposalId, uint256 creditAmount, uint256 minOut, address to)
        external
        returns (uint256 totalOut);

    /// @notice Buy SHORT with `creditAmount` credits. Mirror of `tradeBuyLong`.
    function tradeBuyShort(uint256 roundId, uint256 proposalId, uint256 creditAmount, uint256 minOut, address to)
        external
        returns (uint256 totalOut);

    /// @notice Sell `amountIn` raw LONG. Caller has transferred `amountIn` LONG to the market first.
    /// @dev Swaps only part of the input, keeps the rest and pairs it with the swap output as complete sets.
    ///      The result is parked as a pending settlement that must be taken with `consumeSellSettlement`.
    /// @return creditsOut Credits the seller is owed. Reverts below `minCreditsOut`.
    function tradeSellLong(uint256 roundId, uint256 proposalId, uint256 amountIn, uint256 minCreditsOut)
        external
        returns (uint256 creditsOut);

    /// @notice Sell `amountIn` raw SHORT. Mirror of `tradeSellLong`.
    function tradeSellShort(uint256 roundId, uint256 proposalId, uint256 amountIn, uint256 minCreditsOut)
        external
        returns (uint256 creditsOut);

    /// @notice Settles the pending sell: sends `credits * 1e12` of BOTH legs to the caller (QuantumRound burns them
    ///         and mints `credits` to the seller) and sends the dust of both legs to `seller`.
    function consumeSellSettlement(uint256 roundId, uint256 proposalId, address seller)
        external
        returns (uint256 credits, uint256 longDust, uint256 shortDust);

    /// @notice After trading ends: removes all liquidity and sends all remaining LONG/SHORT to the caller.
    /// @dev Reverts `PendingRemainder` if a sell settlement is unconsumed.
    function finalizeProposal(uint256 roundId, uint256 proposalId) external;

    /// @notice Spot price of LONG denominated in SHORT, 18 decimals (SHORT per LONG).
    function spotPrice(uint256 roundId, uint256 proposalId) external view returns (uint256 priceX18);

    /// @notice Spot probabilities, 18 decimals, always summing to exactly 1e18.
    function probabilities(uint256 roundId, uint256 proposalId) external view returns (uint256 pLong, uint256 pShort);

    /// @notice Probability TWAP of LONG over the final window (extrapolated to tradingEnd), 18 decimals.
    function probabilityTwap(uint256 roundId, uint256 proposalId) external view returns (uint256 pLongTwapX18);

    /// @notice Price TWAP (SHORT per LONG) over the final window (extrapolated to tradingEnd), 18 decimals.
    function twap(uint256 roundId, uint256 proposalId) external view returns (uint256 priceTwapX18);

    /// @notice After tradingEnd: snapshots the final TWAPs so they can no longer change. Idempotent.
    function closeTwapWindow(uint256 roundId, uint256 proposalId)
        external
        returns (uint256 pLongTwapX18, uint256 priceTwapX18);
}
