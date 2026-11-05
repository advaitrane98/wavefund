// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestAsset
/// @notice Mock 18-decimal tETH for Wavefund testnet liquidity. No native value is accepted.
/// @custom:upgrade-strategy Immutable, non-upgradeable code keeps token behavior fixed; live role administration is not an upgrade mechanism.
contract TestAsset is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    error ZeroAddress();

    /// @notice Grants administration and supply control to admin; creates no initial supply.
    constructor(address admin) ERC20("Test ETH", "tETH") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mints amount base units to to. Emits the ERC20 Transfer event.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Burns amount base units from from without an allowance. Emits Transfer.
    function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(from, amount);
    }
}
