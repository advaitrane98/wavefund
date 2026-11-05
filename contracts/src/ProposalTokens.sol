// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ProposalToken} from "./ProposalToken.sol";

/// @title ProposalTokens
/// @notice Deterministic EIP-1167 factory for each proposal's CREDIT, LONG and SHORT tokens.
/// @custom:upgrade-strategy Immutable, non-upgradeable factory code fixes clone behavior through delegation to the ProposalToken implementation deployed in this constructor, with no implementation-upgrade path; live role administration is not an upgrade mechanism.
contract ProposalTokens is AccessControl {
    enum Kind { CREDIT, LONG, SHORT }

    struct TokenSet {
        address credit;
        address long_;
        address short_;
    }

    bytes32 public constant QUANTUM_ROUND_ROLE = keccak256("QUANTUM_ROUND_ROLE");
    address public immutable implementation;
    uint8 public creditDecimals = 18;
    bool private _creditDecimalsSet;
    bool private _creationStarted;
    mapping(uint256 roundId => mapping(uint256 proposalId => TokenSet)) private _tokens;

    error ZeroAddress();
    error CreditDecimalsAlreadySet();
    error CreditDecimalsLocked();
    error InvalidCreditDecimals(uint8 decimals);
    error ProposalAlreadyExists(uint256 roundId, uint256 proposalId);

    event CreditDecimalsSet(uint8 decimals);
    event CreditDecimalsLockedOnCreation(uint8 decimals);
    event ProposalTokensCreated(
        uint256 indexed roundId,
        uint256 indexed proposalId,
        address credit,
        address long_,
        address short_
    );

    /// @notice Grants admin rights and deploys a permanently initialization-locked implementation.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        implementation = address(new ProposalToken());
    }

    /// @notice Sets CREDIT precision once, before any successful proposal-token creation.
    function setCreditDecimals(uint8 decimals_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_creditDecimalsSet) revert CreditDecimalsAlreadySet();
        if (_creationStarted) revert CreditDecimalsLocked();
        if (decimals_ > 18) revert InvalidCreditDecimals(decimals_);
        _creditDecimalsSet = true;
        creditDecimals = decimals_;
        emit CreditDecimalsSet(decimals_);
    }

    /// @notice Creates and initializes all three tokens atomically for a previously unused pair.
    /// @dev Salt is keccak256(abi.encode(roundId, proposalId, kind)); no native value is sent.
    function createProposalTokens(uint256 roundId, uint256 proposalId)
        external
        onlyRole(QUANTUM_ROUND_ROLE)
        returns (address credit, address long_, address short_)
    {
        if (proposalExists(roundId, proposalId)) revert ProposalAlreadyExists(roundId, proposalId);
        if (!_creationStarted) {
            _creationStarted = true;
            emit CreditDecimalsLockedOnCreation(creditDecimals);
        }
        credit = _createToken(roundId, proposalId, Kind.CREDIT, "CREDIT", creditDecimals);
        long_ = _createToken(roundId, proposalId, Kind.LONG, "LONG", 18);
        short_ = _createToken(roundId, proposalId, Kind.SHORT, "SHORT", 18);
        _tokens[roundId][proposalId] = TokenSet(credit, long_, short_);
        emit ProposalTokensCreated(roundId, proposalId, credit, long_, short_);
    }

    /// @notice Returns CREDIT, or zero before creation.
    function creditToken(uint256 roundId, uint256 proposalId) external view returns (address) {
        return _tokens[roundId][proposalId].credit;
    }

    /// @notice Returns LONG, or zero before creation.
    function longToken(uint256 roundId, uint256 proposalId) external view returns (address) {
        return _tokens[roundId][proposalId].long_;
    }

    /// @notice Returns SHORT, or zero before creation.
    function shortToken(uint256 roundId, uint256 proposalId) external view returns (address) {
        return _tokens[roundId][proposalId].short_;
    }

    /// @notice Reports whether the token triplet has been created successfully.
    function proposalExists(uint256 roundId, uint256 proposalId) public view returns (bool) {
        return _tokens[roundId][proposalId].credit != address(0);
    }

    function _createToken(uint256 roundId, uint256 proposalId, Kind kind, string memory label, uint8 precision)
        private
        returns (address token)
    {
        token = Clones.cloneDeterministic(implementation, keccak256(abi.encode(roundId, proposalId, kind)));
        string memory round = Strings.toString(roundId);
        string memory proposal = Strings.toString(proposalId);
        ProposalToken(token).initialize(
            string.concat("Wavefund Round ", round, " Proposal ", proposal, " ", label),
            string.concat("W-R", round, "-P", proposal, "-", label),
            precision,
            address(this)
        );
    }
}
