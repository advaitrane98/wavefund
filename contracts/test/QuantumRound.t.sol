// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {QuantumBase} from "./QuantumBase.sol";
import {QuantumRound} from "../src/QuantumRound.sol";
import {RoundStatus} from "../src/interfaces/IQuantumRoundControl.sol";
import {ProposerRegistry} from "../src/ProposerRegistry.sol";

contract QuantumRoundTest is QuantumBase {
    // ------------------------------------------------------------------ helpers
    function _escrowPaid(uint256 r) internal view returns (uint256 escrow, uint256 paid) {
        (,,,,,,,,,,,,,, escrow, paid) = qr.rounds(r);
    }

    function _redeemAs(address user, uint256 r) internal returns (uint256 received) {
        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        qr.redeem(r);
        received = usdc.balanceOf(user) - before;
    }

    /// @dev Round where proposal 1 (agentA, 60 percent tETH) wins; alice deposited 100 USDC.
    function _p1Wins() internal returns (uint256 r) {
        r = _open();
        _propose(agentA, r, 6000);
        _fund(alice, r, 100e6);
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        assertEq(_winner(r), 1, "p1 should win");
    }

    // ------------------------------------------------------------------ round opening
    function test_openRound_createsStatusQuoFromAllocationSource() public {
        uint256 reserve = qr.protocolLiquiditySeed();
        uint256 r = _open();
        assertEq(r, 1);
        (address proposer, uint16 bps, bool isSq, uint256 seed,,,) = qr.proposals(r, 0);
        assertEq(proposer, address(0));
        assertEq(bps, vault.currentTEthBps());
        assertEq(bps, 3333);
        assertTrue(isSq);
        assertEq(seed, SEED);
        assertEq(qr.protocolLiquiditySeed(), reserve - SEED);
        (uint64 start, uint64 end, uint64 win) = qr.marketTiming(r, 0);
        assertEq(start, T0);
        assertEq(end, T0 + DURATION);
        assertEq(win, WINDOW);
        assertEq(qr.evaluationEnd(r), T0 + DURATION + HORIZON);
    }

    function test_openRound_requiresKeeperAndSettledPreviousRound() public {
        vm.prank(stranger);
        vm.expectRevert();
        qr.openRound(block.timestamp + DURATION, HORIZON, R_MIN, R_MAX, WINDOW);
        uint256 r = _open();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.PreviousRoundActive.selector, r));
        qr.openRound(block.timestamp + DURATION, HORIZON, R_MIN, R_MAX, WINDOW);
    }

    function test_openRound_rejectsBadParameters() public {
        vm.startPrank(keeper);
        vm.expectRevert(QuantumRound.InvalidParameters.selector);
        qr.openRound(block.timestamp, HORIZON, R_MIN, R_MAX, WINDOW);
        vm.expectRevert(QuantumRound.InvalidParameters.selector);
        qr.openRound(block.timestamp + DURATION, 0, R_MIN, R_MAX, WINDOW);
        vm.expectRevert(QuantumRound.InvalidParameters.selector);
        qr.openRound(block.timestamp + DURATION, HORIZON, R_MAX, R_MIN, WINDOW);
        vm.expectRevert(QuantumRound.InvalidParameters.selector);
        qr.openRound(block.timestamp + DURATION, HORIZON, R_MIN, R_MAX, DURATION + 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ proposals
    function test_propose_locksBondAndSeeds() public {
        uint256 r = _open();
        uint256 reserve = qr.protocolLiquiditySeed();
        uint256 p = _propose(agentA, r, 7000);
        assertEq(p, 1);
        assertEq(registry.lockedBond(agentA), 1e6);
        assertEq(usdc.balanceOf(agentA), 99e6);
        assertEq(qr.protocolLiquiditySeed(), reserve - SEED);
        (address proposer, uint16 bps, bool isSq,, uint256 bond,, string memory why) = qr.proposals(r, 1);
        assertEq(proposer, agentA);
        assertEq(bps, 7000);
        assertFalse(isSq);
        assertEq(bond, 1e6);
        assertEq(why, "rationale");
    }

    function test_propose_rejectsUnregisteredAndBadAllocation() public {
        uint256 r = _open();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.AgentNotRegistered.selector, stranger));
        qr.propose(r, QuantumRound.Allocation(5000), "x");
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.InvalidAllocation.selector, 10_001));
        qr.propose(r, QuantumRound.Allocation(10_001), "x");
    }

    function test_propose_capsAtTenIncludingStatusQuo() public {
        uint256 r = _open();
        for (uint256 i = 1; i < 10; ++i) {
            _propose(i % 2 == 0 ? agentA : agentB, r, uint16(1000 * i));
        }
        vm.prank(agentA);
        vm.expectRevert(QuantumRound.TooManyProposals.selector);
        qr.propose(r, QuantumRound.Allocation(5000), "x");
    }

    function test_propose_failsAfterTradingEnds() public {
        uint256 r = _open();
        _toEnd(r);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.TradingNotOpen.selector, r));
        qr.propose(r, QuantumRound.Allocation(5000), "x");
    }

    // ------------------------------------------------------------------ credits
    function test_claimCredits_isCappedPerProposalNotAcrossProposals() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _propose(agentB, r, 4000);
        _fund(alice, r, 1e6);
        for (uint256 p; p < 3; ++p) {
            _claim(alice, r, p, 1e6);
            assertEq(_bal(tokens.creditToken(r, p), alice), 1e6);
        }
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.ClaimExceedsDeposit.selector, 1e6, 2e6));
        qr.claimCredits(r, 1, 1e6);
    }

    function test_claimCredits_partialClaimsAccumulateToTheCap() public {
        uint256 r = _open();
        _fund(alice, r, 10e6);
        _claim(alice, r, 0, 4e6);
        _claim(alice, r, 0, 6e6);
        assertEq(qr.creditsClaimed(r, 0, alice), 10e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.ClaimExceedsDeposit.selector, 10e6, 10e6 + 1));
        qr.claimCredits(r, 0, 1);
    }

    function test_claimCredits_rejectsNoDepositAndUnknownProposal() public {
        uint256 r = _open();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.ClaimExceedsDeposit.selector, 0, 1));
        qr.claimCredits(r, 0, 1);
        _fund(bob, r, 1e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.ProposalNotFound.selector, r, 5));
        qr.claimCredits(r, 5, 1);
    }

    // ------------------------------------------------------------------ trading
    function test_buyThenSell_roundTripLosesOnlyFees() public {
        uint256 r = _open();
        _fund(alice, r, 10e6);
        _claim(alice, r, 0, 2e6);
        uint256 out = _buyLong(alice, r, 0, 2e6);
        assertEq(_bal(tokens.creditToken(r, 0), alice), 0);
        assertEq(_bal(tokens.longToken(r, 0), alice), out);
        assertGt(out, 2e6 * SCALE);
        vm.prank(alice);
        uint256 credits = qr.sellLong(r, 0, out, 0);
        assertLe(credits, 2e6);
        assertGe(credits, 2e6 - 20_000, "round trip should only cost fees");
        assertLt(_bal(tokens.longToken(r, 0), alice), SCALE, "only sub-credit dust is returned");
        assertEq(_bal(tokens.creditToken(r, 0), alice), credits);
    }

    function test_buy_enforcesMinOut() public {
        uint256 r = _open();
        _fund(alice, r, 10e6);
        _claim(alice, r, 0, 2e6);
        vm.prank(alice);
        vm.expectRevert();
        qr.buyLong(r, 0, 2e6, type(uint256).max);
    }

    function test_trading_closedAfterTradingEnd() public {
        uint256 r = _open();
        _fund(alice, r, 10e6);
        _claim(alice, r, 0, 2e6);
        _toEnd(r);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.TradingNotOpen.selector, r));
        qr.buyShort(r, 0, 1e6, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.TradingNotOpen.selector, r));
        qr.deposit(r, 1);
    }

    // ------------------------------------------------------------------ collapse
    function _piOf(uint256 r) internal view returns (uint256 pi) {
        (,,,,,,,,,,, pi,,,,) = qr.rounds(r);
    }

    function test_collapse_statusQuoWinsWhenNobodyBeatsIt() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _toEnd(r);
        _collapse(r);
        assertEq(_winner(r), 0);
        assertEq(uint256(_roundStatus(r)), uint256(RoundStatus.Collapsed));
        assertEq(qr.protocolLiquiditySeed(), 1_000e6 - SEED, "only the winning seed stays out of the reserve");
    }

    function test_collapse_proposalWinsWhenItBeatsStatusQuoByEpsilon() public {
        uint256 r = _p1Wins();
        (,,,,, uint256 twap1,) = qr.proposals(r, 1);
        (,,,,, uint256 twap0,) = qr.proposals(r, 0);
        assertGt(twap1, twap0 + qr.EPSILON());
        assertEq(qr.protocolLiquiditySeed(), 1_000e6 - SEED, "status quo seed returned, winner seed held");
        (, , , , , , , , uint8 winnerId,,,,,,,) = qr.rounds(r);
        assertEq(winnerId, 1);
        (uint256 id, uint16 bps) = qr.winningAllocation(r);
        assertEq(id, 1);
        assertEq(bps, 6000);
    }

    function test_collapse_emitsCollapsedWithProbabilities() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _toEnd(r);
        uint256[] memory probs = new uint256[](2);
        probs[0] = 0.5e18;
        probs[1] = 0.5e18;
        vm.expectEmit(true, true, false, true, address(qr));
        emit QuantumRound.Collapsed(r, 0, probs);
        _collapse(r);
    }

    function test_collapse_revertsWhenRepeated() public {
        uint256 r = _open();
        _toEnd(r);
        _collapse(r);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.AlreadyCollapsed.selector, r));
        qr.collapse(r);
    }

    function test_collapse_revertsBeforeTradingEnd() public {
        uint256 r = _open();
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.TradingNotEnded.selector, r));
        qr.collapse(r);
    }

    function test_collapse_refundsAllBondsEvenWhenAMarketWasDumped() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _propose(agentB, r, 3000);
        _fund(bob, r, 20e6);
        _claim(bob, r, 1, 4e6);
        _buyShort(bob, r, 1, 4e6); // dumps proposal 1 towards its floor
        _fund(alice, r, 20e6);
        _pushUp(r, 2, alice, 3e6);
        assertEq(registry.lockedBond(agentA), 1e6);
        assertEq(registry.lockedBond(agentB), 1e6);
        _collapse(r);
        assertEq(_winner(r), 2);
        assertEq(registry.lockedBond(agentA), 0);
        assertEq(registry.lockedBond(agentB), 0);
        assertEq(usdc.balanceOf(agentA), 100e6);
        assertEq(usdc.balanceOf(agentB), 100e6);
        assertEq(registry.pendingRefund(agentA), 0);
        (,,, uint32 wonB) = _stats(agentB);
        assertEq(wonB, 1);
    }

    function _stats(address agent) internal view returns (uint64 a, bool b, uint32 made, uint32 won) {
        (, a, b, made, won) = registry.agents(agent);
    }

    // ------------------------------------------------------------------ settlement
    function test_settle_requiresResolverUntilEmergencyDelay() public {
        uint256 r = _p1Wins();
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.EvaluationNotEnded.selector, r));
        vm.prank(address(resolver));
        qr.settle(r, R_MAX);
        vm.warp(qr.evaluationEnd(r));
        vm.prank(stranger);
        vm.expectRevert(QuantumRound.NotAuthorizedToSettle.selector);
        qr.settle(r, R_MAX);
    }

    function test_settle_emergencyIgnoresSuppliedValueAndUsesMidpoint() public {
        uint256 r = _p1Wins();
        vm.warp(qr.evaluationEnd(r) + qr.EMERGENCY_SETTLE_DELAY());
        vm.prank(stranger);
        qr.settle(r, R_MAX);
        assertEq(_piOf(r), 0.5e18);
        assertEq(uint256(_roundStatus(r)), uint256(RoundStatus.Settled));
    }

    function test_settle_resolverSettlesOnceAndClampsTheReturn() public {
        uint256 r = _p1Wins();
        _settleAt(r, 2e18);
        assertEq(_piOf(r), ONE);
        vm.prank(address(resolver));
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.NotCollapsed.selector, r));
        qr.settle(r, R_MIN);
    }

    function test_resolver_onlyRoleHolderCanSubmit() public {
        uint256 r = _p1Wins();
        vm.warp(qr.evaluationEnd(r));
        vm.prank(stranger);
        vm.expectRevert();
        resolver.submitReturn(r, R_MAX);
    }

    // ------------------------------------------------------------------ redemption
    /// @dev alice: 100 deposit, 10 credits in p0 (+ short), 40 credits in p1 of which 3 buy LONG.
    function _exactnessScenario() internal returns (uint256 r) {
        r = _open();
        _propose(agentA, r, 6000);
        _fund(alice, r, 100e6);
        _claim(alice, r, 0, 10e6);
        _buyShort(alice, r, 0, 2e6);
        _toFinalWindow(r);
        _claim(alice, r, 1, 40e6);
        _buyLong(alice, r, 1, 3e6);
        _toEnd(r);
        _collapse(r);
        assertEq(_winner(r), 1);
    }

    function _expectedPayout(uint256 r, uint256 realised) internal view returns (uint256) {
        uint256 pi = _pi(realised);
        uint256 credit = _bal(tokens.creditToken(r, 1), alice);
        uint256 long_ = _bal(tokens.longToken(r, 1), alice);
        uint256 short_ = _bal(tokens.shortToken(r, 1), alice);
        return (100e6 - 40e6) + credit + Math.mulDiv(long_, pi, 1e30) + Math.mulDiv(short_, ONE - pi, 1e30);
    }

    function test_redeem_formulaIsExact() public {
        uint256 r = _exactnessScenario();
        uint256 realised = 0.995e18; // pi = 0.25
        assertEq(_pi(realised), 0.25e18);
        _settleAt(r, realised);
        uint256 expected = _expectedPayout(r, realised);
        uint256 longRaw = _bal(tokens.longToken(r, 1), alice);
        assertEq(_bal(tokens.creditToken(r, 1), alice), 37e6);
        assertEq(expected, 60e6 + 37e6 + longRaw / 4 / SCALE);
        assertEq(qr.previewRedeem(r, alice), expected);
        assertEq(_redeemAs(alice, r), expected);
        assertEq(_bal(tokens.creditToken(r, 1), alice), 0);
        assertEq(_bal(tokens.longToken(r, 1), alice), 0);
        assertGt(_bal(tokens.shortToken(r, 0), alice), 0, "erased tokens are untouched and pay nothing");
        vm.prank(alice);
        vm.expectRevert(QuantumRound.NothingToRedeem.selector);
        qr.redeem(r);
        assertTrue(qr.liabilitiesClear(r));
        assertEq(usdc.balanceOf(address(qr)), qr.protocolLiquiditySeed());
    }

    function testFuzz_redeem_formulaMatchesIndependentCalculation(uint256 realised) public {
        realised = bound(realised, 0.9e18, 1.1e18);
        uint256 r = _exactnessScenario();
        _settleAt(r, realised);
        uint256 expected = _expectedPayout(r, realised);
        assertEq(_redeemAs(alice, r), expected);
    }

    function test_redeem_losingOnlyTraderGetsTheFullDeposit() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _fund(bob, r, 50e6);
        _claim(bob, r, 0, 20e6);
        _buyShort(bob, r, 0, 2e6);
        _fund(alice, r, 100e6);
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        assertEq(_winner(r), 1);
        _settleAt(r, R_MAX);
        assertEq(_redeemAs(bob, r), 50e6);
        assertEq(_bal(tokens.shortToken(r, 0), bob) > 0, true);
    }

    function test_redeem_revertsBeforeSettlementAndForOutsiders() public {
        uint256 r = _p1Wins();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.NotRedeemable.selector, r));
        qr.redeem(r);
        _settleAt(r, R_MAX);
        vm.prank(stranger);
        vm.expectRevert(QuantumRound.NothingToRedeem.selector);
        qr.redeem(r);
    }

    function test_cancelRound_onlyVaultAndRefundsAtPar() public {
        uint256 r = _p1Wins();
        vm.prank(stranger);
        vm.expectRevert();
        qr.cancelRound(r);
        vm.prank(address(vault));
        qr.cancelRound(r);
        assertEq(uint256(_roundStatus(r)), uint256(RoundStatus.Cancelled));
        assertEq(registry.lockedBond(agentA), 0, "bonds are returned");
        assertEq(usdc.balanceOf(agentA), 100e6);
        vm.warp(qr.evaluationEnd(r));
        vm.prank(address(resolver));
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.NotCollapsed.selector, r));
        qr.settle(r, R_MAX);
        assertGt(_bal(tokens.longToken(r, 1), alice), 0);
        assertEq(_redeemAs(alice, r), 100e6, "cancelled rounds redeem at par whatever tokens are held");
        assertEq(qr.protocolLiquiditySeed(), 1_000e6, "winning seed is back too");
        assertEq(usdc.balanceOf(address(qr)), 1_000e6);
    }

    // ------------------------------------------------------------------ seed release
    function test_releaseSeed_onAnEmptyRoundHappensAtSettle() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.NotRedeemable.selector, r));
        qr.releaseSeed(r);
        _toEnd(r);
        _collapse(r);
        assertEq(qr.protocolLiquiditySeed(), 1_000e6 - SEED);
        _settleAt(r, R_MAX);
        assertEq(qr.protocolLiquiditySeed(), 1_000e6, "nobody deposited so the seed is back at once");
        qr.releaseSeed(r); // already released: harmless no-op
        assertEq(qr.protocolLiquiditySeed(), 1_000e6);
    }

    function test_releaseSeed_waitsForTheLastRedeemWhenThereWereDeposits() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _fund(alice, r, 100e6);
        _fund(bob, r, 40e6);
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        _settleAt(r, R_MIN);
        uint256 reserveBefore = qr.protocolLiquiditySeed();
        assertEq(reserveBefore, 1_000e6 - SEED);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.LiabilitiesRemain.selector, r));
        qr.releaseSeed(r);
        _redeemAs(alice, r);
        assertEq(qr.protocolLiquiditySeed(), reserveBefore, "bob has not redeemed yet");
        assertFalse(qr.liabilitiesClear(r));
        assertEq(_redeemAs(bob, r), 40e6);
        assertTrue(qr.liabilitiesClear(r));
        assertGt(qr.protocolLiquiditySeed(), reserveBefore, "last redeem returns the winning seed");
        assertEq(usdc.balanceOf(address(qr)), qr.protocolLiquiditySeed());
    }

    function test_rescueProtocolSeed_isCappedAtTheUnallocatedSeed() public {
        uint256 r = _open();
        uint256 free = qr.protocolLiquiditySeed();
        assertEq(free, 1_000e6 - SEED);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.ExceedsUnallocatedSeed.selector, free + 1, free));
        qr.rescueProtocolSeed(free + 1);
        qr.rescueProtocolSeed(free);
        assertEq(qr.protocolLiquiditySeed(), 0);
        assertEq(usdc.balanceOf(address(qr)), SEED, "the live seed stays");
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.InsufficientProtocolSeed.selector, SEED, 0));
        qr.propose(r, QuantumRound.Allocation(5000), "x");
        vm.prank(stranger);
        vm.expectRevert();
        qr.rescueProtocolSeed(1);
    }

    function test_adminSetters() public {
        qr.setInitialLiquidityPerProposal(7e6);
        uint256 r = _open();
        (,,, uint256 seed,,,) = qr.proposals(r, 0);
        assertEq(seed, 7e6);
        vm.expectRevert(QuantumRound.InvalidParameters.selector);
        qr.setInitialLiquidityPerProposal(0);
        vm.prank(stranger);
        vm.expectRevert();
        qr.setInitialLiquidityPerProposal(1);
        vm.prank(stranger);
        vm.expectRevert();
        qr.setAllocationSource(stranger);
    }

    function test_secondRoundOpensAfterSettlement() public {
        uint256 r = _p1Wins();
        _settleAt(r, R_MAX);
        _redeemAs(alice, r);
        vm.prank(keeper);
        uint256 r2 = qr.openRound(block.timestamp + DURATION, HORIZON, R_MIN, R_MAX, WINDOW);
        assertEq(r2, 2);
        // a fresh round reuses nothing from the old one
        _fund(alice, r2, 5e6);
        _claim(alice, r2, 0, 5e6);
    }

    // ------------------------------------------------------------------ fuzz: per-proposal claims, solvency, seed return
    function testFuzz_PerProposalClaims_SolvencyAndSeedReturn(
        uint256 depA,
        uint256 depB,
        uint256 claimSeed,
        uint256 buySeed,
        uint256 realised
    ) public {
        depA = bound(depA, 1e6, 1e10);
        depB = bound(depB, 1e6, 1e10);
        realised = bound(realised, 0.9e18, 1.1e18);
        uint256 reserve0 = qr.protocolLiquiditySeed();

        uint256 r = _open();
        _propose(agentA, r, 6000);
        _propose(agentB, r, 3000);
        _fund(alice, r, depA);
        _fund(bob, r, depB);
        _toFinalWindow(r);
        for (uint256 p; p < 3; ++p) {
            // every proposal can be claimed up to the FULL deposit, independently
            uint256 ca = bound(uint256(keccak256(abi.encode(claimSeed, p, "a"))), 0, depA);
            uint256 cb = bound(uint256(keccak256(abi.encode(claimSeed, p, "b"))), 0, depB);
            if (ca != 0) _claim(alice, r, p, ca);
            if (cb != 0) _claim(bob, r, p, cb);
            assertEq(qr.creditsClaimed(r, p, alice), ca);
            if (ca == depA) {
                vm.prank(alice);
                vm.expectRevert();
                qr.claimCredits(r, p, 1);
            }
        }
        uint256 pa = uint256(keccak256(abi.encode(buySeed, "pa"))) % 3;
        uint256 pb = uint256(keccak256(abi.encode(buySeed, "pb"))) % 3;
        uint256 ba = Math.min(_bal(tokens.creditToken(r, pa), alice), 2e6);
        uint256 bb = Math.min(_bal(tokens.creditToken(r, pb), bob), 2e6);
        if (ba != 0) _buyLong(alice, r, pa, ba);
        if (bb != 0) _buyShort(bob, r, pb, bb);
        _toEnd(r);
        _collapse(r);
        _settleAt(r, realised);

        // solvency: cash held is exactly the reserve plus what the round still owes out
        (uint256 escrow, uint256 paid) = _escrowPaid(r);
        assertEq(usdc.balanceOf(address(qr)), qr.protocolLiquiditySeed() + escrow - paid, "cash accounting");

        uint256 got = _redeemAs(alice, r) + _redeemAs(bob, r);
        assertTrue(qr.liabilitiesClear(r), "everything redeemed");
        assertEq(usdc.balanceOf(address(qr)), qr.protocolLiquiditySeed(), "no cash is stranded");
        assertEq(got + qr.protocolLiquiditySeed(), reserve0 + depA + depB, "conservation of USDC");
    }

    // ------------------------------------------------------------------ redeemFor and blocked payouts
    function test_redeemFor_letsAnyoneClearADustDepositorSoTheSeedIsReleased() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _fund(alice, r, 100e6);
        _fund(bob, r, 1); // one raw USDC, never redeems
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        _settleAt(r, R_MAX);
        _redeemAs(alice, r);
        assertFalse(qr.liabilitiesClear(r), "the dust depositor still blocks the release");
        uint256 reserve = qr.protocolLiquiditySeed();
        vm.prank(stranger);
        qr.redeemFor(r, bob);
        assertEq(usdc.balanceOf(bob), 1, "payout goes to the depositor, not the caller");
        assertEq(usdc.balanceOf(stranger), 0);
        assertTrue(qr.liabilitiesClear(r));
        assertGt(qr.protocolLiquiditySeed(), reserve);
        assertEq(usdc.balanceOf(address(qr)), qr.protocolLiquiditySeed());
        vm.expectRevert(QuantumRound.NothingToRedeem.selector);
        qr.redeemFor(r, bob);
    }

    function test_redeemFor_blockedRecipientBecomesAPendingPayout() public {
        uint256 r = _p1Wins();
        _settleAt(r, R_MAX);
        uint256 owed = qr.previewRedeem(r, alice);
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(usdc.transfer.selector, alice, owed), "blocked");
        qr.redeemFor(r, alice);
        vm.clearMockedCalls();
        assertEq(qr.pendingPayout(alice), owed);
        assertTrue(qr.liabilitiesClear(r), "a deferred payout does not keep the seed locked");
        assertEq(usdc.balanceOf(address(qr)), qr.protocolLiquiditySeed() + owed);
        vm.prank(alice);
        qr.claimPayout();
        assertEq(usdc.balanceOf(alice), owed);
        assertEq(usdc.balanceOf(address(qr)), qr.protocolLiquiditySeed());
        vm.prank(alice);
        vm.expectRevert(QuantumRound.NothingToClaim.selector);
        qr.claimPayout();
    }

    function test_redeemFor_worksAfterCancellationToo() public {
        uint256 r = _p1Wins();
        vm.prank(address(vault));
        qr.cancelRound(r);
        vm.prank(stranger);
        qr.redeemFor(r, alice);
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(qr.protocolLiquiditySeed(), 1_000e6);
    }

    function test_redeemFor_cannotTargetTheRoundContractItself() public {
        uint256 r = _p1Wins();
        _settleAt(r, R_MAX);
        (, uint256 paidBefore) = _escrowPaid(r);
        uint256 lumpBefore = _bal(tokens.longToken(r, 1), address(qr));
        assertGt(lumpBefore, 0, "the round holds the market's returned inventory");
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.InvalidRedeemTarget.selector, address(qr)));
        qr.redeemFor(r, address(qr));
        (, uint256 paidAfter) = _escrowPaid(r);
        assertEq(paidAfter, paidBefore);
        assertEq(_bal(tokens.longToken(r, 1), address(qr)), lumpBefore);
        _redeemAs(alice, r);
        assertEq(usdc.balanceOf(address(qr)), qr.protocolLiquiditySeed(), "all remaining cash is accounted reserve");
    }
}
