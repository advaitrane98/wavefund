// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {WaveBase} from "./WaveBase.sol";

/// @notice The four quote functions are only callable inside [tradingStart, tradingEnd) and match execution there.
/// @dev A market can only be SEEDED inside its window (the hook gates the liquidity add), and time only moves forward
///      on a real chain, so the "before tradingStart" branch is exercised by rewinding the test clock with vm.warp.
contract WaveV4ProposalMarketQuotesTest is WaveBase {
    uint256 internal constant SEED = 5_000_000;

    uint64 internal start;
    uint64 internal end;

    function setUp() public override {
        super.setUp();
        vm.warp(10_000);
        start = uint64(_now());
        end = start + 1 days;
        _open(R, P, SEED);
    }

    function _closedErr(uint256 at) internal view returns (bytes memory) {
        return abi.encodeWithSelector(WaveV4ProposalMarket.TradingClosed.selector, start, end, at);
    }

    function _expectAllQuotesRevert(bytes memory err) internal {
        vm.expectRevert(err);
        adapter.quoteBuyLong(R, P, 1_000);
        vm.expectRevert(err);
        adapter.quoteBuyShort(R, P, 1_000);
        vm.expectRevert(err);
        adapter.quoteSellLong(R, P, 1e15);
        vm.expectRevert(err);
        adapter.quoteSellShort(R, P, 1e15);
    }

    function _assertAllQuotesWork() internal view {
        assertGt(adapter.quoteBuyLong(R, P, 1_000), 1_000 * SCALE);
        assertGt(adapter.quoteBuyShort(R, P, 1_000), 1_000 * SCALE);
        (uint256 cl,,) = adapter.quoteSellLong(R, P, 1e15);
        (uint256 cs,,) = adapter.quoteSellShort(R, P, 1e15);
        assertGt(cl, 0);
        assertGt(cs, 0);
    }

    // ------------------------------------------------------------------ window edges
    function test_Quotes_WorkAtTradingStart() public view {
        assertEq(_now(), start);
        _assertAllQuotesWork();
    }

    function test_Quotes_WorkMidWindowAndAtLastSecond() public {
        vm.warp(start + 12 hours);
        _assertAllQuotesWork();
        vm.warp(end - 1);
        _assertAllQuotesWork();
    }

    function test_Quotes_RevertBeforeTradingStart() public {
        vm.warp(start - 1);
        _expectAllQuotesRevert(_closedErr(start - 1));
        vm.warp(1);
        _expectAllQuotesRevert(_closedErr(1));
    }

    function test_Quotes_RevertAtTradingEnd() public {
        vm.warp(end);
        _expectAllQuotesRevert(_closedErr(end));
    }

    function test_Quotes_RevertAfterTradingEnd() public {
        vm.warp(end + 1);
        _expectAllQuotesRevert(_closedErr(end + 1));
        vm.warp(end + 400 days);
        _expectAllQuotesRevert(_closedErr(end + 400 days));
    }

    function test_Quotes_WindowIsHalfOpen_ReopeningTheClockReopensQuotes() public {
        vm.warp(end);
        _expectAllQuotesRevert(_closedErr(end));
        vm.warp(end - 1); // synthetic rewind: proves the revert is purely a function of block.timestamp
        _assertAllQuotesWork();
    }

    // ------------------------------------------------------------------ precedence
    function test_Quotes_UnseededMarketReportsNotSeededRegardlessOfTime() public {
        bytes memory err = abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, 99);
        vm.expectRevert(err);
        adapter.quoteBuyLong(R, 99, 1_000);
        vm.warp(end + 5 days);
        vm.expectRevert(err);
        adapter.quoteBuyShort(R, 99, 1_000);
        vm.expectRevert(err);
        adapter.quoteSellLong(R, 99, 1e15);
        vm.expectRevert(err);
        adapter.quoteSellShort(R, 99, 1e15);
    }

    function test_QuoteSell_PendingRemainderInsideWindow_TradingClosedOutside() public {
        _buy(alice, R, P, 1_000_000, true);
        qr.sellStep(alice, R, P, _bal(_long(R, P), alice) / 2, true, 0);
        bytes memory pending = abi.encodeWithSelector(WaveV4ProposalMarket.PendingRemainder.selector, R, P);
        vm.expectRevert(pending);
        adapter.quoteSellLong(R, P, 1e15);
        vm.expectRevert(pending);
        adapter.quoteSellShort(R, P, 1e15);
        vm.warp(end);
        vm.expectRevert(_closedErr(end));
        adapter.quoteSellLong(R, P, 1e15);
        vm.expectRevert(_closedErr(end));
        adapter.quoteSellShort(R, P, 1e15);
    }

    function test_Quotes_ZeroAmountStillRejectedInsideWindow() public {
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.quoteBuyLong(R, P, 0);
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.quoteBuyShort(R, P, 0);
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.quoteSellLong(R, P, 0);
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.quoteSellShort(R, P, 0);
    }

    function test_Quotes_TradingClosedCarriesTheMarketsOwnTiming() public {
        uint64 s2 = uint64(_now() - 500);
        uint64 e2 = uint64(_now() + 7 days);
        _openWith(R, 2, SEED, s2, e2, 2 hours);
        bytes memory err = abi.encodeWithSelector(WaveV4ProposalMarket.TradingClosed.selector, s2, e2, e2);
        vm.warp(e2);
        vm.expectRevert(err);
        adapter.quoteBuyLong(R, 2, 1_000);
        vm.expectRevert(err);
        adapter.quoteBuyShort(R, 2, 1_000);
        vm.expectRevert(err);
        adapter.quoteSellLong(R, 2, 1e15);
        vm.expectRevert(err);
        adapter.quoteSellShort(R, 2, 1e15);
        // market 1 (1-day window) closed long before market 2: its own timing is reported
        vm.expectRevert(_closedErr(e2));
        adapter.quoteBuyLong(R, P, 1_000);
    }

    // ------------------------------------------------------------------ quote == execution
    function test_QuoteEqualsExecution_AtTradingStartAndLastSecond() public {
        // at tradingStart
        uint256 qb = adapter.quoteBuyLong(R, P, 300_000);
        qr.fund(alice, R, P, 300_000);
        assertEq(qr.buy(alice, R, P, 300_000, true, qb), qb, "buy at start");

        // at the last second of the window
        vm.warp(end - 1);
        uint256 amt = _bal(_long(R, P), alice);
        (uint256 qc, uint256 qld, uint256 qsd) = adapter.quoteSellLong(R, P, amt);
        (uint256 c, uint256 ld, uint256 sd) = qr.sell(alice, R, P, amt, true, qc);
        assertEq(c, qc, "credits at end-1");
        assertEq(ld, qld);
        assertEq(sd, qsd);
        uint256 qs = adapter.quoteBuyShort(R, P, 200_000);
        qr.fund(bob, R, P, 200_000);
        assertEq(qr.buy(bob, R, P, 200_000, false, qs), qs, "short buy at end-1");

        // and the quote is gone the second the window closes, while execution is refused by the hook
        vm.warp(end);
        vm.expectRevert(_closedErr(end));
        adapter.quoteBuyShort(R, P, 1_000);
    }

    function testFuzz_QuoteEqualsExecution_AtAnyTimeInWindow(uint256 tRaw, uint256 amtRaw, uint8 mode) public {
        vm.warp(start + bound(tRaw, 0, 1 days - 1));
        bool long_ = mode & 1 != 0;
        uint256 credits = bound(amtRaw, 1, SEED * 2);

        uint256 qb = long_ ? adapter.quoteBuyLong(R, P, credits) : adapter.quoteBuyShort(R, P, credits);
        qr.fund(alice, R, P, credits);
        uint256 out = qr.buy(alice, R, P, credits, long_, qb);
        assertEq(out, qb, "buy == quote at any in-window time");

        uint256 amount = bound(amtRaw >> 7, 1, out);
        (uint256 qc, uint256 qld, uint256 qsd) =
            long_ ? adapter.quoteSellLong(R, P, amount) : adapter.quoteSellShort(R, P, amount);
        (uint256 c, uint256 ld, uint256 sd) = qr.sell(alice, R, P, amount, long_, qc);
        assertEq(c, qc, "sell credits == quote");
        assertEq(ld, qld, "LONG dust == quote");
        assertEq(sd, qsd, "SHORT dust == quote");
    }

    function testFuzz_QuotesRevertAtAnyTimeOutsideWindow(uint256 tRaw, bool before_) public {
        uint256 t = before_ ? bound(tRaw, 0, start - 1) : bound(tRaw, end, uint256(end) + 3650 days);
        vm.warp(t);
        _expectAllQuotesRevert(_closedErr(_now()));
    }
}
