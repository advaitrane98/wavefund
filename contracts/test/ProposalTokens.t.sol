// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ProposalTokens} from "../src/ProposalTokens.sol";
import {ProposalToken} from "../src/ProposalToken.sol";

contract ProposalTokensTest is Test {
    ProposalTokens internal factory;
    address internal admin = makeAddr("admin");
    address internal round = makeAddr("round");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    bytes32 internal ROUND_ROLE;
    bytes32 internal ADMIN_ROLE;

    function setUp() public {
        factory = new ProposalTokens(admin);
        ROUND_ROLE = factory.QUANTUM_ROUND_ROLE();
        ADMIN_ROLE = factory.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        factory.grantRole(ROUND_ROLE, round);
    }

    function _create(uint256 r, uint256 p) internal returns (address c, address l, address s) {
        vm.prank(round);
        return factory.createProposalTokens(r, p);
    }

    function _predict(uint256 r, uint256 p, uint8 kind) internal view returns (address) {
        return Clones.predictDeterministicAddress(
            factory.implementation(), keccak256(abi.encode(r, p, kind)), address(factory)
        );
    }

    // ---- deployment ----
    function test_Deployment() public view {
        assertTrue(factory.hasRole(ADMIN_ROLE, admin));
        assertFalse(factory.hasRole(ROUND_ROLE, admin));
        assertEq(factory.creditDecimals(), 18);
        assertEq(ROUND_ROLE, keccak256("QUANTUM_ROUND_ROLE"));
        assertTrue(factory.implementation().code.length > 0);
    }

    function test_Constructor_RevertsOnZeroAdmin() public {
        vm.expectRevert(ProposalTokens.ZeroAddress.selector);
        new ProposalTokens(address(0));
    }

    // ---- creation ----
    function test_Create_ThreeDistinctClonesWithExactMetadata() public {
        (address c, address l, address s) = _create(1, 1);
        assertTrue(c != l && l != s && c != s);
        assertTrue(c != address(0));
        assertEq(ProposalToken(c).name(), "Wavefund Round 1 Proposal 1 CREDIT");
        assertEq(ProposalToken(l).name(), "Wavefund Round 1 Proposal 1 LONG");
        assertEq(ProposalToken(s).name(), "Wavefund Round 1 Proposal 1 SHORT");
        assertEq(ProposalToken(c).symbol(), "W-R1-P1-CREDIT");
        assertEq(ProposalToken(l).symbol(), "W-R1-P1-LONG");
        assertEq(ProposalToken(s).symbol(), "W-R1-P1-SHORT");
        assertEq(ProposalToken(c).decimals(), 18);
        assertEq(ProposalToken(l).decimals(), 18);
        assertEq(ProposalToken(s).decimals(), 18);
        assertEq(ProposalToken(c).factory(), address(factory));
        assertEq(ProposalToken(l).factory(), address(factory));
        assertEq(ProposalToken(s).factory(), address(factory));
        assertEq(ProposalToken(l).totalSupply(), 0);
    }

    function test_Create_MultiDigitNames() public {
        (, address l,) = _create(12, 345);
        assertEq(ProposalToken(l).name(), "Wavefund Round 12 Proposal 345 LONG");
        assertEq(ProposalToken(l).symbol(), "W-R12-P345-LONG");
    }

    function test_Create_AddressesAreDeterministic() public {
        (address c, address l, address s) = _create(3, 9);
        assertEq(c, _predict(3, 9, 0));
        assertEq(l, _predict(3, 9, 1));
        assertEq(s, _predict(3, 9, 2));
    }

    function test_Create_EmitsEvents() public {
        address c = _predict(2, 7, 0);
        address l = _predict(2, 7, 1);
        address s = _predict(2, 7, 2);
        vm.expectEmit(false, false, false, true, address(factory));
        emit ProposalTokens.CreditDecimalsLockedOnCreation(18);
        vm.expectEmit(true, true, false, true, address(factory));
        emit ProposalTokens.ProposalTokensCreated(2, 7, c, l, s);
        _create(2, 7);
    }

    function test_Create_LockEventEmittedOnlyOnFirstCreation() public {
        _create(1, 1);
        vm.recordLogs();
        _create(1, 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 lockSig = ProposalTokens.CreditDecimalsLockedOnCreation.selector;
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != lockSig);
        }
    }

    function test_Create_RevertsForNonRoundRole() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ROUND_ROLE));
        factory.createProposalTokens(1, 1);
        // admin without round role is rejected
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, ROUND_ROLE));
        factory.createProposalTokens(1, 1);
    }

    function test_Create_RevertsOnDuplicatePair() public {
        _create(1, 1);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposalTokens.ProposalAlreadyExists.selector, 1, 1));
        factory.createProposalTokens(1, 1);
    }

    function test_Create_SwappedPairIsDistinct() public {
        (address c1,,) = _create(1, 2);
        (address c2,,) = _create(2, 1);
        assertTrue(c1 != c2);
    }

    function test_Create_ZeroIdsAllowed() public {
        (address c,,) = _create(0, 0);
        assertTrue(factory.proposalExists(0, 0));
        assertEq(factory.creditToken(0, 0), c);
    }

    // ---- views ----
    function test_Views_ReturnZeroWhenAbsent() public view {
        assertFalse(factory.proposalExists(1, 1));
        assertEq(factory.creditToken(1, 1), address(0));
        assertEq(factory.longToken(1, 1), address(0));
        assertEq(factory.shortToken(1, 1), address(0));
    }

    function test_Views_ReturnTokensWhenPresent() public {
        (address c, address l, address s) = _create(5, 6);
        assertTrue(factory.proposalExists(5, 6));
        assertEq(factory.creditToken(5, 6), c);
        assertEq(factory.longToken(5, 6), l);
        assertEq(factory.shortToken(5, 6), s);
        assertFalse(factory.proposalExists(5, 7));
        assertEq(factory.longToken(5, 7), address(0));
    }

    // ---- credit decimals ----
    function test_SetCreditDecimals_6_AppliesToCredit() public {
        vm.expectEmit(false, false, false, true, address(factory));
        emit ProposalTokens.CreditDecimalsSet(6);
        vm.prank(admin);
        factory.setCreditDecimals(6);
        assertEq(factory.creditDecimals(), 6);
        (address c, address l, address s) = _create(1, 1);
        assertEq(ProposalToken(c).decimals(), 6);
        assertEq(ProposalToken(l).decimals(), 18);
        assertEq(ProposalToken(s).decimals(), 18);
    }

    function test_SetCreditDecimals_SecondCallReverts() public {
        vm.startPrank(admin);
        factory.setCreditDecimals(6);
        vm.expectRevert(ProposalTokens.CreditDecimalsAlreadySet.selector);
        factory.setCreditDecimals(8);
        vm.expectRevert(ProposalTokens.CreditDecimalsAlreadySet.selector);
        factory.setCreditDecimals(6);
        vm.stopPrank();
        assertEq(factory.creditDecimals(), 6);
    }

    function test_SetCreditDecimals_ExplicitDefaultAlsoConsumesOneShot() public {
        vm.startPrank(admin);
        factory.setCreditDecimals(18);
        vm.expectRevert(ProposalTokens.CreditDecimalsAlreadySet.selector);
        factory.setCreditDecimals(6);
        vm.stopPrank();
    }

    function test_SetCreditDecimals_ZeroAllowed() public {
        vm.prank(admin);
        factory.setCreditDecimals(0);
        (address c,,) = _create(1, 1);
        assertEq(ProposalToken(c).decimals(), 0);
    }

    function test_SetCreditDecimals_RevertsAfterFirstCreation() public {
        _create(1, 1);
        vm.prank(admin);
        vm.expectRevert(ProposalTokens.CreditDecimalsLocked.selector);
        factory.setCreditDecimals(6);
        assertEq(factory.creditDecimals(), 18);
    }

    function test_SetCreditDecimals_RevertsAbove18() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ProposalTokens.InvalidCreditDecimals.selector, uint8(19)));
        factory.setCreditDecimals(19);
        // a rejected call must not consume the one-shot
        vm.prank(admin);
        factory.setCreditDecimals(6);
        assertEq(factory.creditDecimals(), 6);
    }

    function test_SetCreditDecimals_AdminOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, ADMIN_ROLE));
        factory.setCreditDecimals(6);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, round, ADMIN_ROLE));
        factory.setCreditDecimals(6);
    }

    // ---- clones / initialization ----
    function test_Clones_AreEIP1167MinimalProxies() public {
        (address c, address l, address s) = _create(1, 1);
        bytes memory expected = abi.encodePacked(
            hex"363d3d373d3d3d363d73", factory.implementation(), hex"5af43d82803e903d91602b57fd5bf3"
        );
        assertEq(c.code, expected);
        assertEq(l.code, expected);
        assertEq(s.code, expected);
        assertEq(c.code.length, 45);
    }

    function test_Clone_CannotBeReinitialized() public {
        (, address l,) = _create(1, 1);
        vm.prank(address(factory));
        vm.expectRevert(ProposalToken.AlreadyInitialized.selector);
        ProposalToken(l).initialize("x", "x", 18, address(factory));
        vm.prank(alice);
        vm.expectRevert(ProposalToken.AlreadyInitialized.selector);
        ProposalToken(l).initialize("x", "x", 18, alice);
        assertEq(ProposalToken(l).factory(), address(factory));
        assertEq(ProposalToken(l).symbol(), "W-R1-P1-LONG");
    }

    function test_Implementation_IsLocked() public {
        ProposalToken impl = ProposalToken(factory.implementation());
        vm.prank(address(factory));
        vm.expectRevert(ProposalToken.AlreadyInitialized.selector);
        impl.initialize("x", "x", 18, address(factory));
        vm.prank(alice);
        vm.expectRevert(ProposalToken.AlreadyInitialized.selector);
        impl.initialize("x", "x", 18, address(this));
        assertEq(impl.factory(), address(0));
        // implementation can never mint (no factory to resolve roles)
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, round));
        impl.mint(alice, 1);
    }

    function test_Initialize_ValidationOnFreshClone() public {
        ProposalToken fresh = ProposalToken(Clones.clone(factory.implementation()));
        // zero factory
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.InvalidFactory.selector, address(0)));
        fresh.initialize("n", "s", 18, address(0));
        // EOA factory (no code)
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.InvalidFactory.selector, alice));
        fresh.initialize("n", "s", 18, alice);
        // caller is not the stated factory
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedInitializer.selector, alice));
        fresh.initialize("n", "s", 18, address(factory));
        // decimals > 18
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.InvalidDecimals.selector, uint8(19)));
        fresh.initialize("n", "s", 19, address(factory));
        // valid, from factory address
        vm.prank(address(factory));
        fresh.initialize("n", "s", 12, address(factory));
        assertEq(fresh.decimals(), 12);
        assertEq(fresh.name(), "n");
    }

    function test_Uninitialized_TokenCannotMint() public {
        ProposalToken fresh = ProposalToken(Clones.clone(factory.implementation()));
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, round));
        fresh.mint(alice, 1);
    }

    // ---- mint / burn ----
    function test_Mint_ByRoundRoleHolder() public {
        (, address l,) = _create(1, 1);
        vm.expectEmit(true, true, false, true, l);
        emit IERC20.Transfer(address(0), alice, 100e18);
        vm.prank(round);
        ProposalToken(l).mint(alice, 100e18);
        assertEq(ProposalToken(l).balanceOf(alice), 100e18);
        assertEq(ProposalToken(l).totalSupply(), 100e18);
    }

    function test_Mint_RevertsForNonRoleHolders() public {
        (, address l,) = _create(1, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, alice));
        ProposalToken(l).mint(alice, 1);
        // factory admin without the round role is not enough
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, admin));
        ProposalToken(l).mint(alice, 1);
        // the factory contract itself is not a supply controller
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, address(factory)));
        ProposalToken(l).mint(alice, 1);
    }

    function test_Burn_ByRoundRoleHolderNoAllowance() public {
        (address c,,) = _create(1, 1);
        vm.startPrank(round);
        ProposalToken(c).mint(alice, 50e18);
        assertEq(ProposalToken(c).allowance(alice, round), 0);
        vm.expectEmit(true, true, false, true, c);
        emit IERC20.Transfer(alice, address(0), 20e18);
        ProposalToken(c).burn(alice, 20e18);
        vm.stopPrank();
        assertEq(ProposalToken(c).balanceOf(alice), 30e18);
        assertEq(ProposalToken(c).totalSupply(), 30e18);
    }

    function test_Burn_RevertsForNonRoleHolderAndInsufficientBalance() public {
        (, address l,) = _create(1, 1);
        vm.prank(round);
        ProposalToken(l).mint(alice, 10);
        vm.prank(alice); // even the token holder cannot burn
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, alice));
        ProposalToken(l).burn(alice, 1);
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 10, 11));
        ProposalToken(l).burn(alice, 11);
    }

    function test_RoleRevocation_TakesEffectImmediately() public {
        (, address l, address s) = _create(1, 1);
        vm.prank(round);
        ProposalToken(l).mint(alice, 10);
        vm.prank(admin);
        factory.revokeRole(ROUND_ROLE, round);
        vm.startPrank(round);
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, round));
        ProposalToken(l).mint(alice, 1);
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, round));
        ProposalToken(s).burn(alice, 0);
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, round));
        ProposalToken(l).burn(alice, 1);
        vm.stopPrank();
        // and factory creation too
        vm.prank(round);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, round, ROUND_ROLE));
        factory.createProposalTokens(9, 9);
    }

    function test_RoleGrant_TakesEffectImmediatelyOnExistingTokens() public {
        (, address l,) = _create(1, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ProposalToken.UnauthorizedRound.selector, bob));
        ProposalToken(l).mint(bob, 1);
        vm.prank(admin);
        factory.grantRole(ROUND_ROLE, bob);
        vm.prank(bob);
        ProposalToken(l).mint(bob, 1);
        assertEq(ProposalToken(l).balanceOf(bob), 1);
    }

    function test_Token_RejectsNativeValue() public {
        (address c,,) = _create(1, 1);
        vm.deal(address(this), 2);
        (bool ok,) = c.call{value: 1}("");
        assertFalse(ok);
        (ok,) = address(factory).call{value: 1}("");
        assertFalse(ok);
    }

    // ---- fuzz ----
    function testFuzz_Create_NamesAndLookups(uint256 r, uint256 p) public {
        (address c, address l, address s) = _create(r, p);
        string memory rs = vm.toString(r);
        string memory ps = vm.toString(p);
        assertEq(ProposalToken(l).name(), string.concat("Wavefund Round ", rs, " Proposal ", ps, " LONG"));
        assertEq(ProposalToken(s).symbol(), string.concat("W-R", rs, "-P", ps, "-SHORT"));
        assertEq(ProposalToken(c).name(), string.concat("Wavefund Round ", rs, " Proposal ", ps, " CREDIT"));
        assertEq(factory.creditToken(r, p), c);
        assertEq(factory.longToken(r, p), l);
        assertEq(factory.shortToken(r, p), s);
        assertTrue(factory.proposalExists(r, p));
    }

    function testFuzz_Create_DistinctPairsDistinctTokens(uint256 r1, uint256 p1, uint256 r2, uint256 p2) public {
        vm.assume(r1 != r2 || p1 != p2);
        (address c1, address l1, address s1) = _create(r1, p1);
        (address c2, address l2, address s2) = _create(r2, p2);
        assertTrue(c1 != c2 && l1 != l2 && s1 != s2);
        assertTrue(c1 != l2 && c1 != s2 && l1 != c2 && l1 != s2 && s1 != c2 && s1 != l2);
    }

    function testFuzz_SetCreditDecimals(uint8 d) public {
        vm.prank(admin);
        if (d > 18) {
            vm.expectRevert(abi.encodeWithSelector(ProposalTokens.InvalidCreditDecimals.selector, d));
            factory.setCreditDecimals(d);
        } else {
            factory.setCreditDecimals(d);
            (address c,,) = _create(1, 1);
            assertEq(ProposalToken(c).decimals(), d);
        }
    }

    function testFuzz_MintBurn(uint256 minted, uint256 burned) public {
        minted = bound(minted, 0, type(uint128).max);
        burned = bound(burned, 0, minted);
        (, address l,) = _create(1, 1);
        vm.startPrank(round);
        ProposalToken(l).mint(alice, minted);
        ProposalToken(l).burn(alice, burned);
        vm.stopPrank();
        assertEq(ProposalToken(l).balanceOf(alice), minted - burned);
        assertEq(ProposalToken(l).totalSupply(), minted - burned);
    }
}
