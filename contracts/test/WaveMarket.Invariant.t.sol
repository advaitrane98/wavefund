// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {WaveHook} from "../src/WaveHook.sol";
import {MockQuantumRound} from "./mocks/MockQuantumRound.sol";
import {ProposalTokens} from "../src/ProposalTokens.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WaveBase} from "./WaveBase.sol";

/// @notice Stateful actor: several users buy/sell both legs and time advances inside the trading window.
contract WaveMarketHandler is CommonBase, StdUtils {
    MockQuantumRound public immutable qr;
    uint256 public immutable r;
    uint256 public immutable p;
    uint256 public immutable seed;
    uint64 public immutable end;
    address[] internal actors;

    uint256 public funded;
    uint256 public buys;
    uint256 public sells;
    uint256 public depthRejects;
    uint256 public unexpectedReverts;

    constructor(MockQuantumRound qr_, uint256 r_, uint256 p_, uint256 seed_, uint64 end_, address[] memory actors_) {
        qr = qr_;
        r = r_;
        p = p_;
        seed = seed_;
        end = end_;
        actors = actors_;
    }

    function _open() internal view returns (bool) {
        return vm.getBlockTimestamp() < end;
    }

    function _record(bytes memory err) internal {
        if (bytes4(err) == WaveV4ProposalMarket.InsufficientDepth.selector) ++depthRejects;
        else ++unexpectedReverts;
    }

    function _doBuy(uint256 a, uint256 amt, bool long_) internal {
        if (!_open()) return;
        address u = actors[a % actors.length];
        amt = bound(amt, 1, seed * 2);
        qr.fund(u, r, p, amt);
        funded += amt;
        try qr.buy(u, r, p, amt, long_, 0) returns (uint256) {
            ++buys;
        } catch (bytes memory err) {
            _record(err);
        }
    }

    function _doSell(uint256 a, uint256 frac, bool long_) internal {
        if (!_open()) return;
        address u = actors[a % actors.length];
        IERC20 t = IERC20(long_ ? qr.tokens().longToken(r, p) : qr.tokens().shortToken(r, p));
        uint256 amt = t.balanceOf(u) * bound(frac, 1, 100) / 100;
        if (amt == 0) return;
        try qr.sell(u, r, p, amt, long_, 0) returns (uint256, uint256, uint256) {
            ++sells;
        } catch (bytes memory err) {
            _record(err);
        }
    }

    function buyLong(uint256 a, uint256 amt) external {
        _doBuy(a, amt, true);
    }

    function buyShort(uint256 a, uint256 amt) external {
        _doBuy(a, amt, false);
    }

    function sellLong(uint256 a, uint256 frac) external {
        _doSell(a, frac, true);
    }

    function sellShort(uint256 a, uint256 frac) external {
        _doSell(a, frac, false);
    }

    /// @dev Time moves forward but never reaches tradingEnd, so trading and TWAP accumulation stay live.
    function warp(uint256 dt) external {
        uint256 now_ = vm.getBlockTimestamp();
        if (now_ + 1 >= end) return;
        dt = bound(dt, 0, 3 hours);
        uint256 target = now_ + dt;
        if (target >= end) target = end - 1;
        vm.warp(target);
    }
}

/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 50
contract WaveMarketInvariantTest is WaveBase {
    uint256 internal constant SEED = 5_000_000;
    WaveMarketHandler internal handler;
    uint256 internal idleL;
    uint256 internal idleS;

    function setUp() public override {
        super.setUp();
        _open(R, P, SEED);
        idleL = _bal(_long(R, P), address(adapter));
        idleS = _bal(_short(R, P), address(adapter));
        address[] memory actors = new address[](3);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        (,uint64 end,) = qr.marketTiming(R, P);
        handler = new WaveMarketHandler(qr, R, P, SEED, end, actors);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](5);
        sels[0] = WaveMarketHandler.buyLong.selector;
        sels[1] = WaveMarketHandler.buyShort.selector;
        sels[2] = WaveMarketHandler.sellLong.selector;
        sels[3] = WaveMarketHandler.sellShort.selector;
        sels[4] = WaveMarketHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function invariant_LongSupplyEqualsShortSupply() public view {
        assertEq(_supply(_long(R, P)), _supply(_short(R, P)));
    }

    /// @dev sets + circulating credits == seed + everything ever funded: credits never exceed backing.
    function invariant_CreditsNeverExceedBacking() public view {
        assertEq(
            _supply(_long(R, P)) + _supply(_credit(R, P)) * SCALE,
            (SEED + handler.funded()) * SCALE
        );
    }

    function invariant_PLongWithinBoundsAndComplementary() public view {
        (uint256 pl, uint256 ps) = adapter.probabilities(R, P);
        assertGe(pl, 0.01e18);
        assertLe(pl, 0.99e18);
        assertEq(pl + ps, 1e18);
        assertGe(adapter.spotPrice(R, P), uint256(0.01e18) * 1e18 / 0.99e18);
        assertLe(adapter.spotPrice(R, P), uint256(0.99e18) * 1e18 / 0.01e18);
    }

    function invariant_TwapWithinBounds() public view {
        uint256 t = adapter.probabilityTwap(R, P);
        assertGe(t, 0.01e18);
        assertLe(t, 0.99e18);
        uint256 pt = adapter.twap(R, P);
        assertGe(pt, uint256(0.01e18) * 1e18 / 0.99e18);
        assertLe(pt, uint256(0.99e18) * 1e18 / 0.01e18);
    }

    /// @dev Every handler sale consumes its own settlement; a lingering one would make quoting revert PendingRemainder.
    function invariant_NoStuckPendingState() public view {
        (bool ok, bytes memory ret) =
            address(adapter).staticcall(abi.encodeCall(adapter.quoteSellLong, (R, P, 1e15)));
        if (!ok) assertTrue(bytes4(ret) != WaveV4ProposalMarket.PendingRemainder.selector, "stuck pending");
    }

    /// @dev After each full trade the adapter holds exactly the idle seed sets again.
    function invariant_AdapterHoldsOnlyIdleSets() public view {
        assertEq(_bal(_long(R, P), address(adapter)), idleL);
        assertEq(_bal(_short(R, P), address(adapter)), idleS);
    }

    function invariant_NoUnexpectedRevertsInTrading() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    function afterInvariant() public {
        emit log_named_uint("buys", handler.buys());
        emit log_named_uint("sells", handler.sells());
        emit log_named_uint("depth rejects", handler.depthRejects());
        emit log_named_uint("funded credits", handler.funded());
    }
}
