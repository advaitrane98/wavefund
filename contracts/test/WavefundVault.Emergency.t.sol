// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VaultBase} from "./VaultBase.sol";
import {WavefundVault} from "../src/WavefundVault.sol";
import {RoundStatus} from "../src/interfaces/IQuantumRoundControl.sol";

/// @notice emergencyWithdraw: oracle-free, in-kind exit of an unprocessed withdrawal request after the delay.
contract WavefundVaultEmergencyTest is VaultBase {
    uint256 internal constant EXIT = 15_000e18; // 10% of the 150k supply (1e12 shares per USDC)
    uint256 internal delay;

    function setUp() public override {
        super.setUp();
        delay = vault.WITHDRAW_EXIT_DELAY();
    }

    function test_exitDelayIsThreeDays() public view {
        assertEq(delay, 3 days);
    }

    // ------------------------------------------------------------------ guards
    function test_tooEarly_revertsUntilTheDelayHasPassed() public {
        _requestWithdrawAs(alice, EXIT);
        uint256 availableAt = block.timestamp + delay;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.WithdrawExitTooEarly.selector, availableAt));
        vault.emergencyWithdraw();
        vm.warp(availableAt - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.WithdrawExitTooEarly.selector, availableAt));
        vault.emergencyWithdraw();
        assertEq(vault.withdrawRequest(alice), EXIT, "request untouched");
        vm.warp(availableAt); // inclusive boundary
        vm.prank(alice);
        vault.emergencyWithdraw();
        assertEq(vault.withdrawRequest(alice), 0);
    }

    function test_noRequest_reverts() public {
        vm.prank(alice);
        vm.expectRevert(WavefundVault.NoRequest.selector);
        vault.emergencyWithdraw();
    }

    function test_onlyTheRequestOwnerCanExitItsEscrow() public {
        _requestWithdrawAs(alice, EXIT);
        vm.warp(block.timestamp + delay);
        // bob has no request of his own; alice's escrow is not reachable by anyone else
        vm.prank(bob);
        vm.expectRevert(WavefundVault.NoRequest.selector);
        vault.emergencyWithdraw();
        vm.prank(stranger);
        vm.expectRevert(WavefundVault.NoRequest.selector);
        vault.emergencyWithdraw();
        assertEq(vault.withdrawRequest(alice), EXIT);
        assertEq(usdc.balanceOf(bob), 0);
        assertEq(teth.balanceOf(bob), 0);
    }

    function test_cannotExitTwiceOrAfterCancelling() public {
        _requestWithdrawAs(alice, EXIT);
        vm.warp(block.timestamp + delay);
        vm.startPrank(alice);
        vault.emergencyWithdraw();
        vm.expectRevert(WavefundVault.NoRequest.selector);
        vault.emergencyWithdraw();
        vm.expectRevert(WavefundVault.NoRequest.selector);
        vault.cancelWithdrawRequest();
        vm.stopPrank();
    }

    function test_aProcessedRequestIsNoLongerEmergencyExitable() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _requestWithdrawAs(alice, EXIT);
        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        _execute(r, 3333); // alice's request is priced in this batch
        vm.warp(block.timestamp + delay);
        vm.prank(alice);
        vm.expectRevert(WavefundVault.NoRequest.selector);
        vault.emergencyWithdraw();
        // she collects the processed USDC the normal way
        vault.claimFor(alice);
        assertEq(usdc.balanceOf(alice), Math.mulDiv(EXIT, NAV0, 150_000e6 * 1e12));
    }

    // ------------------------------------------------------------------ happy path
    function test_happyPath_paysProRataInKindAndLeavesQueuedDepositsAlone() public {
        _requestDeposit(carol, 5_000e6); // queued deposit USDC must not be paid out
        _requestWithdrawAs(alice, EXIT);
        vm.warp(block.timestamp + delay);

        uint256 supply = vault.totalSupply();
        uint256 vUsdc = vault.totalVaultUsdc();
        uint256 vTEth = vault.totalVaultTEth();
        uint256 priceBefore = vault.sharePriceUsdc();
        uint256 expUsdc = Math.mulDiv(EXIT, vUsdc, supply);
        uint256 expTEth = Math.mulDiv(EXIT, vTEth, supply);
        assertEq(expUsdc, 10_000e6);
        assertEq(expTEth, 2.5e18);

        vm.expectEmit(true, true, false, true, address(vault));
        emit WavefundVault.EmergencyWithdrawn(alice, 0, EXIT, expUsdc, expTEth);
        vm.prank(alice);
        vault.emergencyWithdraw();

        assertEq(usdc.balanceOf(alice), expUsdc, "USDC in kind");
        assertEq(teth.balanceOf(alice), expTEth, "tETH in kind");
        assertEq(vault.totalVaultUsdc(), vUsdc - expUsdc);
        assertEq(vault.totalVaultTEth(), vTEth - expTEth);
        assertEq(vault.totalSupply(), supply - EXIT, "escrowed shares burned");
        assertEq(vault.balanceOf(address(vault)), 0);
        assertEq(vault.queuedWithdrawShares(), 0);
        assertEq(vault.withdrawRequest(alice), 0);
        assertEq(vault.balanceOf(alice), 0);
        // queued deposit USDC untouched and still fully backed; accounting equals real balances
        assertEq(vault.queuedDepositsUsdc(), 5_000e6);
        assertEq(vault.depositRequest(carol), 5_000e6);
        assertEq(usdc.balanceOf(address(vault)), vault.totalVaultUsdc() + 5_000e6);
        assertEq(teth.balanceOf(address(vault)), vault.totalVaultTEth());
        assertEq(vault.claimableUsdcTotal(), 0);
        // remaining holders' share price is unchanged
        assertApproxEqAbs(vault.sharePriceUsdc(), priceBefore, 1);
        // carol can still cancel her deposit in full
        vm.prank(carol);
        vault.cancelDepositRequest();
        assertEq(usdc.balanceOf(carol), 5_000e6);
    }

    function test_happyPath_worksWithAStaleOracleAndWithoutAnyRound() public {
        _requestWithdrawAs(alice, EXIT);
        vm.warp(block.timestamp + 30 days); // oracle long stale, no round ever opened
        assertFalse(oracle.isFresh());
        vm.prank(alice);
        vault.emergencyWithdraw();
        assertEq(usdc.balanceOf(alice), 10_000e6);
        assertEq(teth.balanceOf(alice), 2.5e18);
    }

    function test_happyPath_noPoolSwapIsMade() public {
        _requestWithdrawAs(alice, EXIT);
        vm.warp(block.timestamp + delay);
        uint256 poolUsdc = usdc.balanceOf(address(pm));
        uint256 poolTEth = teth.balanceOf(address(pm));
        vm.prank(alice);
        vault.emergencyWithdraw();
        assertEq(usdc.balanceOf(address(pm)), poolUsdc);
        assertEq(teth.balanceOf(address(pm)), poolTEth);
    }

    function test_happyPath_fullExitByTheOnlyHolderLeavesQueuedDepositsCancellable() public {
        _requestDeposit(carol, 2_000e6);
        uint256 all = vault.balanceOf(address(this));
        vault.requestWithdraw(all);
        vm.warp(block.timestamp + delay);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 tEthBefore = teth.balanceOf(address(this));
        vault.emergencyWithdraw();
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.totalVaultUsdc(), 0);
        assertEq(vault.totalVaultTEth(), 0);
        assertEq(usdc.balanceOf(address(this)) - usdcBefore, 100_000e6, "got the vault USDC back");
        assertEq(teth.balanceOf(address(this)) - tEthBefore, 25e18, "and the vault tETH");
        assertEq(vault.queuedDepositsUsdc(), 2_000e6);
        vm.prank(carol);
        vault.cancelDepositRequest();
        assertEq(usdc.balanceOf(carol), 2_000e6);
    }

    function test_dustShareExitRoundsToZeroButBurnsOnlyTheEscrow() public {
        _requestWithdrawAs(alice, 1);
        vm.warp(block.timestamp + delay);
        uint256 supply = vault.totalSupply();
        vm.prank(alice);
        vault.emergencyWithdraw();
        assertEq(vault.totalSupply(), supply - 1);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(teth.balanceOf(alice), 0);
    }

    // ------------------------------------------------------------------ deferred USDC
    function test_failedUsdcTransferIsDeferredToClaimable() public {
        _requestWithdrawAs(alice, EXIT);
        vm.warp(block.timestamp + delay);
        uint256 usdcOut = 10_000e6;
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(IERC20.transfer.selector, alice, usdcOut), "blocked");
        vm.expectEmit(true, false, false, true, address(vault));
        emit WavefundVault.UsdcClaimable(alice, usdcOut);
        vm.prank(alice);
        vault.emergencyWithdraw();
        vm.clearMockedCalls();
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(teth.balanceOf(alice), 2.5e18, "tETH still paid");
        assertEq(vault.claimableUsdc(alice), usdcOut);
        assertEq(vault.claimableUsdcTotal(), usdcOut);
        assertEq(vault.withdrawRequest(alice), 0);
        // the deferred USDC stays backed and un-rescuable
        assertEq(usdc.balanceOf(address(vault)), vault.totalVaultUsdc() + usdcOut);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ExceedsRescuable.selector, 1, 0));
        vault.rescue(IERC20(address(usdc)), stranger, 1);
        vm.prank(alice);
        vault.claimUsdc();
        assertEq(usdc.balanceOf(alice), usdcOut);
        assertEq(vault.claimableUsdcTotal(), 0);
    }

    // ------------------------------------------------------------------ top-up restarts the delay
    function test_addingSharesRestartsTheDelayForTheWholeRequest() public {
        _requestWithdrawAs(alice, EXIT);
        vm.warp(block.timestamp + 2 days);
        vault.transfer(alice, EXIT);
        vm.prank(alice);
        vault.requestWithdraw(EXIT);
        uint256 availableAt = block.timestamp + delay;
        assertEq(vault.withdrawRequest(alice), 2 * EXIT);
        // 4 days after the first request but only 2 after the top-up
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.WithdrawExitTooEarly.selector, availableAt));
        vault.emergencyWithdraw();
        vm.warp(availableAt);
        vm.prank(alice);
        vault.emergencyWithdraw();
        assertEq(usdc.balanceOf(alice), 20_000e6, "both tranches exit together");
        assertEq(teth.balanceOf(alice), 5e18);
    }

    // ------------------------------------------------------------------ interaction with the next executeTrade
    function test_laterExecuteTradeStaysConsistentWithRemainingRequestsAndDeposits() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _requestWithdrawAs(alice, EXIT);
        _requestWithdrawAs(bob, EXIT);
        _requestDeposit(carol, 6_000e6);
        vm.warp(block.timestamp + delay);
        vm.prank(alice);
        vault.emergencyWithdraw();
        uint256 aliceUsdc = usdc.balanceOf(alice);
        uint256 aliceTEth = teth.balanceOf(alice);

        _toEnd(r);
        _collapse(r);
        _price(2000e8);
        uint256 supply0 = vault.totalSupply();
        uint256 nav0 = vault.navUsdc();
        assertEq(vault.queuedWithdrawShares(), EXIT, "only bob's request remains queued");
        _execute(r, 3333);

        vault.claimFor(bob);
        vault.claimFor(carol);
        // bob is paid his share of the post-exit NAV: the same value alice took in kind
        uint256 bobUsdc = Math.mulDiv(EXIT, nav0, supply0);
        assertEq(usdc.balanceOf(bob), bobUsdc);
        assertApproxEqAbs(bobUsdc, aliceUsdc + Math.mulDiv(aliceTEth, 2000e6, 1e18), 2e6);
        // carol's deposit is priced at the unchanged NAV per share
        uint256 carolShares = Math.mulDiv(6_000e6, supply0, nav0);
        assertEq(vault.balanceOf(carol), carolShares);
        assertEq(vault.totalSupply(), supply0 + carolShares - EXIT);
        // everything the vault holds is accounted for
        assertEq(vault.queuedWithdrawShares(), 0);
        assertEq(vault.queuedDepositsUsdc(), 0);
        assertEq(vault.claimableUsdcTotal(), 0);
        assertEq(vault.unclaimedDepositShares(), 0);
        assertEq(usdc.balanceOf(address(vault)), vault.totalVaultUsdc());
        assertEq(teth.balanceOf(address(vault)), vault.totalVaultTEth());
    }

    function test_exitAfterTheDecisionDoesNotChangeTheReportedReturn() public {
        uint256 r = _statusQuoRound();
        _execute(r, 3333);
        // bob requests after the decision (next batch); he exits it in kind before the evaluation ends
        vault.transfer(bob, EXIT);
        vm.prank(bob);
        vault.requestWithdraw(EXIT);
        vm.warp(block.timestamp + delay);
        vm.prank(bob);
        vault.emergencyWithdraw();
        uint256 end = qr.evaluationEnd(r);
        vm.warp(end);
        _price(2000e8);
        vault.reportReturn(r);
        assertEq(_realised(r), ONE, "in-kind exits do not move the measured return");
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Settled));
    }
}
