// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WaveGasUtil} from "./WaveGasUtil.sol";

/// @notice Gas report against the local (in-process) PoolManager. The fork variant lives in WaveMarket.Fork.t.sol.
contract WaveMarketGasTest is WaveGasUtil {
    uint256 internal constant SEED = 5_000_000;

    function test_Gas_SeedLiquidityBelowTarget() public {
        uint256 g = _gasSeed(R, P, SEED);
        emit log_named_uint("[local] seedLiquidity gas (5 USDC seed)", g);
        assertLt(g, SEED_GAS_TARGET, "seedLiquidity < 5,000,000 gas");
        // a second proposal on the shared hook (warm hook/PoolManager storage) is cheaper or comparable
        uint256 g2 = _gasSeed(R, P + 1, SEED);
        emit log_named_uint("[local] seedLiquidity gas (2nd proposal)", g2);
        assertLt(g2, SEED_GAS_TARGET);
    }

    function test_Gas_SeedIndependentOfSeedSize() public {
        uint256 gSmall = _gasSeed(R, P, 1_000);
        uint256 gLarge = _gasSeed(R, P + 1, 50_000_000);
        emit log_named_uint("[local] seedLiquidity gas (0.001 USDC)", gSmall);
        emit log_named_uint("[local] seedLiquidity gas (50 USDC)   ", gLarge);
        assertLt(gSmall, SEED_GAS_TARGET);
        assertLt(gLarge, SEED_GAS_TARGET);
    }

    function test_Gas_BuyAndSell() public {
        _gasSeed(R, P, SEED);
        uint256 gBuyL = _gasBuy(R, P, 1_000_000, true, alice);
        uint256 gBuyS = _gasBuy(R, P, 1_000_000, false, alice);
        emit log_named_uint("[local] tradeBuyLong  gas (1 USDC)", gBuyL);
        emit log_named_uint("[local] tradeBuyShort gas (1 USDC)", gBuyS);
        uint256 amt = 1_000_000 * SCALE;
        (uint256 gSellL, uint256 gConsumeL) = _gasSell(R, P, amt, true, alice);
        emit log_named_uint("[local] tradeSellLong  gas (bisection+swap)", gSellL);
        emit log_named_uint("[local] consumeSellSettlement gas", gConsumeL);
        (uint256 gSellS,) = _gasSell(R, P, amt, false, alice);
        emit log_named_uint("[local] tradeSellShort gas (bisection+swap)", gSellS);
        vm.warp(_now() + 1 days);
        uint256 gFin = _gasFinalize(R, P);
        emit log_named_uint("[local] finalizeProposal gas", gFin);
        assertLt(gBuyL, 1_000_000, "buy is cheap");
        assertLt(gSellL, 3_000_000, "sell (bounded bisection) stays well under a block-gas concern");
    }
}
