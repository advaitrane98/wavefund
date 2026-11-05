// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {WaveBase} from "./WaveBase.sol";

/// @notice Fuzzing of the quote/execution equivalence, round-trip no-extraction and bisection sanity.
contract WaveMarketFuzzTest is WaveBase {
    uint256 internal constant DUST_SLACK = 2e8; // bisection tolerance (1e6 raw) amplified by the max price slope (~100)

    // ------------------------------------------------------------------ fixtures
    function _openFuzz(uint256 seedRaw, bool longIs0) internal returns (uint256 p, uint256 seed) {
        seed = bound(seedRaw, 1_000, 50_000_000);
        p = _openOrdering(R, 1, longIs0, seed);
    }

    /// @dev Moves the pool to a fuzzed pre-existing price state with a trade by bob (0..2x seed credits).
    function _preTrade(uint256 p, uint256 seed, uint256 preRaw, bool long_) internal {
        uint256 pre = bound(preRaw, 0, seed * 2);
        if (pre != 0) _buy(bob, R, p, pre, long_);
    }

    function _tryQuoteBuy(uint256 p, uint256 credits, bool long_) internal returns (bool ok, uint256 q) {
        bytes4 sel = long_ ? adapter.quoteBuyLong.selector : adapter.quoteBuyShort.selector;
        (bool s, bytes memory ret) = address(adapter).staticcall(abi.encodeWithSelector(sel, R, p, credits));
        if (!s) {
            assertEq(bytes4(ret), WaveV4ProposalMarket.InsufficientDepth.selector, "only depth may reject a buy quote");
            return (false, 0);
        }
        return (true, abi.decode(ret, (uint256)));
    }

    function _tryQuoteSell(uint256 p, uint256 amount, bool long_)
        internal
        returns (bool ok, uint256 c, uint256 ld, uint256 sd)
    {
        bytes4 sel = long_ ? adapter.quoteSellLong.selector : adapter.quoteSellShort.selector;
        (bool s, bytes memory ret) = address(adapter).staticcall(abi.encodeWithSelector(sel, R, p, amount));
        if (!s) {
            assertEq(bytes4(ret), WaveV4ProposalMarket.InsufficientDepth.selector, "only depth may reject a sell quote");
            return (false, 0, 0, 0);
        }
        (c, ld, sd) = abi.decode(ret, (uint256, uint256, uint256));
        return (true, c, ld, sd);
    }

    function _sellAmount(uint256 raw, uint256 seed, uint8 mode) internal pure returns (uint256) {
        uint256 m = (mode >> 3) & 3;
        if (m == 0) return bound(raw, 1, 2 * SCALE); // dust-level
        if (m == 1) return bound(raw, 1, 1e15);
        if (m == 2) return bound(raw, 1, seed * SCALE);
        return bound(raw, 1, 3 * seed * SCALE);
    }

    // ------------------------------------------------------------------ quotes == execution
    function testFuzz_QuotesMatchExecution_Buy(uint256 seedRaw, uint256 preRaw, uint256 amtRaw, uint8 mode) public {
        (uint256 p, uint256 seed) = _openFuzz(seedRaw, mode & 2 != 0);
        _preTrade(p, seed, preRaw, mode & 1 == 0);
        bool long_ = mode & 4 != 0;
        uint256 credits = (mode >> 3) & 1 == 1 ? bound(amtRaw, 1, 100) : bound(amtRaw, 1, seed * 3);

        (bool ok, uint256 quote) = _tryQuoteBuy(p, credits, long_);
        qr.fund(alice, R, p, credits);
        if (!ok) {
            vm.expectRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
            qr.buy(alice, R, p, credits, long_, 0);
            return;
        }
        uint256 pBefore = _pLong(R, p);
        uint256 out = qr.buy(alice, R, p, credits, long_, quote);
        assertEq(out, quote, "executed == quoted (to the unit)");
        assertEq(_bal(long_ ? _long(R, p) : _short(R, p), alice), quote, "balance == quote");
        assertEq(_bal(long_ ? _short(R, p) : _long(R, p), alice), 0, "no opposite leg");
        assertGe(quote, credits * SCALE, "buyer at least keeps the complete-set leg");
        if (long_) assertGe(_pLong(R, p), pBefore, "LONG buy never lowers pLong");
        else assertLe(_pLong(R, p), pBefore, "SHORT buy never raises pLong");
    }

    function testFuzz_QuotesMatchExecution_Sell(uint256 seedRaw, uint256 preRaw, uint256 amtRaw, uint8 mode) public {
        (uint256 p, uint256 seed) = _openFuzz(seedRaw, mode & 2 != 0);
        _preTrade(p, seed, preRaw, mode & 1 == 0);
        bool long_ = mode & 4 != 0;
        uint256 amount = _sellAmount(amtRaw, seed, mode);
        qr.mintLegs(alice, R, p, long_ ? amount : 0, long_ ? 0 : amount);

        (bool ok, uint256 qc, uint256 qld, uint256 qsd) = _tryQuoteSell(p, amount, long_);
        if (!ok) {
            vm.expectRevert(WaveV4ProposalMarket.InsufficientDepth.selector);
            qr.sell(alice, R, p, amount, long_, 0);
            return;
        }
        (uint256 c, uint256 ld, uint256 sd) = qr.sell(alice, R, p, amount, long_, qc);
        assertEq(c, qc, "credits == quote");
        assertEq(ld, qld, "LONG dust == quote");
        assertEq(sd, qsd, "SHORT dust == quote");
        assertEq(_bal(_credit(R, p), alice), c);
        assertEq(_bal(_long(R, p), alice), ld);
        assertEq(_bal(_short(R, p), alice), sd);
        // proceeds never exceed half the notional at any price... but never exceed the sold amount in credits either
        assertLe(c * SCALE, amount, "cannot receive more credits than raw tokens sold");
        // one leg's dust is strictly below one whole credit, the other within the bisection tolerance
        assertTrue(ld < SCALE || sd < SCALE, "at least one dust leg is sub-credit");
        assertLt(ld, SCALE + DUST_SLACK, "LONG dust bounded");
        assertLt(sd, SCALE + DUST_SLACK, "SHORT dust bounded");
    }

    // ------------------------------------------------------------------ bisection sanity
    function testFuzz_BisectionSanity_NoWholeCreditLeftInDust(
        uint256 seedRaw,
        uint256 buyRaw,
        uint256 fracRaw,
        uint8 mode
    ) public {
        (uint256 p, uint256 seed) = _openFuzz(seedRaw, mode & 1 == 0);
        bool long_ = mode & 2 != 0;
        uint256 got = _buy(alice, R, p, bound(buyRaw, 1, seed * 2), long_);
        uint256 amount = bound(fracRaw, 1, got);
        (uint256 c, uint256 ld, uint256 sd) = _sell(alice, R, p, amount, long_);
        emit log_named_uint("credits", c);
        assertTrue(ld < SCALE || sd < SCALE, "one dust leg is sub-credit");
        assertLt(ld, SCALE + DUST_SLACK, "LONG dust < 1 credit + tolerance");
        assertLt(sd, SCALE + DUST_SLACK, "SHORT dust < 1 credit + tolerance");
        // the sold leg's leftover (soldDust) can never hide a whole credit: it is paid out as part of credits otherwise
        uint256 soldDust = long_ ? ld : sd;
        uint256 otherDust = long_ ? sd : ld;
        assertTrue(soldDust < SCALE || otherDust < SCALE);
    }

    // ------------------------------------------------------------------ round trips
    /// @dev Sells up to `amt` of a leg; halves on InsufficientDepth. Returns whether anything sold.
    function _trySell(address user, uint256 p, uint256 amt, bool long_) internal returns (bool) {
        try qr.sell(user, R, p, amt, long_, 0) returns (uint256, uint256, uint256) {
            return true;
        } catch (bytes memory err) {
            assertEq(bytes4(err), WaveV4ProposalMarket.InsufficientDepth.selector, "only depth may reject a sale");
            return false;
        }
    }

    function _liquidate(address user, uint256 p, bool long_) internal {
        address tok = long_ ? _long(R, p) : _short(R, p);
        uint256 amt = _bal(tok, user);
        for (uint256 i; i < 12 && amt > SCALE; ++i) {
            if (_trySell(user, p, amt, long_)) {
                amt = _bal(tok, user);
                if (amt <= SCALE) break;
            } else {
                amt /= 2;
            }
        }
    }

    function testFuzz_RoundTripsNeverExtractValueAndStayBacked(uint256 seedRaw, uint256 entropy, uint8 mode) public {
        (uint256 p, uint256 seed) = _openFuzz(seedRaw, mode & 1 == 0);
        uint256 idleL = _bal(_long(R, p), address(adapter));
        uint256 idleS = _bal(_short(R, p), address(adapter));
        address[3] memory users = [alice, bob, carol];
        uint256 funded;

        for (uint256 u; u < 3; ++u) {
            uint256 fundedU = _session(users[u], p, seed, uint256(keccak256(abi.encode(entropy, u))));
            funded += fundedU;
            _liquidate(users[u], p, true);
            _liquidate(users[u], p, false);

            // nobody ends with more credits than they paid in
            assertLe(_bal(_credit(R, p), users[u]), fundedU, "credits out <= credits in");
            // complete-set supplies stay symmetric and fully backed
            assertEq(_supply(_long(R, p)), _supply(_short(R, p)), "LONG supply == SHORT supply");
            assertEq(
                _supply(_long(R, p)) + _supply(_credit(R, p)) * SCALE,
                (seed + funded) * SCALE,
                "sets + circulating credits == seed + funded (credits never exceed backing)"
            );
            uint256 pl = _pLong(R, p);
            assertGe(pl, 0.01e18);
            assertLe(pl, 0.99e18);
            assertEq(_bal(_long(R, p), address(adapter)), idleL, "adapter LONG == idle");
            assertEq(_bal(_short(R, p), address(adapter)), idleS, "adapter SHORT == idle");
        }
    }

    /// @dev One user's random buy/sell session; returns the credits it was funded with.
    function _session(address user, uint256 p, uint256 seed, uint256 e) internal returns (uint256 funded) {
        uint256 nOps = 2 + e % 6;
        for (uint256 i; i < nOps; ++i) {
            uint256 h = uint256(keccak256(abi.encode(e, i)));
            uint256 kind = h % 4;
            if (kind < 2) {
                uint256 credits = 1 + (h >> 8) % seed;
                qr.fund(user, R, p, credits);
                funded += credits;
                try qr.buy(user, R, p, credits, kind == 0, 0) returns (uint256) {}
                catch (bytes memory err) {
                    assertEq(bytes4(err), WaveV4ProposalMarket.InsufficientDepth.selector, "only depth may reject a buy");
                }
            } else {
                bool long_ = kind == 2;
                uint256 bal = _bal(long_ ? _long(R, p) : _short(R, p), user);
                uint256 amt = bal * (1 + (h >> 8) % 1000) / 1000;
                if (amt != 0) _trySell(user, p, amt, long_);
            }
        }
    }
}
