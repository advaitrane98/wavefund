// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IQuantumRoundControl} from "./interfaces/IQuantumRoundControl.sol";

/// @title Resolver
/// @notice Holds QuantumRound's RESOLVER_ROLE and forwards realised returns from its own RESOLVER_ROLE holder (the vault).
/// @custom:upgrade-strategy Immutable, non-upgradeable code keeps the settlement path fixed; live role administration is not an upgrade mechanism.
contract Resolver is AccessControl {
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

    IQuantumRoundControl public immutable quantumRound;

    error ZeroAddress();

    event ReturnSubmitted(uint256 indexed roundId, uint256 realisedReturn, address indexed submitter);

    constructor(address admin, IQuantumRoundControl quantumRound_) {
        if (admin == address(0) || address(quantumRound_) == address(0)) revert ZeroAddress();
        quantumRound = quantumRound_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Settles `roundId` in QuantumRound. This contract must hold RESOLVER_ROLE there.
    function submitReturn(uint256 roundId, uint256 realisedReturn) external onlyRole(RESOLVER_ROLE) {
        emit ReturnSubmitted(roundId, realisedReturn, msg.sender);
        quantumRound.settle(roundId, realisedReturn);
    }
}
