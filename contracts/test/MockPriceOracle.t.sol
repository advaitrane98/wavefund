// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {MockPriceOracle} from "../src/MockPriceOracle.sol";

contract MockPriceOracleTest is Test {
    MockPriceOracle internal oracle;
    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    int256 internal constant INITIAL = 2_500e8;

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new MockPriceOracle(admin, keeper, INITIAL);
    }

    // ---- deployment ----
    function test_Deployment() public view {
        assertEq(oracle.decimals(), 8);
        assertEq(oracle.MAX_ORACLE_AGE(), 5 minutes);
        assertEq(oracle.KEEPER_ROLE(), keccak256("KEEPER_ROLE"));
        (int256 answer, uint256 updatedAt) = oracle.latestPrice();
        assertEq(answer, INITIAL);
        assertEq(updatedAt, block.timestamp);
        assertTrue(oracle.hasRole(oracle.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(oracle.hasRole(oracle.KEEPER_ROLE(), keeper));
        assertFalse(oracle.hasRole(oracle.KEEPER_ROLE(), admin));
    }

    function test_Constructor_EmitsPriceUpdated() public {
        vm.expectEmit(false, false, false, true);
        emit MockPriceOracle.PriceUpdated(1e8, block.timestamp);
        new MockPriceOracle(admin, keeper, 1e8);
    }

    function test_Constructor_RevertsOnZeroAdmin() public {
        vm.expectRevert(MockPriceOracle.ZeroAddress.selector);
        new MockPriceOracle(address(0), keeper, INITIAL);
    }

    function test_Constructor_RevertsOnZeroKeeper() public {
        vm.expectRevert(MockPriceOracle.ZeroAddress.selector);
        new MockPriceOracle(admin, address(0), INITIAL);
    }

    function test_Constructor_RevertsOnNonPositiveInitial() public {
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.InvalidPrice.selector, int256(0)));
        new MockPriceOracle(admin, keeper, 0);
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.InvalidPrice.selector, int256(-5)));
        new MockPriceOracle(admin, keeper, -5);
    }

    // ---- updatePrice ----
    function test_UpdatePrice_ByKeeper() public {
        skip(100);
        vm.expectEmit(false, false, false, true, address(oracle));
        emit MockPriceOracle.PriceUpdated(3_000e8, block.timestamp);
        vm.prank(keeper);
        oracle.updatePrice(3_000e8);
        (int256 answer, uint256 updatedAt) = oracle.latestPrice();
        assertEq(answer, 3_000e8);
        assertEq(updatedAt, block.timestamp);
    }

    function test_UpdatePrice_RevertsForNonKeeper() public {
        bytes32 role = oracle.KEEPER_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        oracle.updatePrice(1e8);
        // admin without keeper role is also rejected
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, role));
        oracle.updatePrice(1e8);
    }

    function test_UpdatePrice_RejectsZeroAndNegative() public {
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.InvalidPrice.selector, int256(0)));
        oracle.updatePrice(0);
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.InvalidPrice.selector, int256(-1)));
        oracle.updatePrice(-1);
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.InvalidPrice.selector, type(int256).min));
        oracle.updatePrice(type(int256).min);
        vm.stopPrank();
        (int256 answer,) = oracle.latestPrice();
        assertEq(answer, INITIAL);
    }

    function test_UpdatePrice_RefreshesStaleOracle() public {
        skip(1 hours);
        assertFalse(oracle.isFresh());
        vm.prank(keeper);
        oracle.updatePrice(2_600e8);
        assertTrue(oracle.isFresh());
        assertEq(oracle.latestFreshPrice(), 2_600e8);
    }

    // ---- freshness ----
    function test_IsFresh_Boundary() public {
        assertTrue(oracle.isFresh());
        skip(5 minutes - 1);
        assertTrue(oracle.isFresh());
        skip(1); // exactly 5 minutes
        assertTrue(oracle.isFresh());
        assertEq(oracle.latestFreshPrice(), INITIAL);
        skip(1); // 5 minutes + 1
        assertFalse(oracle.isFresh());
    }

    function test_LatestFreshPrice_RevertsWhenStale() public {
        (, uint256 updatedAt) = oracle.latestPrice();
        skip(5 minutes + 1);
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.StalePrice.selector, updatedAt, uint256(5 minutes)));
        oracle.latestFreshPrice();
    }

    function test_LatestPrice_NeverRevertsEvenWhenStale() public {
        (, uint256 updatedAt0) = oracle.latestPrice();
        skip(365 days);
        (int256 answer, uint256 updatedAt) = oracle.latestPrice();
        assertEq(answer, INITIAL);
        assertEq(updatedAt, updatedAt0);
    }

    // ---- fuzz ----
    function testFuzz_UpdatePrice_StoresPositive(int256 answer, uint32 delay) public {
        answer = bound(answer, 1, type(int256).max);
        skip(delay);
        vm.prank(keeper);
        oracle.updatePrice(answer);
        (int256 got, uint256 at) = oracle.latestPrice();
        assertEq(got, answer);
        assertEq(at, block.timestamp);
        assertEq(oracle.latestFreshPrice(), answer);
    }

    function testFuzz_UpdatePrice_RejectsNonPositive(int256 answer) public {
        answer = bound(answer, type(int256).min, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.InvalidPrice.selector, answer));
        oracle.updatePrice(answer);
    }

    function testFuzz_Freshness(uint32 age) public {
        skip(age);
        assertEq(oracle.isFresh(), uint256(age) <= 5 minutes);
        if (uint256(age) <= 5 minutes) {
            assertEq(oracle.latestFreshPrice(), INITIAL);
        } else {
            vm.expectRevert();
            oracle.latestFreshPrice();
        }
    }

    // ---- observation history ----
    function _push(uint256 at, int256 answer) internal {
        vm.warp(at);
        vm.prank(keeper);
        oracle.updatePrice(answer);
    }

    function test_FirstObservation_ConstructorPriceIsTheFirstObservation() public view {
        (int256 a, uint256 t) = oracle.firstObservationAtOrAfter(0);
        assertEq(a, INITIAL);
        assertEq(t, 1_000_000);
        (a, t) = oracle.firstObservationAtOrAfter(1_000_000);
        assertEq(a, INITIAL);
        assertEq(t, 1_000_000);
    }

    function test_FirstObservation_ReturnsEarliestAtOrAfterTimestamp() public {
        _push(1_000_100, 2_600e8);
        _push(1_000_200, 2_700e8);
        _push(1_000_900, 2_800e8);
        (int256 a, uint256 t) = oracle.firstObservationAtOrAfter(1_000_001);
        assertEq(a, 2_600e8);
        assertEq(t, 1_000_100);
        (a, t) = oracle.firstObservationAtOrAfter(1_000_100); // inclusive
        assertEq(a, 2_600e8);
        (a, t) = oracle.firstObservationAtOrAfter(1_000_101);
        assertEq(a, 2_700e8);
        assertEq(t, 1_000_200);
        (a, t) = oracle.firstObservationAtOrAfter(1_000_201);
        assertEq(a, 2_800e8);
        assertEq(t, 1_000_900);
    }

    function test_FirstObservation_LaterUpdatesNeverChangeAnEarlierAnswer() public {
        _push(1_000_100, 2_600e8);
        (int256 before_,) = oracle.firstObservationAtOrAfter(1_000_050);
        _push(1_000_200, 1_000e8);
        _push(1_009_999, 9_000e8);
        (int256 after_, uint256 t) = oracle.firstObservationAtOrAfter(1_000_050);
        assertEq(after_, before_);
        assertEq(t, 1_000_100);
        // while latestPrice follows the newest update
        (int256 latest,) = oracle.latestPrice();
        assertEq(latest, 9_000e8);
    }

    function test_FirstObservation_RevertsWhenNoneAtOrAfter() public {
        _push(1_000_100, 2_600e8);
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.ObservationNotFound.selector, 1_000_101));
        oracle.firstObservationAtOrAfter(1_000_101);
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.ObservationNotFound.selector, type(uint256).max));
        oracle.firstObservationAtOrAfter(type(uint256).max);
    }

    function test_FirstObservation_SameTimestampUpdatesKeepTheFirstOne() public {
        _push(1_000_100, 2_600e8);
        vm.prank(keeper);
        oracle.updatePrice(2_650e8); // same block timestamp
        (int256 a,) = oracle.firstObservationAtOrAfter(1_000_100);
        assertEq(a, 2_600e8);
    }

    function testFuzz_FirstObservation_MatchesLinearScan(uint8 n, uint16 query) public {
        uint256 count = bound(n, 1, 40);
        uint256 t = 1_000_000;
        uint256[] memory times = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            t += 1 + (uint256(keccak256(abi.encode(i, n))) % 50);
            times[i] = t;
            _push(t, int256(1_000e8 + int256(i)));
        }
        uint256 q = 1_000_000 + (uint256(query) % (t - 1_000_000 + 20));
        uint256 expectedIdx = type(uint256).max;
        for (uint256 i; i < count; ++i) {
            if (times[i] >= q) {
                expectedIdx = i;
                break;
            }
        }
        if (q <= 1_000_000) {
            (int256 a0,) = oracle.firstObservationAtOrAfter(q);
            assertEq(a0, INITIAL);
        } else if (expectedIdx == type(uint256).max) {
            vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.ObservationNotFound.selector, q));
            oracle.firstObservationAtOrAfter(q);
        } else {
            (int256 a, uint256 at) = oracle.firstObservationAtOrAfter(q);
            assertEq(at, times[expectedIdx]);
            assertEq(a, int256(1_000e8 + int256(expectedIdx)));
        }
    }
}
