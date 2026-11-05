// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ProposalTokens} from "../src/ProposalTokens.sol";
import {ProposerRegistry} from "../src/ProposerRegistry.sol";
import {WaveHook} from "../src/WaveHook.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {QuantumRound} from "../src/QuantumRound.sol";
import {Resolver} from "../src/Resolver.sol";
import {WavefundVault} from "../src/WavefundVault.sol";
import {MockPriceOracle} from "../src/MockPriceOracle.sol";
import {TestAsset} from "../src/TestAsset.sol";
import {RoundStatus} from "../src/interfaces/IQuantumRoundControl.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Full stack: PoolManager, market adapter + hook, QuantumRound, registry, resolver, vault, oracle and a
///         funded USDC/tETH pool at 2000 USDC per tETH. Vault starts with 100k USDC + 25 tETH (33.3% tETH).
abstract contract QuantumBase is Test {
    uint256 internal constant T0 = 1_000_000;
    uint256 internal constant SEED = 5e6;
    uint256 internal constant ONE = 1e18;
    uint256 internal constant SCALE = 1e12;
    uint256 internal constant R_MIN = 0.99e18;
    uint256 internal constant R_MAX = 1.01e18;
    uint256 internal constant DURATION = 1 days;
    uint256 internal constant HORIZON = 7 days;
    uint256 internal constant WINDOW = 1 hours;
    address internal constant HOOK_ADDR = address(uint160(uint256(0x4444) << 144) | 2752);

    IPoolManager internal pm;
    PoolModifyLiquidityTest internal lpRouter;
    ProposalTokens internal tokens;
    ProposerRegistry internal registry;
    WaveV4ProposalMarket internal adapter;
    WaveHook internal hook;
    QuantumRound internal qr;
    Resolver internal resolver;
    WavefundVault internal vault;
    MockPriceOracle internal oracle;
    MockUSDC internal usdc;
    TestAsset internal teth;

    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal agentA = makeAddr("agentA");
    address internal agentB = makeAddr("agentB");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        vm.warp(T0);
        pm = IPoolManager(address(new PoolManager(address(this))));
        usdc = new MockUSDC();
        tokens = new ProposalTokens(address(this));
        tokens.setCreditDecimals(6);
        registry = new ProposerRegistry(address(this), usdc);
        adapter = new WaveV4ProposalMarket(pm, tokens, address(this));
        deployCodeTo("WaveHook.sol:WaveHook", abi.encode(pm, address(adapter)), HOOK_ADDR);
        hook = WaveHook(HOOK_ADDR);
        qr = new QuantumRound(address(this), IERC20(address(usdc)), tokens, registry, adapter);
        tokens.grantRole(tokens.QUANTUM_ROUND_ROLE(), address(qr));
        registry.grantRole(registry.QUANTUM_ROUND_ROLE(), address(qr));
        adapter.setQuantumRound(address(qr));
        adapter.setWaveHook(address(hook));

        teth = new TestAsset(address(this));
        oracle = new MockPriceOracle(address(this), keeper, 2000e8);
        vault = new WavefundVault(address(this), IERC20(address(usdc)), IERC20(address(teth)), oracle, pm);
        resolver = new Resolver(address(this), qr);
        resolver.grantRole(resolver.RESOLVER_ROLE(), address(vault));
        vault.setRound(qr, resolver);
        vault.grantRole(vault.KEEPER_ROLE(), keeper);
        qr.grantRole(qr.KEEPER_ROLE(), keeper);
        qr.grantRole(qr.VAULT_ROLE(), address(vault));
        qr.grantRole(qr.RESOLVER_ROLE(), address(resolver));
        qr.setAllocationSource(address(vault));

        _initPoolAndLiquidity(4.5e17);
        usdc.mint(address(this), 100_000e6);
        teth.mint(address(this), 25e18);
        usdc.approve(address(vault), type(uint256).max);
        teth.approve(address(vault), type(uint256).max);
        vault.fundVault(100_000e6, 25e18, address(this));

        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(qr), type(uint256).max);
        qr.addProtocolLiquiditySeed(1_000e6);
        _register(agentA, "Agent A");
        _register(agentB, "Agent B");
    }

    // ------------------------------------------------------------------ pool
    function _initPoolAndLiquidity(int256 liquidity) internal {
        bool usdc0 = vault.usdcIsCurrency0();
        uint256 num = usdc0 ? 1e18 : 2000e6;
        uint256 den = usdc0 ? 2000e6 : 1e18;
        vault.initializePool(uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den))));
        lpRouter = new PoolModifyLiquidityTest(pm);
        usdc.mint(address(this), 1e27);
        teth.mint(address(this), 1e30);
        usdc.approve(address(lpRouter), type(uint256).max);
        teth.approve(address(lpRouter), type(uint256).max);
        PoolKey memory key;
        (key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks) = vault.poolKey();
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(-887220, 887220, liquidity, bytes32(0)), "");
    }

    // ------------------------------------------------------------------ round helpers
    function _register(address agent, string memory name) internal {
        vm.prank(agent);
        registry.registerAgent(name);
        usdc.mint(agent, 100e6);
        vm.prank(agent);
        usdc.approve(address(registry), type(uint256).max);
    }

    function _open() internal returns (uint256 r) {
        vm.prank(keeper);
        r = qr.openRound(block.timestamp + DURATION, HORIZON, R_MIN, R_MAX, WINDOW);
    }

    function _propose(address agent, uint256 r, uint16 bps) internal returns (uint256 p) {
        vm.prank(agent);
        p = qr.propose(r, QuantumRound.Allocation(bps), "rationale");
    }

    function _fund(address user, uint256 r, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(qr), type(uint256).max);
        qr.deposit(r, amount);
        vm.stopPrank();
    }

    function _claim(address user, uint256 r, uint256 p, uint256 amount) internal {
        vm.prank(user);
        qr.claimCredits(r, p, amount);
    }

    function _buyLong(address user, uint256 r, uint256 p, uint256 credits) internal returns (uint256) {
        vm.prank(user);
        return qr.buyLong(r, p, credits, 0);
    }

    function _buyShort(address user, uint256 r, uint256 p, uint256 credits) internal returns (uint256) {
        vm.prank(user);
        return qr.buyShort(r, p, credits, 0);
    }

    function _tradingEnd(uint256 r) internal view returns (uint256 end) {
        uint64 tradingEnd;
        (, tradingEnd,) = qr.marketTiming(r, 0);
        end = tradingEnd;
    }

    function _roundStatus(uint256 r) internal view returns (RoundStatus) {
        return qr.roundStatus(r);
    }

    function _toFinalWindow(uint256 r) internal {
        vm.warp(_tradingEnd(r) - WINDOW + 1);
    }

    function _toEnd(uint256 r) internal {
        vm.warp(_tradingEnd(r));
    }

    /// @dev Pushes proposal `p` above the status quo by buying LONG at the start of the final window.
    function _pushUp(uint256 r, uint256 p, address trader, uint256 credits) internal {
        _toFinalWindow(r);
        _claim(trader, r, p, credits);
        _buyLong(trader, r, p, credits);
        _toEnd(r);
    }

    function _collapse(uint256 r) internal {
        qr.collapse(r);
    }

    function _winner(uint256 r) internal view returns (uint256 w) {
        (w,) = qr.winningAllocation(r);
    }

    function _settleAt(uint256 r, uint256 realised) internal {
        vm.warp(block.timestamp > T0 ? block.timestamp : T0);
        uint256 evalEnd = qr.evaluationEnd(r);
        if (block.timestamp < evalEnd) vm.warp(evalEnd);
        vm.prank(address(resolver));
        qr.settle(r, realised);
    }

    function _pi(uint256 realised) internal pure returns (uint256) {
        uint256 c = realised < R_MIN ? R_MIN : (realised > R_MAX ? R_MAX : realised);
        return Math.mulDiv(c - R_MIN, ONE, R_MAX - R_MIN);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }
}
