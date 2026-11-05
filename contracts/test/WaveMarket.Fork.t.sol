// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {WaveGasUtil} from "./WaveGasUtil.sol";

/// @notice Runs the market against the REAL Arc Testnet PoolManager on a pinned fork.
///         No USDC ever moves (tokens are ProposalTokens clones). If the RPC is unreachable, setUp's
///         `createSelectFork` reverts and EVERY test in this file FAILS (never skips).
contract WaveMarketForkTest is WaveGasUtil {
    using StateLibrary for IPoolManager;

    address internal constant ARC_POOL_MANAGER = 0x2756F3F7bFAf103F4c550f4d24CdCa82B093240A;
    uint256 internal constant ARC_CHAIN_ID = 5042002;
    /// @dev Latest block at authoring time was 70894501; pinned ~100 blocks earlier.
    uint256 internal constant FORK_BLOCK = 70894400;
    uint256 internal constant SEED = 5_000_000;

    function setUp() public override {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC", string("https://rpc.testnet.arc.io"));
        vm.createSelectFork(rpc, FORK_BLOCK);
        assertEq(block.chainid, ARC_CHAIN_ID, "Arc Testnet chain id");
        assertEq(block.number, FORK_BLOCK, "pinned block");
        assertGt(ARC_POOL_MANAGER.code.length, 0, "PoolManager has code on the fork");
        super.setUp();
    }

    function _deployPoolManager() internal pure override returns (IPoolManager) {
        return IPoolManager(ARC_POOL_MANAGER);
    }

    function test_Fork_ForkIsRealArcAndStackIsWired() public view {
        assertEq(block.chainid, ARC_CHAIN_ID);
        assertEq(address(pm), ARC_POOL_MANAGER);
        assertEq(address(adapter.poolManager()), ARC_POOL_MANAGER);
        assertEq(address(hook.poolManager()), ARC_POOL_MANAGER);
        assertEq(uint160(address(hook)) & 0x3FFF, 2752);
        assertEq(hook.adapter(), address(adapter));
        assertEq(adapter.owner(), address(qr), "ownership handed to the round");
    }

    function test_Fork_SeedLiquidityGasAndState() public {
        uint256 g = _gasSeed(R, P, SEED);
        emit log_named_uint("[fork]  seedLiquidity gas (5 USDC seed)", g);
        assertLt(g, SEED_GAS_TARGET, "seedLiquidity < 5,000,000 gas on the real PoolManager");
        assertEq(_pLong(R, P), 0.5e18, "seeded at 1:1");
        PoolId id = _id(R, P);
        assertEq(uint256(pm.getLiquidity(id)), SEED * SCALE, "liquidity == complete-set notional");
        assertTrue(hook.isRegistered(id));
        (uint160 price,,,) = pm.getSlot0(id);
        assertEq(price, Q96);
    }

    function test_Fork_FullLifecycle() public {
        _open(R, P, SEED);
        PoolId id = _id(R, P);
        (, uint64 end, uint64 fw) = qr.marketTiming(R, P);
        assertEq(_pLong(R, P), 0.5e18);

        // ---- buy LONG: pLong rises
        uint256 qL = adapter.quoteBuyLong(R, P, 1_000_000);
        uint256 gotL = _buy(alice, R, P, 1_000_000, true);
        assertEq(gotL, qL, "quote == execution on the real PoolManager");
        uint256 pAfterLong = _pLong(R, P);
        assertGt(pAfterLong, 0.5e18);
        assertApproxEqAbs(pAfterLong, 0.59e18, 0.003e18, "1 USDC buy ~ +9pp on the fork too");

        // ---- buy SHORT: pLong falls
        uint256 qS = adapter.quoteBuyShort(R, P, 700_000);
        uint256 gotS = _buy(bob, R, P, 700_000, false);
        assertEq(gotS, qS);
        uint256 pAfterShort = _pLong(R, P);
        assertLt(pAfterShort, pAfterLong);
        assertApproxEqAbs(hook.pLong(id) + hook.pShort(id), 1e18, 0, "complementary");

        // ---- sell: quote == execution, credits <= spent
        uint256 sellAmt = gotL / 2;
        (uint256 qc, uint256 qld, uint256 qsd) = adapter.quoteSellLong(R, P, sellAmt);
        (uint256 c, uint256 ld, uint256 sd) = _sell(alice, R, P, sellAmt, true);
        assertEq(c, qc);
        assertEq(ld, qld);
        assertEq(sd, qsd);
        assertGt(c, 0);
        assertLt(c, 1_000_000, "half the tokens fetch less than all credits spent");
        assertEq(_bal(_credit(R, P), alice), c);

        // ---- TWAP: enter the final window, trade, and watch the integral move
        uint256 pBeforeWindow = _pLong(R, P);
        assertEq(hook.finalWindowTwap(id), pBeforeWindow, "before the window the TWAP extrapolates the last spot");
        vm.warp(end - fw / 2);
        assertEq(hook.finalWindowTwap(id), pBeforeWindow, "no trade in window yet: TWAP == last observation");
        _buy(carol, R, P, 900_000, false);
        uint256 pNow = _pLong(R, P);
        assertLt(pNow, pBeforeWindow);
        uint256 twapNow = hook.finalWindowTwap(id);
        // first half of the window at pBeforeWindow, second half extrapolated at pNow
        assertApproxEqAbs(twapNow, (pBeforeWindow + pNow) / 2, 1, "TWAP is the half/half average");
        assertLt(twapNow, pBeforeWindow);
        assertGt(twapNow, pNow);
        emit log_named_uint("[fork]  pLong before window", pBeforeWindow);
        emit log_named_uint("[fork]  pLong after window trade", pNow);
        emit log_named_uint("[fork]  final-window TWAP", twapNow);

        // ---- trading closes, finalize
        vm.warp(end);
        vm.expectRevert(); // hook rejects trading at tradingEnd
        qr.buy(alice, R, P, 1, true, 0);
        (uint256 pT, uint256 prT) = adapter.closeTwapWindow(R, P);
        assertApproxEqAbs(pT, twapNow, 1, "closed TWAP == value at last trade extrapolated to the end");
        assertGt(prT, 0);
        uint256 supplyL = _supply(_long(R, P));
        uint256 g = _gasFinalize(R, P);
        emit log_named_uint("[fork]  finalizeProposal gas", g);
        assertEq(_bal(_long(R, P), address(adapter)), 0, "adapter LONG zero");
        assertEq(_bal(_short(R, P), address(adapter)), 0, "adapter SHORT zero");
        assertEq(pm.getLiquidity(id), 0);
        uint256 users = _bal(_long(R, P), alice) + _bal(_long(R, P), bob) + _bal(_long(R, P), carol);
        assertLe(
            supplyL - users - _bal(_long(R, P), address(qr)), 10, "round holds all non-user LONG (<=10 wei left in PM)"
        );
        vm.prank(address(qr));
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.AlreadyFinalized.selector, R, P));
        adapter.finalizeProposal(R, P);
    }

    function test_Fork_GasBuyAndSell() public {
        _gasSeed(R, P, SEED);
        uint256 gBuyL = _gasBuy(R, P, 1_000_000, true, alice);
        uint256 gBuyS = _gasBuy(R, P, 1_000_000, false, alice);
        emit log_named_uint("[fork]  tradeBuyLong  gas (1 USDC)", gBuyL);
        emit log_named_uint("[fork]  tradeBuyShort gas (1 USDC)", gBuyS);
        (uint256 gSellL, uint256 gConsume) = _gasSell(R, P, 1_000_000 * SCALE, true, alice);
        emit log_named_uint("[fork]  tradeSellLong gas", gSellL);
        emit log_named_uint("[fork]  consumeSellSettlement gas", gConsume);
        (uint256 gSellS,) = _gasSell(R, P, 1_000_000 * SCALE, false, alice);
        emit log_named_uint("[fork]  tradeSellShort gas", gSellS);
    }

    function test_Fork_BothOrderingsRoundTrip() public {
        for (uint256 i; i < 2; ++i) {
            bool longIs0 = i == 0;
            uint256 p = _openOrdering(R, 10 + 50 * i, longIs0, SEED);
            uint256 before_ = _pLong(R, p);
            _buy(alice, R, p, 500_000, true);
            uint256 up = _pLong(R, p);
            assertGt(up, before_);
            _buy(bob, R, p, 500_000, false);
            assertLt(_pLong(R, p), up);
            (uint256 back,,) = _sellAll(alice, R, p, true);
            assertLe(back, 500_000);
        }
    }
}
