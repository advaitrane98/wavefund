// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {WaveHook} from "../src/WaveHook.sol";
import {IWaveHook} from "../src/interfaces/IWaveHook.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {WaveBase} from "./WaveBase.sol";

/// @notice Probability bounds, final-window TWAPs, multi-market isolation and griefing, through the real adapter.
contract WaveHookTwapTest is WaveBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant SEED = 5_000_000;
    uint256 internal t0;
    uint256 internal fwStart;
    uint256 internal end;

    function setUp() public override {
        super.setUp();
        t0 = _now();
        end = t0 + 1 days;
        fwStart = end - 1 hours;
    }

    function _check(uint256 r, uint256 p) internal view returns (uint256 pl) {
        uint256 ps;
        (pl, ps) = adapter.probabilities(r, p);
        assertEq(pl + ps, 1e18, "complementary");
        assertEq(hook.pLong(_id(r, p)), pl);
        assertEq(hook.pShort(_id(r, p)), ps);
        assertGe(pl, 0.01e18, "pLong >= 1%");
        assertLe(pl, 0.99e18, "pLong <= 99%");
        assertGe(ps, 0.01e18);
        assertLe(ps, 0.99e18);
        assertApproxEqRel(adapter.spotPrice(r, p), pl * 1e18 / ps, 1e6, "price == pLong / pShort");
    }

    // ------------------------------------------------------------------ probability
    function _boundedAndComplementary(bool longIs0) internal {
        uint256 p = _openOrdering(R, 1, longIs0, SEED);
        uint256 prev = _check(R, p);
        assertEq(prev, 0.5e18);
        bool[8] memory sides = [true, true, false, false, true, false, true, false];
        uint256[8] memory amts = [uint256(1), 1_000_000, 3_000_000, 1, 500_000, 10_000_000, 2_000_000, 100];
        for (uint256 i; i < sides.length; ++i) {
            _buy(alice, R, p, amts[i], sides[i]);
            uint256 cur = _check(R, p);
            if (sides[i]) assertGt(cur, prev, "LONG buy raises pLong");
            else assertLt(cur, prev, "SHORT buy lowers pLong");
            prev = cur;
        }
        // selling LONG pushes pLong down again, selling SHORT pushes it up
        uint256 before_ = prev;
        _sell(alice, R, p, _bal(_long(R, p), alice), true);
        assertLt(_check(R, p), before_);
        before_ = _pLong(R, p);
        _sell(alice, R, p, _bal(_short(R, p), alice), false);
        assertGt(_check(R, p), before_);
    }

    function test_LongProbabilityIsBoundedAndComplementary() public {
        _boundedAndComplementary(true);
        _boundedAndComplementary(false);
    }

    function test_LongProbabilityIsBoundedAndComplementary_LongIsCurrency0() public {
        _boundedAndComplementary(true);
    }

    function test_LongProbabilityIsBoundedAndComplementary_LongIsCurrency1() public {
        _boundedAndComplementary(false);
    }

    // ------------------------------------------------------------------ boundaries
    /// @dev Largest buy that still fits before the +-45900 tick limit, found by doubling + bisection on the quote.
    function _maxBuy(uint256 r, uint256 p, bool long_) internal view returns (uint256 lo) {
        lo = SEED;
        uint256 hi;
        for (uint256 i; i < 60; ++i) {
            try this.quote(r, p, lo * 2, long_) {
                lo *= 2;
            } catch {
                hi = lo * 2;
                break;
            }
        }
        require(hi != 0, "no bound found");
        for (uint256 i; i < 40; ++i) {
            uint256 mid = (lo + hi) / 2;
            try this.quote(r, p, mid, long_) {
                lo = mid;
            } catch {
                hi = mid;
            }
        }
    }

    function quote(uint256 r, uint256 p, uint256 c, bool long_) external view returns (uint256) {
        return _quoteBuy(r, p, c, long_);
    }

    function _boundary(bool longIs0, bool long_) internal {
        uint256 p = _openOrdering(R, 1, longIs0, SEED);
        uint256 maxCredits = _maxBuy(R, p, long_);
        emit log_named_uint(long_ ? "max LONG buy (credits)" : "max SHORT buy (credits)", maxCredits);

        // one step too big reverts with InsufficientDepth and leaves the pool untouched
        uint256 pBefore = _pLong(R, p);
        qr.fund(alice, R, p, maxCredits * 2);
        vm.expectPartialRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
        qr.buy(alice, R, p, maxCredits * 2, long_, 0);
        vm.expectPartialRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
        qr.buy(alice, R, p, maxCredits + maxCredits / 100, long_, 0);
        assertEq(_pLong(R, p), pBefore);

        // the largest fitting buy succeeds and lands inside the bounds, close to the edge
        qr.buy(alice, R, p, maxCredits, long_, 0);
        uint256 pl = _check(R, p);
        emit log_named_decimal_uint("pLong at the edge", pl, 18);
        if (long_) {
            assertLe(pl, 0.99e18);
            assertGt(pl, 0.985e18, "edge reached");
        } else {
            assertGe(pl, 0.01e18);
            assertLt(pl, 0.015e18, "edge reached");
        }
        // more of the same direction is refused (at most 1 credit of room can remain)
        qr.fund(bob, R, p, 1_000_000);
        vm.expectPartialRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
        qr.buy(bob, R, p, 1_000_000, long_, 0);
        // the opposite direction still works from the edge, and everything stays in bounds
        _buy(bob, R, p, 1_000_000, !long_);
        _check(R, p);
    }

    function test_BoundaryTradesCannotExceedBounds_LongIs0_BuyLong() public {
        _boundary(true, true);
    }

    function test_BoundaryTradesCannotExceedBounds_LongIs0_BuyShort() public {
        _boundary(true, false);
    }

    function test_BoundaryTradesCannotExceedBounds_LongIs1_BuyLong() public {
        _boundary(false, true);
    }

    function test_BoundaryTradesCannotExceedBounds_LongIs1_BuyShort() public {
        _boundary(false, false);
    }

    // ------------------------------------------------------------------ trading window via the adapter
    function test_AdapterTradesAtOrAfterEndAreRejectedByHook() public {
        _open(R, P, SEED);
        vm.warp(end - 1);
        _buy(alice, R, P, 1_000, true);
        vm.warp(end);
        qr.fund(alice, R, P, 1_000);
        vm.expectRevert(_hookFail(IHooks.beforeSwap.selector, abi.encodeWithSelector(WaveHook.TradingNotOpen.selector)));
        qr.buy(alice, R, P, 1_000, true, 0);
        uint256 amt = _bal(_long(R, P), alice) / 2;
        vm.expectRevert(_hookFail(IHooks.beforeSwap.selector, abi.encodeWithSelector(WaveHook.TradingNotOpen.selector)));
        qr.sell(alice, R, P, amt, true, 0);
    }

    function test_SeedingOutsideTheWindowReverts() public {
        // before tradingStart: registration is fine but the liquidity add is gated
        qr.setTiming(R, 2, uint64(t0 + 1000), uint64(t0 + 1 days), 1 hours);
        vm.expectRevert(_hookFail(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(WaveHook.TradingNotOpen.selector)));
        qr.openMarket(R, 2, SEED);
        vm.warp(t0 + 1000);
        qr.openMarket(R, 2, SEED); // exactly tradingStart works

        // tradingEnd <= now is refused at registration
        qr.setTiming(R, 3, uint64(t0), uint64(t0 + 1000), 100);
        vm.expectRevert(WaveHook.InvalidTradingWindow.selector);
        qr.openMarket(R, 3, SEED);
        // bad final windows
        qr.setTiming(R, 4, uint64(t0 + 1000), uint64(t0 + 5000), 0);
        vm.expectRevert(WaveHook.InvalidFinalWindow.selector);
        qr.openMarket(R, 4, SEED);
        qr.setTiming(R, 5, uint64(t0 + 1000), uint64(t0 + 5000), 4001);
        vm.expectRevert(WaveHook.InvalidFinalWindow.selector);
        qr.openMarket(R, 5, SEED);
    }

    // ------------------------------------------------------------------ TWAP
    function _twaps(uint256 r, uint256 p) internal view returns (uint256 pt, uint256 prt) {
        pt = adapter.probabilityTwap(r, p);
        prt = adapter.twap(r, p);
        assertEq(pt, hook.finalWindowTwap(_id(r, p)));
        assertEq(prt, hook.finalWindowPriceTwap(_id(r, p)));
    }

    function test_TwapHandComputed() public {
        _open(R, P, SEED);
        PoolId id = _id(R, P);
        // pre-window trade: does not accumulate
        vm.warp(t0 + 1 hours);
        _buy(alice, R, P, 1_000_000, true);
        uint256 pA = _pLong(R, P);
        uint256 qA = adapter.spotPrice(R, P);
        assertEq(hook.poolDetails(id).finalWindowCumulative, 0, "nothing accumulated before the window");
        assertEq(hook.poolDetails(id).finalWindowCumulativePrice, 0);

        // 10 min into the window
        vm.warp(fwStart + 600);
        _buy(bob, R, P, 700_000, false);
        uint256 p1 = _pLong(R, P);
        uint256 q1 = adapter.spotPrice(R, P);
        uint256 cum = pA * 600;
        uint256 cumQ = qA * 600;
        assertEq(hook.poolDetails(id).finalWindowCumulative, cum, "first in-window trade integrates the carried value");
        assertEq(hook.poolDetails(id).finalWindowCumulativePrice, cumQ);

        // 25 min
        vm.warp(fwStart + 1500);
        _buy(carol, R, P, 300_000, true);
        uint256 p2 = _pLong(R, P);
        uint256 q2 = adapter.spotPrice(R, P);
        cum += p1 * 900;
        cumQ += q1 * 900;

        // 35 min: a sale
        vm.warp(fwStart + 2100);
        _sell(alice, R, P, _bal(_long(R, P), alice) / 4, true);
        uint256 p3 = _pLong(R, P);
        uint256 q3 = adapter.spotPrice(R, P);
        cum += p2 * 600;
        cumQ += q2 * 600;
        assertEq(hook.poolDetails(id).finalWindowCumulative, cum);
        assertEq(hook.poolDetails(id).finalWindowCumulativePrice, cumQ);

        // last value is extrapolated to tradingEnd; the TWAP is the same at every query time after the last trade
        uint256 expP = (cum + p3 * 1500) / 3600;
        uint256 expQ = (cumQ + q3 * 1500) / 3600;
        emit log_named_decimal_uint("pLong sequence p1 (SHORT buy)", p1, 18);
        emit log_named_decimal_uint("probability TWAP", expP, 18);
        (uint256 pt, uint256 prt) = _twaps(R, P);
        assertEq(pt, expP, "probability TWAP");
        assertEq(prt, expQ, "price TWAP");
        vm.warp(fwStart + 3000);
        (pt, prt) = _twaps(R, P);
        assertEq(pt, expP);
        assertEq(prt, expQ);
        vm.warp(end);
        (pt, prt) = _twaps(R, P);
        assertEq(pt, expP);
        assertEq(prt, expQ);
        vm.warp(end + 30 days);
        (pt, prt) = _twaps(R, P);
        assertEq(pt, expP, "no drift after the end");
        // TWAP lies between the extreme observed probabilities
        uint256 lo = pA < p1 ? pA : p1;
        lo = lo < p2 ? lo : p2;
        lo = lo < p3 ? lo : p3;
        uint256 hi = pA > p1 ? pA : p1;
        hi = hi > p2 ? hi : p2;
        hi = hi > p3 ? hi : p3;
        assertGe(pt, lo);
        assertLe(pt, hi);
        // closing freezes the same numbers
        (uint256 cp, uint256 cq) = adapter.closeTwapWindow(R, P);
        assertEq(cp, expP);
        assertEq(cq, expQ);
    }

    function test_NoTradeInWindow_TwapEqualsLastProbability() public {
        _open(R, P, SEED);
        (uint256 pt, uint256 prt) = _twaps(R, P);
        assertEq(pt, 0.5e18, "untraded market");
        assertEq(prt, 1e18);
        vm.warp(t0 + 2 hours);
        _buy(alice, R, P, 2_000_000, false);
        uint256 p = _pLong(R, P);
        uint256 q = adapter.spotPrice(R, P);
        uint256[5] memory ts = [t0 + 2 hours, fwStart - 1, fwStart + 1800, end - 1, end + 5 days];
        for (uint256 i; i < ts.length; ++i) {
            vm.warp(ts[i]);
            (pt, prt) = _twaps(R, P);
            assertEq(pt, p, "TWAP == last probability");
            assertEq(prt, q, "price TWAP == last price");
        }
    }

    function test_TradeAtLastSecondBarelyMovesTwap() public {
        _open(R, P, SEED);
        vm.warp(end - 1);
        _buy(alice, R, P, 4_000_000, true);
        uint256 p = _pLong(R, P);
        assertGt(p, 0.75e18);
        uint256 exp = (0.5e18 * 3599 + p * 1) / 3600;
        (uint256 pt,) = _twaps(R, P);
        assertEq(pt, exp);
        assertLt(pt - 0.5e18, 0.001e18, "one second of a big move barely shows");
    }

    function test_TradeExactlyAtWindowStart_ExtrapolatesNewValueOverWholeWindow() public {
        _open(R, P, SEED);
        vm.warp(fwStart);
        _buy(alice, R, P, 1_000_000, true);
        uint256 p = _pLong(R, P);
        (uint256 pt,) = _twaps(R, P);
        assertEq(pt, p, "new value holds for the whole window");
        assertEq(hook.poolDetails(_id(R, P)).finalWindowCumulative, 0);
    }

    function test_WindowEqualToWholeDuration() public {
        _openWith(R, 2, SEED, uint64(t0), uint64(t0 + 7200), 7200);
        vm.warp(t0 + 1000);
        _buy(alice, R, 2, 1_000_000, true);
        uint256 p1 = _pLong(R, 2);
        vm.warp(t0 + 4000);
        _buy(alice, R, 2, 1_000_000, false);
        uint256 p2 = _pLong(R, 2);
        (uint256 pt,) = _twaps(R, 2);
        assertEq(pt, (0.5e18 * 1000 + p1 * 3000 + p2 * 3200) / 7200);
    }

    function _obs(Vm.Log[] memory logs) internal view returns (Vm.Log[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == WaveHook.FinalWindowObservation.selector) ++n;
        }
        out = new Vm.Log[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == WaveHook.FinalWindowObservation.selector) {
                out[n++] = logs[i];
            }
        }
    }

    function test_FinalWindowObservationEventOnlyInsideWindow() public {
        _open(R, P, SEED);
        PoolId id = _id(R, P);
        vm.warp(t0 + 1 hours);
        vm.recordLogs();
        _buy(alice, R, P, 100_000, true);
        assertEq(_obs(vm.getRecordedLogs()).length, 0, "no event before the window");

        vm.warp(fwStart - 1);
        vm.recordLogs();
        _buy(alice, R, P, 100_000, true);
        assertEq(_obs(vm.getRecordedLogs()).length, 0, "no event one second before the window");
        uint256 pPrev = _pLong(R, P);

        vm.warp(fwStart); // first second of the window: event, nothing integrated yet
        vm.recordLogs();
        _buy(alice, R, P, 100_000, false);
        Vm.Log[] memory o = _obs(vm.getRecordedLogs());
        assertEq(o.length, 1, "one event at the window's first second");
        assertEq(o[0].topics[1], PoolId.unwrap(id));
        (uint256 ts, uint256 pl, uint256 px, uint256 cum, uint256 cumPx) =
            abi.decode(o[0].data, (uint256, uint256, uint256, uint256, uint256));
        assertEq(ts, fwStart);
        assertEq(pl, _pLong(R, P));
        assertEq(px, adapter.spotPrice(R, P));
        assertEq(cum, 0);
        assertEq(cumPx, 0);

        vm.warp(fwStart + 100);
        vm.recordLogs();
        uint256 pMid = _pLong(R, P);
        _buy(alice, R, P, 100_000, true);
        o = _obs(vm.getRecordedLogs());
        assertEq(o.length, 1);
        (ts, pl, px, cum, cumPx) = abi.decode(o[0].data, (uint256, uint256, uint256, uint256, uint256));
        assertEq(ts, fwStart + 100);
        assertEq(cum, pMid * 100, "integral of the previous observation");
        assertEq(pl, _pLong(R, P));
        assertTrue(pPrev != pMid);
    }

    // ------------------------------------------------------------------ many markets, one hook
    function _h(uint256 r, uint256 p) internal view returns (bytes32) {
        return keccak256(abi.encode(hook.poolDetails(_id(r, p))));
    }

    function test_MarketsSharingOneHookAreIsolated() public {
        // A: 1d window / 1h final;  B: 3h / 30min;  C (other round): 2d / 6h
        _open(1, 1, SEED);
        _openWith(1, 2, 2_000_000, uint64(t0), uint64(t0 + 3 hours), 30 minutes);
        _openWith(2, 1, 8_000_000, uint64(t0), uint64(t0 + 2 days), 6 hours);

        bytes32 hA = _h(1, 1);
        bytes32 hB = _h(1, 2);
        bytes32 hC = _h(2, 1);
        assertTrue(hA != hB && hB != hC);

        vm.warp(t0 + 10 minutes);
        _buy(alice, 1, 1, 500_000, true);
        assertEq(_h(1, 2), hB, "B untouched by A trade");
        assertEq(_h(2, 1), hC, "C untouched by A trade");
        assertTrue(_h(1, 1) != hA);
        hA = _h(1, 1);

        uint256 bFw = t0 + 3 hours - 30 minutes;
        vm.warp(bFw + 300);
        _buy(bob, 1, 2, 400_000, false);
        assertEq(_h(1, 1), hA, "A untouched by B trade");
        assertEq(_h(2, 1), hC, "C untouched by B trade");
        uint256 pB = _pLong(1, 2);
        assertLt(pB, 0.5e18);
        assertEq(hook.poolDetails(_id(1, 2)).finalWindowCumulative, 0.5e18 * 300);

        uint256 cFw = t0 + 2 days - 6 hours;
        vm.warp(cFw + 3600);
        _buy(carol, 2, 1, 3_000_000, true);
        assertEq(_h(1, 1), hA, "A untouched by C trade");
        uint256 pC = _pLong(2, 1);
        assertGt(pC, 0.5e18);
        // B's window has long ended; its TWAP is still its own hand-computed value
        assertEq(adapter.probabilityTwap(1, 2), (0.5e18 * 300 + pB * 1500) / 1800);
        assertEq(adapter.probabilityTwap(2, 1), (0.5e18 * 3600 + pC * (6 hours - 3600)) / 6 hours);
        // A has had a single pre-window trade: TWAP is that value
        assertEq(adapter.probabilityTwap(1, 1), _pLong(1, 1));
        // B's window ended long ago: closed for trading
        qr.fund(alice, 1, 2, 1000);
        vm.expectRevert(_hookFail(IHooks.beforeSwap.selector, abi.encodeWithSelector(WaveHook.TradingNotOpen.selector)));
        qr.buy(alice, 1, 2, 1000, true, 0);
    }

    function test_DifferentWindowsAreEnforcedPerMarket() public {
        _openWith(1, 1, SEED, uint64(t0), uint64(t0 + 3 hours), 1 hours);
        _openWith(1, 2, SEED, uint64(t0), uint64(t0 + 6 hours), 1 hours);
        vm.warp(t0 + 3 hours);
        qr.fund(alice, 1, 1, 10);
        vm.expectRevert(_hookFail(IHooks.beforeSwap.selector, abi.encodeWithSelector(WaveHook.TradingNotOpen.selector)));
        qr.buy(alice, 1, 1, 10, true, 0);
        _buy(alice, 1, 2, 10, true); // other market still open
        qr.finalize(1, 1); // and the first one can be finalized while the second still trades
        vm.expectRevert(WaveV4ProposalMarket.TradingNotEnded.selector);
        qr.finalize(1, 2);
    }

    // ------------------------------------------------------------------ griefing
    function _grief(uint256 pid, uint160 wrongPrice) internal {
        qr.createTokens(R, pid);
        PoolKey memory key = _key(R, pid);
        pm.initialize(key, wrongPrice); // anybody may initialise: the hook has no initialise permission
        (uint160 px,,,) = pm.getSlot0(key.toId());
        assertEq(uint256(px), uint256(wrongPrice));
        qr.seed(R, pid, SEED);
        (px,,,) = pm.getSlot0(key.toId());
        assertEq(uint256(px), uint256(Q96), "pool ends at 1:1");
        assertEq(uint256(pm.getLiquidity(key.toId())), SEED * SCALE);
        assertEq(_pLong(R, pid), 0.5e18);
        assertEq(adapter.spotPrice(R, pid), 1e18);
        // market is tradable afterwards
        _buy(alice, R, pid, 10_000, true);
        assertGt(_pLong(R, pid), 0.5e18);
    }

    function test_SeedSucceedsAfterGriefInitialize() public {
        _grief(10, uint160(2 * 2 ** 96)); // wrong price in range (1.4x sqrt)
    }

    function test_SeedSucceedsAfterGriefInitialize_Half() public {
        _grief(11, uint160(2 ** 95));
    }

    function test_SeedSucceedsAfterGriefInitialize_TickAboveRange() public {
        _grief(12, TickMath.getSqrtPriceAtTick(80_000));
    }

    function test_SeedSucceedsAfterGriefInitialize_TickBelowRange() public {
        _grief(13, TickMath.getSqrtPriceAtTick(-80_000));
    }

    function test_SeedSucceedsAfterGriefInitialize_ExtremePrices() public {
        _grief(14, TickMath.MAX_SQRT_PRICE - 1);
        _grief(15, TickMath.MIN_SQRT_PRICE);
    }

    function test_SeedSucceedsWhenGrieferInitialisedAtTheCorrectPrice() public {
        _grief(16, Q96);
    }

    function test_GriefedPoolRepairStillWorksLateInTheWindow() public {
        qr.setTiming(R, 20, uint64(t0), uint64(t0 + 1 days), 1 hours);
        qr.createTokens(R, 20);
        pm.initialize(_key(R, 20), uint160(2 * 2 ** 96));
        vm.warp(t0 + 1 hours);
        // the window opened an hour ago; the repair swap is an observation at 0.5
        qr.seed(R, 20, SEED);
        assertEq(_pLong(R, 20), 0.5e18);
        assertEq(hook.poolDetails(_id(R, 20)).lastProbability, 0.5e18);
    }
}
