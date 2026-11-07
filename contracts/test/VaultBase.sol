// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {QuantumBase} from "./QuantumBase.sol";

/// @notice Shared vault helpers for the category files (emergency exit, report observation, swap bounds).
abstract contract VaultBase is QuantumBase {
    uint256 internal constant NAV0 = 150_000e6;

    function _price(int256 usdPerEth8) internal {
        vm.prank(keeper);
        oracle.updatePrice(usdPerEth8);
    }

    function _execute(uint256 r, uint256 bps) internal {
        vm.prank(keeper);
        vault.executeTrade(r, bps);
    }

    /// @dev Round in which proposal 1 (60% tETH) wins; fresh oracle at 2000. Alice deposited 100 USDC.
    function _winner1Round() internal returns (uint256 r) {
        r = _open();
        _propose(agentA, r, 6000);
        _fund(alice, r, 100e6);
        _pushUp(r, 1, alice, 3e6);
        _collapse(r);
        assertEq(_winner(r), 1);
        _price(2000e8);
    }

    /// @dev Status-quo round collapsed (nobody traded); fresh oracle at 2000.
    function _statusQuoRound() internal returns (uint256 r) {
        r = _open();
        _propose(agentA, r, 6000);
        _toEnd(r);
        _collapse(r);
        assertEq(_winner(r), 0);
        _price(2000e8);
    }

    function _requestDeposit(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), type(uint256).max);
        vault.requestDeposit(amount);
        vm.stopPrank();
    }

    /// @dev Gives `user` `shares` WAVE from the bootstrap holder (this test contract) and escrows them.
    function _requestWithdrawAs(address user, uint256 shares) internal {
        vault.transfer(user, shares);
        vm.prank(user);
        vault.requestWithdraw(shares);
    }

    function _realised(uint256 r) internal view returns (uint256 v) {
        (,,,,,,,,,, v,,,,,) = qr.rounds(r);
    }
}
