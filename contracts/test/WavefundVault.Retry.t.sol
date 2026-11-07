// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {VaultBase} from "./VaultBase.sol";
import {WavefundVault} from "../src/WavefundVault.sol";
import {RoundStatus} from "../src/interfaces/IQuantumRoundControl.sol";

/// @notice A slippage / oracle-band failure reverts the whole executeTrade (2- and 4-arg) with SlippageBreached:
///         nothing is cancelled, flows stay queued, the keeper can retry. Cancellation stays with the permissionless
///         `cancelUnexecutedRound` after evaluationEnd and QuantumRound's emergency settle (both at par).
contract WavefundVaultRetryTest is VaultBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    PoolSwapTest internal swapRouter;

    function setUp() public override {
        super.setUp();
        swapRouter = new PoolSwapTest(pm);
        usdc.approve(address(swapRouter), type(uint256).max);
        teth.approve(address(swapRouter), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers
    function _key() internal view returns (PoolKey memory key) {
        (key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks) = vault.poolKey();
    }

    function _sqrtP() internal view returns (uint160 p) {
        (p,,,) = pm.getSlot0(_key().toId());
    }

    /// @dev Swaps (as an outside trader) until the pool reaches `target`.
    function _swapTo(uint160 target) internal {
        bool zeroForOne = target < _sqrtP();
        swapRouter.swap(
            _key(),
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(1e24), sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Pushes the pool's tETH price by `bps` up or down.
    function _frontRun(bool up, uint256 bps) internal {
        bool sqrtUp = (up != vault.usdcIsCurrency0());
        uint256 cur = _sqrtP();
        uint256 f = sqrtUp ? 10_000 + bps : 10_000;
        uint256 g = sqrtUp ? 10_000 : 10_000 + bps;
        _swapTo(uint160(Math.sqrt(Math.mulDiv(cur * cur, f, g))));
    }

    function _state(uint256 r) internal view returns (bool executed, bool cancelled) {
        (,,,,, executed,, cancelled) = vault.roundState(r);
    }

    function _exec(uint256 r, bool fourArg, bool expectSlippage) internal {
        vm.prank(keeper);
        if (expectSlippage) vm.expectPartialRevert(WavefundVault.SlippageBreached.selector);
        if (fourArg) vault.executeTrade(r, 6000, 100, block.timestamp + 1);
        else vault.executeTrade(r, 6000);
    }

    /// @dev Winner round (60% tETH) with carol's 5k deposit queued in the vault.
    function _setupRound() internal returns (uint256 r) {
        r = _winner1Round();
        _requestDeposit(carol, 5_000e6);
    }

    function _assertUntouched(uint256 r) internal view {
        (bool executed, bool cancelled) = _state(r);
        assertFalse(executed, "not executed");
        assertFalse(cancelled, "not cancelled");
        assertFalse(qr.roundExecuted(r));
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Collapsed));
        assertEq(vault.queuedDepositsUsdc(), 5_000e6, "flows stay queued");
        assertEq(vault.depositRequest(carol), 5_000e6);
        assertEq(vault.currentEpoch(), 0);
        assertEq(vault.totalVaultUsdc(), 100_000e6);
        assertEq(vault.totalVaultTEth(), 25e18);
        assertEq(vault.totalSupply(), 150_000e6 * 1e12);
    }

    // ------------------------------------------------------------------ front-run, revert, restore, retry
    function _frontRunThenRetry(bool up, bool fourArg) internal {
        uint256 r = _setupRound();
        uint160 p0 = _sqrtP();
        _frontRun(up, 300); // ~3% outside the 1% band
        uint160 pMoved = _sqrtP();
        assertTrue(pMoved != p0);

        vm.recordLogs();
        _exec(r, fourArg, true);
        // (recordLogs also captures events from the reverted inner frames, so only look for a cancellation)
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != WavefundVault.TradeCancelled.selector, "no TradeCancelled");
            assertTrue(logs[i].topics[0] != WavefundVault.TradeExecuted.selector, "no TradeExecuted");
        }
        assertEq(_sqrtP(), pMoved, "pool untouched by the failed call");
        _assertUntouched(r);
        _exec(r, fourArg, true); // still reverting, still retryable
        _assertUntouched(r);

        _swapTo(p0); // the manipulation is unwound
        assertEq(_sqrtP(), p0);
        vm.expectEmit(true, false, false, false, address(vault));
        emit WavefundVault.TradeExecuted(r, 6000, 0, 0);
        _exec(r, fourArg, false);

        (bool executed, bool cancelled) = _state(r);
        assertTrue(executed);
        assertFalse(cancelled);
        assertTrue(qr.roundExecuted(r));
        assertEq(vault.currentEpoch(), 1);
        assertEq(vault.queuedDepositsUsdc(), 0, "queued deposit processed on the retry");
        assertApproxEqAbs(vault.currentTEthBps(), 6000, 40);
        vault.claimFor(carol);
        assertEq(vault.balanceOf(carol), 5_000e6 * 1e12, "priced at the pre-flow NAV");
    }

    function test_frontRunUp_executeTradeRevertsThenRetrySucceeds() public {
        _frontRunThenRetry(true, false);
    }

    function test_frontRunDown_executeTradeRevertsThenRetrySucceeds() public {
        _frontRunThenRetry(false, false);
    }

    function test_frontRunUp_fourArgRevertsThenRetrySucceeds() public {
        _frontRunThenRetry(true, true);
    }

    function test_frontRunDown_fourArgRevertsThenRetrySucceeds() public {
        _frontRunThenRetry(false, true);
    }

    function test_fourArg_keeperCanRetryWithAWiderToleranceWithoutRestoringThePool() public {
        uint256 r = _setupRound();
        _frontRun(true, 300);
        vm.prank(keeper);
        vm.expectPartialRevert(WavefundVault.SlippageBreached.selector);
        vault.executeTrade(r, 6000, 100, block.timestamp);
        _assertUntouched(r);
        vm.prank(keeper);
        vault.executeTrade(r, 6000, 500, block.timestamp);
        (bool executed, bool cancelled) = _state(r);
        assertTrue(executed);
        assertFalse(cancelled);
        assertEq(vault.queuedDepositsUsdc(), 0);
    }

    function test_slippageRevertDoesNotMaskOtherGuards() public {
        uint256 r = _setupRound();
        _frontRun(true, 300);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.WinnerMismatch.selector, 6000, 1234));
        vault.executeTrade(r, 1234);
        vm.prank(stranger);
        vm.expectRevert();
        vault.executeTrade(r, 6000);
        _assertUntouched(r);
    }

    // ------------------------------------------------------------------ no successful execution: cancel at par
    function _noExecutionThenCancel(bool fourArg) internal returns (uint256 r, uint160 p0) {
        r = _setupRound();
        p0 = _sqrtP();
        _frontRun(true, 300);
        _exec(r, fourArg, true);
        _assertUntouched(r);

        vm.warp(qr.evaluationEnd(r));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ExecutionWindowClosed.selector, r));
        if (fourArg) vault.executeTrade(r, 6000, 100, block.timestamp);
        else vault.executeTrade(r, 6000);

        vm.expectEmit(true, false, false, false, address(vault));
        emit WavefundVault.TradeCancelled(r);
        vm.prank(stranger);
        vault.cancelUnexecutedRound(r);

        (bool executed, bool cancelled) = _state(r);
        assertFalse(executed);
        assertTrue(cancelled);
        assertFalse(qr.roundExecuted(r));
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Cancelled));
        // redeems at par whatever the long exposure was
        assertEq(qr.previewRedeem(r, alice), 100e6);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        qr.redeem(r);
        assertEq(usdc.balanceOf(alice) - before, 100e6, "par");
        // the cancelled round can neither be traded again nor reported
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.AlreadyProcessed.selector, r));
        vault.executeTrade(r, 6000);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.NotExecuted.selector, r));
        vault.reportReturn(r);
    }

    function test_afterEvaluationEnd_cancelUnexecutedRoundCancelsAtPar_twoArg() public {
        (uint256 r,) = _noExecutionThenCancel(false);
        assertEq(vault.queuedDepositsUsdc(), 5_000e6, "vault deposit untouched");
        vm.prank(carol);
        vault.cancelDepositRequest();
        assertEq(usdc.balanceOf(carol), 5_000e6, "and redeemable at par");
        assertEq(vault.queuedDepositsUsdc(), 0);
        assertEq(r, 1);
    }

    function test_afterEvaluationEnd_cancelUnexecutedRoundCancelsAtPar_fourArg() public {
        (uint256 r,) = _noExecutionThenCancel(true);
        assertEq(vault.queuedDepositsUsdc(), 5_000e6, "vault deposit untouched");
        vm.prank(carol);
        vault.cancelDepositRequest();
        assertEq(usdc.balanceOf(carol), 5_000e6, "and redeemable at par");
        assertEq(r, 1);
    }

    function test_queuedDepositSurvivesTheCancelledRoundAndConvertsInTheNextOne() public {
        (, uint160 p0) = _noExecutionThenCancel(false);
        _swapTo(p0); // price restored
        uint256 r2 = _open();
        _propose(agentA, r2, 6000);
        _toEnd(r2);
        _collapse(r2);
        _price(2000e8);
        (, uint16 bps) = qr.winningAllocation(r2);
        _execute(r2, bps);
        assertTrue(qr.roundExecuted(r2));
        assertEq(vault.queuedDepositsUsdc(), 0);
        vault.claimFor(carol);
        assertEq(vault.balanceOf(carol), 5_000e6 * 1e12, "deposit priced at the unchanged NAV");
    }

    function test_cancelUnexecutedRoundIsStillBlockedBeforeEvaluationEnd() public {
        uint256 r = _setupRound();
        _frontRun(true, 300);
        _exec(r, false, true);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ExecutionWindowOpen.selector, r));
        vault.cancelUnexecutedRound(r);
        vm.warp(qr.evaluationEnd(r) - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ExecutionWindowOpen.selector, r));
        vault.cancelUnexecutedRound(r);
        _assertUntouched(r);
    }

    function test_emergencySettleCancelsTheNeverExecutedRoundAtPar() public {
        uint256 r = _setupRound();
        _frontRun(true, 300);
        _exec(r, false, true);
        _exec(r, true, true);
        vm.warp(qr.evaluationEnd(r) + qr.EMERGENCY_SETTLE_DELAY());
        vm.prank(stranger);
        qr.settle(r, 0);
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Cancelled));
        assertFalse(qr.roundExecuted(r));
        assertEq(qr.previewRedeem(r, alice), 100e6);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        qr.redeem(r);
        assertEq(usdc.balanceOf(alice) - before, 100e6, "par");
        // the vault can no longer cancel or execute it; its own flows are still queued and refundable
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.RoundNotCollapsed.selector, r));
        vault.cancelUnexecutedRound(r);
        assertEq(vault.queuedDepositsUsdc(), 5_000e6);
        vm.prank(carol);
        vault.cancelDepositRequest();
        assertEq(usdc.balanceOf(carol), 5_000e6);
    }
}
