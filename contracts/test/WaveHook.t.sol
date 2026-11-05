// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ImmutableState} from "@uniswap/v4-periphery/src/base/ImmutableState.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {WaveHook} from "../src/WaveHook.sol";
import {IWaveHook} from "../src/interfaces/IWaveHook.sol";
import {WaveBase} from "./WaveBase.sol";
import {HookActor, MockERC20} from "./mocks/HookActor.sol";

/// @notice Hook-level tests: constants, mining, registration validation, access control, gating.
///         A second hook instance whose "adapter" is a plain unlock-router (HookActor) gives full control of pools.
contract WaveHookTest is WaveBase {
    using PoolIdLibrary for PoolKey;

    HookActor internal actor;
    WaveHook internal hook2;
    MockERC20 internal tLo;
    MockERC20 internal tHi;
    uint64 internal t0;

    function setUp() public override {
        super.setUp();
        actor = new HookActor(pm);
        hook2 = _deployHookAt(_hookAddr(0x6001), address(actor));
        MockERC20 a = new MockERC20("A");
        MockERC20 b = new MockERC20("B");
        (tLo, tHi) = address(a) < address(b) ? (a, b) : (b, a);
        tLo.mint(address(actor), 1e30);
        tHi.mint(address(actor), 1e30);
        t0 = uint64(_now());
    }

    function _k2() internal view returns (PoolKey memory) {
        return _keyFor(address(tLo), address(tHi), address(hook2));
    }

    function _reg(PoolKey memory k, address longT, uint64 s, uint64 e, uint64 fw, uint256 p0) internal {
        actor.register(IWaveHook(address(hook2)), k, 1, 1, longT, s, e, fw, p0);
    }

    function _regOk() internal returns (PoolKey memory k) {
        k = _k2();
        _reg(k, address(tLo), t0, t0 + 1 days, 1 hours, 0.5e18);
    }

    // ------------------------------------------------------------------ constants & mining
    function test_HookConstants() public view {
        assertEq(hook.MIN_PROBABILITY(), 0.01e18);
        assertEq(hook.MAX_PROBABILITY(), 0.99e18);
        assertEq(int256(hook.MIN_POSITION_TICK()), -45900);
        assertEq(int256(hook.MAX_POSITION_TICK()), 45900);
        assertEq(int256(hook.REQUIRED_TICK_SPACING()), 60);
        assertEq(uint256(hook.REQUIRED_POOL_FEE()), 3000);
        assertEq(address(hook.poolManager()), address(pm));
        // 2752 = beforeAddLiquidity | beforeRemoveLiquidity | beforeSwap | afterSwap
        assertEq(uint256(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG), 2752);
    }

    function test_ConstructorRejectsZeroAdapter() public {
        vm.expectRevert(WaveHook.ZeroAdapter.selector);
        _deployHookAt(_hookAddr(0x6002), address(0));
    }

    function test_ConstructorRejectsZeroPoolManager() public {
        vm.expectRevert(WaveHook.ZeroPoolManager.selector);
        deployCodeTo("WaveHook.sol:WaveHook", abi.encode(address(0), address(adapter)), _hookAddr(0x6003));
    }

    function test_HookRejectsAddressWithWrongFlags() public {
        vm.expectRevert(); // Hooks.HookAddressNotValid
        deployCodeTo("WaveHook.sol:WaveHook", abi.encode(pm, address(adapter)), address(uint160(uint256(0x7777) << 144) | 2753));
    }

    function test_OffchainMinerProducesValidHookAddress() public {
        bytes memory args = abi.encode(pm, address(adapter));
        (address expected, bytes32 salt) = HookMiner.find(address(this), HOOK_FLAGS, type(WaveHook).creationCode, args);
        WaveHook mined = new WaveHook{salt: salt}(pm, address(adapter));
        assertEq(address(mined), expected, "CREATE2 address matches miner");
        assertEq(uint160(address(mined)) & Hooks.ALL_HOOK_MASK, 2752, "low 14 bits == 2752");
        Hooks.Permissions memory perm = mined.getHookPermissions();
        assertTrue(perm.beforeAddLiquidity && perm.beforeRemoveLiquidity && perm.beforeSwap && perm.afterSwap);
        assertFalse(perm.beforeInitialize || perm.afterInitialize || perm.afterAddLiquidity || perm.afterRemoveLiquidity);
        assertFalse(perm.beforeDonate || perm.afterDonate);
        assertFalse(perm.beforeSwapReturnDelta || perm.afterSwapReturnDelta);
        assertFalse(perm.afterAddLiquidityReturnDelta || perm.afterRemoveLiquidityReturnDelta);
        assertEq(mined.adapter(), address(adapter));
        // and a mined hook is accepted by the adapter wiring path
        assertTrue(Hooks.isValidHookAddress(IHooks(address(mined)), 3000));
    }

    // ------------------------------------------------------------------ registerPool validation
    function test_RegisterPool_OnlyAdapter() public {
        PoolKey memory k = _k2();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WaveHook.OnlyAdapter.selector, stranger));
        hook2.registerPool(k, 1, 1, address(tLo), t0, t0 + 1 days, 1 hours, 0.5e18);
        // the real hook: not even the QuantumRound may register, only the adapter
        PoolKey memory kr = _keyFor(address(tLo), address(tHi), address(hook));
        vm.prank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveHook.OnlyAdapter.selector, address(qr)));
        hook.registerPool(kr, 1, 1, address(tLo), t0, t0 + 1 days, 1 hours, 0.5e18);
    }

    function test_RegisterPool_StoresMetadataAndEmits() public {
        PoolKey memory k = _k2();
        PoolId id = k.toId();
        assertFalse(hook2.isRegistered(id));
        vm.expectEmit(true, true, true, true, address(hook2));
        emit WaveHook.PoolRegistered(id, 7, 9, address(tHi), t0 + 5, t0 + 1 days, 2 hours, 0.25e18);
        actor.register(IWaveHook(address(hook2)), k, 7, 9, address(tHi), t0 + 5, t0 + 1 days, 2 hours, 0.25e18);
        assertTrue(hook2.isRegistered(id));
        IWaveHook.PoolData memory d = hook2.poolDetails(id);
        assertEq(d.roundId, 7);
        assertEq(d.proposalId, 9);
        assertEq(d.longToken, address(tHi));
        assertEq(uint256(d.tradingStart), t0 + 5);
        assertEq(uint256(d.tradingEnd), t0 + 1 days);
        assertEq(uint256(d.finalWindowSeconds), 2 hours);
        assertEq(uint256(d.lastObservationTime), t0 + 5);
        assertFalse(d.longIsCurrency0, "LONG is currency1");
        assertTrue(d.registered);
        assertEq(d.lastProbability, 0.25e18);
        assertEq(d.lastPrice, uint256(0.25e18) * 1e18 / 0.75e18, "price = p/(1-p)");
        assertEq(d.finalWindowCumulative, 0);
        assertEq(d.finalWindowCumulativePrice, 0);
    }

    function test_RegisterPool_RejectsBadKeyAndLongToken() public {
        PoolKey memory k = _k2();
        PoolKey memory bad = _k2();
        bad.hooks = IHooks(address(hook)); // some other hook
        vm.expectRevert(WaveHook.InvalidHook.selector);
        _reg(bad, address(tLo), t0, t0 + 1 days, 1 hours, 0.5e18);

        bad = _k2();
        bad.fee = 500;
        vm.expectRevert(abi.encodeWithSelector(WaveHook.InvalidPoolFee.selector, uint24(500), uint24(3000)));
        _reg(bad, address(tLo), t0, t0 + 1 days, 1 hours, 0.5e18);

        bad = _k2();
        bad.tickSpacing = 10;
        vm.expectPartialRevert(WaveHook.InvalidTickSpacing.selector);
        _reg(bad, address(tLo), t0, t0 + 1 days, 1 hours, 0.5e18);

        bad = _k2();
        bad.currency0 = Currency.wrap(address(0));
        vm.expectRevert(WaveHook.NativeCurrencyNotAllowed.selector);
        _reg(bad, address(tHi), t0, t0 + 1 days, 1 hours, 0.5e18);

        vm.expectRevert(WaveHook.InvalidLongToken.selector);
        _reg(k, makeAddr("notInPool"), t0, t0 + 1 days, 1 hours, 0.5e18);
        vm.expectRevert(WaveHook.InvalidLongToken.selector);
        _reg(k, address(0), t0, t0 + 1 days, 1 hours, 0.5e18);
    }

    function test_RegisterPool_RejectsBadWindows() public {
        PoolKey memory k = _k2();
        // start >= end
        vm.expectRevert(WaveHook.InvalidTradingWindow.selector);
        _reg(k, address(tLo), t0 + 100, t0 + 100, 50, 0.5e18);
        vm.expectRevert(WaveHook.InvalidTradingWindow.selector);
        _reg(k, address(tLo), t0 + 100, t0 + 99, 50, 0.5e18);
        // end in the past, and end == now
        vm.warp(t0 + 1000);
        vm.expectRevert(WaveHook.InvalidTradingWindow.selector);
        _reg(k, address(tLo), t0, t0 + 500, 100, 0.5e18);
        vm.expectRevert(WaveHook.InvalidTradingWindow.selector);
        _reg(k, address(tLo), t0, t0 + 1000, 100, 0.5e18);
        // final window 0 or longer than the duration
        vm.expectRevert(WaveHook.InvalidFinalWindow.selector);
        _reg(k, address(tLo), t0 + 1000, t0 + 2000, 0, 0.5e18);
        vm.expectRevert(WaveHook.InvalidFinalWindow.selector);
        _reg(k, address(tLo), t0 + 1000, t0 + 2000, 1001, 0.5e18);
        // == duration is the largest legal window; end = now + 1 is the smallest legal end
        _reg(k, address(tLo), t0 + 1000, t0 + 2000, 1000, 0.5e18);
        assertTrue(hook2.isRegistered(k.toId()));
        MockERC20 c = new MockERC20("C");
        PoolKey memory k2 = _keyFor(address(c), address(tLo), address(hook2));
        actor.register(IWaveHook(address(hook2)), k2, 1, 2, address(c), t0 + 900, t0 + 1001, 1, 0.5e18);
    }

    function test_RegisterPool_RejectsOutOfBoundProbabilityAndAcceptsEdges() public {
        PoolKey memory k = _k2();
        vm.expectRevert(abi.encodeWithSelector(WaveHook.ProbabilityOutOfBounds.selector, 0.01e18 - 1));
        _reg(k, address(tLo), t0, t0 + 1 days, 1 hours, 0.01e18 - 1);
        vm.expectRevert(abi.encodeWithSelector(WaveHook.ProbabilityOutOfBounds.selector, 0.99e18 + 1));
        _reg(k, address(tLo), t0, t0 + 1 days, 1 hours, 0.99e18 + 1);
        vm.expectRevert(abi.encodeWithSelector(WaveHook.ProbabilityOutOfBounds.selector, 0));
        _reg(k, address(tLo), t0, t0 + 1 days, 1 hours, 0);
        vm.expectRevert(abi.encodeWithSelector(WaveHook.ProbabilityOutOfBounds.selector, 1e18));
        _reg(k, address(tLo), t0, t0 + 1 days, 1 hours, 1e18);
        _reg(k, address(tLo), t0, t0 + 1 days, 1 hours, 0.01e18);
        assertEq(hook2.poolDetails(k.toId()).lastPrice, uint256(0.01e18) * 1e18 / 0.99e18);
    }

    function test_RegisterPool_DuplicateReverts() public {
        PoolKey memory k = _regOk();
        vm.expectRevert(WaveHook.PoolAlreadyRegistered.selector);
        _reg(k, address(tLo), t0, t0 + 2 days, 1 hours, 0.4e18);
        // re-registering cannot be used to rewrite a live market's window either
        assertEq(uint256(hook2.poolDetails(k.toId()).tradingEnd), t0 + 1 days);
    }

    function test_UnregisteredPoolViewsRevert() public {
        PoolId id = _k2().toId();
        assertFalse(hook2.isRegistered(id));
        vm.expectRevert(WaveHook.PoolNotRegistered.selector);
        hook2.poolDetails(id);
        vm.expectRevert(WaveHook.PoolNotRegistered.selector);
        hook2.pLong(id);
        vm.expectRevert(WaveHook.PoolNotRegistered.selector);
        hook2.pShort(id);
        vm.expectRevert(WaveHook.PoolNotRegistered.selector);
        hook2.spotPriceX18(id);
        vm.expectRevert(WaveHook.PoolNotRegistered.selector);
        hook2.finalWindowTwap(id);
        vm.expectRevert(WaveHook.PoolNotRegistered.selector);
        hook2.finalWindowPriceTwap(id);
    }

    function test_RegisteredButUninitialisedPoolReadRevertsPriceOutOfRange() public {
        PoolKey memory k = _regOk();
        vm.expectRevert(WaveHook.PriceOutOfRange.selector);
        hook2.pLong(k.toId());
    }

    // ------------------------------------------------------------------ callbacks / senders
    function test_DirectHookCallbacksByNonPoolManagerRevert() public {
        PoolKey memory k = _key2Dummy();
        SwapParams memory sp = SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1);
        ModifyLiquidityParams memory mp = ModifyLiquidityParams(-60, 60, 1, bytes32(0));
        bytes4 sel = ImmutableState.NotPoolManager.selector;
        vm.startPrank(address(actor)); // even the adapter itself cannot call the callbacks directly
        vm.expectRevert(sel);
        hook2.beforeAddLiquidity(address(actor), k, mp, "");
        vm.expectRevert(sel);
        hook2.beforeRemoveLiquidity(address(actor), k, mp, "");
        vm.expectRevert(sel);
        hook2.beforeSwap(address(actor), k, sp, "");
        vm.expectRevert(sel);
        hook2.afterSwap(address(actor), k, sp, BalanceDelta.wrap(0), "");
        vm.stopPrank();
        vm.expectRevert(sel);
        hook.beforeSwap(address(adapter), k, sp, "");
    }

    function _key2Dummy() internal view returns (PoolKey memory) {
        return _k2();
    }

    function test_SwapAndLiquidityBySomeoneOtherThanAdapterRevert() public {
        _open(R, P, 5_000_000);
        PoolKey memory k = _key(R, P);
        // `actor` is a legitimate unlock router but not the adapter bound into the real hook
        bytes memory swapErr = _hookFail(IHooks.beforeSwap.selector, abi.encodeWithSelector(WaveHook.OnlyAdapter.selector, address(actor)));
        vm.expectRevert(swapErr);
        actor.swap(k, true, -1e15, TickMath.MIN_SQRT_PRICE + 1);
        vm.expectRevert(swapErr);
        actor.swap(k, false, -1e15, TickMath.MAX_SQRT_PRICE - 1);
        vm.expectRevert(
            _hookFail(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(WaveHook.OnlyAdapter.selector, address(actor)))
        );
        actor.modify(k, -45900, 45900, 1e18);
        vm.warp(_now() + 1 days);
        vm.expectRevert(
            _hookFail(IHooks.beforeRemoveLiquidity.selector, abi.encodeWithSelector(WaveHook.OnlyAdapter.selector, address(actor)))
        );
        actor.modify(k, -45900, 45900, -1e18);
    }

    function test_UnregisteredPoolWithHookAddressIsRejected_NonAdapterSender() public {
        // rogue pool pointing at the REAL hook
        PoolKey memory rogue = _keyFor(address(tLo), address(tHi), address(hook));
        pm.initialize(rogue, Q96);
        vm.expectRevert(_hookFail(IHooks.beforeSwap.selector, abi.encodeWithSelector(WaveHook.OnlyAdapter.selector, address(actor))));
        actor.swap(rogue, true, -1e15, TickMath.MIN_SQRT_PRICE + 1);
        vm.expectRevert(
            _hookFail(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(WaveHook.OnlyAdapter.selector, address(actor)))
        );
        actor.modify(rogue, -60, 60, 1e18);
    }

    function test_UnregisteredPoolWithHookAddressIsRejected_AdapterSender() public {
        // hook2's "adapter" is the actor, so the sender check passes and only the registration check can stop it
        PoolKey memory rogue = _k2();
        pm.initialize(rogue, Q96);
        bytes memory nr = abi.encodeWithSelector(WaveHook.PoolNotRegistered.selector);
        vm.expectRevert(_hookFail(address(hook2), IHooks.beforeSwap.selector, nr));
        actor.swap(rogue, true, -1e15, TickMath.MIN_SQRT_PRICE + 1);
        vm.expectRevert(_hookFail(address(hook2), IHooks.beforeAddLiquidity.selector, nr));
        actor.modify(rogue, -60, 60, 1e18);
        vm.expectRevert(_hookFail(address(hook2), IHooks.beforeRemoveLiquidity.selector, nr));
        actor.modify(rogue, -60, 60, -1e18);
    }
}
