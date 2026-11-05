// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ProposerRegistry} from "../src/ProposerRegistry.sol";
import {BlocklistUSDC} from "./mocks/MockUSDC.sol";

/// @dev Exercises refundBond deferral + claimRefund against a USDC that rejects transfers to
/// blocklisted recipients, in both failure modes (returns false / reverts).
contract ProposerRegistryBlocklistTest is Test {
    ProposerRegistry internal reg;
    BlocklistUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal round = makeAddr("round");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new BlocklistUSDC();
        reg = new ProposerRegistry(admin, IERC20(address(usdc)));
        vm.startPrank(admin);
        reg.grantRole(reg.QUANTUM_ROUND_ROLE(), round);
        reg.setSlashTreasury(treasury);
        vm.stopPrank();

        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; i++) {
            usdc.mint(users[i], 10_000_000);
            vm.startPrank(users[i]);
            usdc.approve(address(reg), type(uint256).max);
            reg.registerAgent("agent");
            vm.stopPrank();
        }
        vm.prank(round);
        reg.lockBond(alice, 1_000_000);
    }

    function _block(bool returnFalse) internal {
        usdc.setReturnFalse(returnFalse);
        usdc.setBlocked(alice, true);
    }

    function _defers(bool returnFalse) internal {
        _block(returnFalse);
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.RefundDeferred(alice, 1_000_000);
        vm.prank(round);
        reg.refundBond(alice, 1_000_000);

        assertEq(reg.lockedBond(alice), 0);
        assertEq(reg.pendingRefund(alice), 1_000_000);
        assertEq(usdc.balanceOf(address(reg)), 1_000_000, "funds stay escrowed");
        assertEq(usdc.balanceOf(alice), 9_000_000);
    }

    // ---- deferral ----
    function test_Refund_DefersWhenTransferReturnsFalse() public {
        _defers(true);
    }

    function test_Refund_DefersWhenTransferReverts() public {
        _defers(false);
    }

    function test_Refund_DoesNotRevertForBlocklistedProposer() public {
        _block(false);
        vm.prank(round);
        reg.refundBond(alice, 1); // must not revert
        assertEq(reg.pendingRefund(alice), 1);
    }

    function test_Refund_DoesNotAffectOtherProposers() public {
        _defers(true);
        vm.prank(round);
        reg.lockBond(bob, 500_000);
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.BondRefunded(bob, 500_000, 0);
        vm.prank(round);
        reg.refundBond(bob, 500_000);
        assertEq(usdc.balanceOf(bob), 10_000_000);
        assertEq(reg.pendingRefund(bob), 0);
        assertEq(reg.pendingRefund(alice), 1_000_000);
    }

    function test_Refund_DeferralsAccumulate() public {
        _block(true);
        vm.startPrank(round);
        reg.refundBond(alice, 300_000);
        reg.refundBond(alice, 200_000);
        vm.stopPrank();
        assertEq(reg.pendingRefund(alice), 500_000);
        assertEq(reg.lockedBond(alice), 500_000);
    }

    // ---- claimRefund ----
    function _claimFlow(bool returnFalse) internal {
        _defers(returnFalse);

        // still blocklisted: claim fails and the pending balance is preserved
        vm.prank(alice);
        vm.expectRevert();
        reg.claimRefund();
        assertEq(reg.pendingRefund(alice), 1_000_000);
        assertEq(usdc.balanceOf(address(reg)), 1_000_000);

        // unblocked: claim succeeds, pays the caller only
        usdc.setBlocked(alice, false);
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.RefundClaimed(alice, 1_000_000);
        vm.prank(alice);
        reg.claimRefund();
        assertEq(reg.pendingRefund(alice), 0);
        assertEq(usdc.balanceOf(alice), 10_000_000);
        assertEq(usdc.balanceOf(address(reg)), 0);

        // cannot double-claim
        vm.prank(alice);
        vm.expectRevert(ProposerRegistry.NothingToClaim.selector);
        reg.claimRefund();
    }

    function test_ClaimRefund_AfterUnblock_FalseMode() public {
        _claimFlow(true);
    }

    function test_ClaimRefund_AfterUnblock_RevertMode() public {
        _claimFlow(false);
    }

    function test_ClaimRefund_OthersCannotClaimForProposer() public {
        _defers(true);
        vm.prank(bob);
        vm.expectRevert(ProposerRegistry.NothingToClaim.selector);
        reg.claimRefund();
        vm.prank(round);
        vm.expectRevert(ProposerRegistry.NothingToClaim.selector);
        reg.claimRefund();
        assertEq(reg.pendingRefund(alice), 1_000_000);
    }

    function test_ClaimRefund_FalseReturnRevertsWithSafeERC20Error() public {
        _defers(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc)));
        reg.claimRefund();
    }

    function test_ClaimRefund_WorksWhilePaused() public {
        _defers(true);
        usdc.setBlocked(alice, false);
        vm.prank(admin);
        reg.pause();
        vm.prank(alice);
        reg.claimRefund();
        assertEq(usdc.balanceOf(alice), 10_000_000);
    }

    // ---- slash to a blocklisted treasury ----
    function test_Slash_RevertsAtomicallyIfTreasuryBlocked() public {
        usdc.setBlocked(treasury, true);
        vm.prank(round);
        vm.expectRevert();
        reg.slashBond(alice, 1_000_000);
        assertEq(reg.lockedBond(alice), 1_000_000);
        assertEq(usdc.balanceOf(address(reg)), 1_000_000);
    }

    // ---- fuzz ----
    function testFuzz_DeferredThenClaimedConservesFunds(uint256 refund, bool returnFalse) public {
        refund = bound(refund, 0, 1_000_000);
        _block(returnFalse);
        vm.prank(round);
        reg.refundBond(alice, refund);
        assertEq(reg.lockedBond(alice), 1_000_000 - refund);
        assertEq(reg.pendingRefund(alice), refund);
        assertEq(usdc.balanceOf(address(reg)), 1_000_000);
        usdc.setBlocked(alice, false);
        if (refund > 0) {
            vm.prank(alice);
            reg.claimRefund();
            assertEq(usdc.balanceOf(alice), 9_000_000 + refund);
        }
        assertEq(usdc.balanceOf(address(reg)), 1_000_000 - refund);
        assertEq(reg.pendingRefund(alice), 0);
    }
}
