// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {QuantumBase} from "./QuantumBase.sol";
import {QuantumRound} from "../src/QuantumRound.sol";
import {WavefundVault} from "../src/WavefundVault.sol";
import {Resolver} from "../src/Resolver.sol";
import {MockPriceOracle} from "../src/MockPriceOracle.sol";
import {IQuantumRoundControl, RoundStatus} from "../src/interfaces/IQuantumRoundControl.sol";

contract WavefundVaultTest is QuantumBase {
    uint256 internal constant NAV0 = 150_000e6;

    // ------------------------------------------------------------------ helpers
    function _price(int256 usdPerEth8) internal {
        vm.prank(keeper);
        oracle.updatePrice(usdPerEth8);
    }

    function _statusQuoRound() internal returns (uint256 r) {
        r = _open();
        _propose(agentA, r, 6000);
        _toEnd(r);
        _collapse(r);
        assertEq(_winner(r), 0);
        _price(2000e8);
    }

    function _winner1Round() internal returns (uint256 r) {
        r = _open();
        _propose(agentA, r, 6000);
        _fund(alice, r, 100e6);
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        assertEq(_winner(r), 1);
        _price(2000e8);
    }

    function _execute(uint256 r, uint256 bps) internal {
        vm.prank(keeper);
        vault.executeTrade(r, bps);
    }

    function _requestDeposit(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), type(uint256).max);
        vault.requestDeposit(amount);
        vm.stopPrank();
    }

    function _state(uint256 r) internal view returns (uint256 startValue, bool executed, bool reported, bool cancelled) {
        (startValue,,,,, executed, reported, cancelled) = vault.roundState(r);
    }

    // ------------------------------------------------------------------ bootstrap and views
    function test_fundVault_mintsAtOneUsdcPerShareAndViewsAgree() public view {
        assertEq(vault.totalSupply(), NAV0 * 1e12);
        assertEq(vault.balanceOf(address(this)), NAV0 * 1e12);
        assertEq(vault.navUsdc(), NAV0);
        assertEq(vault.totalVaultUsdc(), 100_000e6);
        assertEq(vault.totalVaultTEth(), 25e18);
        assertEq(vault.oraclePriceTEthInUsdc(), 2000e6);
        assertEq(vault.currentTEthBps(), 3333);
        assertEq(vault.sharePriceUsdc(), 1e6);
        assertApproxEqRel(vault.spotPriceTEthInUsdc(), 2000e6, 0.0001e18);
    }

    function test_fundVault_isAdminOnlyAndPricesLaterMintsAtNav() public {
        vm.prank(stranger);
        vm.expectRevert();
        vault.fundVault(1e6, 0, stranger);
        usdc.mint(address(this), 15_000e6);
        uint256 supply = vault.totalSupply();
        uint256 minted = vault.fundVault(15_000e6, 0, alice);
        assertEq(minted, Math.mulDiv(15_000e6, supply, NAV0));
        assertEq(vault.sharePriceUsdc(), 1e6);
    }

    function test_setRound_isOneShot() public {
        vm.expectRevert(WavefundVault.AlreadyWired.selector);
        vault.setRound(qr, resolver);
    }

    // ------------------------------------------------------------------ queues
    function test_depositRequest_queuesAndCancels() public {
        _requestDeposit(alice, 500e6);
        assertEq(vault.depositRequest(alice), 500e6);
        assertEq(vault.queuedDepositsUsdc(), 500e6);
        assertEq(vault.navUsdc(), NAV0, "queued USDC is not shareholder NAV");
        vm.prank(alice);
        vault.cancelDepositRequest();
        assertEq(usdc.balanceOf(alice), 500e6);
        assertEq(vault.queuedDepositsUsdc(), 0);
        assertEq(vault.depositRequest(alice), 0);
        vm.prank(alice);
        vm.expectRevert(WavefundVault.NoRequest.selector);
        vault.cancelDepositRequest();
    }

    function test_withdrawRequest_escrowsSharesAndCancels() public {
        uint256 shares = 1_000e18;
        vault.requestWithdraw(shares);
        assertEq(vault.withdrawRequest(address(this)), shares);
        assertEq(vault.balanceOf(address(vault)), shares);
        vault.requestWithdraw(shares);
        assertEq(vault.withdrawRequest(address(this)), 2 * shares);
        vault.cancelWithdrawRequest();
        assertEq(vault.balanceOf(address(vault)), 0);
        assertEq(vault.queuedWithdrawShares(), 0);
    }

    function test_requests_enforceTheMinimumDeposit() public {
        usdc.mint(alice, 10e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.BelowMinimum.selector, 1e6 - 1, 1e6));
        vault.requestDeposit(1e6 - 1);
        vm.expectRevert(WavefundVault.ZeroAmount.selector);
        vault.requestWithdraw(0);
        vm.stopPrank();
    }

    function test_manyRequestersCannotCrowdOutAnyone() public {
        for (uint256 i; i < 150; ++i) {
            _requestDeposit(address(uint160(0x1000 + i)), 1e6);
        }
        _requestDeposit(alice, 1_000e6); // no slot cap: alice still gets in
        assertEq(vault.queuedDepositsUsdc(), 150e6 + 1_000e6);
    }

    function test_cancelsAreIndependentPerUser() public {
        _requestDeposit(alice, 1e6);
        _requestDeposit(bob, 2e6);
        _requestDeposit(carol, 3e6);
        vm.prank(alice);
        vault.cancelDepositRequest();
        assertEq(vault.queuedDepositsUsdc(), 5e6);
        vm.prank(carol);
        vault.cancelDepositRequest();
        assertEq(vault.depositRequest(bob), 2e6);
        assertEq(vault.queuedDepositsUsdc(), 2e6);
    }

    // ------------------------------------------------------------------ decision
    function test_executeTrade_statusQuoWinMeansNoSwap() public {
        uint256 r = _statusQuoRound();
        uint256 usdcBefore = vault.totalVaultUsdc();
        uint256 tethBefore = vault.totalVaultTEth();
        vm.expectEmit(true, false, false, true, address(vault));
        emit WavefundVault.TradeExecuted(r, 3333, 0, 0);
        _execute(r, 3333);
        assertEq(vault.totalVaultUsdc(), usdcBefore);
        assertEq(vault.totalVaultTEth(), tethBefore);
        assertEq(usdc.balanceOf(address(pm)), _poolUsdc, "pool untouched");
        (uint256 startValue, bool executed,,) = _state(r);
        assertTrue(executed);
        assertEq(startValue, NAV0);
        (, uint256 tEthAtStart, uint256 usdcAtStart, uint256 startPrice, uint256 ts,,,) = vault.roundState(r);
        assertEq(tEthAtStart, 25e18);
        assertEq(usdcAtStart, 100_000e6);
        assertEq(startPrice, 2000e6);
        assertEq(ts, block.timestamp);
    }

    uint256 internal _poolUsdc;

    function setUp() public override {
        super.setUp();
        _poolUsdc = usdc.balanceOf(address(pm));
    }

    function test_executeTrade_swapsTowardTheWinningAllocation() public {
        uint256 r = _winner1Round();
        _execute(r, 6000);
        assertApproxEqAbs(vault.currentTEthBps(), 6000, 30);
        assertGt(vault.totalVaultTEth(), 25e18);
        assertLt(vault.totalVaultUsdc(), 100_000e6);
        assertGt(usdc.balanceOf(address(pm)), _poolUsdc, "USDC went into the pool");
        // accounted balances match real balances: nothing leaked
        assertEq(usdc.balanceOf(address(vault)), vault.totalVaultUsdc());
        assertEq(teth.balanceOf(address(vault)), vault.totalVaultTEth());
        // NAV only fell by the pool fee and impact (< 0.5% of the 40k traded)
        assertGt(vault.navUsdc(), NAV0 - 200e6);
    }

    function test_executeTrade_guards() public {
        uint256 r = _winner1Round();
        vm.prank(stranger);
        vm.expectRevert();
        vault.executeTrade(r, 6000);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.WinnerMismatch.selector, 6000, 3333));
        vault.executeTrade(r, 3333);
        vm.warp(block.timestamp + 6 minutes);
        vm.prank(keeper);
        vm.expectPartialRevert(MockPriceOracle.StalePrice.selector);
        vault.executeTrade(r, 6000);
        _price(2000e8);
        _execute(r, 6000);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.AlreadyProcessed.selector, r));
        vault.executeTrade(r, 6000);
    }

    function test_executeTrade_requiresACollapsedRound() public {
        uint256 r = _open();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.RoundNotCollapsed.selector, r));
        vault.executeTrade(r, 3333);
    }

    // ------------------------------------------------------------------ queue processing at the decision boundary
    function test_queues_areProcessedAtThePreFlowNavAndSupply() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _requestDeposit(alice, 30_000e6);
        uint256 sharesOut = 15_000e18;
        vault.transfer(bob, sharesOut);
        vm.prank(bob);
        vault.requestWithdraw(sharesOut);
        _toEnd(r);
        _collapse(r);
        _price(2200e8); // NAV marks up before the flows: 100k + 25*2200 = 155k
        uint256 nav0 = vault.navUsdc();
        assertEq(nav0, 155_000e6);
        uint256 supply0 = vault.totalSupply();
        _execute(r, 3333);
        assertEq(vault.balanceOf(alice), 0, "shares are collected with claimFor");
        (uint256 pendingShares,) = vault.claimable(alice);
        assertGt(pendingShares, 0);
        vault.claimFor(alice);
        vault.claimFor(bob);
        uint256 aliceShares = Math.mulDiv(30_000e6, supply0, nav0);
        uint256 bobUsdc = Math.mulDiv(sharesOut, nav0, supply0);
        assertEq(vault.balanceOf(alice), aliceShares);
        assertEq(usdc.balanceOf(bob), bobUsdc);
        assertEq(vault.totalSupply(), supply0 + aliceShares - sharesOut);
        assertEq(vault.queuedDepositsUsdc(), 0);
        assertEq(vault.queuedWithdrawShares(), 0);
        assertEq(vault.balanceOf(address(vault)), 0);
        assertEq(vault.unclaimedDepositShares(), 0);
        assertEq(vault.claimableUsdcTotal(), 0);
        assertEq(vault.totalVaultUsdc(), 100_000e6 + 30_000e6 - bobUsdc);
        // share price is untouched by the flows
        assertApproxEqAbs(vault.sharePriceUsdc(), Math.mulDiv(nav0, 1e18, supply0), 1);
        // requests made after the decision wait for the next one
        _requestDeposit(carol, 1_000e6);
        assertEq(vault.queuedDepositsUsdc(), 1_000e6);
        assertEq(vault.balanceOf(carol), 0);
    }

    function test_withdrawals_sellTEthThroughThePoolWhenUsdcIsShort() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        uint256 sharesOut = (vault.totalSupply() * 9) / 10;
        vault.requestWithdraw(sharesOut);
        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        uint256 owed = Math.mulDiv(sharesOut, NAV0, vault.totalSupply());
        assertGt(owed, 100_000e6, "more than the vault's USDC");
        uint256 before = usdc.balanceOf(address(this));
        _execute(r, 3333);
        vault.claimFor(address(this));
        assertEq(usdc.balanceOf(address(this)) - before, owed);
        assertLt(vault.totalVaultTEth(), 25e18);
        assertEq(usdc.balanceOf(address(vault)), vault.totalVaultUsdc());
        assertEq(teth.balanceOf(address(vault)), vault.totalVaultTEth());
    }

    function test_blockedRecipientCannotBlockTheRound_andClaimsLater() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        vault.transfer(bob, 1_000e18);
        vm.prank(bob);
        vault.requestWithdraw(1_000e18);
        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        uint256 owed = Math.mulDiv(1_000e18, NAV0, vault.totalSupply());
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(IERC20.transfer.selector, bob, owed), "blocked");
        _execute(r, 3333);
        vault.claimFor(bob);
        vm.clearMockedCalls();
        assertEq(usdc.balanceOf(bob), 0);
        assertEq(vault.claimableUsdc(bob), owed);
        vm.prank(bob);
        vault.claimUsdc();
        assertEq(usdc.balanceOf(bob), owed);
        assertEq(vault.claimableUsdcTotal(), 0);
    }

    // ------------------------------------------------------------------ slippage guard
    function test_slippageBreach_revertsTheWholeCallAndLeavesStateUntouched() public {
        uint256 r = _winner1Round();
        _requestDeposit(alice, 5_000e6);
        _price(1500e8); // oracle says tETH is cheap, pool still quotes 2000: buying is >5% worse than the oracle
        uint256 usdcBefore = vault.totalVaultUsdc();
        uint256 tethBefore = vault.totalVaultTEth();
        uint256 poolBefore = usdc.balanceOf(address(pm));
        vm.prank(keeper);
        vm.expectPartialRevert(WavefundVault.SlippageBreached.selector);
        vault.executeTrade(r, 6000);
        assertEq(vault.totalVaultUsdc(), usdcBefore, "swap rolled back");
        assertEq(vault.totalVaultTEth(), tethBefore);
        assertEq(usdc.balanceOf(address(pm)), poolBefore);
        assertEq(vault.queuedDepositsUsdc(), 5_000e6, "flows were rolled back too and stay queued");
        assertEq(vault.depositRequest(alice), 5_000e6);
        assertEq(vault.currentEpoch(), 0);
        assertEq(vault.balanceOf(alice), 0);
        (, bool executed,, bool cancelled) = _state(r);
        assertFalse(executed);
        assertFalse(cancelled, "a slippage revert does not cancel the round");
        assertEq(uint256(_roundStatus(r)), uint256(RoundStatus.Collapsed));
        assertFalse(qr.roundExecuted(r));
        // an unexecuted round cannot be reported
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.NotExecuted.selector, r));
        vault.reportReturn(r);
    }

    function test_slippageBreach_keeperCanRetryOnceTheOracleRecovers() public {
        uint256 r = _winner1Round();
        _requestDeposit(alice, 5_000e6);
        _price(1500e8);
        _execute_expectSlippage(r);
        _price(2000e8);
        _execute(r, 6000);
        (, bool executed,, bool cancelled) = _state(r);
        assertTrue(executed);
        assertFalse(cancelled);
        assertEq(vault.queuedDepositsUsdc(), 0, "queue processed on the retry");
        assertEq(vault.currentEpoch(), 1);
    }

    function test_slippageBreach_cancelStaysPermissionlessAfterEvaluationEndAndRedeemsAtPar() public {
        uint256 r = _winner1Round();
        _requestDeposit(alice, 5_000e6);
        _price(1500e8);
        _execute_expectSlippage(r);
        vm.warp(qr.evaluationEnd(r));
        vm.prank(stranger);
        vault.cancelUnexecutedRound(r);
        (, bool executed,, bool cancelled) = _state(r);
        assertFalse(executed);
        assertTrue(cancelled);
        assertEq(uint256(_roundStatus(r)), uint256(RoundStatus.Cancelled));
        assertEq(vault.queuedDepositsUsdc(), 5_000e6, "vault flows still queued for a later round");
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        qr.redeem(r);
        assertEq(usdc.balanceOf(alice) - before, 100e6, "par redemption");
        _price(2000e8);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.AlreadyProcessed.selector, r));
        vault.executeTrade(r, 6000);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.NotExecuted.selector, r));
        vault.reportReturn(r);
    }

    function _execute_expectSlippage(uint256 r) internal {
        vm.prank(keeper);
        vm.expectPartialRevert(WavefundVault.SlippageBreached.selector);
        vault.executeTrade(r, 6000);
    }

    function test_nextRoundCanOpenAfterACancellation() public {
        uint256 r = _winner1Round();
        _price(1500e8);
        _execute_expectSlippage(r);
        vm.warp(qr.evaluationEnd(r));
        vault.cancelUnexecutedRound(r);
        vm.prank(alice);
        qr.redeem(r);
        _price(2000e8);
        uint256 r2 = _open();
        assertEq(r2, 2);
    }

    // ------------------------------------------------------------------ reporting the return
    function test_reportReturn_computesNavRatioAndSettlesTheRound() public {
        uint256 r = _winner1Round();
        _execute(r, 6000);
        (uint256 startValue,,,) = _state(r);
        assertEq(startValue, vault.navUsdc());
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.EvaluationNotEnded.selector, r));
        vault.reportReturn(r);

        uint256 end = qr.evaluationEnd(r);
        vm.warp(end);
        // no observation at or after evaluationEnd exists yet (the latest one predates it)
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.OracleNotUpdated.selector, 0, end));
        vault.reportReturn(r);

        // blocked while the round awaits its report
        usdc.mint(address(this), 1e6);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.RoundPendingReport.selector, r));
        vault.fundVault(1e6, 0, alice);

        _price(2100e8); // tETH +5%
        uint256 navNow = vault.totalVaultUsdc() + Math.mulDiv(vault.totalVaultTEth(), 2100e8, 1e20);
        uint256 expectedR = Math.mulDiv(navNow, ONE, startValue);
        assertGt(expectedR, ONE);
        vault.reportReturn(r);
        (,, bool reported,) = _state(r);
        assertTrue(reported);
        assertEq(uint256(_roundStatus(r)), uint256(RoundStatus.Settled));
        (,,,,,,,,,, uint256 realised,,,,,) = qr.rounds(r);
        assertEq(realised, expectedR);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.AlreadyReported.selector, r));
        vault.reportReturn(r);

        // alice redeems with the settled return; pi reflects the clamp
        uint256 pi = _pi(expectedR);
        assertEq(qr.previewRedeem(r, alice) > 0, true);
        assertLe(pi, ONE);
        usdc.mint(address(this), 0);
        vault.fundVault(1e6, 0, alice); // no longer blocked
    }

    function test_reportReturn_statusQuoRoundTracksPureNavMovement() public {
        uint256 r = _statusQuoRound();
        _execute(r, 3333);
        vm.warp(qr.evaluationEnd(r));
        _price(1800e8); // tETH -10% on a 1/3 position: NAV -3.33%
        vault.reportReturn(r);
        uint256 navNow = 100_000e6 + Math.mulDiv(25e18, 1800e8, 1e20);
        (,,,,,,,,,, uint256 realised,,,,,) = qr.rounds(r);
        assertEq(realised, Math.mulDiv(navNow, ONE, NAV0));
        // below rMin: the round settles with pi clamped to 0
        assertEq(_pi(realised), 0);
    }

    function test_reportReturn_onlyAfterExecution() public {
        uint256 r = _statusQuoRound();
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.NotExecuted.selector, r));
        vault.reportReturn(r);
    }

    // ------------------------------------------------------------------ rescue
    function test_donationsDoNotMoveNavAndCanBeRescued() public {
        usdc.mint(address(vault), 1_000e6);
        teth.mint(address(vault), 1e18);
        assertEq(vault.navUsdc(), NAV0);
        assertEq(vault.sharePriceUsdc(), 1e6);
        _requestDeposit(alice, 700e6);
        // queued deposits are protected, donations are not
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ExceedsRescuable.selector, 1_000e6 + 1, 1_000e6));
        vault.rescue(IERC20(address(usdc)), stranger, 1_000e6 + 1);
        vault.rescue(IERC20(address(usdc)), stranger, 1_000e6);
        vault.rescue(IERC20(address(teth)), stranger, 1e18);
        assertEq(usdc.balanceOf(stranger), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ExceedsRescuable.selector, 1, 0));
        vault.rescue(IERC20(address(teth)), stranger, 1);
        // escrowed WAVE for withdrawals is protected as well
        vault.requestWithdraw(5e18);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ExceedsRescuable.selector, 1, 0));
        vault.rescue(IERC20(address(vault)), stranger, 1);
        vm.prank(stranger);
        vm.expectRevert();
        vault.rescue(IERC20(address(usdc)), stranger, 1);
    }

    // ------------------------------------------------------------------ review fixes
    function test_claimFor_isPermissionlessAndOnlyEverPaysTheOwner() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _requestDeposit(alice, 2_000e6);
        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        _execute(r, 3333);
        vm.prank(stranger);
        vault.claimFor(alice);
        assertEq(vault.balanceOf(stranger), 0);
        assertEq(vault.balanceOf(alice), 2_000e6 * 1e12);
        vault.claimFor(alice); // second call is a no-op
        assertEq(vault.balanceOf(alice), 2_000e6 * 1e12);
    }

    function test_aNewRequestFirstCollectsTheProcessedOne() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _requestDeposit(alice, 1_000e6);
        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        _execute(r, 3333);
        _requestDeposit(alice, 500e6);
        assertEq(vault.balanceOf(alice), 1_000e6 * 1e12, "previous batch collected");
        assertEq(vault.depositRequest(alice), 500e6);
        assertEq(vault.currentEpoch(), 1);
    }

    function test_manyDepositorsAreSettledProRataOfOneBatch() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        for (uint256 i; i < 150; ++i) {
            _requestDeposit(address(uint160(0x1000 + i)), 1e6 + i);
        }
        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        _execute(r, 3333);
        uint256 total;
        for (uint256 i; i < 150; ++i) {
            address u = address(uint160(0x1000 + i));
            vault.claimFor(u);
            total += vault.balanceOf(u);
        }
        assertEq(total + vault.unclaimedDepositShares(), vault.totalSupply() - NAV0 * 1e12, "minted shares are all accounted for");
        assertEq(vault.unclaimedDepositShares(), 0, "the last claimant receives the rounding remainder");
    }

    function test_lateExecutionIsRejectedAndTheRoundCanBeCancelledByAnyone() public {
        uint256 r = _winner1Round();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ExecutionWindowOpen.selector, r));
        vault.cancelUnexecutedRound(r);
        vm.warp(qr.evaluationEnd(r));
        _price(2000e8);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ExecutionWindowClosed.selector, r));
        vault.executeTrade(r, 6000);
        vm.prank(stranger);
        vault.cancelUnexecutedRound(r);
        assertEq(uint256(_roundStatus(r)), uint256(RoundStatus.Cancelled));
        (, bool executed,, bool cancelled) = _state(r);
        assertFalse(executed);
        assertTrue(cancelled);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        qr.redeem(r);
        assertEq(usdc.balanceOf(alice) - before, 100e6);
    }

    function test_reportMustUseAFreshObservationInsideTheReportWindow() public {
        uint256 r = _winner1Round();
        _execute(r, 6000);
        uint256 end = qr.evaluationEnd(r);
        // the only observation at/after evaluationEnd lands after the report window: it cannot be used
        vm.warp(end + vault.REPORT_WINDOW() + 1);
        _price(2000e8);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ReportWindowClosed.selector, r));
        vault.reportReturn(r);
        // missed window: the round's emergency settle takes over (midpoint, since the round was executed)
        vm.warp(end + qr.EMERGENCY_SETTLE_DELAY());
        vm.prank(stranger);
        qr.settle(r, 0);
        assertEq(uint256(_roundStatus(r)), uint256(RoundStatus.Settled));
        usdc.mint(address(this), 1e6);
        _price(2000e8);
        vault.fundVault(1e6, 0, alice); // no longer blocked by the unreported round
    }

    function test_fullExitIsPaidProRataAndDoesNotCancelTheRound() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        uint256 all = vault.totalSupply();
        vault.requestWithdraw(all);
        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        _execute(r, 3333);
        (, bool executed,, bool cancelled) = _state(r);
        assertTrue(executed);
        assertFalse(cancelled);
        assertEq(vault.totalVaultTEth(), 0, "all tETH was sold");
        assertEq(vault.totalSupply(), 0);
        uint256 before = usdc.balanceOf(address(this));
        vault.claimFor(address(this));
        uint256 got = usdc.balanceOf(address(this)) - before;
        assertLt(got, NAV0, "exiting holders bear the liquidation cost");
        assertGt(got, NAV0 - 2_000e6, "but only fees and impact");
        assertEq(vault.totalVaultUsdc(), 0);
        assertEq(usdc.balanceOf(address(vault)), vault.claimableUsdcTotal());
    }

    function test_wiringAndAssetValidation() public {
        Resolver other = new Resolver(address(this), IQuantumRoundControl(address(0xBEEF)));
        WavefundVault v = new WavefundVault(address(this), IERC20(address(usdc)), IERC20(address(teth)), oracle, pm);
        vm.expectRevert(WavefundVault.ResolverMismatch.selector);
        v.setRound(qr, other);
        vm.expectRevert(WavefundVault.InvalidAsset.selector);
        new WavefundVault(address(this), IERC20(address(usdc)), IERC20(address(usdc)), oracle, pm);
        vm.expectRevert(WavefundVault.InvalidAsset.selector);
        new WavefundVault(address(this), IERC20(address(teth)), IERC20(address(usdc)), oracle, pm);
    }

    function test_withdrawalRemaindersAreCollectedByTheLastClaimant() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        for (uint256 i; i < 7; ++i) {
            address u = address(uint160(0x2000 + i));
            vault.transfer(u, 1_000e18 + i * 7);
            vm.prank(u);
            vault.requestWithdraw(1_000e18 + i * 7);
        }
        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        _execute(r, 3333);
        for (uint256 i; i < 7; ++i) {
            vault.claimFor(address(uint160(0x2000 + i)));
        }
        assertEq(vault.claimableUsdcTotal(), 0, "no USDC is left locked by rounding");
    }

    function test_nearTotalExitSharesTheLossAndLeavesTheVaultUsable() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        uint256 supply = vault.totalSupply();
        uint256 exiting = (supply * 999) / 1000;
        vault.requestWithdraw(exiting);
        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        _execute(r, 3333);
        (, bool executed,, bool cancelled) = _state(r);
        assertTrue(executed);
        assertFalse(cancelled);
        assertEq(vault.totalVaultTEth(), 0);
        // the 0.1% who stayed still own a fair slice, not zero
        uint256 stayed = supply - exiting;
        uint256 stayedValue = Math.mulDiv(vault.navUsdc(), stayed, vault.totalSupply());
        assertGt(vault.navUsdc(), 0);
        assertGt(stayedValue, (NAV0 / 1000) * 99 / 100, "remaining holders keep about their share, minus a shared fee");
        // and the vault keeps working: settle, then a deposit batch is priced in the next round
        _settleAt(r, R_MAX);
        _requestDeposit(alice, 5_000e6);
        uint256 r2 = _open();
        _propose(agentA, r2, 6000);
        _toEnd(r2);
        _collapse(r2);
        _price(2000e8);
        _execute(r2, 0); // the vault is all USDC after the exit
        vault.claimFor(alice);
        assertGt(vault.balanceOf(alice), 0);
        assertApproxEqRel(Math.mulDiv(vault.balanceOf(alice), vault.navUsdc(), vault.totalSupply()), 5_000e6, 0.001e18);
    }
}
