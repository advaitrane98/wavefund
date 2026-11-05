// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {WaveHook} from "../src/WaveHook.sol";
import {IWaveHook} from "../src/interfaces/IWaveHook.sol";
import {WaveBase} from "./WaveBase.sol";
import {HookActor, MockERC20} from "./mocks/HookActor.sol";

/// @notice Time gating and tick-range gating of the hook, driven by a raw unlock router bound as hook2's adapter.
contract WaveHookGatingTest is WaveBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    HookActor internal actor;
    WaveHook internal hook2;
    MockERC20 internal tLo;
    MockERC20 internal tHi;
    uint64 internal t0;
    uint64 internal start;
    uint64 internal end;
    PoolKey internal k;

    function setUp() public override {
        super.setUp();
        actor = new HookActor(pm);
        hook2 = _deployHookAt(_hookAddr(0x6001), address(actor));
        MockERC20 a = new MockERC20("A");
        MockERC20 b = new MockERC20("B");
        (tLo, tHi) = address(a) < address(b) ? (a, b) : (b, a);
        tLo.mint(address(actor), 1e30);
        tHi.mint(address(actor), 1e30);
        t0 = uint64(_now());
    }

    function _market(bool longIs0, uint64 s) internal {
        k = _keyFor(address(tLo), address(tHi), address(hook2));
        start = s;
        end = s + 1 days;
        actor.register(IWaveHook(address(hook2)), k, 1, 1, longIs0 ? address(tLo) : address(tHi), s, end, 1 hours, 0.5e18);
        pm.initialize(k, Q96);
    }

    function _fail(bytes4 sel, bytes memory inner) internal view returns (bytes memory) {
        return _hookFail(address(hook2), sel, inner);
    }

    function _notOpen() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(WaveHook.TradingNotOpen.selector);
    }

    function _swap(bool zfo, int256 amt) internal {
        actor.swap(k, zfo, amt, zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }

    // ------------------------------------------------------------------ start boundary
    function test_BeforeTradingStart_NothingAllowed_ExactlyStartAllowed() public {
        _market(true, t0 + 1000);
        vm.expectRevert(_fail(IHooks.beforeSwap.selector, _notOpen()));
        _swap(true, -1e15);
        vm.expectRevert(_fail(IHooks.beforeAddLiquidity.selector, _notOpen()));
        actor.modify(k, -45900, 45900, 1e18);

        vm.warp(t0 + 999);
        vm.expectRevert(_fail(IHooks.beforeAddLiquidity.selector, _notOpen()));
        actor.modify(k, -45900, 45900, 1e18);

        vm.warp(t0 + 1000); // exactly tradingStart: open
        actor.modify(k, -45900, 45900, 1e18);
        _swap(true, -1e15);
        assertLt(hook2.pLong(k.toId()), 0.5e18, "LONG is currency0: selling token0 lowers pLong");
    }

    // ------------------------------------------------------------------ end boundary
    function test_EndBoundary_ClosedForTradingOpenForRemoval() public {
        _market(true, t0);
        actor.modify(k, -45900, 45900, 1e18);
        _swap(true, -1e15);

        vm.warp(end - 1);
        _swap(false, -1e15); // last open second
        vm.expectRevert(_fail(IHooks.beforeRemoveLiquidity.selector, abi.encodeWithSelector(WaveHook.TradingNotEnded.selector)));
        actor.modify(k, -45900, 45900, -1e18);

        vm.warp(end); // exactly tradingEnd
        vm.expectRevert(_fail(IHooks.beforeSwap.selector, _notOpen()));
        _swap(true, -1e15);
        vm.expectRevert(_fail(IHooks.beforeAddLiquidity.selector, _notOpen()));
        actor.modify(k, -45900, 45900, 1e18);
        actor.modify(k, -45900, 45900, -1e18); // removal opens
        assertEq(pm.getLiquidity(k.toId()), 0);

        vm.warp(end + 365 days);
        vm.expectRevert(_fail(IHooks.beforeSwap.selector, _notOpen()));
        _swap(false, -1e15);
    }

    function test_LiquidityDeltaSignsAndPositionTicksAreValidated() public {
        _market(true, t0);
        // add outside +-45900 or with misordered ticks
        vm.expectRevert(_fail(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(WaveHook.InvalidPositionTicks.selector)));
        actor.modify(k, -45960, 45900, 1e18);
        vm.expectRevert(_fail(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(WaveHook.InvalidPositionTicks.selector)));
        actor.modify(k, -45900, 45960, 1e18);
        vm.expectRevert(_fail(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(WaveHook.InvalidPositionTicks.selector)));
        actor.modify(k, 60, 60, 1e18);
        vm.expectRevert(_fail(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(WaveHook.InvalidPositionTicks.selector)));
        actor.modify(k, 600, -600, 1e18);
        actor.modify(k, -45900, 45900, 1e18); // exact bounds are legal
        // zero-delta "poke" is routed to the remove hook, which only opens at tradingEnd and rejects delta >= 0
        vm.expectRevert(_fail(IHooks.beforeRemoveLiquidity.selector, abi.encodeWithSelector(WaveHook.TradingNotEnded.selector)));
        actor.modify(k, -45900, 45900, 0);
        vm.warp(end);
        vm.expectRevert(_fail(IHooks.beforeRemoveLiquidity.selector, abi.encodeWithSelector(WaveHook.InvalidLiquidityDelta.selector)));
        actor.modify(k, -45900, 45900, 0);
    }

    // ------------------------------------------------------------------ out-of-range protection
    function test_SwapThroughTickBoundaryRevertsInAfterSwap() public {
        _market(true, t0);
        actor.modify(k, -45900, 45900, 1e18);
        // exhaust the range and run beyond it down to the global limit
        vm.expectRevert(_fail(IHooks.afterSwap.selector, abi.encodeWithSelector(WaveHook.PriceOutOfRange.selector)));
        actor.swap(k, false, -1e24, TickMath.MAX_SQRT_PRICE - 1);
        vm.expectRevert(_fail(IHooks.afterSwap.selector, abi.encodeWithSelector(WaveHook.PriceOutOfRange.selector)));
        actor.swap(k, true, -1e24, TickMath.MIN_SQRT_PRICE + 1);
        // pool untouched
        (uint160 px,,,) = pm.getSlot0(k.toId());
        assertEq(uint256(px), uint256(Q96));
    }

    function test_SwapStoppingExactlyAtTickBoundIsAccepted() public {
        _market(true, t0);
        actor.modify(k, -45900, 45900, 1e18);
        actor.swap(k, false, -1e24, TickMath.getSqrtPriceAtTick(45900));
        uint256 p = hook2.pLong(k.toId());
        assertLe(p, 0.99e18);
        assertGt(p, 0.98e18);
        // the price limit equals the boundary: swapping on in the same direction is refused by the pool/hook path
        vm.expectRevert();
        actor.swap(k, false, -1e15, TickMath.MAX_SQRT_PRICE - 1);
    }

    // ------------------------------------------------------------------ currency ordering
    function _directionCheck(bool longIs0) internal {
        _market(longIs0, t0);
        PoolId id = k.toId();
        actor.modify(k, -45900, 45900, 1e18);
        uint256 p = hook2.pLong(id);
        assertEq(p, 0.5e18);
        _swap(true, -1e15); // zeroForOne: price of token0 in token1 falls
        uint256 p1 = hook2.pLong(id);
        if (longIs0) assertLt(p1, p, "LONG=token0 sold -> pLong falls");
        else assertGt(p1, p, "LONG=token1 -> pLong rises");
        assertEq(hook2.pLong(id) + hook2.pShort(id), 1e18);
        _swap(false, -3e15);
        uint256 p2 = hook2.pLong(id);
        if (longIs0) assertGt(p2, p1);
        else assertLt(p2, p1);
        assertEq(hook2.pLong(id) + hook2.pShort(id), 1e18);
        assertGe(p2, 0.01e18);
        assertLe(p2, 0.99e18);
        IWaveHook.PoolData memory d = hook2.poolDetails(id);
        assertEq(d.longIsCurrency0, longIs0);
        assertEq(d.lastProbability, p2, "last observation tracks spot");
    }

    function test_HookLevelOrdering_LongIsCurrency0() public {
        _directionCheck(true);
    }

    function test_HookLevelOrdering_LongIsCurrency1() public {
        _directionCheck(false);
    }
}
