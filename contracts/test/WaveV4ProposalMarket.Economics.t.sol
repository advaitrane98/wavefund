// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Test.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {WaveBase} from "./WaveBase.sol";

/// @notice Buy / sell economics, slippage, input validation and the calibration table.
contract WaveV4ProposalMarketEconomicsTest is WaveBase {
    uint256 internal constant SEED = 5_000_000;

    function setUp() public override {
        super.setUp();
        _open(R, P, SEED);
    }

    function _lp(uint256 v) internal pure returns (string memory) {
        // percent with 3 decimals, from a 1e18 fraction
        uint256 milli = v / 1e15; // 0.1% units
        return string.concat(vm.toString(milli / 10), ".", vm.toString(milli % 10), "%");
    }

    /// @dev Continuous constant-product reference at p = 0.5 (virtual reserves X = Y = L, fee 0.3% on the input).
    function _expectedSellCredits(uint256 L, uint256 n) internal pure returns (uint256) {
        uint256 lo;
        uint256 hi = n;
        for (uint256 i; i < 90; ++i) {
            uint256 mid = (lo + hi) / 2;
            uint256 eff = mid * 997 / 1000;
            uint256 out = L * eff / (L + eff);
            if (out >= n - mid) hi = mid;
            else lo = mid;
        }
        uint256 eff2 = hi * 997 / 1000;
        uint256 out2 = L * eff2 / (L + eff2);
        uint256 rem = n - hi;
        return (rem < out2 ? rem : out2) / 1e12;
    }

    function _sellHalf(bool long_) internal {
        uint256 L = SEED * SCALE;
        uint256[4] memory ns = [uint256(1e15), 1e16, 1e17, 1e18];
        emit log_string(long_ ? "--- sell LONG at p=0.5 (seed 5 USDC) ---" : "--- sell SHORT at p=0.5 (seed 5 USDC) ---");
        emit log_string("rawIn | N/2/1e12 (naive) | expected(const-product) | actual credits | actual/naive");
        for (uint256 i; i < ns.length; ++i) {
            // fresh identical market per sample so each starts exactly at p = 0.5
            uint256 p = 100 + i + (long_ ? 0 : 10);
            _open(R, p, SEED);
            qr.mintLegs(alice, R, p, long_ ? ns[i] : 0, long_ ? 0 : ns[i]);
            (uint256 credits,,) = qr.sell(alice, R, p, ns[i], long_, 0);
            uint256 naive = ns[i] / 2 / 1e12;
            uint256 expected = _expectedSellCredits(L, ns[i]);
            emit log_string(
                string.concat(
                    vm.toString(ns[i]), " | ", vm.toString(naive), " | ", vm.toString(expected), " | ",
                    vm.toString(credits), " | ", _lp(credits * 1e18 / naive)
                )
            );
            assertLe(_absDiff(credits, expected), 1, "matches constant-product reference within 1 credit");
            assertLt(credits, naive, "fee + impact strictly reduce proceeds");
            if (i == 1) {
                // N = 1e16 (0.2% of reserves): proceeds within 0.5% below the naive N/2
                assertGt(credits, naive * 995 / 1000, "within 0.5% of N/2");
            }
        }
    }

    function test_SellLongAtHalfReturnsAboutHalfInCredits() public {
        _sellHalf(true);
    }

    function test_SellShortAtHalfReturnsAboutHalfInCredits() public {
        _sellHalf(false);
    }

    // ------------------------------------------------------------------ round trips
    function _roundTrip(bool long_, uint256 c) internal {
        address idleOwner = address(adapter);
        uint256 idleL = _bal(_long(R, P), idleOwner);
        uint256 idleS = _bal(_short(R, P), idleOwner);

        uint256 got = _buy(alice, R, P, c, long_);
        assertEq(got, _bal(long_ ? _long(R, P) : _short(R, P), alice));
        assertEq(_bal(_credit(R, P), alice), 0, "credits spent");
        (uint256 back, uint256 ld, uint256 sd) = _sellAll(alice, R, P, long_);

        emit log_named_uint(long_ ? "LONG  round trip: credits in " : "SHORT round trip: credits in ", c);
        emit log_named_uint("                    credits back", back);
        emit log_named_uint("                    LONG dust   ", ld);
        emit log_named_uint("                    SHORT dust  ", sd);

        assertLe(back, c, "never more credits than spent");
        assertLt(back, c, "fees make a round trip strictly lossy");
        assertGe(back, c * 98 / 100, "loss bounded (fees + impact)");
        assertEq(_bal(_credit(R, P), alice), back);
        // user leftovers are exactly the dust that consume returned, each below one whole credit-worth + surplus
        assertEq(_bal(_long(R, P), alice), ld);
        assertEq(_bal(_short(R, P), alice), sd);
        assertLt(ld, 1e12 + 1e8);
        assertLt(sd, 1e12 + 1e8);
        // adapter keeps only the idle seed sets and has no pending settlement
        assertEq(_bal(_long(R, P), idleOwner), idleL, "adapter LONG == idle");
        assertEq(_bal(_short(R, P), idleOwner), idleS, "adapter SHORT == idle");
        adapter.quoteSellLong(R, P, 1e15); // would revert PendingRemainder if pending state lingered
        // supplies stay symmetric and fully backed: sets = seed + bought - sold
        assertEq(_supply(_long(R, P)), _supply(_short(R, P)));
        assertEq(_supply(_long(R, P)), (SEED + c - back) * 1e12);
        assertApproxEqAbs(_pLong(R, P), 0.5e18, 0.003e18, "price back near 0.5");
    }

    function test_BuyLongThenSellAllReturnsAtMostSpentAndNoLeftovers() public {
        _roundTrip(true, 1_000_000);
    }

    function test_BuyShortThenSellAllReturnsAtMostSpentAndNoLeftovers() public {
        _roundTrip(false, 1_000_000);
    }

    function test_RoundTripSmallAmount() public {
        _roundTrip(true, 10_000);
    }

    function test_RoundTripLargeAmount() public {
        _roundTrip(false, 3_000_000);
    }

    // ------------------------------------------------------------------ buy mechanics
    function test_BuyEmitsTradeAndPaysQuotedAmount() public {
        uint256 c = 400_000;
        uint256 quote = adapter.quoteBuyLong(R, P, c);
        assertGt(quote, c * 1e12, "buy returns the complete-set leg plus swap output");
        qr.fund(alice, R, P, c);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit WaveV4ProposalMarket.Trade(R, P, true, true, c, quote, alice);
        uint256 out = qr.buy(alice, R, P, c, true, quote);
        assertEq(out, quote);
        assertEq(_bal(_long(R, P), alice), quote);
        assertEq(_bal(_short(R, P), alice), 0);
    }

    function test_SellEmitsTrade() public {
        _buy(alice, R, P, 400_000, false);
        uint256 amt = _bal(_short(R, P), alice);
        (uint256 q,,) = adapter.quoteSellShort(R, P, amt);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit WaveV4ProposalMarket.Trade(R, P, false, false, amt, q, address(qr));
        qr.sell(alice, R, P, amt, false, q);
    }

    // ------------------------------------------------------------------ slippage / validation
    function test_BuySlippageRevert() public {
        uint256 q = adapter.quoteBuyLong(R, P, 100_000);
        qr.fund(alice, R, P, 100_000);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.Slippage.selector, q + 1, q));
        qr.buy(alice, R, P, 100_000, true, q + 1);
        qr.buy(alice, R, P, 100_000, true, q); // exactly the quote passes
        uint256 qs = adapter.quoteBuyShort(R, P, 100_000);
        qr.fund(alice, R, P, 100_000);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.Slippage.selector, qs + 1, qs));
        qr.buy(alice, R, P, 100_000, false, qs + 1);
    }

    function test_SellSlippageRevert() public {
        _buy(alice, R, P, 500_000, true);
        uint256 amt = _bal(_long(R, P), alice);
        (uint256 q,,) = adapter.quoteSellLong(R, P, amt);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.Slippage.selector, q + 1, q));
        qr.sell(alice, R, P, amt, true, q + 1);
        qr.sell(alice, R, P, amt, true, q);
    }

    function test_SellShortSlippageRevert() public {
        _buy(alice, R, P, 500_000, false);
        uint256 amt = _bal(_short(R, P), alice);
        (uint256 q,,) = adapter.quoteSellShort(R, P, amt);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.Slippage.selector, q + 1, q));
        qr.sell(alice, R, P, amt, false, q + 1);
    }

    function test_ZeroRecipientAndZeroAmountsRevert() public {
        vm.startPrank(address(qr));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAddress.selector);
        adapter.tradeBuyLong(R, P, 1, 0, address(0));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAddress.selector);
        adapter.tradeBuyShort(R, P, 1, 0, address(0));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.tradeBuyLong(R, P, 0, 0, alice);
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.tradeBuyShort(R, P, 0, 0, alice);
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.tradeSellLong(R, P, 0, 0);
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.tradeSellShort(R, P, 0, 0);
        vm.stopPrank();
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.quoteBuyLong(R, P, 0);
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.quoteSellShort(R, P, 0);
    }

    function test_TradesOnUnseededMarketRevert() public {
        vm.startPrank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, 9, 9));
        adapter.tradeBuyLong(9, 9, 1, 0, alice);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, 9, 9));
        adapter.tradeSellLong(9, 9, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, 9, 9));
        adapter.consumeSellSettlement(9, 9, alice);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, 9, 9));
        adapter.finalizeProposal(9, 9);
        vm.stopPrank();
    }

    function test_TinySellYieldsZeroCreditsAndReturnsAllAsDust() public {
        // below one whole credit-worth: nothing to settle, everything comes back as dust, nothing is lost
        qr.mintLegs(alice, R, P, 1e11, 0);
        (uint256 c, uint256 ld, uint256 sd) = qr.sell(alice, R, P, 1e11, true, 0);
        assertEq(c, 0);
        assertEq(_bal(_long(R, P), alice), ld);
        assertEq(_bal(_short(R, P), alice), sd);
        assertLe(ld + sd, 1e11 + 1, "value is not created");
    }

    // ------------------------------------------------------------------ depth limits
    function test_HugeBuyAndSellRevertInsufficientDepth() public {
        // pool can absorb ~8.9x seed in input before the +-45900 tick limit is reached
        vm.startPrank(address(qr));
        vm.expectPartialRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
        adapter.tradeBuyLong(R, P, SEED * 100, 0, alice);
        vm.expectPartialRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
        adapter.tradeBuyShort(R, P, SEED * 100, 0, alice);
        vm.stopPrank();
        vm.expectPartialRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
        adapter.quoteSellLong(R, P, 1e24);
        vm.expectPartialRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
        adapter.quoteSellShort(R, P, 1e24);
    }

    // ------------------------------------------------------------------ calibration
    function _calibrate(uint256 pid, bool long_, uint256 credits) internal returns (uint256 movedBp) {
        _open(R, pid, SEED);
        uint256 before_ = _pLong(R, pid);
        _buy(alice, R, pid, credits, long_);
        uint256 after_ = _pLong(R, pid);
        uint256 pTarget = long_ ? after_ : 1e18 - after_; // probability of the side that was bought
        movedBp = (pTarget - 0.5e18) / 1e14;
        assertEq(before_, 0.5e18);
        emit log_string(
            string.concat(
                long_ ? "BUY LONG  " : "BUY SHORT ", vm.toString(credits), " credits -> p(side) ",
                _lp(pTarget), "  (+", vm.toString(movedBp / 100), ".", vm.toString(movedBp % 100), " pp)"
            )
        );
    }

    function test_CalibrationTable() public {
        emit log_string("=== calibration: 5 USDC seed (5_000_000 credits), start p = 50% ===");
        uint256[5] memory amounts = [uint256(100_000), 500_000, 1_000_000, 2_000_000, 5_000_000];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 mvL = _calibrate(200 + i, true, amounts[i]);
            uint256 mvS = _calibrate(300 + i, false, amounts[i]);
            // a buy of either side moves its own probability by the same amount (mirror symmetry)
            assertApproxEqAbs(mvL, mvS, 2, "LONG/SHORT mirror (within 0.02pp)");
            if (amounts[i] == 1_000_000) assertApproxEqAbs(mvL, 900, 30, "1 USDC buy -> +9.0pp +-0.3pp");
            if (amounts[i] == 500_000) assertApproxEqAbs(mvL, 470, 30, "0.5 USDC buy -> +4.7pp +-0.3pp");
        }
    }
}
