// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProposerRegistry} from "../src/ProposerRegistry.sol";
import {BlocklistUSDC} from "./mocks/MockUSDC.sol";

contract RegistryHandler is Test {
    ProposerRegistry public reg;
    BlocklistUSDC public usdc;
    address public round;
    address public treasury;
    address[] public actors;

    uint256 public ghostSlashed;
    uint256 public ghostClaimed;
    uint256 public ghostRefunded;
    mapping(address => uint32) public ghostProposals;
    mapping(address => uint32) public ghostWins;

    constructor(ProposerRegistry reg_, BlocklistUSDC usdc_, address round_, address treasury_, address[] memory actors_) {
        reg = reg_;
        usdc = usdc_;
        round = round_;
        treasury = treasury_;
        actors = actors_;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _a(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function lock(uint256 seed, uint256 amount) external {
        address a = _a(seed);
        amount = bound(amount, 1, 5_000_000);
        if (usdc.balanceOf(a) < amount) usdc.mint(a, amount);
        vm.prank(round);
        reg.lockBond(a, amount);
    }

    function refund(uint256 seed, uint256 amount) external {
        address a = _a(seed);
        amount = bound(amount, 0, reg.lockedBond(a));
        uint256 pendingBefore = reg.pendingRefund(a);
        vm.prank(round);
        reg.refundBond(a, amount);
        if (reg.pendingRefund(a) == pendingBefore) ghostRefunded += amount;
    }

    function slash(uint256 seed, uint256 amount) external {
        address a = _a(seed);
        amount = bound(amount, 0, reg.lockedBond(a));
        vm.prank(round);
        reg.slashBond(a, amount);
        ghostSlashed += amount;
    }

    function claim(uint256 seed) external {
        address a = _a(seed);
        uint256 p = reg.pendingRefund(a);
        if (p == 0 || usdc.blocked(a)) return;
        vm.prank(a);
        reg.claimRefund();
        ghostClaimed += p;
    }

    function setBlocked(uint256 seed, bool blocked_, bool returnFalse) external {
        usdc.setBlocked(_a(seed), blocked_);
        usdc.setReturnFalse(returnFalse);
    }

    function recordProposal(uint256 seed) external {
        address a = _a(seed);
        vm.prank(round);
        reg.recordProposal(a);
        ghostProposals[a]++;
    }

    function recordWin(uint256 seed) external {
        address a = _a(seed);
        vm.prank(round);
        reg.recordWin(a);
        ghostWins[a]++;
    }
}

contract ProposerRegistryInvariantTest is Test {
    ProposerRegistry internal reg;
    BlocklistUSDC internal usdc;
    RegistryHandler internal handler;
    address internal admin = makeAddr("admin");
    address internal round = makeAddr("round");
    address internal treasury = makeAddr("treasury");
    address[] internal actors;

    function setUp() public {
        usdc = new BlocklistUSDC();
        reg = new ProposerRegistry(admin, IERC20(address(usdc)));
        vm.startPrank(admin);
        reg.grantRole(reg.QUANTUM_ROUND_ROLE(), round);
        reg.setSlashTreasury(treasury);
        vm.stopPrank();

        for (uint256 i; i < 3; i++) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            vm.startPrank(a);
            usdc.approve(address(reg), type(uint256).max);
            reg.registerAgent("agent");
            vm.stopPrank();
        }
        handler = new RegistryHandler(reg, usdc, round, treasury, actors);
        targetContract(address(handler));
    }

    /// Conservation: the registry's USDC balance always equals all locked bonds + all pending refunds.
    function invariant_RegistryBalanceEqualsLockedPlusPending() public view {
        uint256 total;
        for (uint256 i; i < actors.length; i++) {
            total += reg.lockedBond(actors[i]) + reg.pendingRefund(actors[i]);
        }
        assertEq(usdc.balanceOf(address(reg)), total);
    }

    /// Slashed funds all arrive at the treasury, and nowhere else.
    function invariant_TreasuryReceivedExactlySlashed() public view {
        assertEq(usdc.balanceOf(treasury), handler.ghostSlashed());
    }

    /// Counters equal the number of recorded calls.
    function invariant_CountersMatchGhosts() public view {
        for (uint256 i; i < actors.length; i++) {
            (,,, uint32 made, uint32 won) = reg.agents(actors[i]);
            assertEq(made, handler.ghostProposals(actors[i]));
            assertEq(won, handler.ghostWins(actors[i]));
        }
    }

    /// The registry never holds native value.
    function invariant_NoNativeBalance() public view {
        assertEq(address(reg).balance, 0);
    }
}
