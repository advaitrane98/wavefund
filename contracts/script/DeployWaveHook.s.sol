// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Common} from "./Common.s.sol";
import {WaveHook} from "../src/WaveHook.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";

/// @notice Step 2 of 3: mines a CREATE2 salt for hook flags 2752, deploys WaveHook through the standard CREATE2
///         deployer (0x4e59...), then calls market.setWaveHook. The mining runs inside this script's local
///         simulation, never on chain; only the final deployment and setWaveHook are broadcast.
contract DeployWaveHook is Common {
    uint160 internal constant FLAGS = 2752;
    uint160 internal constant FLAG_MASK = 0x3FFF;

    function run() external {
        _requireArc();
        uint256 pk = vm.envUint("DEPLOYER_PK");
        WaveV4ProposalMarket market = WaveV4ProposalMarket(_addr("WaveV4ProposalMarket"));
        bytes memory args = abi.encode(IPoolManager(POOL_MANAGER), address(market));
        (address predicted, bytes32 salt) = HookMiner.find(CREATE2_FACTORY, FLAGS, type(WaveHook).creationCode, args);
        require(uint160(predicted) & FLAG_MASK == FLAGS, "mined address has wrong flags");

        vm.startBroadcast(pk);
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, type(WaveHook).creationCode, args));
        require(ok && predicted.code.length > 0, "hook CREATE2 deployment failed");
        market.setWaveHook(predicted);
        vm.stopBroadcast();

        _setAddr("WaveHook", predicted);
        vm.writeJson(string.concat('"', vm.toString(salt), '"'), _bookPath(), ".hookSalt");
        require(market.waveHook() == predicted, "market.waveHook mismatch");
    }
}
