// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {WavefundPoolHelper} from "../src/WavefundPoolHelper.sol";
import {TestAsset} from "../src/TestAsset.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract WavefundPoolHelperTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager pm;
    MockUSDC usdc;
    TestAsset teth;
    WavefundPoolHelper helper;
    address stranger = makeAddr("stranger");

    function setUp() public {
        pm = IPoolManager(address(new PoolManager(address(this))));
        usdc = new MockUSDC();
        teth = new TestAsset(address(this));
        helper = new WavefundPoolHelper(address(this), pm, IERC20(address(usdc)), IERC20(address(teth)));
        usdc.mint(address(this), 1_000_000e6);
        teth.mint(address(this), 1_000e18);
        usdc.approve(address(helper), type(uint256).max);
        teth.approve(address(helper), type(uint256).max);
    }

    function _key() internal view returns (PoolKey memory key) {
        (key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks) = helper.poolKey();
    }

    function _sqrtPrice2000() internal view returns (uint160) {
        bool usdc0 = address(usdc) < address(teth);
        uint256 num = usdc0 ? 1e18 : 2000e6;
        uint256 den = usdc0 ? 2000e6 : 1e18;
        return uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)));
    }

    function test_onlyOwnerCanOperate() public {
        vm.startPrank(stranger);
        vm.expectRevert();
        helper.initializePool(_sqrtPrice2000());
        vm.expectRevert();
        helper.modifyLiquidity(-60, 60, 1);
        vm.expectRevert();
        helper.swap(true, -1, 0);
        vm.stopPrank();
    }

    function test_callbackRejectsOutsiders() public {
        vm.expectRevert(WavefundPoolHelper.NotPoolManager.selector);
        helper.unlockCallback("");
    }

    function test_initializeAddRemoveRoundTrip() public {
        uint160 p = _sqrtPrice2000();
        helper.initializePool(p);
        (uint160 sqrtP,,,) = pm.getSlot0(_key().toId());
        assertEq(sqrtP, p);

        int24 tick = TickMath.getTickAtSqrtPrice(p);
        int24 lower = (tick / 60 - 100) * 60;
        int24 upper = (tick / 60 + 100) * 60;
        uint256 u0 = usdc.balanceOf(address(this));
        uint256 t0 = teth.balanceOf(address(this));
        (int256 a0, int256 a1) = helper.modifyLiquidity(lower, upper, 1e13);
        assertLt(a0, 0);
        assertLt(a1, 0);
        assertLt(usdc.balanceOf(address(this)), u0);
        assertLt(teth.balanceOf(address(this)), t0);
        assertEq(usdc.balanceOf(address(helper)), 0, "helper never holds funds");
        assertEq(teth.balanceOf(address(helper)), 0);

        (int256 r0, int256 r1) = helper.modifyLiquidity(lower, upper, -1e13);
        assertGt(r0, 0);
        assertGt(r1, 0);
        // rounding favours the pool by at most a couple of wei per side
        assertApproxEqAbs(usdc.balanceOf(address(this)), u0, 2);
        assertApproxEqAbs(teth.balanceOf(address(this)), t0, 2);
    }

    function test_alignSwapMovesAnEmptyPoolForFree() public {
        helper.initializePool(_sqrtPrice2000());
        uint160 target = uint160((uint256(_sqrtPrice2000()) * 105) / 100);
        uint256 u0 = usdc.balanceOf(address(this));
        uint256 t0 = teth.balanceOf(address(this));
        bool zeroForOne = target < _sqrtPrice2000();
        (int256 a0, int256 a1) = helper.swap(zeroForOne, -1, target);
        assertEq(a0, 0);
        assertEq(a1, 0);
        (uint160 sqrtP,,,) = pm.getSlot0(_key().toId());
        assertEq(sqrtP, target);
        assertEq(usdc.balanceOf(address(this)), u0);
        assertEq(teth.balanceOf(address(this)), t0);
    }

    function test_swapAgainstLiquidityPaysAndReceives() public {
        helper.initializePool(_sqrtPrice2000());
        int24 tick = TickMath.getTickAtSqrtPrice(_sqrtPrice2000());
        helper.modifyLiquidity((tick / 60 - 200) * 60, (tick / 60 + 200) * 60, 1e14);
        bool usdc0 = address(usdc) < address(teth);
        uint256 u0 = usdc.balanceOf(address(this));
        uint256 t0 = teth.balanceOf(address(this));
        // spend 10 USDC on tETH
        helper.swap(usdc0, -10e6, usdc0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        assertEq(u0 - usdc.balanceOf(address(this)), 10e6);
        assertGt(teth.balanceOf(address(this)), t0);
    }
}
