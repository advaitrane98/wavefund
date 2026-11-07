// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultBase} from "./VaultBase.sol";
import {WavefundVault} from "../src/WavefundVault.sol";

/// @notice Zero-supply bootstrap in `_processFlows`: after every shareholder used emergencyWithdraw, a pending deposit
///         becomes shares at the next executeTrade (1e6 raw USDC per 1e18 shares), with no admin action.
contract WavefundVaultBootstrapTest is VaultBase {
    using stdStorage for StdStorage;

    uint256 internal constant RATE = 1e12; // shares (1e18 units) per raw USDC, same as fundVault's first mint

    /// @dev The bootstrap holder (this test contract) escrows everything and exits in kind: supply drops to zero.
    function _fullExit() internal {
        uint256 all = vault.balanceOf(address(this));
        vault.requestWithdraw(all);
        vm.warp(block.timestamp + vault.WITHDRAW_EXIT_DELAY());
        vault.emergencyWithdraw();
        assertEq(vault.totalSupply(), 0, "every shareholder is out");
    }

    /// @dev Status-quo round on the (possibly empty) vault; returns the id and the winner's tETH bps.
    function _quietRound() internal returns (uint256 r, uint256 bps) {
        r = _statusQuoRound();
        (, uint16 b) = qr.winningAllocation(r);
        bps = b;
    }

    function _injectDust(uint256 usdcDust, uint256 tEthDust) internal {
        stdstore.target(address(vault)).sig("totalVaultUsdc()").checked_write(usdcDust);
        stdstore.target(address(vault)).sig("totalVaultTEth()").checked_write(tEthDust);
        usdc.mint(address(vault), usdcDust); // keep the accounting backed by real balances
        teth.mint(address(vault), tEthDust);
    }

    // ------------------------------------------------------------------ preconditions
    function test_emptyVaultStillRejectsNewDepositRequests() public {
        _fullExit();
        usdc.mint(carol, 1_000e6);
        vm.startPrank(carol);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(WavefundVault.NotBootstrapped.selector);
        vault.requestDeposit(1_000e6);
        vm.stopPrank();
    }

    function test_pendingDepositIsRefundableWhileTheVaultIsEmpty() public {
        _requestDeposit(carol, 5_000e6);
        _fullExit();
        assertEq(vault.queuedDepositsUsdc(), 5_000e6, "the exit does not touch queued deposits");
        assertEq(vault.totalVaultUsdc(), 0);
        vm.prank(carol);
        vault.cancelDepositRequest();
        assertEq(usdc.balanceOf(carol), 5_000e6);
    }

    // ------------------------------------------------------------------ bootstrap
    function test_pendingDepositBecomesSharesAtTheBootstrapRateWithoutAdminAction() public {
        _requestDeposit(carol, 5_000e6);
        _fullExit();
        (uint256 r, uint256 bps) = _quietRound();
        uint256 expShares = 5_000e6 * RATE;

        vm.expectEmit(true, true, false, true, address(vault));
        emit WavefundVault.FlowsProcessed(r, 0, 5_000e6, expShares, 0, 0);
        _execute(r, bps); // keeper only

        assertEq(vault.currentEpoch(), 1);
        assertEq(vault.queuedDepositsUsdc(), 0);
        assertEq(vault.depositRequest(carol), 0, "no longer pending");
        assertEq(vault.totalSupply(), expShares);
        assertEq(vault.unclaimedDepositShares(), expShares);
        assertEq(vault.totalVaultUsdc(), 5_000e6);
        assertEq(vault.totalVaultTEth(), 0);
        (uint256 dUsdc, uint256 dShares,,, uint256 dUsdcLeft, uint256 dSharesLeft,,) = vault.epochs(0);
        assertEq(dUsdc, 5_000e6);
        assertEq(dShares, expShares);
        assertEq(dUsdcLeft, 5_000e6);
        assertEq(dSharesLeft, expShares);

        (uint256 viewShares, uint256 viewUsdc) = vault.claimable(carol);
        assertEq(viewShares, expShares, "claimable view agrees");
        assertEq(viewUsdc, 0);

        vm.prank(stranger); // permissionless
        vault.claimFor(carol);
        assertEq(vault.balanceOf(carol), expShares);
        assertEq(vault.balanceOf(stranger), 0);
        assertEq(vault.unclaimedDepositShares(), 0);
        assertEq(vault.balanceOf(address(vault)), 0);
        (dUsdc,,,, dUsdcLeft, dSharesLeft,,) = vault.epochs(0);
        assertEq(dUsdcLeft, 0);
        assertEq(dSharesLeft, 0);
        assertEq(vault.sharePriceUsdc(), 1e6, "1 USDC per share, like fundVault's first mint");
        assertEq(vault.navUsdc(), 5_000e6);
        assertEq(usdc.balanceOf(address(vault)), vault.totalVaultUsdc());
        (viewShares, viewUsdc) = vault.claimable(carol);
        assertEq(viewShares, 0);
        assertEq(viewUsdc, 0);
    }

    function test_bootstrapRateMatchesFundVaultsFirstMint() public {
        _requestDeposit(carol, 2_500e6);
        _fullExit();
        uint256 snap = vm.snapshotState();
        usdc.mint(address(this), 2_500e6);
        _price(2000e8); // fundVault needs a fresh oracle answer
        uint256 funded = vault.fundVault(2_500e6, 0, alice);
        assertEq(funded, 2_500e6 * RATE, "fundVault's first mint");
        vm.revertToState(snap); // back to the empty vault with carol's deposit pending
        (uint256 r, uint256 bps) = _quietRound();
        _execute(r, bps);
        vault.claimFor(carol);
        assertEq(vault.balanceOf(carol), funded, "queue bootstrap == admin bootstrap, share for share");
    }

    function test_manyDepositorsShareTheBootstrapBatchProRata() public {
        _requestDeposit(carol, 5_000e6 + 1);
        _requestDeposit(bob, 3_000e6 + 7);
        _requestDeposit(alice, 1e6);
        _fullExit();
        (uint256 r, uint256 bps) = _quietRound();
        _execute(r, bps);
        uint256 total = (5_000e6 + 1 + 3_000e6 + 7 + 1e6);
        assertEq(vault.totalSupply(), total * RATE);
        assertEq(vault.unclaimedDepositShares(), total * RATE);
        vault.claimFor(carol);
        vault.claimFor(bob);
        assertEq(vault.balanceOf(carol), (5_000e6 + 1) * RATE);
        assertEq(vault.balanceOf(bob), (3_000e6 + 7) * RATE);
        vault.claimFor(alice);
        assertEq(vault.balanceOf(alice), 1e6 * RATE);
        assertEq(vault.unclaimedDepositShares(), 0, "nothing stays locked in the vault");
        assertEq(vault.balanceOf(address(vault)), 0);
        assertEq(
            vault.balanceOf(carol) + vault.balanceOf(bob) + vault.balanceOf(alice), vault.totalSupply(), "all minted"
        );
    }

    function test_bootstrappedHolderCanDepositAgainAndTheFirstBatchIsCollectedFirst() public {
        _requestDeposit(carol, 5_000e6);
        _fullExit();
        (uint256 r, uint256 bps) = _quietRound();
        _execute(r, bps);
        // a new request settles the processed one first (vault is no longer empty)
        _requestDeposit(carol, 1_000e6);
        assertEq(vault.balanceOf(carol), 5_000e6 * RATE, "previous batch collected");
        assertEq(vault.depositRequest(carol), 1_000e6);
        assertEq(vault.currentEpoch(), 1);
        vm.prank(carol);
        vault.cancelDepositRequest();
        assertEq(usdc.balanceOf(carol), 1_000e6);
    }

    function test_bootstrappedRoundCanBeReportedAndSettled() public {
        _requestDeposit(carol, 5_000e6);
        _fullExit();
        (uint256 r, uint256 bps) = _quietRound();
        _execute(r, bps);
        (uint256 startValue,,,,, bool executed,,) = vault.roundState(r);
        assertTrue(executed);
        assertTrue(qr.roundExecuted(r));
        assertEq(startValue, 5_000e6, "NAV at decision is the bootstrapped deposit");
        vm.warp(qr.evaluationEnd(r));
        _price(2000e8);
        vault.reportReturn(r);
        assertEq(_realised(r), ONE, "unchanged NAV");
    }

    function test_bootstrapBatchIsTradedTowardAWinningAllocation() public {
        _requestDeposit(carol, 10_000e6);
        _fullExit();
        uint256 r = _open();
        _propose(agentA, r, 6000);
        _fund(alice, r, 100e6);
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        assertEq(_winner(r), 1);
        _price(2000e8);
        _execute(r, 6000);
        assertEq(vault.totalSupply(), 10_000e6 * RATE);
        // the freshly bootstrapped USDC is moved toward 60% tETH in the same call
        assertGt(vault.totalVaultTEth(), 0);
        assertApproxEqAbs(vault.currentTEthBps(), 6000, 30);
        vault.claimFor(carol);
        assertEq(vault.balanceOf(carol), 10_000e6 * RATE);
    }

    // ------------------------------------------------------------------ leftover accounted dust
    function test_leftoverAccountedDustDoesNotChangeTheBootstrapRate() public {
        _requestDeposit(carol, 5_000e6);
        _fullExit();
        _injectDust(7, 3);
        assertEq(vault.totalSupply(), 0);
        (uint256 r, uint256 bps) = _quietRound();
        _execute(r, bps);
        uint256 expShares = 5_000e6 * RATE;
        assertEq(vault.totalSupply(), expShares, "dust neither dilutes nor inflates the mint");
        (, uint256 dShares,,,,,,) = vault.epochs(0);
        assertEq(dShares, expShares);
        assertEq(vault.totalVaultUsdc(), 5_000e6 + 7, "dust stays accounted and now belongs to the new holders");
        assertEq(vault.totalVaultTEth(), 3);
        (uint256 viewShares,) = vault.claimable(carol);
        assertEq(viewShares, expShares);
        vault.claimFor(carol);
        assertEq(vault.balanceOf(carol), expShares);
        assertEq(vault.unclaimedDepositShares(), 0);
        assertGe(vault.sharePriceUsdc(), 1e6);
        assertEq(usdc.balanceOf(address(vault)), vault.totalVaultUsdc(), "accounting is backed");
        assertEq(teth.balanceOf(address(vault)), vault.totalVaultTEth());
    }

    function test_leftoverDustWithSeveralDepositorsStillSettlesEveryone() public {
        _requestDeposit(carol, 4_000e6 + 3);
        _requestDeposit(bob, 1_000e6 + 5);
        _fullExit();
        _injectDust(123_456, 1e9);
        (uint256 r, uint256 bps) = _quietRound();
        _execute(r, bps);
        uint256 total = 5_000e6 + 8;
        assertEq(vault.totalSupply(), total * RATE);
        vault.claimFor(carol);
        vault.claimFor(bob);
        assertEq(vault.balanceOf(carol), (4_000e6 + 3) * RATE);
        assertEq(vault.balanceOf(bob), (1_000e6 + 5) * RATE);
        assertEq(vault.unclaimedDepositShares(), 0);
        assertEq(vault.totalVaultUsdc(), total + 123_456);
    }

    function test_noPendingDepositKeepsAnEmptyVaultEmpty() public {
        _fullExit();
        (uint256 r, uint256 bps) = _quietRound();
        _execute(r, bps);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.currentEpoch(), 0, "no batch to process");
    }
}
