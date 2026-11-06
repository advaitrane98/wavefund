// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Common} from "./Common.s.sol";
import {ProposalTokens} from "../src/ProposalTokens.sol";
import {ProposerRegistry} from "../src/ProposerRegistry.sol";
import {MockPriceOracle} from "../src/MockPriceOracle.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {QuantumRound} from "../src/QuantumRound.sol";
import {Resolver} from "../src/Resolver.sol";
import {WavefundVault} from "../src/WavefundVault.sol";
import {IQuantumRoundControl} from "../src/interfaces/IQuantumRoundControl.sol";

/// @notice Step 3 of 3: wires the contracts, grants roles, then verifies every relationship and role and reverts
///         if any check fails. Run after Deploy and DeployWaveHook. No USDC moves.
/// @dev Differences from the original task text, forced by the contracts as built:
///      - The market hands its ownership to QuantumRound by itself once setQuantumRound and setWaveHook are both
///        done (transferOwnership always reverts), so this script only calls the two setters and then checks `owner`.
///      - QuantumRound has no setResolver. The Resolver gets RESOLVER_ROLE on QuantumRound, and the vault is wired to
///        the pair with vault.setRound(round, resolver).
contract Wire is Common {
    uint256 internal constant SEED_PER_PROPOSAL = 5e6; // 5 USDC

    struct Book {
        ProposalTokens tokens;
        ProposerRegistry registry;
        MockPriceOracle oracle;
        WaveV4ProposalMarket market;
        QuantumRound round;
        Resolver resolver;
        WavefundVault vault;
        address hook;
        address keeper;
    }

    function run() external {
        _requireArc();
        uint256 pk = vm.envUint("DEPLOYER_PK");
        Book memory b = _load();

        vm.startBroadcast(pk);
        if (b.market.quantumRound() == address(0)) b.market.setQuantumRound(address(b.round));
        if (address(b.vault.quantumRound()) == address(0)) b.vault.setRound(IQuantumRoundControl(address(b.round)), b.resolver);
        if (b.round.allocationSource() != address(b.vault)) b.round.setAllocationSource(address(b.vault));
        if (b.round.initialLiquidityPerProposal() != SEED_PER_PROPOSAL) {
            b.round.setInitialLiquidityPerProposal(SEED_PER_PROPOSAL);
        }
        _grant(address(b.tokens), b.tokens.QUANTUM_ROUND_ROLE(), address(b.round));
        _grant(address(b.registry), b.registry.QUANTUM_ROUND_ROLE(), address(b.round));
        _grant(address(b.round), b.round.KEEPER_ROLE(), b.keeper);
        _grant(address(b.vault), b.vault.KEEPER_ROLE(), b.keeper);
        _grant(address(b.oracle), b.oracle.KEEPER_ROLE(), b.keeper);
        _grant(address(b.round), b.round.VAULT_ROLE(), address(b.vault));
        _grant(address(b.resolver), b.resolver.RESOLVER_ROLE(), address(b.vault));
        _grant(address(b.round), b.round.RESOLVER_ROLE(), address(b.resolver));
        vm.stopBroadcast();

        _verify(b);
    }

    function _load() internal view returns (Book memory b) {
        b.tokens = ProposalTokens(_addr("ProposalTokens"));
        b.registry = ProposerRegistry(_addr("ProposerRegistry"));
        b.oracle = MockPriceOracle(_addr("MockPriceOracle"));
        b.market = WaveV4ProposalMarket(_addr("WaveV4ProposalMarket"));
        b.round = QuantumRound(_addr("QuantumRound"));
        b.resolver = Resolver(_addr("Resolver"));
        b.vault = WavefundVault(_addr("WavefundVault"));
        b.hook = _addr("WaveHook");
        b.keeper = _keeper();
    }

    function _grant(address target, bytes32 role, address who) internal {
        if (!_has(target, role, who)) {
            (bool done,) = target.call(abi.encodeWithSignature("grantRole(bytes32,address)", role, who));
            require(done, "grantRole failed");
        }
    }

    function _has(address target, bytes32 role, address who) internal view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("hasRole(bytes32,address)", role, who));
        return ok && abi.decode(ret, (bool));
    }

    /// @dev Every check reverts with a message naming the failed relationship.
    function _verify(Book memory b) internal view {
        require(b.tokens.creditDecimals() == 6, "check: creditDecimals != 6");
        require(b.tokens.hasRole(b.tokens.QUANTUM_ROUND_ROLE(), address(b.round)), "check: round lacks QUANTUM_ROUND_ROLE on tokens");
        require(b.registry.hasRole(b.registry.QUANTUM_ROUND_ROLE(), address(b.round)), "check: round lacks QUANTUM_ROUND_ROLE on registry");
        require(b.round.hasRole(b.round.KEEPER_ROLE(), b.keeper), "check: keeper lacks KEEPER_ROLE on round");
        require(b.vault.hasRole(b.vault.KEEPER_ROLE(), b.keeper), "check: keeper lacks KEEPER_ROLE on vault");
        require(b.oracle.hasRole(b.oracle.KEEPER_ROLE(), b.keeper), "check: keeper lacks KEEPER_ROLE on oracle");
        require(b.round.hasRole(b.round.VAULT_ROLE(), address(b.vault)), "check: vault lacks VAULT_ROLE on round");
        require(b.resolver.hasRole(b.resolver.RESOLVER_ROLE(), address(b.vault)), "check: vault lacks RESOLVER_ROLE on resolver");
        require(b.round.hasRole(b.round.RESOLVER_ROLE(), address(b.resolver)), "check: resolver lacks RESOLVER_ROLE on round");
        require(b.market.quantumRound() == address(b.round), "check: market.quantumRound != round");
        require(b.market.waveHook() == b.hook, "check: market.waveHook != hook");
        require(b.market.owner() == address(b.round), "check: market owner != round");
        require(address(b.vault.quantumRound()) == address(b.round), "check: vault.quantumRound != round");
        require(address(b.vault.resolver()) == address(b.resolver), "check: vault.resolver != resolver");
        require(b.round.allocationSource() == address(b.vault), "check: allocationSource != vault");
        require(b.round.initialLiquidityPerProposal() == SEED_PER_PROPOSAL, "check: initial liquidity != 5 USDC");
        require(uint160(b.hook) & 0x3FFF == 2752, "check: hook address flags != 2752");
    }
}
