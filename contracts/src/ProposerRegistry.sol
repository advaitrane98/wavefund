// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ProposerRegistry
/// @notice Registers Wavefund agents and escrows ERC20 USDC bonds, never native USDC.
/// @dev Round-role holders are trusted to manage aggregate proposer bonds and statistics.
/// @dev Custody risk: if the USDC issuer blocklists this registry, bonds are frozen and no
/// function can bypass that restriction. Pause stops new deposits during such an incident;
/// exits remain callable but USDC transfers remain subject to issuer restrictions.
/// @custom:upgrade-strategy Immutable, non-upgradeable code keeps bond accounting fixed; live role administration is not an upgrade mechanism.
contract ProposerRegistry is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct Agent {
        string name;
        uint64 registeredAt;
        bool active;
        uint32 proposalsMade;
        uint32 roundsWon;
    }

    bytes32 public constant QUANTUM_ROUND_ROLE = keccak256("QUANTUM_ROUND_ROLE");
    uint256 public constant DEFAULT_BOND = 1_000_000;
    IERC20 public immutable usdc;
    address public slashTreasury;

    /// @notice Getter returns exactly (name, registeredAt, active, proposalsMade, roundsWon).
    mapping(address proposer => Agent) public agents;
    mapping(address proposer => uint256 amount) public lockedBond;
    mapping(address proposer => uint256 amount) public pendingRefund;

    error ZeroAddress();
    error InvalidUSDC(address usdc);
    error InvalidUSDCDecimals(uint8 actual);
    error SlashTreasuryNotSet();
    error AgentAlreadyRegistered(address proposer);
    error AgentNotRegistered(address proposer);
    error AgentInactive(address proposer);
    error InvalidNameLength(uint256 length);
    error ZeroBondAmount();
    error InsufficientLockedBond(address proposer, uint256 available, uint256 requested);
    error CounterOverflow(address proposer);
    error NothingToClaim();

    event AgentRegistered(address indexed proposer, string name, uint64 registeredAt);
    event BondLocked(address indexed proposer, uint256 amount, uint256 totalLocked);
    event BondRefunded(address indexed proposer, uint256 amount, uint256 totalLocked);
    event RefundDeferred(address indexed proposer, uint256 amount);
    event RefundClaimed(address indexed proposer, uint256 amount);
    event BondSlashed(address indexed proposer, address indexed slashTreasury, uint256 amount, uint256 totalLocked);
    event SlashTreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event ProposalRecorded(address indexed proposer, uint32 proposalsMade);
    event WinRecorded(address indexed proposer, uint32 roundsWon);

    /// @notice Configures administration and the six-decimal ERC20 USDC used for bonds.
    /// @dev No slash treasury is configured at deployment, so slashing starts disabled.
    constructor(address admin, IERC20 usdc_) {
        if (admin == address(0) || address(usdc_) == address(0)) revert ZeroAddress();
        if (address(usdc_).code.length == 0) revert InvalidUSDC(address(usdc_));
        uint8 decimals = IERC20Metadata(address(usdc_)).decimals();
        if (decimals != 6) revert InvalidUSDCDecimals(decimals);
        usdc = usdc_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Stops new bond commitments without disabling exits or registration.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resumes new bond commitments.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Registers the caller once with a nonempty name of at most 64 bytes.
    /// @dev Nonempty stored names identify registration even if the timestamp is zero.
    function registerAgent(string calldata name) external {
        if (bytes(agents[msg.sender].name).length != 0) revert AgentAlreadyRegistered(msg.sender);
        uint256 length = bytes(name).length;
        if (length == 0 || length > 64) revert InvalidNameLength(length);
        uint64 timestamp = SafeCast.toUint64(block.timestamp);
        agents[msg.sender] = Agent(name, timestamp, true, 0, 0);
        emit AgentRegistered(msg.sender, name, timestamp);
    }

    /// @notice Pulls an approved positive ERC20 USDC amount from an active registered proposer.
    /// @dev DEFAULT_BOND is a convenience constant, not an enforced minimum.
    function lockBond(address proposer, uint256 amount) external onlyRole(QUANTUM_ROUND_ROLE) nonReentrant whenNotPaused {
        _requireRegistered(proposer);
        if (!agents[proposer].active) revert AgentInactive(proposer);
        if (amount == 0) revert ZeroBondAmount();
        uint256 total = lockedBond[proposer] + amount;
        lockedBond[proposer] = total;
        emit BondLocked(proposer, amount, total);
        usdc.safeTransferFrom(proposer, address(this), amount);
    }

    /// @notice Returns up to the proposer's aggregate locked balance; zero amounts are allowed.
    /// @dev Failed transfers become claims payable only to the proposer. The USDC call has no
    /// explicit gas cap to avoid assuming the issuer's proxy implementation has a fixed gas cost.
    function refundBond(address proposer, uint256 amount) external onlyRole(QUANTUM_ROUND_ROLE) nonReentrant {
        uint256 remaining = _reduceBond(proposer, amount);
        (bool success, bytes memory returndata) = address(usdc).call(
            abi.encodeCall(IERC20.transfer, (proposer, amount))
        );
        // Validate the ABI boolean as a uint256 so malformed boolean values cannot revert decoding.
        bool transferred = success && address(usdc).code.length != 0
            && (returndata.length == 0 || (returndata.length >= 32 && abi.decode(returndata, (uint256)) == 1));
        if (transferred) {
            emit BondRefunded(proposer, amount, remaining);
        } else {
            pendingRefund[proposer] += amount;
            emit RefundDeferred(proposer, amount);
        }
    }

    /// @notice Claims the caller's deferred refunds only to the caller; no redirection is allowed.
    /// @dev A failed transfer reverts and restores the pending refund for a later attempt.
    function claimRefund() external nonReentrant {
        uint256 amount = pendingRefund[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingRefund[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit RefundClaimed(msg.sender, amount);
    }

    /// @notice Sets the sole slash destination; setting zero disables slashing.
    function setSlashTreasury(address treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address previousTreasury = slashTreasury;
        slashTreasury = treasury;
        emit SlashTreasuryUpdated(previousTreasury, treasury);
    }

    /// @notice Sends a locked amount only to the configured slash treasury.
    /// @dev V1 rounds never call slashBond: bonds are always refunded.
    function slashBond(address proposer, uint256 amount)
        external
        onlyRole(QUANTUM_ROUND_ROLE)
        nonReentrant
    {
        address treasury = slashTreasury;
        if (treasury == address(0)) revert SlashTreasuryNotSet();
        uint256 remaining = _reduceBond(proposer, amount);
        emit BondSlashed(proposer, treasury, amount, remaining);
        usdc.safeTransfer(treasury, amount);
    }

    /// @notice Increments the proposal count of a registered agent, regardless of active status.
    function recordProposal(address proposer) external onlyRole(QUANTUM_ROUND_ROLE) {
        _requireRegistered(proposer);
        Agent storage agent = agents[proposer];
        if (agent.proposalsMade == type(uint32).max) revert CounterOverflow(proposer);
        agent.proposalsMade += 1;
        emit ProposalRecorded(proposer, agent.proposalsMade);
    }

    /// @notice Increments the win count of a registered agent, regardless of active status.
    function recordWin(address proposer) external onlyRole(QUANTUM_ROUND_ROLE) {
        _requireRegistered(proposer);
        Agent storage agent = agents[proposer];
        if (agent.roundsWon == type(uint32).max) revert CounterOverflow(proposer);
        agent.roundsWon += 1;
        emit WinRecorded(proposer, agent.roundsWon);
    }

    function _requireRegistered(address proposer) private view {
        if (bytes(agents[proposer].name).length == 0) revert AgentNotRegistered(proposer);
    }

    function _reduceBond(address proposer, uint256 amount) private returns (uint256 remaining) {
        uint256 available = lockedBond[proposer];
        if (amount > available) revert InsufficientLockedBond(proposer, available, amount);
        remaining = available - amount;
        lockedBond[proposer] = remaining;
    }
}
