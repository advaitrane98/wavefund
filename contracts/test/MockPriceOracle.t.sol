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
}
