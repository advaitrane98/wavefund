// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {WaveBase} from "./WaveBase.sol";

/// @notice Sell-solver convergence bound, InsufficientDepth arguments and the post-swap delta sanity checks.
/// @dev The sell bisection runs at most 64 halvings from hi = amountIn and must end with hi - lo <= 1e6, so any
///      amountIn > 1e6 * 2**64 raw units is unsolvable. That needs NO special liquidity: for such sizes the pool
///      consumes only a tiny fraction of the input on every probe, so lo walks up to amountIn and the loop exhausts
///      its 64 iterations (SolverDidNotConverge fires before the depth check can).
contract WaveV4ProposalMarketSolverTest is WaveBase {
    uint256 internal constant SEED = 5_000_000;
    uint256 internal constant LIMIT = 1e6 * 2 ** 64; // largest amountIn the bounded bisection can resolve

    uint256[2] internal ps; // [0]: LONG is currency0, [1]: LONG is currency1

    function setUp() public override {
        super.setUp();
        ps[0] = _openOrdering(R, 10, true, SEED);
        ps[1] = _openOrdering(R, 500, false, SEED);
    }

    // ------------------------------------------------------------------ helpers
    function _tail(bytes memory d) internal pure returns (bytes memory t) {
        t = new bytes(d.length - 4);
        for (uint256 i; i < t.length; ++i) t[i] = d[i + 4];
    }

    function _uints(bytes memory ret) internal pure returns (uint256 a, uint256 b) {
        (a, b) = abi.decode(_tail(ret), (uint256, uint256));
    }

    function _ints(bytes memory ret) internal pure returns (int256 a, int256 b) {
        (a, b) = abi.decode(_tail(ret), (int256, int256));
    }

    function _quoteSellRaw(uint256 p, uint256 amount, bool long_) internal view returns (bool ok, bytes memory ret) {
        bytes4 sel = long_ ? adapter.quoteSellLong.selector : adapter.quoteSellShort.selector;
        return address(adapter).staticcall(abi.encodeWithSelector(sel, R, p, amount));
    }

    function _callAsRound(bytes memory cd) internal returns (bool ok, bytes memory ret) {
        vm.prank(address(qr));
        return address(adapter).call(cd);
    }

    /// @dev Replaces the PoolManager's unlock() result so the adapter sees an arbitrary swap delta.
    function _mockSwapDelta(bool zeroForOne, int128 inputDelta, int128 outputDelta) internal {
        BalanceDelta d = zeroForOne ? toBalanceDelta(inputDelta, outputDelta) : toBalanceDelta(outputDelta, inputDelta);
        vm.mockCall(address(pm), abi.encodeWithSelector(IPoolManager.unlock.selector), abi.encode(abi.encode(d)));
    }

    // ------------------------------------------------------------------ SolverDidNotConverge
    function test_Solver_LimitConvergesButOneMoreRawUnitDoesNot_Quote() public {
        for (uint256 i; i < 2; ++i) {
            for (uint256 k; k < 2; ++k) {
                bool long_ = k == 0;
                uint256 p = ps[i];
                // exactly LIMIT: the solver converges, then the depth check refuses it
                (bool ok, bytes memory ret) = _quoteSellRaw(p, LIMIT, long_);
                assertFalse(ok);
                assertEq(bytes4(ret), WaveV4ProposalMarket.InsufficientDepth.selector, "LIMIT -> depth, not solver");
                // one raw unit above LIMIT: the bounded bisection cannot resolve it
                vm.expectRevert(WaveV4ProposalMarket.SolverDidNotConverge.selector);
                this.sellQuote(p, LIMIT + 1, long_);
                vm.expectRevert(WaveV4ProposalMarket.SolverDidNotConverge.selector);
                this.sellQuote(p, 2e25, long_);
                vm.expectRevert(WaveV4ProposalMarket.SolverDidNotConverge.selector);
                this.sellQuote(p, 1e40, long_);
                vm.expectRevert(WaveV4ProposalMarket.SolverDidNotConverge.selector);
                this.sellQuote(p, (uint256(1) << 255) - 1, long_);
            }
        }
    }

    /// @dev External wrapper so vm.expectRevert can target the quote call.
    function sellQuote(uint256 p, uint256 amount, bool long_) external view returns (uint256) {
        (uint256 c,,) = long_ ? adapter.quoteSellLong(R, p, amount) : adapter.quoteSellShort(R, p, amount);
        return c;
    }

    function test_Solver_BelowLimitIsAlwaysADepthRevert_NeverSolver() public view {
        uint256[4] memory amounts = [uint256(1e24), 1e25, LIMIT / 2, LIMIT - 1];
        for (uint256 i; i < amounts.length; ++i) {
            (bool ok, bytes memory ret) = _quoteSellRaw(ps[i % 2], amounts[i], i % 2 == 0);
            assertFalse(ok);
            assertEq(bytes4(ret), WaveV4ProposalMarket.InsufficientDepth.selector, "depth revert below the limit");
        }
    }

    function test_Solver_ExecutionRevertsAndLeavesNoTrace() public {
        for (uint256 k; k < 4; ++k) {
            uint256 p = ps[k % 2];
            bool long_ = k < 2;
            uint256 amount = LIMIT + 1;
            qr.mintLegs(alice, R, p, long_ ? amount : 0, long_ ? 0 : amount);
            uint256 before_ = _pLong(R, p);
            vm.expectRevert(WaveV4ProposalMarket.SolverDidNotConverge.selector);
            qr.sellStep(alice, R, p, amount, long_, 0);
            assertEq(_bal(long_ ? _long(R, p) : _short(R, p), alice), amount, "tokens untouched");
            assertEq(_pLong(R, p), before_, "price untouched");
            vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.NoPendingSettlement.selector, R, p));
            qr.consume(alice, R, p);
        }
    }

    function test_Solver_ExecutionAtLimitIsADepthRevert() public {
        uint256 p = ps[0];
        qr.mintLegs(alice, R, p, LIMIT, 0);
        vm.expectPartialRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
        qr.sellStep(alice, R, p, LIMIT, true, 0);
    }

    function test_Solver_AmountAboveInt256IsRejectedBySafeCast() public {
        // the very first probes already exceed int256 -> the Pool.swap signed domain is respected
        vm.expectPartialRevert(SafeCast.SafeCastOverflowedUintToInt.selector);
        this.sellQuote(ps[0], type(uint256).max, true);
        vm.expectPartialRevert(SafeCast.SafeCastOverflowedUintToInt.selector);
        this.sellQuote(ps[1], type(uint256).max, false);
    }

    // ------------------------------------------------------------------ InsufficientDepth arguments
    function test_InsufficientDepth_Buy_ReportsRequestedInputAndWhatThePoolAbsorbed() public {
        for (uint256 i; i < 2; ++i) {
            for (uint256 k; k < 2; ++k) {
                uint256 p = ps[i];
                bool long_ = k == 0;
                uint256 credits = SEED * 100;
                bytes4 sel = long_ ? adapter.quoteBuyLong.selector : adapter.quoteBuyShort.selector;
                (bool ok, bytes memory ret) = address(adapter).staticcall(abi.encodeWithSelector(sel, R, p, credits));
                assertFalse(ok);
                assertEq(bytes4(ret), WaveV4ProposalMarket.InsufficientDepth.selector);
                (uint256 requested, uint256 consumed) = _uints(ret);
                assertEq(requested, credits * SCALE, "requestedIn == credits * 1e12");
                assertGt(consumed, 0);
                assertLt(consumed, requested, "pool absorbed strictly less than asked");
                // the pool can absorb roughly 8.95x the seed notional before the tick limit
                assertApproxEqRel(consumed, SEED * SCALE * 895 / 100, 0.02e18, "~8.95x seed absorbed");

                // the executing trade reports the identical pair
                bytes4 tsel = long_ ? adapter.tradeBuyLong.selector : adapter.tradeBuyShort.selector;
                (bool ok2, bytes memory ret2) = _callAsRound(abi.encodeWithSelector(tsel, R, p, credits, 0, alice));
                assertFalse(ok2);
                (uint256 requested2, uint256 consumed2) = _uints(ret2);
                assertEq(requested2, requested);
                assertEq(consumed2, consumed);
            }
        }
    }

    function test_InsufficientDepth_Sell_ReportsSolvedInputAndConsumedLessThanIt() public view {
        for (uint256 i; i < 2; ++i) {
            (bool ok, bytes memory ret) = _quoteSellRaw(ps[i], 1e24, i == 0);
            assertFalse(ok);
            assertEq(bytes4(ret), WaveV4ProposalMarket.InsufficientDepth.selector);
            (uint256 requested, uint256 consumed) = _uints(ret);
            assertGt(requested, 0);
            assertLe(requested, 1e24, "solved swap input never exceeds amountIn");
            assertLt(consumed, requested);
        }
    }

    // ------------------------------------------------------------------ post-swap delta sanity (mocked PoolManager)
    function _buyDeltaCase(uint256 p, bool long_) internal {
        uint256 credits = 100_000;
        uint256 input = credits * SCALE;
        uint256 q = _quoteBuy(R, p, credits, long_);
        uint256 expOut = q - input;
        bool zeroForOne = long_ != _longIs0(R, p);
        qr.fund(alice, R, p, credits * 6);

        _mockSwapDelta(zeroForOne, -int128(int256(input)), int128(int256(expOut + 1)));
        vm.expectRevert(
            abi.encodeWithSelector(WaveV4ProposalMarket.UnexpectedSwapDelta.selector, int256(expOut), int256(expOut + 1))
        );
        qr.buy(alice, R, p, credits, long_, 0);

        _mockSwapDelta(zeroForOne, -int128(int256(input)), int128(int256(expOut - 1)));
        vm.expectRevert(
            abi.encodeWithSelector(WaveV4ProposalMarket.UnexpectedSwapDelta.selector, int256(expOut), int256(expOut - 1))
        );
        qr.buy(alice, R, p, credits, long_, 0);

        _mockSwapDelta(zeroForOne, 5, int128(int256(expOut)));
        vm.expectRevert(
            abi.encodeWithSelector(WaveV4ProposalMarket.UnexpectedSwapDelta.selector, -int256(input), int256(5))
        );
        qr.buy(alice, R, p, credits, long_, 0);

        _mockSwapDelta(zeroForOne, -int128(int256(input)), -7);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.UnexpectedSwapDelta.selector, int256(0), int256(-7)));
        qr.buy(alice, R, p, credits, long_, 0);

        // pool took less input than requested -> reported as a depth failure with both numbers
        _mockSwapDelta(zeroForOne, -int128(int256(input - 1)), int128(int256(expOut)));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.InsufficientDepth.selector, input, input - 1));
        qr.buy(alice, R, p, credits, long_, 0);

        // control: the exact expected delta passes through the same mocked path and pays the quote
        _mockSwapDelta(zeroForOne, -int128(int256(input)), int128(int256(expOut)));
        assertEq(qr.buy(alice, R, p, credits, long_, q), q, "control: matching delta succeeds");
        vm.clearMockedCalls();
    }

    function test_UnexpectedSwapDelta_Buy_AllBranches_BothOrderings_BothSides() public {
        _buyDeltaCase(ps[0], true);
        _buyDeltaCase(ps[0], false);
        _buyDeltaCase(ps[1], true);
        _buyDeltaCase(ps[1], false);
    }

    function _sellDeltaCase(uint256 p, bool long_) internal {
        uint256 amount = 1e17;
        bool zeroForOne = long_ == _longIs0(R, p);
        qr.mintLegs(address(adapter), R, p, long_ ? amount : 0, long_ ? 0 : amount);

        // a zero input delta reveals the solver's chosen swap input through InsufficientDepth(swapInput, 0)
        _mockSwapDelta(zeroForOne, 0, 0);
        (bool ok, bytes memory ret) = _callAsRound(
            abi.encodeWithSelector(long_ ? adapter.tradeSellLong.selector : adapter.tradeSellShort.selector, R, p, amount, 0)
        );
        assertFalse(ok);
        assertEq(bytes4(ret), WaveV4ProposalMarket.InsufficientDepth.selector);
        (uint256 swapInput, uint256 consumed) = _uints(ret);
        assertEq(consumed, 0);
        assertGt(swapInput, 0);
        assertLt(swapInput, amount);

        // right input, wrong output -> UnexpectedSwapDelta(expectedOutput, 1)
        _mockSwapDelta(zeroForOne, -int128(int256(swapInput)), 1);
        (ok, ret) = _callAsRound(
            abi.encodeWithSelector(long_ ? adapter.tradeSellLong.selector : adapter.tradeSellShort.selector, R, p, amount, 0)
        );
        assertFalse(ok);
        assertEq(bytes4(ret), WaveV4ProposalMarket.UnexpectedSwapDelta.selector);
        (int256 expected, int256 actual) = _ints(ret);
        assertGt(expected, 1, "expected output is the solver's swapOutput");
        assertEq(actual, 1);

        // control: feeding back the reported expected output makes the sale go through and record a pending settlement
        _mockSwapDelta(zeroForOne, -int128(int256(swapInput)), int128(expected));
        (ok, ret) = _callAsRound(
            abi.encodeWithSelector(long_ ? adapter.tradeSellLong.selector : adapter.tradeSellShort.selector, R, p, amount, 0)
        );
        assertTrue(ok, "control: matching delta succeeds");
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.PendingRemainder.selector, R, p));
        long_ ? adapter.quoteSellLong(R, p, 1e15) : adapter.quoteSellShort(R, p, 1e15);
        vm.clearMockedCalls();
    }

    function test_UnexpectedSwapDelta_Sell_BothOrderings_BothSides() public {
        // each case leaves a pending settlement, so every (ordering, side) gets its own market
        _sellDeltaCase(ps[0], true);
        _sellDeltaCase(_openOrdering(R, 100, true, SEED), false);
        _sellDeltaCase(ps[1], true);
        _sellDeltaCase(_openOrdering(R, 700, false, SEED), false);
    }
}
