// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WaveBase} from "./WaveBase.sol";

/// @notice Adapter-level gas measurements (only the adapter call itself is metered, not the mock round's mint/burn).
abstract contract WaveGasUtil is WaveBase {
    uint256 internal constant SEED_GAS_TARGET = 5_000_000;

    function _gasSeed(uint256 r, uint256 p, uint256 seedCredits) internal returns (uint256 g) {
        qr.createTokens(r, p);
        qr.mintLegs(address(adapter), r, p, seedCredits * SCALE, seedCredits * SCALE);
        vm.prank(address(qr));
        uint256 g0 = gasleft();
        adapter.seedLiquidity(r, p, seedCredits);
        g = g0 - gasleft();
    }

    function _gasBuy(uint256 r, uint256 p, uint256 credits, bool long_, address to) internal returns (uint256 g) {
        qr.mintLegs(address(adapter), r, p, credits * SCALE, credits * SCALE);
        vm.prank(address(qr));
        uint256 g0 = gasleft();
        if (long_) adapter.tradeBuyLong(r, p, credits, 0, to);
        else adapter.tradeBuyShort(r, p, credits, 0, to);
        g = g0 - gasleft();
    }

    /// @dev Meters tradeSell* then consumeSellSettlement (the second half of every sale).
    function _gasSell(uint256 r, uint256 p, uint256 amount, bool long_, address seller)
        internal
        returns (uint256 gSell, uint256 gConsume)
    {
        qr.mintLegs(address(adapter), r, p, long_ ? amount : 0, long_ ? 0 : amount);
        vm.prank(address(qr));
        uint256 g0 = gasleft();
        if (long_) adapter.tradeSellLong(r, p, amount, 0);
        else adapter.tradeSellShort(r, p, amount, 0);
        gSell = g0 - gasleft();
        vm.prank(address(qr));
        g0 = gasleft();
        adapter.consumeSellSettlement(r, p, seller);
        gConsume = g0 - gasleft();
    }

    function _gasFinalize(uint256 r, uint256 p) internal returns (uint256 g) {
        vm.prank(address(qr));
        uint256 g0 = gasleft();
        adapter.finalizeProposal(r, p);
        g = g0 - gasleft();
    }
}
