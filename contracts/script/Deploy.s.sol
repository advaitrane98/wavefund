// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Common} from "./Common.s.sol";
import {TestAsset} from "../src/TestAsset.sol";
import {MockPriceOracle} from "../src/MockPriceOracle.sol";
import {ProposerRegistry} from "../src/ProposerRegistry.sol";
import {ProposalTokens} from "../src/ProposalTokens.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {QuantumRound} from "../src/QuantumRound.sol";
import {Resolver} from "../src/Resolver.sol";
import {WavefundVault} from "../src/WavefundVault.sol";

/// @notice Step 1 of 3: deploys the core contracts (no hook, no wiring, no USDC moved).
///         Env: DEPLOYER_PK, KEEPER_PK (or KEEPER_ADDRESS), optional INITIAL_ETH_USD_E8 (default 2000e8).
contract Deploy is Common {
    function run() external {
        _requireArc();
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        address keeper = _keeper();
        int256 price = int256(vm.envOr("INITIAL_ETH_USD_E8", uint256(2000e8)));

        vm.startBroadcast(pk);
        TestAsset teth = new TestAsset(deployer);
        MockPriceOracle oracle = new MockPriceOracle(deployer, keeper, price);
        ProposerRegistry registry = new ProposerRegistry(deployer, IERC20(USDC));
        ProposalTokens tokens = new ProposalTokens(deployer);
        tokens.setCreditDecimals(6);
        WaveV4ProposalMarket market = new WaveV4ProposalMarket(IPoolManager(POOL_MANAGER), tokens, deployer);
        QuantumRound round = new QuantumRound(deployer, IERC20(USDC), tokens, registry, market);
        Resolver resolver = new Resolver(deployer, round);
        WavefundVault vault =
            new WavefundVault(deployer, IERC20(USDC), IERC20(address(teth)), oracle, IPoolManager(POOL_MANAGER));
        vm.stopBroadcast();

        string memory json = string.concat(
            '{"network":"arc-testnet","chainId":',
            vm.toString(block.chainid),
            ',"startBlock":',
            vm.toString(block.number),
            ',"deployer":"',
            vm.toString(deployer),
            '","keeper":"',
            vm.toString(keeper),
            '","contracts":{"USDC":"',
            vm.toString(USDC),
            '","PoolManager":"',
            vm.toString(POOL_MANAGER),
            '","TestAsset":"',
            vm.toString(address(teth)),
            '","MockPriceOracle":"',
            vm.toString(address(oracle))
        );
        json = string.concat(
            json,
            '","ProposerRegistry":"',
            vm.toString(address(registry)),
            '","ProposalTokens":"',
            vm.toString(address(tokens)),
            '","WaveV4ProposalMarket":"',
            vm.toString(address(market)),
            '","QuantumRound":"',
            vm.toString(address(round)),
            '","Resolver":"',
            vm.toString(address(resolver)),
            '","WavefundVault":"',
            vm.toString(address(vault)),
            '"}}'
        );
        vm.writeFile(_bookPath(), json);

        require(tokens.creditDecimals() == 6, "creditDecimals != 6");
    }
}
