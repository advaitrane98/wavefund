// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MockPriceOracle
/// @notice Keeper-controlled, 8-decimal ETH/USD test oracle with optional freshness enforcement.
/// @custom:upgrade-strategy Immutable, non-upgradeable code keeps oracle behavior fixed; live role administration is not an upgrade mechanism.
contract MockPriceOracle is AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 public constant MAX_ORACLE_AGE = 5 minutes;

    int256 private _answer;
    uint256 private _updatedAt;

    error ZeroAddress();
    error InvalidPrice(int256 answer);
    error StalePrice(uint256 updatedAt, uint256 maxAge);

    event PriceUpdated(int256 answer, uint256 updatedAt);

    /// @notice Configures roles and records a strictly positive initial price at the current timestamp.
    constructor(address admin, address keeper, int256 initialAnswer) {
        if (admin == address(0) || keeper == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);
        _storePrice(initialAnswer);
    }

    /// @notice Returns the number of decimals in the USD price.
    function decimals() external pure returns (uint8) {
        return 8;
    }

    /// @notice Replaces the price and refreshes its on-chain timestamp.
    function updatePrice(int256 answer) external onlyRole(KEEPER_ROLE) {
        _storePrice(answer);
    }

    /// @notice Returns the last observation, even when stale; consumers choose their own policy.
    function latestPrice() external view returns (int256 answer, uint256 updatedAt) {
        return (_answer, _updatedAt);
    }

    /// @notice An observation exactly MAX_ORACLE_AGE seconds old remains fresh.
    function isFresh() public view returns (bool) {
        return block.timestamp - _updatedAt <= MAX_ORACLE_AGE;
    }

    /// @notice Returns the last price or reverts if older than MAX_ORACLE_AGE.
    function latestFreshPrice() external view returns (int256) {
        if (!isFresh()) revert StalePrice(_updatedAt, MAX_ORACLE_AGE);
        return _answer;
    }

    function _storePrice(int256 answer) private {
        if (answer <= 0) revert InvalidPrice(answer);
        _answer = answer;
        _updatedAt = block.timestamp;
        emit PriceUpdated(answer, _updatedAt);
    }
}
