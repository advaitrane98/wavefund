// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {WaveBase} from "./WaveBase.sol";

/// @notice Every parameterised error must carry the (roundId, proposalId) it was raised for, in that order.
///         Uses ids (7, 13) so a swapped or hard-coded argument cannot pass by coincidence.
contract WaveV4ProposalMarketErrorArgsTest is WaveBase {
    uint256 internal constant R2 = 7;
    uint256 internal constant P2 = 13;
    uint256 internal constant SEED = 5_000_000;

    function _ids(bytes4 sel) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(sel, R2, P2);
    }

    // ------------------------------------------------------------------ MarketNotSeeded
    function test_MarketNotSeeded_CarriesRoundAndProposalId_OnEveryEntryPoint() public {
        bytes memory err = _ids(WaveV4ProposalMarket.MarketNotSeeded.selector);
        vm.startPrank(address(qr));
        vm.expectRevert(err);
        adapter.tradeBuyLong(R2, P2, 1, 0, alice);
        vm.expectRevert(err);
        adapter.tradeBuyShort(R2, P2, 1, 0, alice);
        vm.expectRevert(err);
        adapter.tradeSellLong(R2, P2, 1, 0);
        vm.expectRevert(err);
        adapter.tradeSellShort(R2, P2, 1, 0);
        vm.expectRevert(err);
        adapter.consumeSellSettlement(R2, P2, alice);
        vm.expectRevert(err);
        adapter.finalizeProposal(R2, P2);
        vm.stopPrank();
        vm.expectRevert(err);
        adapter.probabilities(R2, P2);
        vm.expectRevert(err);
        adapter.spotPrice(R2, P2);
        vm.expectRevert(err);
        adapter.probabilityTwap(R2, P2);
        vm.expectRevert(err);
        adapter.twap(R2, P2);
        vm.expectRevert(err);
        adapter.closeTwapWindow(R2, P2);
        vm.expectRevert(err);
        adapter.quoteBuyLong(R2, P2, 1);
        vm.expectRevert(err);
        adapter.quoteBuyShort(R2, P2, 1);
        vm.expectRevert(err);
        adapter.quoteSellLong(R2, P2, 1);
        vm.expectRevert(err);
        adapter.quoteSellShort(R2, P2, 1);
    }

    function test_MarketNotSeeded_OnlyForTheMissingPairNotItsNeighbours() public {
        _open(R2, P2, SEED);
        // (7,13) is seeded; (13,7), (7,14) and (8,13) are not and must report THEIR OWN ids
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, P2, R2));
        adapter.spotPrice(P2, R2);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R2, P2 + 1));
        adapter.spotPrice(R2, P2 + 1);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R2 + 1, P2));
        adapter.spotPrice(R2 + 1, P2);
        assertEq(adapter.spotPrice(R2, P2), 1e18);
    }

    // ------------------------------------------------------------------ MarketNotFound / AlreadySeeded
    function test_MarketNotFound_CarriesRoundAndProposalId() public {
        vm.prank(address(qr));
        vm.expectRevert(_ids(WaveV4ProposalMarket.MarketNotFound.selector));
        adapter.seedLiquidity(R2, P2, 1);
    }

    function test_AlreadySeeded_CarriesRoundAndProposalId() public {
        _open(R2, P2, SEED);
        vm.expectRevert(_ids(WaveV4ProposalMarket.AlreadySeeded.selector));
        qr.seed(R2, P2, SEED);
        vm.prank(address(qr));
        vm.expectRevert(_ids(WaveV4ProposalMarket.AlreadySeeded.selector));
        adapter.seedLiquidity(R2, P2, 1);
    }

    // ------------------------------------------------------------------ NoPendingSettlement / PendingRemainder
    function test_NoPendingSettlement_CarriesRoundAndProposalId() public {
        _open(R2, P2, SEED);
        vm.expectRevert(_ids(WaveV4ProposalMarket.NoPendingSettlement.selector));
        qr.consume(alice, R2, P2);
        // and again after a completed sale
        _buy(alice, R2, P2, 500_000, true);
        _sellAll(alice, R2, P2, true);
        vm.expectRevert(_ids(WaveV4ProposalMarket.NoPendingSettlement.selector));
        qr.consume(alice, R2, P2);
    }

    function test_PendingRemainder_CarriesRoundAndProposalId() public {
        _open(R2, P2, SEED);
        _buy(alice, R2, P2, 1_000_000, true);
        qr.sellStep(alice, R2, P2, _bal(_long(R2, P2), alice) / 2, true, 0);
        qr.mintLegs(alice, R2, P2, 1e15, 1e15);
        bytes memory err = _ids(WaveV4ProposalMarket.PendingRemainder.selector);
        vm.expectRevert(err);
        qr.sellStep(alice, R2, P2, 1e15, true, 0);
        vm.expectRevert(err);
        qr.sellStep(alice, R2, P2, 1e15, false, 0);
        vm.expectRevert(err);
        adapter.quoteSellLong(R2, P2, 1e15);
        vm.expectRevert(err);
        adapter.quoteSellShort(R2, P2, 1e15);
        vm.warp(_now() + 1 days);
        vm.expectRevert(err);
        qr.finalize(R2, P2);
    }

    // ------------------------------------------------------------------ AlreadyFinalized / TradingClosed
    function test_AlreadyFinalized_CarriesRoundAndProposalId() public {
        uint64 s0 = uint64(_now());
        _open(R2, P2, SEED);
        qr.fund(alice, R2, P2, 10);
        vm.warp(_now() + 1 days);
        qr.finalize(R2, P2);

        bytes memory err = _ids(WaveV4ProposalMarket.AlreadyFinalized.selector);
        vm.expectRevert(err);
        qr.finalize(R2, P2);
        vm.expectRevert(err);
        qr.buy(alice, R2, P2, 1, true, 0);
        vm.startPrank(address(qr));
        vm.expectRevert(err);
        adapter.tradeBuyShort(R2, P2, 1, 0, alice);
        vm.expectRevert(err);
        adapter.tradeSellLong(R2, P2, 1, 0);
        vm.expectRevert(err);
        adapter.tradeSellShort(R2, P2, 1, 0);
        // consume has no finalized check; with nothing pending it reports NoPendingSettlement
        vm.expectRevert(_ids(WaveV4ProposalMarket.NoPendingSettlement.selector));
        adapter.consumeSellSettlement(R2, P2, alice);
        vm.stopPrank();
        // quotes check the window first, so a finalized market reports TradingClosed with its own timing
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.TradingClosed.selector, s0, s0 + 1 days, _now()));
        adapter.quoteBuyShort(R2, P2, 1);
    }

    // ------------------------------------------------------------------ Slippage
    function test_Slippage_CarriesMinRequiredThenActual_AllFourTrades() public {
        _open(R2, P2, SEED);
        qr.fund(alice, R2, P2, 2_000_000);
        uint256 qL = adapter.quoteBuyLong(R2, P2, 100_000);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.Slippage.selector, qL + 12_345, qL));
        qr.buy(alice, R2, P2, 100_000, true, qL + 12_345);
        uint256 qS = adapter.quoteBuyShort(R2, P2, 100_000);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.Slippage.selector, type(uint256).max, qS));
        qr.buy(alice, R2, P2, 100_000, false, type(uint256).max);

        qr.mintLegs(alice, R2, P2, 1e17, 1e17);
        (uint256 cL,,) = adapter.quoteSellLong(R2, P2, 1e17);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.Slippage.selector, cL + 7, cL));
        qr.sellStep(alice, R2, P2, 1e17, true, cL + 7);
        (uint256 cS,,) = adapter.quoteSellShort(R2, P2, 1e17);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.Slippage.selector, cS + 1, cS));
        qr.sellStep(alice, R2, P2, 1e17, false, cS + 1);
        // a failed slippage check leaves no pending settlement and no price move
        assertEq(_pLong(R2, P2), 0.5e18);
        vm.expectRevert(_ids(WaveV4ProposalMarket.NoPendingSettlement.selector));
        qr.consume(alice, R2, P2);
    }
}
