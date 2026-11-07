// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ProposerRegistry} from "../src/ProposerRegistry.sol";
import {MockUSDC, MockDecimalsToken} from "./mocks/MockUSDC.sol";

contract ProposerRegistryTest is Test {
    ProposerRegistry internal reg;
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal round = makeAddr("round");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal treasury = makeAddr("treasury");
    bytes32 internal ROUND_ROLE;
    bytes32 internal ADMIN_ROLE;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        reg = new ProposerRegistry(admin, IERC20(address(usdc)));
        ROUND_ROLE = reg.QUANTUM_ROUND_ROLE();
        ADMIN_ROLE = reg.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        reg.grantRole(ROUND_ROLE, round);

        usdc.mint(alice, 100_000_000);
        usdc.mint(bob, 100_000_000);
        vm.prank(alice);
        usdc.approve(address(reg), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(reg), type(uint256).max);
        vm.prank(alice);
        reg.registerAgent("Alice Agent");
    }

    function _agent(address who)
        internal
        view
        returns (string memory name, uint64 at, bool active, uint32 made, uint32 won)
    {
        return reg.agents(who);
    }

    function _lock(address who, uint256 amt) internal {
        vm.prank(round);
        reg.lockBond(who, amt);
    }

    // ---- constructor ----
    function test_Constructor_State() public view {
        assertEq(address(reg.usdc()), address(usdc));
        assertTrue(reg.hasRole(ADMIN_ROLE, admin));
        assertFalse(reg.hasRole(ROUND_ROLE, admin));
        assertEq(reg.slashTreasury(), address(0));
        assertEq(reg.DEFAULT_BOND(), 1_000_000);
        assertEq(ROUND_ROLE, keccak256("QUANTUM_ROUND_ROLE"));
        assertFalse(reg.paused());
    }

    function test_Constructor_RevertsOnZeroAdmin() public {
        vm.expectRevert(ProposerRegistry.ZeroAddress.selector);
        new ProposerRegistry(address(0), IERC20(address(usdc)));
    }

    function test_Constructor_RevertsOnZeroUsdc() public {
        vm.expectRevert(ProposerRegistry.ZeroAddress.selector);
        new ProposerRegistry(admin, IERC20(address(0)));
    }

    function test_Constructor_RevertsOnNoCodeUsdc() public {
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InvalidUSDC.selector, alice));
        new ProposerRegistry(admin, IERC20(alice));
    }

    function test_Constructor_RevertsOnNonSixDecimalBondToken() public {
        uint8[4] memory bad = [0, 8, 18, 255];
        for (uint256 i; i < bad.length; ++i) {
            MockDecimalsToken t = new MockDecimalsToken(bad[i]);
            vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InvalidUSDCDecimals.selector, bad[i]));
            new ProposerRegistry(admin, IERC20(address(t)));
        }
    }

    function test_Constructor_AcceptsSixDecimalBondToken() public {
        MockDecimalsToken t = new MockDecimalsToken(6);
        ProposerRegistry r = new ProposerRegistry(admin, IERC20(address(t)));
        assertEq(address(r.usdc()), address(t));
    }

    function test_Constructor_NonErc20ContractRevertsWithoutDecimals() public {
        // a contract with code but no decimals() cannot be a bond token: the constructor reverts
        vm.expectRevert();
        new ProposerRegistry(admin, IERC20(address(this)));
    }

    // ---- registerAgent ----
    function test_Register_StoresAgent() public {
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.AgentRegistered(bob, "Bob", uint64(block.timestamp));
        vm.prank(bob);
        reg.registerAgent("Bob");
        (string memory name, uint64 at, bool active, uint32 made, uint32 won) = _agent(bob);
        assertEq(name, "Bob");
        assertEq(at, uint64(block.timestamp));
        assertTrue(active);
        assertEq(made, 0);
        assertEq(won, 0);
    }

    function test_Register_UnregisteredAgentIsEmpty() public view {
        (string memory name, uint64 at, bool active, uint32 made, uint32 won) = _agent(bob);
        assertEq(bytes(name).length, 0);
        assertEq(at, 0);
        assertFalse(active);
        assertEq(made, 0);
        assertEq(won, 0);
    }

    function test_Register_DuplicateReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.AgentAlreadyRegistered.selector, alice));
        reg.registerAgent("Other");
    }

    function test_Register_EmptyNameReverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InvalidNameLength.selector, 0));
        reg.registerAgent("");
    }

    function test_Register_NameLengthBoundary() public {
        bytes memory b64 = new bytes(64);
        bytes memory b65 = new bytes(65);
        for (uint256 i; i < 64; i++) b64[i] = "a";
        for (uint256 i; i < 65; i++) b65[i] = "a";
        vm.prank(bob);
        reg.registerAgent(string(b64));
        (string memory name,,,,) = _agent(bob);
        assertEq(bytes(name).length, 64);

        address carol = makeAddr("carol");
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InvalidNameLength.selector, 65));
        reg.registerAgent(string(b65));
    }

    function test_Register_LengthCountsBytesNotCharacters() public {
        // "é" is 2 bytes in UTF-8: 32 of them = 64 bytes OK, 33 = 66 bytes revert
        bytes memory ok = new bytes(64);
        bytes memory bad = new bytes(66);
        for (uint256 i; i < 32; i++) {
            ok[2 * i] = 0xC3;
            ok[2 * i + 1] = 0xA9;
        }
        for (uint256 i; i < 33; i++) {
            bad[2 * i] = 0xC3;
            bad[2 * i + 1] = 0xA9;
        }
        vm.prank(bob);
        reg.registerAgent(string(ok));
        vm.prank(makeAddr("carol"));
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InvalidNameLength.selector, 66));
        reg.registerAgent(string(bad));
    }

    function test_Register_WorksWhilePaused() public {
        vm.prank(admin);
        reg.pause();
        vm.prank(bob);
        reg.registerAgent("Bob");
        (string memory name,,,,) = _agent(bob);
        assertEq(name, "Bob");
    }

    // ---- lockBond ----
    function test_LockBond_PullsUsdc() public {
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.BondLocked(alice, 1_000_000, 1_000_000);
        _lock(alice, 1_000_000);
        assertEq(reg.lockedBond(alice), 1_000_000);
        assertEq(usdc.balanceOf(address(reg)), 1_000_000);
        assertEq(usdc.balanceOf(alice), 99_000_000);
    }

    function test_LockBond_Accumulates() public {
        _lock(alice, 1_000_000);
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.BondLocked(alice, 500_000, 1_500_000);
        _lock(alice, 500_000);
        assertEq(reg.lockedBond(alice), 1_500_000);
    }

    function test_LockBond_OnlyRoundRole() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ROUND_ROLE));
        reg.lockBond(alice, 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, ROUND_ROLE));
        reg.lockBond(alice, 1);
    }

    function test_LockBond_RevertsIfUnregistered() public {
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.AgentNotRegistered.selector, bob));
        reg.lockBond(bob, 1_000_000);
    }

    function test_LockBond_RevertsOnZeroAmount() public {
        vm.prank(round);
        vm.expectRevert(ProposerRegistry.ZeroBondAmount.selector);
        reg.lockBond(alice, 0);
    }

    function test_LockBond_RevertsWithoutAllowance() public {
        vm.prank(bob);
        reg.registerAgent("Bob");
        vm.prank(bob);
        usdc.approve(address(reg), 0);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(reg), 0, 1_000_000));
        reg.lockBond(bob, 1_000_000);
        assertEq(reg.lockedBond(bob), 0);
    }

    function test_LockBond_RevertsWithInsufficientAllowanceAmount() public {
        vm.prank(alice);
        usdc.approve(address(reg), 999_999);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(reg), 999_999, 1_000_000));
        reg.lockBond(alice, 1_000_000);
        assertEq(reg.lockedBond(alice), 0);
    }

    function test_LockBond_RevertsOnInsufficientBalance() public {
        address carol = makeAddr("carol");
        vm.startPrank(carol);
        reg.registerAgent("Carol");
        usdc.approve(address(reg), type(uint256).max);
        vm.stopPrank();
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, carol, 0, 1));
        reg.lockBond(carol, 1);
        assertEq(reg.lockedBond(carol), 0);
    }

    function test_LockBond_RevertsWhenPaused() public {
        vm.prank(admin);
        reg.pause();
        vm.prank(round);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        reg.lockBond(alice, 1_000_000);
    }

    // ---- refundBond ----
    function test_Refund_ReturnsUsdc() public {
        _lock(alice, 1_000_000);
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.BondRefunded(alice, 400_000, 600_000);
        vm.prank(round);
        reg.refundBond(alice, 400_000);
        assertEq(reg.lockedBond(alice), 600_000);
        assertEq(reg.pendingRefund(alice), 0);
        assertEq(usdc.balanceOf(alice), 99_400_000);
        assertEq(usdc.balanceOf(address(reg)), 600_000);
    }

    function test_Refund_FullAmount() public {
        _lock(alice, 1_000_000);
        vm.prank(round);
        reg.refundBond(alice, 1_000_000);
        assertEq(reg.lockedBond(alice), 0);
        assertEq(usdc.balanceOf(alice), 100_000_000);
        assertEq(usdc.balanceOf(address(reg)), 0);
    }

    function test_Refund_ZeroAmountAllowed() public {
        _lock(alice, 1_000_000);
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.BondRefunded(alice, 0, 1_000_000);
        vm.prank(round);
        reg.refundBond(alice, 0);
        assertEq(reg.lockedBond(alice), 1_000_000);
    }

    function test_Refund_OnlyRoundRole() public {
        _lock(alice, 1_000_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ROUND_ROLE));
        reg.refundBond(alice, 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, ROUND_ROLE));
        reg.refundBond(alice, 1);
    }

    function test_Refund_MoreThanLockedReverts() public {
        _lock(alice, 1_000_000);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InsufficientLockedBond.selector, alice, 1_000_000, 1_000_001));
        reg.refundBond(alice, 1_000_001);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InsufficientLockedBond.selector, bob, 0, 1));
        reg.refundBond(bob, 1);
    }

    function test_Refund_WorksWhilePaused() public {
        _lock(alice, 1_000_000);
        vm.prank(admin);
        reg.pause();
        vm.prank(round);
        reg.refundBond(alice, 1_000_000);
        assertEq(usdc.balanceOf(alice), 100_000_000);
        assertEq(reg.lockedBond(alice), 0);
    }

    function test_ClaimRefund_NothingToClaim() public {
        vm.prank(alice);
        vm.expectRevert(ProposerRegistry.NothingToClaim.selector);
        reg.claimRefund();
    }

    // ---- slash ----
    function test_Slash_RevertsUntilTreasurySet() public {
        _lock(alice, 1_000_000);
        vm.prank(round);
        vm.expectRevert(ProposerRegistry.SlashTreasuryNotSet.selector);
        reg.slashBond(alice, 1_000_000);
        assertEq(reg.lockedBond(alice), 1_000_000);
    }

    function test_Slash_PaysTreasury() public {
        _lock(alice, 1_000_000);
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.SlashTreasuryUpdated(address(0), treasury);
        vm.prank(admin);
        reg.setSlashTreasury(treasury);

        vm.expectEmit(true, true, false, true, address(reg));
        emit ProposerRegistry.BondSlashed(alice, treasury, 300_000, 700_000);
        vm.prank(round);
        reg.slashBond(alice, 300_000);
        assertEq(usdc.balanceOf(treasury), 300_000);
        assertEq(reg.lockedBond(alice), 700_000);
        assertEq(usdc.balanceOf(address(reg)), 700_000);
    }

    function test_Slash_OnlyRoundRole() public {
        vm.prank(admin);
        reg.setSlashTreasury(treasury);
        _lock(alice, 1_000_000);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, ROUND_ROLE));
        reg.slashBond(alice, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ROUND_ROLE));
        reg.slashBond(alice, 1);
    }

    function test_Slash_MoreThanLockedReverts() public {
        vm.prank(admin);
        reg.setSlashTreasury(treasury);
        _lock(alice, 1_000_000);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InsufficientLockedBond.selector, alice, 1_000_000, 1_000_001));
        reg.slashBond(alice, 1_000_001);
    }

    function test_Slash_WorksWhilePaused() public {
        vm.startPrank(admin);
        reg.setSlashTreasury(treasury);
        vm.stopPrank();
        _lock(alice, 1_000_000);
        vm.prank(admin);
        reg.pause();
        vm.prank(round);
        reg.slashBond(alice, 1_000_000);
        assertEq(usdc.balanceOf(treasury), 1_000_000);
    }

    function test_SetSlashTreasury_AdminOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ADMIN_ROLE));
        reg.setSlashTreasury(treasury);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, round, ADMIN_ROLE));
        reg.setSlashTreasury(treasury);
    }

    function test_SetSlashTreasury_ZeroDisablesSlashing() public {
        vm.startPrank(admin);
        reg.setSlashTreasury(treasury);
        vm.expectEmit(true, true, false, false, address(reg));
        emit ProposerRegistry.SlashTreasuryUpdated(treasury, address(0));
        reg.setSlashTreasury(address(0));
        vm.stopPrank();
        _lock(alice, 1);
        vm.prank(round);
        vm.expectRevert(ProposerRegistry.SlashTreasuryNotSet.selector);
        reg.slashBond(alice, 1);
    }

    // ---- pause ----
    function test_Pause_AdminOnlyAndUnpauseRestores() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ADMIN_ROLE));
        reg.pause();
        vm.prank(admin);
        reg.pause();
        assertTrue(reg.paused());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ADMIN_ROLE));
        reg.unpause();
        vm.prank(admin);
        reg.unpause();
        _lock(alice, 1_000_000);
        assertEq(reg.lockedBond(alice), 1_000_000);
    }

    // ---- counters ----
    function test_RecordProposal_Increments() public {
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.ProposalRecorded(alice, 1);
        vm.startPrank(round);
        reg.recordProposal(alice);
        reg.recordProposal(alice);
        vm.stopPrank();
        (,,, uint32 made, uint32 won) = _agent(alice);
        assertEq(made, 2);
        assertEq(won, 0);
    }

    function test_RecordWin_Increments() public {
        vm.expectEmit(true, false, false, true, address(reg));
        emit ProposerRegistry.WinRecorded(alice, 1);
        vm.startPrank(round);
        reg.recordWin(alice);
        reg.recordWin(alice);
        reg.recordWin(alice);
        vm.stopPrank();
        (,,, uint32 made, uint32 won) = _agent(alice);
        assertEq(made, 0);
        assertEq(won, 3);
    }

    function test_Record_RevertForUnregistered() public {
        vm.startPrank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.AgentNotRegistered.selector, bob));
        reg.recordProposal(bob);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.AgentNotRegistered.selector, bob));
        reg.recordWin(bob);
        vm.stopPrank();
    }

    function test_Record_OnlyRoundRole() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ROUND_ROLE));
        reg.recordProposal(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ROUND_ROLE));
        reg.recordWin(alice);
        vm.stopPrank();
    }

    function test_Record_CounterOverflowReverts() public {
        // agents mapping: slot of `agents` is found via stdstore-free approach: write packed struct fields.
        // Struct layout: name (slot s), then slot s+1 = registeredAt | active<<64 | proposalsMade<<72 | roundsWon<<104.
        bytes32 base = keccak256(abi.encode(alice, uint256(_agentsSlot())));
        bytes32 packedSlot = bytes32(uint256(base) + 1);
        uint256 packed = uint256(uint64(block.timestamp)) | (uint256(1) << 64)
            | (uint256(type(uint32).max) << 72) | (uint256(type(uint32).max) << 104);
        vm.store(address(reg), packedSlot, bytes32(packed));
        (,,, uint32 made, uint32 won) = _agent(alice);
        assertEq(made, type(uint32).max);
        assertEq(won, type(uint32).max);
        vm.startPrank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.CounterOverflow.selector, alice));
        reg.recordProposal(alice);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.CounterOverflow.selector, alice));
        reg.recordWin(alice);
        vm.stopPrank();
    }

    /// @dev Slot index of `agents` found by probing: AccessControl(1: _roles) , Pausable(_paused),
    /// ReentrancyGuard(_status), slashTreasury, agents ... computed dynamically to avoid layout assumptions.
    function _agentsSlot() internal returns (uint256 slot) {
        for (slot = 0; slot < 12; slot++) {
            bytes32 packedSlot = bytes32(uint256(keccak256(abi.encode(alice, slot))) + 1);
            bytes32 before = vm.load(address(reg), packedSlot);
            // registeredAt is nonzero for alice; the true agents slot holds it in the low 64 bits.
            if (uint64(uint256(before)) == uint64(block.timestamp) && uint256(before) >> 64 == 1) return slot;
        }
        revert("agents slot not found");
    }

    // ---- no native value ----
    function test_NoNativeValue_Accepted() public {
        vm.deal(address(this), 10 ether);
        vm.deal(round, 10 ether);
        bool ok;
        (ok,) = address(reg).call{value: 1}("");
        assertFalse(ok, "receive");
        (ok,) = address(reg).call{value: 1}(abi.encodeWithSignature("nonexistent()"));
        assertFalse(ok, "fallback");
        (ok,) = address(reg).call{value: 1}(abi.encodeCall(reg.registerAgent, ("x")));
        assertFalse(ok, "registerAgent");
        (ok,) = address(reg).call{value: 1}(abi.encodeCall(reg.claimRefund, ()));
        assertFalse(ok, "claimRefund");
        (ok,) = address(reg).call{value: 1}(abi.encodeCall(reg.setSlashTreasury, (treasury)));
        assertFalse(ok, "setSlashTreasury");
        vm.startPrank(round);
        (ok,) = address(reg).call{value: 1}(abi.encodeCall(reg.lockBond, (alice, 1)));
        assertFalse(ok, "lockBond");
        (ok,) = address(reg).call{value: 1}(abi.encodeCall(reg.refundBond, (alice, 0)));
        assertFalse(ok, "refundBond");
        (ok,) = address(reg).call{value: 1}(abi.encodeCall(reg.slashBond, (alice, 0)));
        assertFalse(ok, "slashBond");
        (ok,) = address(reg).call{value: 1}(abi.encodeCall(reg.recordProposal, (alice)));
        assertFalse(ok, "recordProposal");
        (ok,) = address(reg).call{value: 1}(abi.encodeCall(reg.recordWin, (alice)));
        assertFalse(ok, "recordWin");
        vm.stopPrank();
        vm.startPrank(admin);
        (ok,) = address(reg).call{value: 1}(abi.encodeCall(reg.pause, ()));
        assertFalse(ok, "pause");
        vm.stopPrank();
        assertEq(address(reg).balance, 0);
    }

    // ---- fuzz ----
    function testFuzz_LockRefund(uint256 lockAmt, uint256 refundAmt) public {
        lockAmt = bound(lockAmt, 1, 100_000_000);
        refundAmt = bound(refundAmt, 0, lockAmt);
        _lock(alice, lockAmt);
        vm.prank(round);
        reg.refundBond(alice, refundAmt);
        assertEq(reg.lockedBond(alice), lockAmt - refundAmt);
        assertEq(usdc.balanceOf(address(reg)), lockAmt - refundAmt);
        assertEq(usdc.balanceOf(alice), 100_000_000 - lockAmt + refundAmt);
    }

    function testFuzz_RefundMoreThanLockedReverts(uint256 lockAmt, uint256 extra) public {
        lockAmt = bound(lockAmt, 1, 100_000_000);
        extra = bound(extra, 1, type(uint128).max);
        _lock(alice, lockAmt);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InsufficientLockedBond.selector, alice, lockAmt, lockAmt + extra));
        reg.refundBond(alice, lockAmt + extra);
    }

    function testFuzz_SlashRefundSplit(uint256 lockAmt, uint256 slashAmt, uint256 refundAmt) public {
        lockAmt = bound(lockAmt, 1, 100_000_000);
        slashAmt = bound(slashAmt, 0, lockAmt);
        refundAmt = bound(refundAmt, 0, lockAmt - slashAmt);
        vm.prank(admin);
        reg.setSlashTreasury(treasury);
        _lock(alice, lockAmt);
        vm.startPrank(round);
        reg.slashBond(alice, slashAmt);
        reg.refundBond(alice, refundAmt);
        vm.stopPrank();
        assertEq(reg.lockedBond(alice), lockAmt - slashAmt - refundAmt);
        assertEq(usdc.balanceOf(treasury), slashAmt);
        assertEq(usdc.balanceOf(address(reg)), reg.lockedBond(alice));
    }

    function testFuzz_NameLength(uint8 len) public {
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; i++) b[i] = "z";
        vm.prank(bob);
        if (len == 0 || len > 64) {
            vm.expectRevert(abi.encodeWithSelector(ProposerRegistry.InvalidNameLength.selector, uint256(len)));
            reg.registerAgent(string(b));
        } else {
            reg.registerAgent(string(b));
            (string memory name,, bool active,,) = _agent(bob);
            assertEq(bytes(name).length, len);
            assertTrue(active);
        }
    }

    function testFuzz_CountersMatchCalls(uint8 nProposals, uint8 nWins) public {
        vm.startPrank(round);
        for (uint256 i; i < nProposals; i++) reg.recordProposal(alice);
        for (uint256 i; i < nWins; i++) reg.recordWin(alice);
        vm.stopPrank();
        (,,, uint32 made, uint32 won) = _agent(alice);
        assertEq(made, nProposals);
        assertEq(won, nWins);
    }
}
