// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/RevenueVault.sol";
import "./mocks/MockUSDC.sol";

contract RevenueVaultTest is Test {
    RevenueVault vault;
    MockUSDC usdc;

    address pullPayment = address(0xCAFE);
    address merchant = address(0xBEEF);
    address affiliate = address(0xAFF1);
    address attacker = address(0xBAD);

    function setUp() public {
        usdc = new MockUSDC();
        vault = new RevenueVault(address(usdc));
        vault.setPullPayment(pullPayment);
        usdc.mint(address(vault), 1_000_000_000);
    }

    function test_setPullPayment_onlyOnce() public {
        vm.expectRevert(RevenueVault.PullPaymentAlreadySet.selector);
        vault.setPullPayment(address(0xdead));
    }

    function test_setPullPayment_onlyOwner() public {
        RevenueVault freshVault = new RevenueVault(address(usdc));
        vm.prank(attacker);
        vm.expectRevert(RevenueVault.NotOwner.selector);
        freshVault.setPullPayment(pullPayment);
    }

    function test_credit_onlyPullPayment() public {
        vm.prank(attacker);
        vm.expectRevert(RevenueVault.NotPullPayment.selector);
        vault.credit(merchant, 1_000_000);
    }

    function test_credit_creditsFullAmountWithNoSplit() public {
        vm.prank(pullPayment);
        vault.credit(merchant, 1_000_000);
        assertEq(vault.getBalance(merchant), 1_000_000);
        assertEq(vault.totalCredited(), 1_000_000);
    }

    function test_credit_appliesSplitCorrectly() public {
        vm.prank(merchant);
        vault.setSplit(affiliate, 2_000); // 20%

        vm.prank(pullPayment);
        vault.credit(merchant, 1_000_000);

        assertEq(vault.getBalance(affiliate), 200_000);
        assertEq(vault.getBalance(merchant), 800_000);
    }

    function test_setSplit_revertsAboveMax() public {
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(RevenueVault.SplitTooHigh.selector, 9_001, 9_000));
        vault.setSplit(affiliate, 9_001);
    }

    function test_setSplit_revertsOnSelfSplit() public {
        vm.prank(merchant);
        vm.expectRevert(RevenueVault.SplitToSelf.selector);
        vault.setSplit(merchant, 1_000);
    }

    function test_withdraw_success() public {
        vm.prank(pullPayment);
        vault.credit(merchant, 1_000_000);

        vm.prank(merchant);
        vault.withdraw();

        assertEq(usdc.balanceOf(merchant), 1_000_000);
        assertEq(vault.getBalance(merchant), 0);
        assertEq(vault.totalWithdrawn(), 1_000_000);
    }

    function test_withdraw_revertsOnZeroBalance() public {
        vm.prank(attacker);
        vm.expectRevert(RevenueVault.ZeroAmount.selector);
        vault.withdraw();
    }

    function test_withdrawTo_revertsOnInsufficientBalance() public {
        vm.prank(pullPayment);
        vault.credit(merchant, 1_000_000);

        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(RevenueVault.InsufficientBalance.selector, merchant, 2_000_000, 1_000_000));
        vault.withdrawTo(merchant, 2_000_000);
    }

    function test_removeSplit() public {
        vm.prank(merchant);
        vault.setSplit(affiliate, 2_000);

        vm.prank(merchant);
        vault.removeSplit();

        RevenueVault.Split memory s = vault.getSplit(merchant);
        assertEq(s.recipient, address(0));
    }
}
