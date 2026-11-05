// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title ProposalToken
/// @notice Cloneable ERC20 whose supply controllers are resolved live from its factory.
/// @custom:upgrade-strategy Immutable, non-upgradeable token code keeps clone behavior fixed by delegating to the implementation deployed in the ProposalTokens constructor, with no implementation-upgrade path; live role administration is not an upgrade mechanism.
contract ProposalToken is ERC20 {
    bytes32 public constant QUANTUM_ROUND_ROLE = keccak256("QUANTUM_ROUND_ROLE");

    bool private _initialized;
    string private _tokenName;
    string private _tokenSymbol;
    uint8 private _tokenDecimals;
    address public factory;

    error AlreadyInitialized();
    error InvalidFactory(address factory);
    error UnauthorizedInitializer(address caller);
    error InvalidDecimals(uint8 decimals);
    error UnauthorizedRound(address caller);

    event Initialized(string name, string symbol, uint8 decimals, address indexed factory);

    /// @notice Locks the implementation itself; clone storage starts uninitialized.
    constructor() ERC20("", "") {
        _initialized = true;
    }

    /// @notice Initializes a clone once, atomically from its factory during creation.
    /// @dev The caller must be the supplied factory, which must already have code.
    function initialize(string memory name_, string memory symbol_, uint8 decimals_, address factory_) external {
        if (_initialized) revert AlreadyInitialized();
        if (factory_ == address(0) || factory_.code.length == 0) revert InvalidFactory(factory_);
        if (msg.sender != factory_) revert UnauthorizedInitializer(msg.sender);
        if (decimals_ > 18) revert InvalidDecimals(decimals_);
        _initialized = true;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        _tokenDecimals = decimals_;
        factory = factory_;
        emit Initialized(name_, symbol_, decimals_, factory_);
    }

    /// @notice Returns the clone's initialized name.
    function name() public view override returns (string memory) {
        return _tokenName;
    }

    /// @notice Returns the clone's initialized symbol.
    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }

    /// @notice Returns the clone's initialized decimal precision.
    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    modifier onlyQuantumRound() {
        address factory_ = factory;
        if (factory_ == address(0)) revert UnauthorizedRound(msg.sender);
        if (!IAccessControl(factory_).hasRole(QUANTUM_ROUND_ROLE, msg.sender)) {
            revert UnauthorizedRound(msg.sender);
        }
        _;
    }

    /// @notice Mints base units; role revocations on the factory take effect immediately.
    function mint(address to, uint256 amount) external onlyQuantumRound {
        _mint(to, amount);
    }

    /// @notice Burns base units without an allowance; emits the ERC20 Transfer event.
    function burn(address from, uint256 amount) external onlyQuantumRound {
        _burn(from, amount);
    }
}
