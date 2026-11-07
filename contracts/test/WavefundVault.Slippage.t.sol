// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {VaultBase} from "./VaultBase.sol";
import {WavefundVault} from "../src/WavefundVault.sol";
import {RoundStatus} from "../src/interfaces/IQuantumRoundControl.sol";

/// @notice Default/ceiling/setter for the swap tolerance, the keeper overload, and the oracle-band price limit.
contract WavefundVaultSlippageTest is VaultBase {
    PoolSwapTest internal swapRouter;

    function setUp() public override {
        super.setUp();
        swapRouter = new PoolSwapTest(pm);
        usdc.approve(address(swapRouter), type(uint256).max);
        teth.approve(address(swapRouter), type(uint256).max);
    }

    function _state(uint256 r) internal view returns (bool executed, bool cancelled) {
        (,,,,, executed,, cancelled) = vault.roundState(r);
    }

    /// @dev Moves the pool price of tETH by `bps` (up if `up`) with an external swap that stops at the target.
    function _movePool(bool up, uint256 bps) internal {
        PoolKey memory key;
        (key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks) = vault.poolKey();
        // price of tETH in USDC rises when tETH is bought (USDC in)
        bool usdcIn = up;
        bool zeroForOne = usdcIn == vault.usdcIsCurrency0();
        (uint160 sqrtP,,,) = _slot0(key);
        // sqrt(price) scales by sqrt(1 +- bps); sqrtP rises iff price(token1/token0) rises
        bool sqrtUp = (up != vault.usdcIsCurrency0());
        uint256 f = sqrtUp ? 10_000 + bps : 10_000;
        uint256 g = sqrtUp ? 10_000 : 10_000 + bps;
        // target = sqrtP * sqrt(f/g)
        uint256 target = Math.sqrt(Math.mulDiv(uint256(sqrtP) * uint256(sqrtP), f, g));
        require(zeroForOne == (target < sqrtP), "direction");
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(1e24), sqrtPriceLimitX96: uint160(target)}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _slot0(PoolKey memory key) internal view returns (uint160 p, int24 t, uint24 a, uint24 b) {
        bytes32 id = keccak256(abi.encode(key));
        (bool ok, bytes memory ret) = address(pm).staticcall(abi.encodeWithSignature("extsload(bytes32)", _slotOf(id)));
        require(ok, "extsload");
        uint256 word = abi.decode(ret, (uint256));
        p = uint160(word);
        t = int24(uint24(word >> 160));
        a = 0;
        b = 0;
    }

    function _slotOf(bytes32 poolId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(poolId, bytes32(uint256(6)))); // PoolManager._pools mapping slot
    }

    function _spot() internal view returns (uint256) {
        return vault.spotPriceTEthInUsdc();
    }

    // ------------------------------------------------------------------ parameters
    function test_defaults() public view {
        assertEq(vault.maxSlippageBps(), 100, "1% default");
        assertEq(vault.MAX_SLIPPAGE_CAP_BPS(), 500, "5% hard cap");
    }

    function test_setMaxSlippageBps_adminOnlyAndCapped() public {
        vm.expectEmit(false, false, false, true, address(vault));
        emit WavefundVault.MaxSlippageUpdated(250);
        vault.setMaxSlippageBps(250);
        assertEq(vault.maxSlippageBps(), 250);
        vault.setMaxSlippageBps(500); // at the cap
        assertEq(vault.maxSlippageBps(), 500);
        vault.setMaxSlippageBps(0);
        assertEq(vault.maxSlippageBps(), 0);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.InvalidSlippage.selector, 501));
        vault.setMaxSlippageBps(501);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.InvalidSlippage.selector, type(uint16).max));
        vault.setMaxSlippageBps(type(uint16).max);
        assertEq(vault.maxSlippageBps(), 0, "failed sets leave the value alone");
    }

    function test_setMaxSlippageBps_nonAdminReverts() public {
        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, keeper, adminRole)
        );
        vault.setMaxSlippageBps(300);
        assertEq(vault.maxSlippageBps(), 100);
    }

    // ------------------------------------------------------------------ keeper overload
    function test_overload_keeperOnly() public {
        uint256 r = _winner1Round();
        vm.prank(stranger);
        vm.expectRevert();
        vault.executeTrade(r, 6000, 100, block.timestamp + 1);
    }

    function test_overload_rejectsSlippageAboveTheCap() public {
        uint256 r = _winner1Round();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.InvalidSlippage.selector, 501));
        vault.executeTrade(r, 6000, 501, block.timestamp + 1);
        (bool executed, bool cancelled) = _state(r);
        assertFalse(executed);
        assertFalse(cancelled);
    }

    function test_overload_deadlineIsInclusive() public {
        uint256 r = _winner1Round();
        uint256 deadline = block.timestamp - 1;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.DeadlineExpired.selector, deadline));
        vault.executeTrade(r, 6000, 100, deadline);
        vm.prank(keeper);
        vault.executeTrade(r, 6000, 100, block.timestamp); // deadline == now still executes
        (bool executed,) = _state(r);
        assertTrue(executed);
        assertTrue(qr.roundExecuted(r));
    }

    function test_overload_slippageIsCheckedBeforeTheDeadline() public {
        uint256 r = _winner1Round();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.InvalidSlippage.selector, 600));
        vault.executeTrade(r, 6000, 600, 0);
    }

    function test_overload_zeroDeadlineAlwaysExpires() public {
        uint256 r = _winner1Round();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.DeadlineExpired.selector, 0));
        vault.executeTrade(r, 6000, 100, 0);
    }

    function test_overload_keepsTheOtherExecutionGuards() public {
        uint256 r = _winner1Round();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.WinnerMismatch.selector, 6000, 3333));
        vault.executeTrade(r, 3333, 100, block.timestamp);
        vm.prank(keeper);
        vault.executeTrade(r, 6000, 100, block.timestamp);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.AlreadyProcessed.selector, r));
        vault.executeTrade(r, 6000, 100, block.timestamp);
    }

    // ------------------------------------------------------------------ tolerance applied to the oracle band
    function test_defaultOnePercent_acceptsAPoolWithinTheBand() public {
        uint256 r = _winner1Round();
        _price(2010e8); // pool 2000 is 0.5% below the oracle
        _execute(r, 6000);
        (bool executed,) = _state(r);
        assertTrue(executed);
        assertApproxEqRel(_spot(), 2000e6, 0.01e18, "trade ends near the oracle");
    }

    /// @dev executeTrade (2-arg) must revert with SlippageBreached.
    function _executeReverts(uint256 r, uint256 bps) internal {
        vm.prank(keeper);
        vm.expectPartialRevert(WavefundVault.SlippageBreached.selector);
        vault.executeTrade(r, bps);
    }

    /// @dev A slippage revert leaves the round collapsed, uncancelled, unexecuted and the keeper able to retry.
    function _assertRoundUntouched(uint256 r) internal view {
        (bool executed, bool cancelled) = _state(r);
        assertFalse(executed, "not executed");
        assertFalse(cancelled, "not cancelled");
        assertFalse(qr.roundExecuted(r));
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Collapsed), "still collapsed");
    }

    function test_defaultOnePercent_revertsWhenThePoolIsOutsideTheBand() public {
        uint256 r = _winner1Round();
        _price(2030e8); // pool is ~1.5% below the oracle
        uint256 usdcBefore = vault.totalVaultUsdc();
        uint256 tEthBefore = vault.totalVaultTEth();
        _executeReverts(r, 6000);
        _assertRoundUntouched(r);
        assertEq(vault.totalVaultUsdc(), usdcBefore);
        assertEq(vault.totalVaultTEth(), tEthBefore);
    }

    function test_defaultOnePercent_revertsWhenThePoolIsAboveTheBand() public {
        uint256 r = _winner1Round();
        _price(1970e8); // pool is ~1.5% above the oracle
        _executeReverts(r, 6000);
        _assertRoundUntouched(r);
    }

    function test_adminSetterWidensTheDefaultTolerance() public {
        uint256 r = _winner1Round();
        _price(2030e8);
        vault.setMaxSlippageBps(300);
        _execute(r, 6000);
        (bool executed,) = _state(r);
        assertTrue(executed);
        assertTrue(qr.roundExecuted(r));
    }

    function test_adminSetterNarrowsTheDefaultTolerance() public {
        uint256 r = _winner1Round();
        _price(2010e8); // 0.5% away: fine at 1%
        vault.setMaxSlippageBps(25); // but not at 0.25%
        _executeReverts(r, 6000);
        _assertRoundUntouched(r);
    }

    function test_overloadToleranceOverridesTheDefault() public {
        uint256 r = _winner1Round();
        _price(2030e8);
        vm.prank(keeper);
        vault.executeTrade(r, 6000, 300, block.timestamp);
        (bool executed,) = _state(r);
        assertTrue(executed);
        assertEq(vault.maxSlippageBps(), 100, "the default is not changed by an override");
    }

    function test_overloadCanTightenBelowTheDefault() public {
        uint256 r = _winner1Round();
        _price(2010e8);
        vm.prank(keeper);
        vm.expectPartialRevert(WavefundVault.SlippageBreached.selector);
        vault.executeTrade(r, 6000, 25, block.timestamp);
        _assertRoundUntouched(r);
    }

    function test_overloadAtTheCapAcceptsAFourPercentDeviation() public {
        uint256 r = _winner1Round();
        _price(2080e8); // pool ~3.8% below the oracle
        vm.prank(keeper);
        vault.executeTrade(r, 6000, 500, block.timestamp);
        (bool executed,) = _state(r);
        assertTrue(executed);
    }

    function test_executionToleranceDoesNotLeakIntoTheNextRound() public {
        uint256 r = _winner1Round();
        _price(2030e8);
        vm.prank(keeper);
        vault.executeTrade(r, 6000, 300, block.timestamp);
        _settleAt(r, R_MAX);
        // next round with the plain overload-free call is back at the 1% default
        uint256 r2 = _open();
        _propose(agentA, r2, 2000);
        _fund(alice, r2, 100e6);
        _pushUp(r2, 1, alice, 3e6);
        _collapse(r2);
        _price(2200e8); // far outside 1% of any pool price
        _executeReverts(r2, 2000); // default 1% applies again
        _assertRoundUntouched(r2);
    }

    // ------------------------------------------------------------------ the price limit stops the swap inside the band
    function test_priceLimit_swapThatWouldLeaveTheBandRevertsTheCall() public {
        uint256 r = _winner1Round();
        _movePool(true, 90); // tETH ~0.9% above the oracle: inside the 1% band, but only just
        uint256 spotBefore = _spot();
        assertGt(spotBefore, 2015e6);
        assertLt(spotBefore, 2020e6);
        uint256 usdcBefore = vault.totalVaultUsdc();
        uint256 tEthBefore = vault.totalVaultTEth();
        // buying ~40k USDC of tETH would push the pool beyond +1%; the limit price makes that impossible
        _executeReverts(r, 6000);
        _assertRoundUntouched(r);
        assertEq(vault.totalVaultUsdc(), usdcBefore);
        assertEq(vault.totalVaultTEth(), tEthBefore);
        assertEq(_spot(), spotBefore, "the swap was rolled back, pool price unchanged");
    }

    function test_priceLimit_sameTradeFromAnAlignedPoolExecutesAndStaysInBand() public {
        uint256 r = _winner1Round();
        _movePool(true, 90);
        _price(int256(_spot() / 1e6 * 1e8)); // oracle follows the pool: the same trade is now well inside the band
        uint256 oracleUsd = vault.oraclePriceTEthInUsdc();
        _execute(r, 6000);
        (bool executed,) = _state(r);
        assertTrue(executed);
        uint256 spot = _spot();
        assertLe(spot, oracleUsd * 10_100 / 10_000, "ends inside the upper band edge");
        assertGt(spot, oracleUsd);
    }

    function test_priceLimit_wideningTheToleranceLetsThePushedPoolTradeThrough() public {
        uint256 r = _winner1Round();
        _movePool(true, 90);
        vm.prank(keeper);
        vault.executeTrade(r, 6000, 200, block.timestamp);
        (bool executed,) = _state(r);
        assertTrue(executed);
        assertLe(_spot(), 2000e6 * 10_200 / 10_000, "bounded by the 2% limit");
    }

    function test_priceLimit_sellsAreBoundedToo() public {
        uint256 r = _open();
        _propose(agentA, r, 1000); // 10% tETH wins: the vault must SELL tETH
        _fund(alice, r, 100e6);
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        assertEq(_winner(r), 1);
        _price(2000e8);
        _movePool(false, 90); // tETH ~0.9% below the oracle
        uint256 spotBefore = _spot();
        assertLt(spotBefore, 1985e6);
        assertGt(spotBefore, 1980e6);
        _executeReverts(r, 1000);
        _assertRoundUntouched(r);
        assertEq(_spot(), spotBefore);
    }

    function test_priceLimit_sellsExecuteWhenThePoolIsAligned() public {
        uint256 r = _open();
        _propose(agentA, r, 1000);
        _fund(alice, r, 100e6);
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        _price(2000e8);
        uint256 tEthBefore = vault.totalVaultTEth();
        _execute(r, 1000);
        (bool executed,) = _state(r);
        assertTrue(executed);
        assertLt(vault.totalVaultTEth(), tEthBefore);
        assertApproxEqAbs(vault.currentTEthBps(), 1000, 30);
        assertGe(_spot(), 2000e6 * 9_900 / 10_000, "price stays above the lower band edge");
    }

    function test_withdrawalFundingSwapIsBandGuardedToo() public {
        uint256 r = _open();
        _propose(agentA, r, 6000);
        uint256 sharesOut = (vault.totalSupply() * 9) / 10; // forces tETH to be sold to fund the exit
        vault.requestWithdraw(sharesOut);
        _toEnd(r);
        _collapse(r);
        _price(2040e8); // pool is ~2% off the oracle
        _executeReverts(r, 3333);
        _assertRoundUntouched(r);
        assertEq(vault.queuedWithdrawShares(), sharesOut, "flows rolled back and stay queued");
        assertEq(vault.currentEpoch(), 0, "no epoch consumed");
    }
}
