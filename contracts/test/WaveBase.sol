// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {ProposalTokens} from "../src/ProposalTokens.sol";
import {WaveHook} from "../src/WaveHook.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {MockQuantumRound} from "./mocks/MockQuantumRound.sol";

/// @notice Shared harness: PoolManager + ProposalTokens + MockQuantumRound + adapter + hook (flags 2752).
abstract contract WaveBase is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant SCALE = 1e12;
    uint160 internal constant HOOK_FLAGS = 2752;
    address internal constant HOOK_ADDR = address(uint160(uint256(0x4444) << 144) | 2752);
    uint160 internal constant Q96 = uint160(1 << 96);

    IPoolManager internal pm;
    ProposalTokens internal tokens;
    MockQuantumRound internal qr;
    WaveV4ProposalMarket internal adapter;
    WaveHook internal hook;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant R = 1;
    uint256 internal constant P = 1;

    function setUp() public virtual {
        pm = _deployPoolManager();
        _deployStack();
    }

    function _deployPoolManager() internal virtual returns (IPoolManager) {
        return IPoolManager(address(new PoolManager(address(this))));
    }

    function _deployStack() internal {
        tokens = new ProposalTokens(address(this));
        tokens.setCreditDecimals(6);
        qr = new MockQuantumRound(tokens);
        tokens.grantRole(tokens.QUANTUM_ROUND_ROLE(), address(qr));
        adapter = new WaveV4ProposalMarket(pm, tokens, address(this));
        qr.setMarket(adapter);
        hook = _deployHookAt(HOOK_ADDR, address(adapter));
        adapter.setQuantumRound(address(qr));
        adapter.setWaveHook(address(hook));
    }

    /// @dev A round controller whose `market()` getter returns `a` (what setQuantumRound now requires).
    function _roundFor(WaveV4ProposalMarket a) internal returns (MockQuantumRound r) {
        r = new MockQuantumRound(tokens);
        r.setMarket(a);
    }

    /// @dev An address whose low 14 bits are exactly 2752, distinguished by `tag` in the high bits.
    function _hookAddr(uint256 tag) internal pure returns (address) {
        return address(uint160(tag << 144) | 2752);
    }

    function _deployHookAt(address where, address adapter_) internal returns (WaveHook) {
        deployCodeTo("WaveHook.sol:WaveHook", abi.encode(pm, adapter_), where);
        return WaveHook(where);
    }

    // ------------------------------------------------------------------ market helpers
    function _open(uint256 r, uint256 p, uint256 seedCredits) internal {
        qr.openMarket(r, p, seedCredits);
    }

    function _openWith(uint256 r, uint256 p, uint256 seedCredits, uint64 start, uint64 end, uint64 fw) internal {
        qr.setTiming(r, p, start, end, fw);
        qr.openMarket(r, p, seedCredits);
    }

    function _long(uint256 r, uint256 p) internal view returns (address) {
        return tokens.longToken(r, p);
    }

    function _short(uint256 r, uint256 p) internal view returns (address) {
        return tokens.shortToken(r, p);
    }

    function _credit(uint256 r, uint256 p) internal view returns (address) {
        return tokens.creditToken(r, p);
    }

    function _longIs0(uint256 r, uint256 p) internal view returns (bool) {
        return _long(r, p) < _short(r, p);
    }

    function _keyFor(address longT, address shortT, address hooks_) internal pure returns (PoolKey memory) {
        bool l0 = longT < shortT;
        return PoolKey({
            currency0: Currency.wrap(l0 ? longT : shortT),
            currency1: Currency.wrap(l0 ? shortT : longT),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hooks_)
        });
    }

    function _key(uint256 r, uint256 p) internal view returns (PoolKey memory) {
        return _keyFor(_long(r, p), _short(r, p), address(hook));
    }

    function _id(uint256 r, uint256 p) internal view returns (PoolId) {
        return _key(r, p).toId();
    }

    function _pLong(uint256 r, uint256 p) internal view returns (uint256) {
        return hook.pLong(_id(r, p));
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function _supply(address token) internal view returns (uint256) {
        return IERC20(token).totalSupply();
    }

    function _buy(address user, uint256 r, uint256 p, uint256 credits, bool long_) internal returns (uint256) {
        qr.fund(user, r, p, credits);
        return qr.buy(user, r, p, credits, long_, 0);
    }

    function _sellAll(address user, uint256 r, uint256 p, bool long_)
        internal
        returns (uint256 credits, uint256 ld, uint256 sd)
    {
        uint256 amt = _bal(long_ ? _long(r, p) : _short(r, p), user);
        return qr.sell(user, r, p, amt, long_, 0);
    }

    function _sell(address user, uint256 r, uint256 p, uint256 amount, bool long_)
        internal
        returns (uint256 credits, uint256 ld, uint256 sd)
    {
        return qr.sell(user, r, p, amount, long_, 0);
    }

    function _quoteBuy(uint256 r, uint256 p, uint256 credits, bool long_) internal view returns (uint256) {
        return long_ ? adapter.quoteBuyLong(r, p, credits) : adapter.quoteBuyShort(r, p, credits);
    }

    function _quoteSell(uint256 r, uint256 p, uint256 amount, bool long_)
        internal
        view
        returns (uint256 c, uint256 ld, uint256 sd)
    {
        return long_ ? adapter.quoteSellLong(r, p, amount) : adapter.quoteSellShort(r, p, amount);
    }

    // ------------------------------------------------------------------ ordering discovery
    function _predict(uint256 r, uint256 p, uint8 kind) internal view returns (address) {
        return Clones.predictDeterministicAddress(
            tokens.implementation(), keccak256(abi.encode(r, p, uint256(kind))), address(tokens)
        );
    }

    /// @dev First proposalId >= `from` in round `r` whose LONG token sorts as currency0 (longIs0) or currency1.
    function _findOrdering(uint256 r, uint256 from, bool longIs0) internal view returns (uint256 p) {
        for (p = from; p < from + 200; ++p) {
            if ((_predict(r, p, 1) < _predict(r, p, 2)) == longIs0) return p;
        }
        revert("no ordering found");
    }

    function _openOrdering(uint256 r, uint256 from, bool longIs0, uint256 seedCredits) internal returns (uint256 p) {
        p = _findOrdering(r, from, longIs0);
        _open(r, p, seedCredits);
        assertEq(_longIs0(r, p), longIs0, "ordering");
    }

    // ------------------------------------------------------------------ revert helpers
    /// @dev Encodes the v4 wrapper a hook revert is surfaced in by the PoolManager.
    function _hookFail(address hookAddr, bytes4 hookSelector, bytes memory inner)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector, hookAddr, hookSelector, inner, abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _hookFail(bytes4 hookSelector, bytes memory inner) internal view returns (bytes memory) {
        return _hookFail(address(hook), hookSelector, inner);
    }

    /// @dev via_ir may cache `block.timestamp` across vm.warp, so always read time through the cheatcode.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
