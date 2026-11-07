// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {QuantumBase} from "./QuantumBase.sol";
import {QuantumRound} from "../src/QuantumRound.sol";
import {ProposerRegistry} from "../src/ProposerRegistry.sol";
import {WavefundVault} from "../src/WavefundVault.sol";
import {RoundStatus} from "../src/interfaces/IQuantumRoundControl.sol";
import {MockUSDC, MockDecimalsToken} from "./mocks/MockUSDC.sol";

/// @notice markExecuted / roundExecuted, the emergency-settle split (unexecuted -> cancel at par, executed ->
///         midpoint) and the constructor asset checks.
contract QuantumRoundExecutedTest is QuantumBase {
    function _piOf(uint256 r) internal view returns (uint256 pi) {
        (,,,,,,,,,,, pi,,,,) = qr.rounds(r);
    }

    /// @dev Collapsed round where proposal 1 (60% tETH) won; alice deposited 100 USDC.
    function _collapsedWinner1() internal returns (uint256 r) {
        r = _open();
        _propose(agentA, r, 6000);
        _fund(alice, r, 100e6);
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        assertEq(_winner(r), 1);
        vm.prank(keeper);
        oracle.updatePrice(2000e8);
    }

    // ------------------------------------------------------------------ markExecuted
    function test_markExecuted_defaultsToFalse() public {
        assertFalse(qr.roundExecuted(0));
        assertFalse(qr.roundExecuted(1));
        uint256 r = _collapsedWinner1();
        assertFalse(qr.roundExecuted(r));
    }

    function test_markExecuted_onlyVaultRole() public {
        uint256 r = _collapsedWinner1();
        bytes32 role = qr.VAULT_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        qr.markExecuted(r);
        // keeper and resolver roles are not enough
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, keeper, role)
        );
        qr.markExecuted(r);
        assertFalse(qr.roundExecuted(r));
    }

    function test_markExecuted_vaultRecordsOnce() public {
        uint256 r = _collapsedWinner1();
        vm.prank(address(vault));
        qr.markExecuted(r);
        assertTrue(qr.roundExecuted(r));
        assertFalse(qr.roundExecuted(r + 1), "per round");
        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.AlreadyExecuted.selector, r));
        qr.markExecuted(r);
    }

    function test_markExecuted_onlyWhileCollapsed() public {
        // unknown round
        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.NotCollapsed.selector, 1));
        qr.markExecuted(1);
        // still trading
        uint256 r = _open();
        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.NotCollapsed.selector, r));
        qr.markExecuted(r);
        // cancelled
        _toEnd(r);
        _collapse(r);
        vm.prank(address(vault));
        qr.cancelRound(r);
        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.NotCollapsed.selector, r));
        qr.markExecuted(r);
        assertFalse(qr.roundExecuted(r));
    }

    function test_markExecuted_revertsOnceSettled() public {
        uint256 r = _collapsedWinner1();
        _settleAt(r, R_MAX);
        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(QuantumRound.NotCollapsed.selector, r));
        qr.markExecuted(r);
    }

    // ------------------------------------------------------------------ vault integration
    function test_executeTrade_marksTheRoundExecuted() public {
        uint256 r = _collapsedWinner1();
        assertFalse(qr.roundExecuted(r));
        vm.prank(keeper);
        vault.executeTrade(r, 6000);
        assertTrue(qr.roundExecuted(r));
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Collapsed));
    }

    function test_executeTrade_statusQuoWinAlsoMarksExecuted() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _toEnd(r);
        _collapse(r);
        assertEq(_winner(r), 0);
        vm.prank(keeper);
        oracle.updatePrice(2000e8);
        vm.prank(keeper);
        vault.executeTrade(r, 3333);
        assertTrue(qr.roundExecuted(r));
    }

    function test_executeTrade_slippageRevertDoesNotMarkExecutedNorCancel() public {
        uint256 r = _collapsedWinner1();
        vm.prank(keeper);
        oracle.updatePrice(1500e8); // pool still quotes 2000: outside the oracle band
        vm.prank(keeper);
        vm.expectPartialRevert(WavefundVault.SlippageBreached.selector);
        vault.executeTrade(r, 6000);
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Collapsed), "round stays collapsed");
        assertFalse(qr.roundExecuted(r));
    }

    function test_cancelUnexecutedRound_leavesRoundUnexecuted() public {
        uint256 r = _collapsedWinner1();
        vm.warp(qr.evaluationEnd(r));
        vault.cancelUnexecutedRound(r);
        assertFalse(qr.roundExecuted(r));
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Cancelled));
    }

    // ------------------------------------------------------------------ emergency settle
    function test_settle_emergencyCancelsAnUnexecutedRoundAtPar() public {
        uint256 reserveBefore = qr.protocolLiquiditySeed();
        uint256 r = _collapsedWinner1();
        vm.warp(qr.evaluationEnd(r) + qr.EMERGENCY_SETTLE_DELAY());
        vm.expectEmit(true, false, false, false, address(qr));
        emit QuantumRound.RoundCancelled(r);
        vm.prank(stranger);
        qr.settle(r, R_MAX); // the supplied value is irrelevant
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Cancelled));
        assertEq(_piOf(r), 0, "no payout ratio was set");
        // alice's whole deposit comes back at par, ignoring her 3 credits of LONG exposure
        assertEq(qr.previewRedeem(r, alice), 100e6);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        qr.redeem(r);
        assertEq(usdc.balanceOf(alice) - before, 100e6);
        // the winning seed is released back to the reserve once nobody can claim
        assertTrue(qr.liabilitiesClear(r));
        assertEq(qr.protocolLiquiditySeed(), reserveBefore);
        // and the next round can open
        uint256 r2 = _open();
        assertEq(r2, r + 1);
    }

    function test_settle_emergencyCancelDoesNotEmitSettled() public {
        uint256 r = _collapsedWinner1();
        vm.warp(qr.evaluationEnd(r) + qr.EMERGENCY_SETTLE_DELAY());
        vm.recordLogs();
        vm.prank(stranger);
        qr.settle(r, 0);
        bytes32 settledSig = keccak256("RoundSettled(uint256,uint256,uint256,bool)");
        bytes32 cancelledSig = keccak256("RoundCancelled(uint256)");
        bool sawCancelled;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != settledSig, "no RoundSettled");
            if (logs[i].topics[0] == cancelledSig) sawCancelled = true;
        }
        assertTrue(sawCancelled);
    }

    function test_settle_emergencyStillWaitsForTheDelayWhenUnexecuted() public {
        uint256 r = _collapsedWinner1();
        vm.warp(qr.evaluationEnd(r) + qr.EMERGENCY_SETTLE_DELAY() - 1);
        vm.prank(stranger);
        vm.expectRevert(QuantumRound.NotAuthorizedToSettle.selector);
        qr.settle(r, R_MAX);
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Collapsed));
    }

    function test_settle_emergencySettlesAnExecutedRoundAtTheMidpoint() public {
        uint256 r = _collapsedWinner1();
        vm.prank(keeper);
        vault.executeTrade(r, 6000);
        vm.warp(qr.evaluationEnd(r) + qr.EMERGENCY_SETTLE_DELAY());
        vm.expectEmit(true, false, false, true, address(qr));
        emit QuantumRound.RoundSettled(r, (R_MIN + R_MAX) / 2, 0.5e18, true);
        vm.prank(stranger);
        qr.settle(r, R_MAX);
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Settled));
        assertEq(_piOf(r), 0.5e18);
    }

    function test_settle_resolverPathIsUnaffectedByTheExecutedFlag() public {
        // a RESOLVER_ROLE caller settles with the supplied value even if the round was never marked executed
        uint256 r = _collapsedWinner1();
        _settleAt(r, R_MAX);
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Settled));
        assertEq(_piOf(r), ONE);
    }

    // ------------------------------------------------------------------ constructor asset checks
    function test_constructor_revertsWhenRegistryBondAssetDiffersFromRoundAsset() public {
        MockUSDC other = new MockUSDC(); // 6 decimals, different address
        vm.expectRevert(
            abi.encodeWithSelector(QuantumRound.RegistryAssetMismatch.selector, address(usdc), address(other))
        );
        new QuantumRound(address(this), IERC20(address(other)), tokens, registry, adapter);
    }

    function test_constructor_acceptsMatchingRegistryAsset() public {
        QuantumRound q = new QuantumRound(address(this), IERC20(address(usdc)), tokens, registry, adapter);
        assertEq(address(q.usdc()), address(registry.usdc()));
    }

    function test_constructor_roundAssetMustHaveSixDecimals() public {
        MockDecimalsToken t18 = new MockDecimalsToken(18);
        vm.expectRevert(QuantumRound.InvalidParameters.selector);
        new QuantumRound(address(this), IERC20(address(t18)), tokens, registry, adapter);
    }
}
