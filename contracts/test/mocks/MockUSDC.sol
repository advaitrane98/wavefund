// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Plain 6-decimal mock USDC for tests.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev 6-decimal mock USDC with a recipient blocklist. A transfer to a blocklisted address
/// either returns false (returnFalse == true) or reverts (returnFalse == false).
contract BlocklistUSDC is ERC20 {
    mapping(address => bool) public blocked;
    bool public returnFalse;

    constructor() ERC20("Blocklist USDC", "bUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function setReturnFalse(bool value) external {
        returnFalse = value;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (blocked[to]) {
            if (returnFalse) return false;
            revert("blocklisted");
        }
        return super.transfer(to, value);
    }
}

/// @dev Mintable ERC-20 with configurable decimals, for rejecting wrongly scaled bond/payment assets.
contract MockDecimalsToken is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 dec_) ERC20("Mock Decimals", "mDEC") {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
