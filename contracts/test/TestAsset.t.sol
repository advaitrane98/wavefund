// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TestAsset} from "../src/TestAsset.sol";

contract TestAssetTest is Test {
    TestAsset internal asset;
    address internal admin = makeAddr("admin");
    address internal minter = makeAddr("minter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        asset = new TestAsset(admin);
    }

    // ---- deployment ----
    function test_Metadata() public view {
        assertEq(asset.decimals(), 18);
        assertEq(asset.name(), "Test ETH");
        assertEq(asset.symbol(), "tETH");
        assertEq(asset.totalSupply(), 0);
    }

    function test_AdminHoldsBothRoles() public view {
        assertTrue(asset.hasRole(asset.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(asset.hasRole(asset.MINTER_ROLE(), admin));
        assertEq(asset.MINTER_ROLE(), keccak256("MINTER_ROLE"));
    }

    function test_Constructor_RevertsOnZeroAdmin() public {
        vm.expectRevert(TestAsset.ZeroAddress.selector);
        new TestAsset(address(0));
    }

    // ---- mint ----
    function test_Mint_ByMinter() public {
        vm.expectEmit(true, true, false, true, address(asset));
        emit IERC20.Transfer(address(0), alice, 5e18);
        vm.prank(admin);
        asset.mint(alice, 5e18);
        assertEq(asset.balanceOf(alice), 5e18);
        assertEq(asset.totalSupply(), 5e18);
    }

    function test_Mint_RevertsForNonMinter() public {
        bytes32 role = asset.MINTER_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        asset.mint(alice, 1);
    }

    function test_Mint_GrantedMinterCanMint() public {
        bytes32 role = asset.MINTER_ROLE();
        vm.prank(admin);
        asset.grantRole(role, minter);
        vm.prank(minter);
        asset.mint(bob, 7);
        assertEq(asset.balanceOf(bob), 7);
    }

    function test_Mint_RevokedMinterCannotMint() public {
        bytes32 role = asset.MINTER_ROLE();
        vm.startPrank(admin);
        asset.grantRole(role, minter);
        asset.revokeRole(role, minter);
        vm.stopPrank();
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, minter, role));
        asset.mint(bob, 1);
    }

    function test_Mint_ToZeroReverts() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        asset.mint(address(0), 1);
    }

    // ---- burn ----
    function test_Burn_ByMinterNeedsNoAllowance() public {
        vm.startPrank(admin);
        asset.mint(alice, 10e18);
        assertEq(asset.allowance(alice, admin), 0);
        vm.expectEmit(true, true, false, true, address(asset));
        emit IERC20.Transfer(alice, address(0), 4e18);
        asset.burn(alice, 4e18);
        vm.stopPrank();
        assertEq(asset.balanceOf(alice), 6e18);
        assertEq(asset.totalSupply(), 6e18);
    }

    function test_Burn_RevertsForNonMinter() public {
        vm.prank(admin);
        asset.mint(alice, 10);
        bytes32 role = asset.MINTER_ROLE();
        // Holder cannot burn their own balance either.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        asset.burn(alice, 1);
    }

    function test_Burn_RevertsOnInsufficientBalance() public {
        vm.startPrank(admin);
        asset.mint(alice, 3);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 3, 4));
        asset.burn(alice, 4);
        vm.stopPrank();
    }

    // ---- misc ----
    function test_RejectsNativeValue() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(asset).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(asset).balance, 0);
    }

    // ---- fuzz ----
    function testFuzz_MintBurn(uint256 mintAmt, uint256 burnAmt) public {
        mintAmt = bound(mintAmt, 0, type(uint128).max);
        burnAmt = bound(burnAmt, 0, mintAmt);
        vm.startPrank(admin);
        asset.mint(alice, mintAmt);
        asset.burn(alice, burnAmt);
        vm.stopPrank();
        assertEq(asset.balanceOf(alice), mintAmt - burnAmt);
        assertEq(asset.totalSupply(), mintAmt - burnAmt);
    }

    function testFuzz_NonMinterCannotMint(address caller, uint256 amount) public {
        vm.assume(caller != admin);
        vm.prank(caller);
        vm.expectRevert();
        asset.mint(caller, amount);
    }
}
