// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {ProposalToken} from "../src/ProposalToken.sol";
import {WaveGasUtil} from "./WaveGasUtil.sol";

/// @notice Accounted balances / pushed-token enforcement.
/// @dev Facts the tests lean on (derived from the adapter's accounting):
///      * A FUNDED buy leaves every held balance unchanged (push in == swap in + payout - swap out).
///      * A funded sell leaves held = idle + pending remainder (credits*1e12 + dust per leg); consume restores idle.
///      * Anything above `held` at the start of a call is "newly pushed" - including unsolicited donations - and is
///        absorbed into held when the call ends. finalizeProposal returns the entire balance.
contract WaveV4ProposalMarketFundingTest is WaveGasUtil {
    using StateLibrary for IPoolManager;

    uint256 internal constant SEED = 5_000_000;
    uint256 internal constant SELL = 1e17; // raw token units sold in the sell tests

    uint256[2] internal ps; // [0]: LONG is currency0, [1]: LONG is currency1

    struct Snap {
        uint256 hL;
        uint256 hS;
        uint256 bL;
        uint256 bS;
        uint256 pmL;
        uint256 pmS;
        uint160 price;
        uint128 liq;
        uint256 pLong;
    }

    function setUp() public override {
        super.setUp();
        ps[0] = _openOrdering(R, 10, true, SEED);
        ps[1] = _openOrdering(R, 500, false, SEED);
    }

    // ------------------------------------------------------------------ helpers
    function _snap(uint256 p) internal view returns (Snap memory s) {
        (s.hL, s.hS) = adapter.accountedBalances(R, p);
        s.bL = _bal(_long(R, p), address(adapter));
        s.bS = _bal(_short(R, p), address(adapter));
        s.pmL = _bal(_long(R, p), address(pm));
        s.pmS = _bal(_short(R, p), address(pm));
        PoolId id = _id(R, p);
        (s.price,,,) = pm.getSlot0(id);
        s.liq = pm.getLiquidity(id);
        s.pLong = _pLong(R, p);
    }

    function _assertSame(Snap memory a, Snap memory b, string memory tag) internal pure {
        assertEq(a.hL, b.hL, string.concat(tag, ": heldLong"));
        assertEq(a.hS, b.hS, string.concat(tag, ": heldShort"));
        assertEq(a.bL, b.bL, string.concat(tag, ": adapter LONG balance"));
        assertEq(a.bS, b.bS, string.concat(tag, ": adapter SHORT balance"));
        assertEq(a.pmL, b.pmL, string.concat(tag, ": pool LONG balance"));
        assertEq(a.pmS, b.pmS, string.concat(tag, ": pool SHORT balance"));
        assertEq(a.price, b.price, string.concat(tag, ": sqrtPrice"));
        assertEq(a.liq, b.liq, string.concat(tag, ": liquidity"));
        assertEq(a.pLong, b.pLong, string.concat(tag, ": pLong"));
    }

    function _push(uint256 p, uint256 l, uint256 s) internal {
        qr.mintLegs(address(adapter), R, p, l, s);
    }

    function _tradeBuy(uint256 p, bool long_, uint256 credits) internal returns (uint256) {
        vm.prank(address(qr));
        return long_
            ? adapter.tradeBuyLong(R, p, credits, 0, alice)
            : adapter.tradeBuyShort(R, p, credits, 0, alice);
    }

    function _tradeSell(uint256 p, bool long_, uint256 amount) internal returns (uint256) {
        vm.prank(address(qr));
        return long_ ? adapter.tradeSellLong(R, p, amount, 0) : adapter.tradeSellShort(R, p, amount, 0);
    }

    function _expectShort(uint256 p, uint256 needed, uint256 received) internal {
        vm.expectRevert(
            abi.encodeWithSelector(WaveV4ProposalMarket.InsufficientPushedTokens.selector, R, p, needed, received)
        );
    }

    function _assertAccountedEqBalances(uint256 p, string memory tag) internal view {
        (uint256 hL, uint256 hS) = adapter.accountedBalances(R, p);
        assertEq(hL, _bal(_long(R, p), address(adapter)), string.concat(tag, ": accounted LONG == balance"));
        assertEq(hS, _bal(_short(R, p), address(adapter)), string.concat(tag, ": accounted SHORT == balance"));
    }

    // ------------------------------------------------------------------ under-funded buy
    function test_UnderFundedBuy_RevertsAndSeedInventoryUnchanged() public {
        uint256 credits = 250_000;
        uint256 n = credits * SCALE;
        // [pushLong, pushShort, received reported for the FIRST failing leg (LONG is checked first)]
        uint256[3][8] memory cases = [
            [uint256(0), uint256(0), uint256(0)], // nothing pushed
            [n, uint256(0), uint256(0)], // LONG full, SHORT missing
            [uint256(0), n, uint256(0)], // SHORT full, LONG missing -> LONG fails first
            [n / 2, n, n / 2], // LONG half
            [n, n / 3, n / 3], // SHORT a third
            [n - 1, n, n - 1], // LONG one wei short
            [n, n - 1, n - 1], // SHORT one wei short
            [n - 1, n - 1, n - 1] // both one wei short -> LONG reported
        ];
        for (uint256 i; i < 2; ++i) {
            for (uint256 k; k < 2; ++k) {
                uint256 p = ps[i];
                bool long_ = k == 0;
                Snap memory idle = _snap(p);
                assertGt(idle.hL, 0, "seed leaves idle LONG inventory");
                assertGt(idle.hS, 0, "seed leaves idle SHORT inventory");
                for (uint256 c; c < cases.length; ++c) {
                    uint256 snapId = vm.snapshotState();
                    _push(p, cases[c][0], cases[c][1]);
                    Snap memory before = _snap(p);
                    // the push itself must not touch accounted inventory
                    assertEq(before.hL, idle.hL, "push does not change heldLong");
                    assertEq(before.hS, idle.hS, "push does not change heldShort");

                    _expectShort(p, n, cases[c][2]);
                    _tradeBuy(p, long_, credits);

                    _assertSame(before, _snap(p), "reverted buy");
                    (uint256 aL, uint256 aS) = adapter.accountedBalances(R, p);
                    assertEq(aL, idle.hL, "idle LONG intact");
                    assertEq(aS, idle.hS, "idle SHORT intact");
                    assertEq(_bal(long_ ? _long(R, p) : _short(R, p), alice), 0, "recipient got nothing");
                    assertTrue(vm.revertToState(snapId));
                }
            }
        }
    }

    // ------------------------------------------------------------------ under-funded sell
    function test_UnderFundedSell_RevertsAndSeedInventoryUnchanged() public {
        uint256 a = SELL;
        // [pushSold, pushOther, received reported]
        uint256[3][6] memory cases = [
            [uint256(0), uint256(0), uint256(0)], // nothing
            [a - 1, uint256(0), a - 1], // one wei short
            [uint256(0), a, uint256(0)], // the OTHER leg in full does not count
            [a - 1, 2 * a, a - 1], // one wei short, plus plenty of the other leg
            [a / 2, a / 7, a / 2],
            [uint256(0), 10 * a, uint256(0)]
        ];
        for (uint256 i; i < 2; ++i) {
            for (uint256 k; k < 2; ++k) {
                uint256 p = ps[i];
                bool long_ = k == 0;
                Snap memory idle = _snap(p);
                for (uint256 c; c < cases.length; ++c) {
                    uint256 snapId = vm.snapshotState();
                    _push(p, long_ ? cases[c][0] : cases[c][1], long_ ? cases[c][1] : cases[c][0]);
                    Snap memory before = _snap(p);
                    assertEq(before.hL, idle.hL);
                    assertEq(before.hS, idle.hS);

                    _expectShort(p, a, cases[c][2]);
                    _tradeSell(p, long_, a);

                    _assertSame(before, _snap(p), "reverted sell");
                    // no pending settlement was recorded: a quote works and consume has nothing to consume
                    long_ ? adapter.quoteSellLong(R, p, a) : adapter.quoteSellShort(R, p, a);
                    vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.NoPendingSettlement.selector, R, p));
                    qr.consume(alice, R, p);
                    assertTrue(vm.revertToState(snapId));
                }
            }
        }
    }

    // ------------------------------------------------------------------ under-funded seed
    function test_UnderFundedSeed_Reverts() public {
        uint256 n = SEED * SCALE;
        uint256[3][7] memory cases = [
            [uint256(0), uint256(0), uint256(0)],
            [n, uint256(0), uint256(0)],
            [uint256(0), n, uint256(0)],
            [n - 1, n, n - 1],
            [n, n - 1, n - 1],
            [n / 2, n, n / 2],
            [n, n / 4, n / 4]
        ];
        for (uint256 i; i < 2; ++i) {
            uint256 p = _findOrdering(R, 3000 + i * 400, i == 0);
            qr.createTokens(R, p);
            for (uint256 c; c < cases.length; ++c) {
                uint256 snapId = vm.snapshotState();
                _push(p, cases[c][0], cases[c][1]);
                _expectShort(p, n, cases[c][2]);
                vm.prank(address(qr));
                adapter.seedLiquidity(R, p, SEED);
                vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, p));
                adapter.accountedBalances(R, p);
                (uint160 price,,,) = pm.getSlot0(_id(R, p));
                assertEq(price, 0, "no pool was initialised");
                assertTrue(vm.revertToState(snapId));
            }
            // control: exactly the required legs seed the market and hold == the whole balance
            _push(p, n, n);
            vm.prank(address(qr));
            adapter.seedLiquidity(R, p, SEED);
            _assertAccountedEqBalances(p, "seeded");
        }
    }

    // ------------------------------------------------------------------ check ordering
    function test_FundingCheckComesAfterCheapValidationsAndBeforeQuoteLogic() public {
        uint256 p = ps[0];
        uint256 big = SEED * 100;
        // zero recipient wins over under-funding
        vm.prank(address(qr));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAddress.selector);
        adapter.tradeBuyLong(R, p, 1000, 0, address(0));
        // unseeded market wins over under-funding
        vm.prank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, 999));
        adapter.tradeBuyLong(R, 999, 1000, 0, alice);
        vm.prank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, 999));
        adapter.tradeSellLong(R, 999, 1000, 0);
        // zero amounts have nothing to fund -> the amount check fires
        vm.prank(address(qr));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.tradeBuyShort(R, p, 0, 0, alice);
        vm.prank(address(qr));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.tradeSellShort(R, p, 0, 0);
        // under-funding wins over slippage, depth, and an impossible minOut
        _expectShort(p, 1000 * SCALE, 0);
        vm.prank(address(qr));
        adapter.tradeBuyLong(R, p, 1000, type(uint256).max, alice);
        _expectShort(p, big * SCALE, 0);
        vm.prank(address(qr));
        adapter.tradeBuyShort(R, p, big, 0, alice);
        _expectShort(p, 1e24, 0);
        vm.prank(address(qr));
        adapter.tradeSellLong(R, p, 1e24, 0);
        _expectShort(p, SELL, 0);
        vm.prank(address(qr));
        adapter.tradeSellShort(R, p, SELL, type(uint256).max);

        // a pending sell wins over under-funding on the next sell
        qr.mintLegs(alice, R, p, SELL, 0);
        qr.sellStep(alice, R, p, SELL, true, 0);
        vm.prank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.PendingRemainder.selector, R, p));
        adapter.tradeSellLong(R, p, SELL, 0);
        qr.consume(alice, R, p);

        // a finalized market wins over under-funding
        vm.warp(_now() + 1 days);
        qr.finalize(R, p);
        vm.prank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.AlreadyFinalized.selector, R, p));
        adapter.tradeBuyLong(R, p, 1000, 0, alice);
        vm.prank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.AlreadyFinalized.selector, R, p));
        adapter.tradeSellLong(R, p, SELL, 0);
    }

    // ------------------------------------------------------------------ funded trades behave exactly as before
    function test_FundedTradesBehaveExactlyAsBefore() public {
        for (uint256 i; i < 2; ++i) {
            for (uint256 k; k < 2; ++k) {
                uint256 p = ps[i];
                bool long_ = k == 0;
                address tok = long_ ? _long(R, p) : _short(R, p);
                (uint256 idleL, uint256 idleS) = adapter.accountedBalances(R, p);
                _assertAccountedEqBalances(p, "after seed");

                // BUY: output == quote, recipient receives exactly the quote, held unchanged
                uint256 credits = 300_000;
                uint256 q = _quoteBuy(R, p, credits, long_);
                uint256 aliceBefore = _bal(tok, alice);
                assertEq(_buy(alice, R, p, credits, long_), q, "buy output == quote");
                assertEq(_bal(tok, alice) - aliceBefore, q, "recipient received the quote");
                _assertAccountedEqBalances(p, "after buy");
                (uint256 hL, uint256 hS) = adapter.accountedBalances(R, p);
                assertEq(hL, idleL, "buy leaves idle LONG as is");
                assertEq(hS, idleS, "buy leaves idle SHORT as is");

                // SELL (two halves): credits/dust equal the quote; held == idle + pending remainder; consume restores idle
                uint256 amt = _bal(tok, alice) / 2;
                (uint256 qc, uint256 qld, uint256 qsd) = _quoteSell(R, p, amt, long_);
                assertEq(qr.sellStep(alice, R, p, amt, long_, 0), qc, "sell credits == quote");
                _assertAccountedEqBalances(p, "pending");
                (hL, hS) = adapter.accountedBalances(R, p);
                assertEq(hL, idleL + qc * SCALE + qld, "held LONG = idle + pending remainder");
                assertEq(hS, idleS + qc * SCALE + qsd, "held SHORT = idle + pending remainder");

                uint256 creditBefore = _bal(_credit(R, p), alice);
                uint256 dustLBefore = _bal(_long(R, p), alice);
                uint256 dustSBefore = _bal(_short(R, p), alice);
                (uint256 c, uint256 ld, uint256 sd) = qr.consume(alice, R, p);
                assertEq(c, qc);
                assertEq(ld, qld);
                assertEq(sd, qsd);
                assertEq(_bal(_credit(R, p), alice) - creditBefore, qc, "seller paid in CREDIT");
                assertEq(_bal(_long(R, p), alice) - dustLBefore, qld, "LONG dust returned");
                assertEq(_bal(_short(R, p), alice) - dustSBefore, qsd, "SHORT dust returned");
                _assertAccountedEqBalances(p, "after consume");
                (hL, hS) = adapter.accountedBalances(R, p);
                assertEq(hL, idleL, "consume restores idle LONG");
                assertEq(hS, idleS, "consume restores idle SHORT");
            }
        }
    }

    // ------------------------------------------------------------------ idle inventory is invariant under any funded sequence
    function testFuzz_IdleSeedInventoryIdenticalAcrossAnySequenceOfFundedTrades(uint256 seed, uint8 ord) public {
        uint256 p = ps[ord % 2];
        (uint256 idleL, uint256 idleS) = adapter.accountedBalances(R, p);
        for (uint256 i; i < 10; ++i) {
            _randomStep(p, uint256(keccak256(abi.encode(seed, i))), idleL, idleS);
        }
        _finalizeAndCheck(p, idleL, idleS);
    }

    /// @dev Fixed script through the same step function so every action kind (buy/sell, both legs, warp) is hit.
    function test_IdleSeedInventoryIdentical_ScriptedSequenceHitsEveryAction() public {
        for (uint256 i; i < 2; ++i) {
            uint256 snapId = vm.snapshotState(); // finalisation warps past the window; isolate each ordering
            uint256 p = ps[i];
            (uint256 idleL, uint256 idleS) = adapter.accountedBalances(R, p);
            // rnd = act | long << 8 | x << 16 ; act: 0/1 buy, 2/3 sell, 4 warp
            uint256[10] memory script = [
                uint256(0) | (1 << 8) | (150_000 << 16), // buy LONG
                uint256(1) | (0 << 8) | (90_000 << 16), // buy SHORT
                uint256(4) | (1800 << 16), // warp
                uint256(2) | (1 << 8) | (3e17 << 16), // sell LONG (part of holdings)
                uint256(3) | (0 << 8) | (2e17 << 16), // sell SHORT
                uint256(0) | (0 << 8) | (7 << 16), // tiny buy SHORT
                uint256(4) | (3600 << 16), // warp
                uint256(2) | (0 << 8) | (1 << 16), // 1-wei sell SHORT (all dust)
                uint256(3) | (1 << 8) | (uint256(type(uint128).max) << 16), // sell all LONG held
                uint256(1) | (1 << 8) | (200_000 << 16) // buy LONG
            ];
            for (uint256 j; j < script.length; ++j) {
                _randomStep(p, script[j], idleL, idleS);
            }
            _finalizeAndCheck(p, idleL, idleS);
            assertTrue(vm.revertToState(snapId));
        }
    }

    function _finalizeAndCheck(uint256 p, uint256 idleL, uint256 idleS) internal {
        // finalisation: returned == idle + what the pool paid out on REMOVE (principal + fees)
        vm.warp(_now() + 1 days);
        uint256 pmL = _bal(_long(R, p), address(pm));
        uint256 pmS = _bal(_short(R, p), address(pm));
        uint256 qrL = _bal(_long(R, p), address(qr));
        uint256 qrS = _bal(_short(R, p), address(qr));
        qr.finalize(R, p);
        uint256 removedL = pmL - _bal(_long(R, p), address(pm));
        uint256 removedS = pmS - _bal(_short(R, p), address(pm));
        assertEq(_bal(_long(R, p), address(qr)) - qrL, idleL + removedL, "returned LONG = idle + pool principal+fees");
        assertEq(_bal(_short(R, p), address(qr)) - qrS, idleS + removedS, "returned SHORT = idle + pool principal+fees");
        assertEq(_bal(_long(R, p), address(adapter)), 0, "adapter drained LONG");
        assertEq(_bal(_short(R, p), address(adapter)), 0, "adapter drained SHORT");
        (uint256 hL, uint256 hS) = adapter.accountedBalances(R, p);
        assertEq(hL, 0, "held LONG zeroed");
        assertEq(hS, 0, "held SHORT zeroed");
    }

    function _randomStep(uint256 p, uint256 rnd, uint256 idleL, uint256 idleS) internal {
        uint256 act = rnd % 5;
        bool long_ = (rnd >> 8) & 1 == 1;
        uint256 x = rnd >> 16;
        address tok = long_ ? _long(R, p) : _short(R, p);
        if (act == 4) {
            vm.warp(_now() + bound(x, 1, 3600)); // at most 10h in total, trading window is 24h
            _assertIdle(p, idleL, idleS, 0, 0, "after warp");
            return;
        }
        uint256 held = _bal(tok, alice);
        if (act >= 2 && held != 0) {
            uint256 amt = bound(x, 1, held);
            (uint256 qc, uint256 qld, uint256 qsd) = _quoteSell(R, p, amt, long_);
            uint256 creditsBefore = _bal(_credit(R, p), alice);
            assertEq(qr.sellStep(alice, R, p, amt, long_, 0), qc, "sell == quote");
            _assertIdle(p, idleL, idleS, qc * SCALE + qld, qc * SCALE + qsd, "pending");
            (uint256 c, uint256 ld, uint256 sd) = qr.consume(alice, R, p);
            assertEq(c, qc);
            assertEq(ld, qld);
            assertEq(sd, qsd);
            assertEq(_bal(_credit(R, p), alice) - creditsBefore, qc);
            _assertIdle(p, idleL, idleS, 0, 0, "after consume");
        } else {
            uint256 credits = bound(x, 1, 200_000);
            uint256 q = _quoteBuy(R, p, credits, long_);
            assertEq(_buy(alice, R, p, credits, long_), q, "buy == quote");
            _assertIdle(p, idleL, idleS, 0, 0, "after buy");
        }
    }

    /// @dev accounted - pending == idle exactly, and the real balance covers (here: equals) what is accounted.
    function _assertIdle(uint256 p, uint256 idleL, uint256 idleS, uint256 pendL, uint256 pendS, string memory tag)
        internal
        view
    {
        (uint256 hL, uint256 hS) = adapter.accountedBalances(R, p);
        assertEq(hL - pendL, idleL, string.concat(tag, ": idle LONG"));
        assertEq(hS - pendS, idleS, string.concat(tag, ": idle SHORT"));
        assertGe(_bal(_long(R, p), address(adapter)), hL, string.concat(tag, ": balance >= accounted LONG"));
        assertGe(_bal(_short(R, p), address(adapter)), hS, string.concat(tag, ": balance >= accounted SHORT"));
        _assertAccountedEqBalances(p, tag);
    }

    // ------------------------------------------------------------------ pending remainder protection
    function test_PendingRemainderIsProtected() public {
        for (uint256 i; i < 2; ++i) {
            for (uint256 k; k < 2; ++k) {
                _pendingRemainderCase(ps[i], k == 0);
            }
        }
    }

    function _pendingRemainderCase(uint256 p, bool sellLong) internal {
        (uint256 idleL, uint256 idleS) = adapter.accountedBalances(R, p);
        uint256 amt = 5e17;
        qr.mintLegs(alice, R, p, sellLong ? amt : 0, sellLong ? 0 : amt);
        (uint256 qc, uint256 qld, uint256 qsd) = _quoteSell(R, p, amt, sellLong);
        qr.sellStep(alice, R, p, amt, sellLong, 0);
        uint256 pendL = qc * SCALE + qld;
        uint256 pendS = qc * SCALE + qsd;
        assertGt(pendL, 0);
        assertGt(pendS, 0);
        _assertIdle(p, idleL, idleS, pendL, pendS, "pending");

        assertGt(_bal(_long(R, p), address(adapter)), 100_000 * SCALE, "adapter holds far more than a buy needs");
        _buyWhilePending(p, true, idleL, idleS, pendL, pendS);
        _buyWhilePending(p, false, idleL, idleS, pendL, pendS);
        // sells stay blocked while pending
        vm.prank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.PendingRemainder.selector, R, p));
        adapter.tradeSellLong(R, p, SELL, 0);
        _consumeAndCheck(p, idleL, idleS, qc, qld, qsd);
    }

    function _buyWhilePending(uint256 p, bool buyLong, uint256 idleL, uint256 idleS, uint256 pendL, uint256 pendS)
        internal
    {
        uint256 credits = 100_000;
        uint256 n = credits * SCALE;
        Snap memory before = _snap(p);
        // not a single wei of idle inventory or pending remainder may fund the buy
        _expectShort(p, n, 0);
        _tradeBuy(p, buyLong, credits);
        _push(p, n - 1, n - 1);
        _expectShort(p, n, n - 1);
        _tradeBuy(p, buyLong, credits);
        Snap memory after_ = _snap(p);
        assertEq(after_.hL, before.hL);
        assertEq(after_.hS, before.hS);
        assertEq(after_.price, before.price);
        assertEq(after_.bL, before.bL + n - 1);
        assertEq(after_.bS, before.bS + n - 1);
        _push(p, 1, 1); // now exactly n of each is newly pushed
        uint256 q = _quoteBuy(R, p, credits, buyLong);
        assertEq(_tradeBuy(p, buyLong, credits), q, "funded buy while a remainder is pending");
        _assertIdle(p, idleL, idleS, pendL, pendS, "buy leaves pending untouched");
    }

    function _consumeAndCheck(uint256 p, uint256 idleL, uint256 idleS, uint256 qc, uint256 qld, uint256 qsd) internal {
        uint256 aliceCreditBefore = _bal(_credit(R, p), alice);
        (uint256 c, uint256 ld, uint256 sd) = qr.consume(alice, R, p);
        assertEq(c, qc);
        assertEq(ld, qld);
        assertEq(sd, qsd);
        assertEq(_bal(_credit(R, p), alice) - aliceCreditBefore, qc);
        // consume pays out exactly the remainder and leaves accounted == balance == idle
        _assertIdle(p, idleL, idleS, 0, 0, "after consume");
    }

    function test_ConsumeLeavesAccountedEqualToBalanceWhenNothingUnsolicited() public {
        uint256 p = ps[0];
        qr.mintLegs(alice, R, p, 3e17, 0);
        qr.sellStep(alice, R, p, 3e17, true, 0);
        qr.consume(alice, R, p);
        _assertAccountedEqBalances(p, "after consume");
    }

    // ------------------------------------------------------------------ unsolicited tokens
    uint256 internal donL; // cumulative unsolicited LONG sent to the "donee" market
    uint256 internal donS;
    uint256 internal unL; // part of it that no trade has absorbed yet
    uint256 internal unS;

    function _donate(uint256 p, uint256 l, uint256 s) internal {
        _push(p, l, s);
        donL += l;
        donS += s;
        unL += l;
        unS += s;
    }

    /// @dev `a` is the donee market, `b` an identical control twin. Differences must be exactly the donations.
    function _assertTwin(uint256 a, uint256 b, string memory tag) internal view {
        (uint256 aL, uint256 aS) = adapter.accountedBalances(R, a);
        (uint256 bL, uint256 bS) = adapter.accountedBalances(R, b);
        assertEq(aL, bL + donL - unL, string.concat(tag, ": accounted LONG = twin + absorbed donations"));
        assertEq(aS, bS + donS - unS, string.concat(tag, ": accounted SHORT = twin + absorbed donations"));
        assertEq(_bal(_long(R, a), address(adapter)), aL + unL, string.concat(tag, ": balance = accounted + unabsorbed"));
        assertEq(_bal(_short(R, a), address(adapter)), aS + unS);
        assertEq(_bal(_long(R, b), address(adapter)), bL, string.concat(tag, ": twin accounted == balance"));
        assertEq(_bal(_short(R, b), address(adapter)), bS);
    }

    function _twinBuy(uint256 a, uint256 b, bool long_, uint256 credits) internal {
        uint256 q = _quoteBuy(R, a, credits, long_);
        assertEq(q, _quoteBuy(R, b, credits, long_), "a donation does not move the quote");
        assertEq(_buy(alice, R, a, credits, long_), q, "donee buy == quote");
        assertEq(_buy(alice, R, b, credits, long_), q, "twin buy == quote");
        unL = 0;
        unS = 0; // a funded trade absorbs the surplus
        _assertTwin(a, b, "after buy");
    }

    function _twinSell(uint256 a, uint256 b, bool long_, uint256 amt, bool donateBeforeConsume) internal {
        qr.mintLegs(alice, R, a, long_ ? amt : 0, long_ ? 0 : amt);
        qr.mintLegs(alice, R, b, long_ ? amt : 0, long_ ? 0 : amt);
        (uint256 c, uint256 ld, uint256 sd) = _quoteSell(R, a, amt, long_);
        (uint256 cb, uint256 ldb, uint256 sdb) = _quoteSell(R, b, amt, long_);
        assertEq(c, cb);
        assertEq(ld, ldb);
        assertEq(sd, sdb);
        assertEq(qr.sellStep(alice, R, a, amt, long_, 0), c, "donee sell == quote");
        assertEq(qr.sellStep(alice, R, b, amt, long_, 0), c, "twin sell == quote");
        unL = 0;
        unS = 0;
        _assertTwin(a, b, "pending");
        if (donateBeforeConsume) _donate(a, 9e12 + 3, 4e12 + 7);
        (uint256 c1, uint256 ld1, uint256 sd1) = qr.consume(alice, R, a);
        (uint256 c2, uint256 ld2, uint256 sd2) = qr.consume(alice, R, b);
        assertEq(c1, c);
        assertEq(ld1, ld);
        assertEq(sd1, sd);
        assertEq(c2, c);
        assertEq(ld2, ld);
        assertEq(sd2, sd);
        _assertTwin(a, b, "after consume");
    }

    function test_UnsolicitedTokensAreIgnoredAndReturnedAtFinalize() public {
        uint256 a = _findOrdering(R, 900, true);
        uint256 b = _findOrdering(R, 1300, true);
        qr.createTokens(R, a);
        qr.createTokens(R, b);
        // (1) a donation BEFORE seeding rides along with the seed push and is absorbed by it
        _push(a, SEED * SCALE + 777e12 + 13, SEED * SCALE + 31e12 + 5);
        _push(b, SEED * SCALE, SEED * SCALE);
        donL = 777e12 + 13;
        donS = 31e12 + 5;
        vm.prank(address(qr));
        adapter.seedLiquidity(R, a, SEED);
        vm.prank(address(qr));
        adapter.seedLiquidity(R, b, SEED);
        _assertTwin(a, b, "seeded");
        assertEq(_snap(a).price, _snap(b).price, "same pool state");

        // (2) a donation between trades is ignored until the next trade absorbs it
        _donate(a, 11e12 + 3, 5e12 + 1);
        _assertTwin(a, b, "donation ignored");
        _twinBuy(a, b, true, 200_000);
        _twinBuy(a, b, false, 150_000);
        // (3) a donation while a remainder is pending: consume pays exactly the remainder, nothing more
        _twinSell(a, b, true, 2e17, true);
        _twinBuy(a, b, false, 50_000);
        _twinSell(a, b, false, 1e17, false);
        // (4) a donation right before finalisation is returned as well
        _donate(a, 123e12 + 1, 77e12 + 9);
        _assertTwin(a, b, "last donation pending");

        vm.warp(_now() + 1 days);
        qr.finalize(R, a);
        qr.finalize(R, b);
        assertEq(
            _bal(_long(R, a), address(qr)), _bal(_long(R, b), address(qr)) + donL, "LONG returned incl. donations"
        );
        assertEq(
            _bal(_short(R, a), address(qr)), _bal(_short(R, b), address(qr)) + donS, "SHORT returned incl. donations"
        );
        assertEq(_bal(_long(R, a), address(adapter)), 0);
        assertEq(_bal(_short(R, a), address(adapter)), 0);
        (uint256 hL, uint256 hS) = adapter.accountedBalances(R, a);
        assertEq(hL, 0, "held LONG zero after finalize");
        assertEq(hS, 0, "held SHORT zero after finalize");
    }

    // ------------------------------------------------------------------ donations cannot make idle inventory spendable
    /// @dev What a donation DOES allow: whoever is the next caller (only QuantumRound can call) may use the donated
    ///      tokens as the "pushed" funds of a trade, so a donor can subsidise a call that was not funded by the round.
    ///      It never lets that call take a single wei from idle inventory or a pending remainder.
    function test_Donation_FundsOnlyWhatWasDonated_NeverIdleInventory() public {
        uint256 p = ps[0];
        uint256 credits = 200_000;
        uint256 n = credits * SCALE;
        Snap memory s0 = _snap(p);

        _push(p, n, n - 1); // donation one wei short on SHORT
        Snap memory s1 = _snap(p);
        _expectShort(p, n, n - 1);
        _tradeBuy(p, true, credits);
        _assertSame(s1, _snap(p), "short donation changes nothing");

        _push(p, 0, 1); // the donation alone now covers a buy that the round never pushed for
        uint256 q = _quoteBuy(R, p, credits, true);
        assertEq(_tradeBuy(p, true, credits), q, "donation funds the call");
        Snap memory s2 = _snap(p);
        assertEq(_bal(_long(R, p), alice), q);
        assertEq(s2.hL, s0.hL, "idle LONG untouched");
        assertEq(s2.hS, s0.hS, "idle SHORT untouched");
        assertEq(s2.bL, s0.bL, "donation fully consumed by the trade");
        assertEq(s2.bS, s0.bS);

        // sell side: only the SOLD leg counts, and one wei short still reverts regardless of the other leg
        _push(p, SELL - 1, 5 * SELL);
        Snap memory s3 = _snap(p);
        _expectShort(p, SELL, SELL - 1);
        _tradeSell(p, true, SELL);
        _assertSame(s3, _snap(p), "short sell donation changes nothing");
        _push(p, 1, 0);
        _tradeSell(p, true, SELL);
        qr.consume(alice, R, p);
        Snap memory s4 = _snap(p);
        assertEq(s4.hL, s0.hL, "idle LONG still untouched after donation-funded sale");
        assertEq(s4.hS, s0.hS + 5 * SELL, "unneeded donated SHORT is absorbed (and returned at finalize)");
        _assertAccountedEqBalances(p, "end");
    }

    function testFuzz_Donation_BuyNeverSpendsIdleInventory(
        uint256 dL,
        uint256 dS,
        uint256 credits,
        bool long_,
        uint8 ord
    ) public {
        uint256 p = ps[ord % 2];
        credits = bound(credits, 1, 300_000);
        uint256 n = credits * SCALE;
        dL = bound(dL, 0, 2 * n);
        dS = bound(dS, 0, 2 * n);
        Snap memory s0 = _snap(p);
        _push(p, dL, dS);
        bool funded = dL >= n && dS >= n;
        if (dL < n) _expectShort(p, n, dL);
        else if (dS < n) _expectShort(p, n, dS);
        _tradeBuy(p, long_, credits);
        Snap memory s1 = _snap(p);
        if (!funded) {
            assertEq(s1.hL, s0.hL);
            assertEq(s1.hS, s0.hS);
            assertEq(s1.bL, s0.bL + dL);
            assertEq(s1.bS, s0.bS + dS);
        } else {
            // idle inventory is intact; only the unspent part of the donation is absorbed
            assertEq(s1.hL, s0.hL + (dL - n));
            assertEq(s1.hS, s0.hS + (dS - n));
            assertEq(s1.bL, s1.hL);
            assertEq(s1.bS, s1.hS);
        }
    }

    function testFuzz_Donation_SellNeverSpendsIdleInventory(uint256 dSold, uint256 dOther, bool long_, uint8 ord)
        public
    {
        uint256 p = ps[ord % 2];
        dSold = bound(dSold, 0, 2 * SELL);
        dOther = bound(dOther, 0, 2 * SELL);
        Snap memory s0 = _snap(p);
        _push(p, long_ ? dSold : dOther, long_ ? dOther : dSold);
        if (dSold < SELL) {
            _expectShort(p, SELL, dSold);
            _tradeSell(p, long_, SELL);
            Snap memory s1 = _snap(p);
            assertEq(s1.hL, s0.hL);
            assertEq(s1.hS, s0.hS);
            return;
        }
        _tradeSell(p, long_, SELL);
        qr.consume(alice, R, p);
        Snap memory s2 = _snap(p);
        uint256 soldBefore = long_ ? s0.hL : s0.hS;
        uint256 otherBefore = long_ ? s0.hS : s0.hL;
        assertEq(long_ ? s2.hL : s2.hS, soldBefore + (dSold - SELL), "sold leg: idle + unspent donation");
        assertEq(long_ ? s2.hS : s2.hL, otherBefore + dOther, "other leg: idle + absorbed donation");
        assertEq(s2.bL, s2.hL);
        assertEq(s2.bS, s2.hS);
    }

    // ------------------------------------------------------------------ AccountingViolation
    function test_AccountingViolation_WhenBalanceFallsBelowAccountedInventory() public {
        uint256 p = ps[0];
        // an external burn (round role) takes 1 wei of idle LONG out from under the adapter
        ProposalToken longToken = qr.longOf(R, p);
        vm.prank(address(qr));
        longToken.burn(address(adapter), 1);
        (uint256 hL,) = adapter.accountedBalances(R, p);
        assertEq(_bal(_long(R, p), address(adapter)), hL - 1);

        // an unfunded call (nothing pushed) sees balance < held -> AccountingViolation, before any funding check
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.AccountingViolation.selector, R, p));
        _tradeBuy(p, true, 1000);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.AccountingViolation.selector, R, p));
        _tradeSell(p, false, SELL);
        // a push that merely re-fills the hole is not "newly pushed": balance >= held but pushed is 1 short
        _push(p, 1000 * SCALE, 1000 * SCALE);
        _expectShort(p, 1000 * SCALE, 1000 * SCALE - 1);
        _tradeBuy(p, true, 1000);
        // pushing one extra wei makes the same buy fully funded again
        _push(p, 1, 0);
        _tradeBuy(p, true, 1000);
    }

    function test_AccountingViolation_WhenPoolManagerDoesNotDeliverTheSwapOutput() public {
        uint256 p = ps[0];
        uint256 credits = 100_000;
        uint256 n = credits * SCALE;
        uint256 q = _quoteBuy(R, p, credits, true);
        bool zeroForOne = !_longIs0(R, p); // buy LONG: sell SHORT into the pool
        BalanceDelta d = zeroForOne
            ? toBalanceDelta(-int128(int256(n)), int128(int256(q - n)))
            : toBalanceDelta(int128(int256(q - n)), -int128(int256(n)));
        vm.mockCall(address(pm), abi.encodeWithSelector(IPoolManager.unlock.selector), abi.encode(abi.encode(d)));
        Snap memory before = _snap(p);
        // the (mock) pool reports a matching delta but moves no tokens: paying `q` would eat idle inventory
        _push(p, n, n);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.AccountingViolation.selector, R, p));
        _tradeBuy(p, true, credits);
        vm.clearMockedCalls();
        assertEq(_bal(_long(R, p), alice), 0);
        assertEq(_snap(p).hL, before.hL);
    }

    // ------------------------------------------------------------------ gas
    function test_Gas_SeedBuySellWithAccounting() public {
        uint256 gSeed = _gasSeed(R, 4000, SEED);
        emit log_named_uint("[funding] seedLiquidity gas", gSeed);
        assertLt(gSeed, SEED_GAS_TARGET, "seedLiquidity < 5,000,000 gas");
        uint256 gBuyL = _gasBuy(R, 4000, 1_000_000, true, alice);
        uint256 gBuyS = _gasBuy(R, 4000, 1_000_000, false, alice);
        emit log_named_uint("[funding] tradeBuyLong  gas (1 USDC)", gBuyL);
        emit log_named_uint("[funding] tradeBuyShort gas (1 USDC)", gBuyS);
        (uint256 gSellL, uint256 gConsumeL) = _gasSell(R, 4000, 1_000_000 * SCALE, true, alice);
        (uint256 gSellS, uint256 gConsumeS) = _gasSell(R, 4000, 1_000_000 * SCALE, false, alice);
        emit log_named_uint("[funding] tradeSellLong  gas", gSellL);
        emit log_named_uint("[funding] tradeSellShort gas", gSellS);
        emit log_named_uint("[funding] consumeSellSettlement gas (long sale)", gConsumeL);
        emit log_named_uint("[funding] consumeSellSettlement gas (short sale)", gConsumeS);
        vm.warp(_now() + 1 days);
        emit log_named_uint("[funding] finalizeProposal gas", _gasFinalize(R, 4000));
        assertLt(gBuyL, 1_000_000);
        assertLt(gSellL, 3_000_000);
    }
}
