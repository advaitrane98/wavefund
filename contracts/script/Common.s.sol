// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";

/// @notice Shared constants and address-book helpers for the Arc Testnet scripts.
/// @dev Scripts never move USDC. Addresses are written to contracts/deployments/current.json.
abstract contract Common is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    address internal constant POOL_MANAGER = 0x2756F3F7bFAf103F4c550f4d24CdCa82B093240A;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;

    function _requireArc() internal view {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "wrong chain: expected Arc Testnet (5042002)");
    }

    /// @dev The address book defaults to deployments/current.json. Fork rehearsals set BOOK_FILE
    ///      (relative to contracts/, inside deployments/) so they never touch the real book.
    function _bookPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/", vm.envOr("BOOK_FILE", string("deployments/current.json")));
    }

    function _book() internal view returns (string memory) {
        return vm.readFile(_bookPath());
    }

    function _addr(string memory name) internal view returns (address a) {
        a = vm.parseJsonAddress(_book(), string.concat(".contracts.", name));
        require(a != address(0), string.concat("missing address for ", name));
    }

    function _setAddr(string memory name, address a) internal {
        vm.writeJson(string.concat('"', vm.toString(a), '"'), _bookPath(), string.concat(".contracts.", name));
    }

    function _keeper() internal view returns (address) {
        address k = vm.envOr("KEEPER_ADDRESS", address(0));
        if (k != address(0)) return k;
        return vm.addr(vm.envUint("KEEPER_PK"));
    }
}
