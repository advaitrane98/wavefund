// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ProposalTokens} from "../src/ProposalTokens.sol";
import {WaveHook} from "../src/WaveHook.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {MockQuantumRound} from "./mocks/MockQuantumRound.sol";
import {WaveBase} from "./WaveBase.sol";

/// @notice Post-review hardening: CREDIT-decimals guard on seeding and hook/PoolManager binding on wiring.
contract WaveV4ProposalMarketHardeningTest is WaveBase {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant SEED = 5_000_000;

    struct Stack {
        ProposalTokens tokens;
        MockQuantumRound qr;
        WaveV4ProposalMarket adapter;
        WaveHook hook;
    }

    /// @dev A second, fully wired stack on the shared PoolManager with its own ProposalTokens.
    ///      `setDec == false` leaves creditDecimals at its default of 18.
    function _buildStack(uint8 dec, bool setDec, uint256 tag) internal returns (Stack memory s) {
        s.tokens = new ProposalTokens(address(this));
        if (setDec) s.tokens.setCreditDecimals(dec);
        s.qr = new MockQuantumRound(s.tokens);
        s.tokens.grantRole(s.tokens.QUANTUM_ROUND_ROLE(), address(s.qr));
        s.adapter = new WaveV4ProposalMarket(pm, s.tokens, address(this));
        s.qr.setMarket(s.adapter);
        s.hook = _deployHookAt(_hookAddr(tag), address(s.adapter));
        s.adapter.setQuantumRound(address(s.qr));
        s.adapter.setWaveHook(address(s.hook));
    }

    function _poolId(Stack memory s) internal view returns (PoolId) {
        return _keyFor(s.tokens.longToken(R, P), s.tokens.shortToken(R, P), address(s.hook)).toId();
    }

    // ------------------------------------------------------------------ CreditDecimalsMismatch
    function test_Seed_RevertsCreditDecimalsMismatch_WhenDecimalsLeftAtDefault18() public {
        Stack memory s = _buildStack(0, false, 0x6001);
        assertEq(s.tokens.creditDecimals(), 18, "default CREDIT decimals");
        s.qr.createTokens(R, P);

        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.CreditDecimalsMismatch.selector, uint8(18)));
        s.qr.seed(R, P, SEED);

        // the failed seed left nothing behind
        assertFalse(s.hook.isRegistered(_poolId(s)), "pool not registered");
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, P));
        s.adapter.spotPrice(R, P);
    }

    function test_Seed_MisconfiguredDecimalsCannotBeFixedAfterTokensExist() public {
        Stack memory s = _buildStack(0, false, 0x6002);
        s.qr.createTokens(R, P);
        // CREDIT precision is locked by the first creation, so this stack can never become seedable
        vm.expectRevert(ProposalTokens.CreditDecimalsLocked.selector);
        s.tokens.setCreditDecimals(6);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.CreditDecimalsMismatch.selector, uint8(18)));
        s.qr.seed(R, P, SEED);
    }

    function test_Seed_RevertsForEveryDecimalsValueExceptSix() public {
        for (uint8 d; d <= 18; ++d) {
            Stack memory s = _buildStack(d, true, 0x6100 + d);
            assertEq(s.tokens.creditDecimals(), d);
            s.qr.createTokens(R, P);
            if (d == 6) {
                s.qr.seed(R, P, SEED);
                assertEq(s.adapter.spotPrice(R, P), 1e18, "6-decimals stack seeds");
            } else {
                vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.CreditDecimalsMismatch.selector, d));
                s.qr.seed(R, P, SEED);
            }
        }
    }

    function test_Seed_DecimalsGuardRunsBeforeMarketLookup() public {
        // wrong decimals + tokens never created: the decimals guard fires, not MarketNotFound
        Stack memory s = _buildStack(0, false, 0x6003);
        vm.prank(address(s.qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.CreditDecimalsMismatch.selector, uint8(18)));
        s.adapter.seedLiquidity(R, P, 1);

        // right decimals + tokens never created: MarketNotFound(roundId, proposalId) as before
        vm.prank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotFound.selector, R, P));
        adapter.seedLiquidity(R, P, 1);
    }

    function test_Seed_ZeroAmountAndWiringChecksPrecedeDecimalsGuard() public {
        Stack memory s = _buildStack(0, false, 0x6004);
        vm.prank(address(s.qr));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        s.adapter.seedLiquidity(R, P, 0);

        // not fully wired (no hook): WiringIncomplete wins over the decimals guard
        WaveV4ProposalMarket half = new WaveV4ProposalMarket(pm, s.tokens, address(this));
        half.setQuantumRound(address(this));
        vm.expectRevert(WaveV4ProposalMarket.WiringIncomplete.selector);
        half.seedLiquidity(R, P, 1);
    }

    function test_Seed_SucceedsWithSixDecimalsInBaseHarness() public {
        assertEq(tokens.creditDecimals(), 6);
        _open(R, P, SEED);
        assertEq(adapter.spotPrice(R, P), 1e18);
        assertTrue(hook.isRegistered(_id(R, P)));
    }

    // ------------------------------------------------------------------ HookPoolManagerMismatch
    function test_SetWaveHook_RevertsWhenHookUsesDifferentPoolManager() public {
        IPoolManager otherPm = IPoolManager(address(new PoolManager(address(this))));
        WaveV4ProposalMarket a = new WaveV4ProposalMarket(pm, tokens, address(this));
        // genuine WaveHook, correctly bound to `a`, but built on another PoolManager
        address foreign = _hookAddr(0x6201);
        deployCodeTo("WaveHook.sol:WaveHook", abi.encode(otherPm, address(a)), foreign);
        assertEq(WaveHook(foreign).adapter(), address(a));
        assertEq(address(WaveHook(foreign).poolManager()), address(otherPm));

        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.HookPoolManagerMismatch.selector, address(otherPm)));
        a.setWaveHook(foreign);
        assertEq(a.waveHook(), address(0), "nothing wired");
        assertEq(a.owner(), address(this), "ownership untouched");

        // still passes for a hook on the right PoolManager
        address good = address(_deployHookAt(_hookAddr(0x6202), address(a)));
        a.setWaveHook(good);
        assertEq(a.waveHook(), good);
    }

    function test_SetWaveHook_MismatchDoesNotBlockCompletingWiring() public {
        IPoolManager otherPm = IPoolManager(address(new PoolManager(address(this))));
        WaveV4ProposalMarket a = new WaveV4ProposalMarket(pm, tokens, address(this));
        a.setQuantumRound(address(qr));
        address foreign = _hookAddr(0x6203);
        deployCodeTo("WaveHook.sol:WaveHook", abi.encode(otherPm, address(a)), foreign);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.HookPoolManagerMismatch.selector, address(otherPm)));
        a.setWaveHook(foreign);
        assertEq(a.owner(), address(this), "handoff did not happen");
        a.setWaveHook(address(_deployHookAt(_hookAddr(0x6204), address(a))));
        assertEq(a.owner(), address(qr), "handoff after the right hook");
    }

    function test_SetWaveHook_AdapterBindingIsCheckedBeforePoolManager() public {
        IPoolManager otherPm = IPoolManager(address(new PoolManager(address(this))));
        WaveV4ProposalMarket a = new WaveV4ProposalMarket(pm, tokens, address(this));
        // wrong adapter AND wrong PoolManager: InvalidHookAdapter is reported first
        address bad = _hookAddr(0x6205);
        deployCodeTo("WaveHook.sol:WaveHook", abi.encode(otherPm, address(0xBEEF)), bad);
        vm.expectRevert(WaveV4ProposalMarket.InvalidHookAdapter.selector);
        a.setWaveHook(bad);
    }

    function test_SetWaveHook_MismatchStillOwnerGated() public {
        IPoolManager otherPm = IPoolManager(address(new PoolManager(address(this))));
        WaveV4ProposalMarket a = new WaveV4ProposalMarket(pm, tokens, address(this));
        address foreign = _hookAddr(0x6206);
        deployCodeTo("WaveHook.sol:WaveHook", abi.encode(otherPm, address(a)), foreign);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        a.setWaveHook(foreign);
    }
}
