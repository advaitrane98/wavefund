// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Common} from "./Common.s.sol";
import {WavefundPoolHelper} from "../src/WavefundPoolHelper.sol";

/// @notice Deploys the deployer-owned v4 callback helper for the vault's USDC/tETH pool. No USDC moves.
contract DeployPoolHelper is Common {
    function run() external {
        _requireArc();
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);
        WavefundPoolHelper helper = new WavefundPoolHelper(
            deployer, IPoolManager(POOL_MANAGER), IERC20(USDC), IERC20(_addr("TestAsset"))
        );
        vm.stopBroadcast();
        _setAddr("WavefundPoolHelper", address(helper));
    }
}
