// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SubscriptionRegistry.sol";
import "../src/RevenueVault.sol";
import "../src/PullPayment.sol";
import "./mocks/MockUSDC.sol";

contract PullPaymentTest is Test {
    SubscriptionRegistry registry;
    RevenueVault vault;
    PullPayment pull;
    MockUSDC usdc;

    address merchant = address(0xBEEF);
    address subscriber = address(0xCAFE);
    address feeRecipient = address(0xFEE5);

    bytes32 planId = keccak256("plan-1");
    uint256 price = 5_000_000;

    function setUp() public {
        usdc = new MockUSDC();
        registry = new SubscriptionRegistry();
        vault = new RevenueVault(address(usdc));
        pull = new PullPayment(address(usdc), address(registry), address(vault), feeRecipient);
        vault.setPullPayment(address(pull));
        registry.setPullPayment(address(pull));

        vm.prank(merchant);
        registry.createPlan(planId, price, SubscriptionRegistry.Interval.Monthly, 0, 0);

        usdc.mint(subscriber, 100_000_000);
        vm.prank(subscriber);
        usdc.approve(address(pull), type(uint256).max);
    }

    // ---------- subscribe ----------

    function test_subscribe_billsImmediatelyWithNoTrial() public {
        vm.prank(subscriber);
        bytes32 subId = pull.subscribe(planId, 100_000_000);

        assertEq(usdc.balanceOf(feeRecipient), 37_500);
        assertEq(vault.getBalance(merchant), 4_962_500);
        assertEq(registry.getSubscription(subId).billingCount, 1);
    }

    function test_subscribe_revertsOnInsufficientAllowance() public {
        vm.prank(subscriber);
        usdc.approve(address(pull), 1_000_000);

        vm.expectRevert();
        vm.prank(subscriber);
        pull.subscribe(planId, 1_000_000);
    }

    // ---------- triggerBilling ----------

    function test_triggerBilling_revertsWhenNotDue() public {
        vm.prank(subscriber);
        bytes32 subId = pull.subscribe(planId, 100_000_000);

        vm.expectRevert();
        pull.triggerBilling(subId);
    }

    function test_triggerBilling_successAfterInterval() public {
        vm.prank(subscriber);
        bytes32 subId = pull.subscribe(planId, 100_000_000);

        vm.warp(block.timestamp + 31 days);
        pull.triggerBilling(subId);

        assertEq(registry.getSubscription(subId).billingCount, 2);
        assertEq(vault.getBalance(merchant), 2 * 4_962_500);
    }

    function test_triggerBilling_anyoneCanCallIt() public {
        // intended behavior — permissionless keepers are the design.
        vm.prank(subscriber);
        bytes32 subId = pull.subscribe(planId, 100_000_000);
        vm.warp(block.timestamp + 31 days);

        address randomKeeper = makeAddr("keeper");
        vm.prank(randomKeeper);
        pull.triggerBilling(subId);

        assertEq(registry.getSubscription(subId).billingCount, 2);
    }

    // ---------- grace period & retries ----------

    function test_triggerBilling_entersGraceOnInsufficientBalance() public {
        vm.prank(subscriber);
        bytes32 subId = pull.subscribe(planId, 100_000_000);

        uint256 subBal = usdc.balanceOf(subscriber);
        vm.prank(subscriber);
        usdc.transfer(address(0xdead), subBal);

        vm.warp(block.timestamp + 31 days);
        pull.triggerBilling(subId);

        assertEq(pull.failedAttempts(subId), 1);
        assertGt(pull.graceExpiresAt(subId), block.timestamp);
        assertEq(registry.getSubscription(subId).billingCount, 1);
    }

    function test_triggerBilling_recoversAfterFundingDuringGrace() public {
        vm.prank(subscriber);
        bytes32 subId = pull.subscribe(planId, 100_000_000);

        uint256 subBal = usdc.balanceOf(subscriber);
        vm.prank(subscriber);
        usdc.transfer(address(0xdead), subBal);

        vm.warp(block.timestamp + 31 days);
        pull.triggerBilling(subId);

        usdc.mint(subscriber, 100_000_000);
        pull.triggerBilling(subId);

        assertEq(registry.getSubscription(subId).billingCount, 2);
        assertEq(pull.failedAttempts(subId), 0);
    }

    /// @notice BUG: "expiring" a subscription after max retries only
    /// resets PullPayment's own local counters — it never tells the
    /// registry to deactivate the subscription. The subscription stays
    /// active and due forever, so a keeper retries it every cycle,
    /// indefinitely, burning gas on a subscriber who can never pay.
    function test_BUG_expiredSubscriptionNeverActuallyDeactivates() public {
        vm.prank(subscriber);
        bytes32 subId = pull.subscribe(planId, 100_000_000);

        uint256 subBal = usdc.balanceOf(subscriber);
        vm.prank(subscriber);
        usdc.transfer(address(0xdead), subBal);

        vm.warp(block.timestamp + 31 days);
        pull.triggerBilling(subId); // attempt 1
        pull.triggerBilling(subId); // attempt 2
        pull.triggerBilling(subId); // attempt 3 -> "expires"

        assertEq(pull.failedAttempts(subId), 0);
        assertEq(pull.graceExpiresAt(subId), 0);

        // but the registry still thinks it's alive and due
        assertTrue(registry.getSubscription(subId).active);
        assertTrue(registry.isBillingDue(subId));

        // so the cycle just repeats, forever
        pull.triggerBilling(subId);
        assertEq(pull.failedAttempts(subId), 1);
    }

    // ---------- fees & ownership ----------

    function test_calculateFee() public {
        (uint256 fee, uint256 net) = pull.calculateFee(10_000_000);
        assertEq(fee, 75_000);
        assertEq(net, 9_925_000);
    }

    function test_setProtocolFee_onlyOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(PullPayment.NotOwner.selector);
        pull.setProtocolFee(100);
    }

    function test_setProtocolFee_revertsAboveMax() public {
        vm.expectRevert(abi.encodeWithSelector(PullPayment.FeeTooHigh.selector, 201, 200));
        pull.setProtocolFee(201);
    }

    // ---------- the critical cross-contract exploit ----------

    /// @notice FIXED: the registry access-control gap that let a
    /// subscriber bypass PullPayment and skip all future billing for
    /// free is now closed. Calling advanceBilling() directly, outside of
    /// PullPayment, correctly reverts.
    function test_FIXED_subscriberCanNoLongerEscapeBillingViaRegistry() public {
        vm.prank(subscriber);
        bytes32 subId = pull.subscribe(planId, 100_000_000);

        vm.warp(block.timestamp + 31 days);

        vm.prank(subscriber);
        vm.expectRevert(SubscriptionRegistry.NotPullPayment.selector);
        registry.advanceBilling(subId);

        // billing is still correctly due, and still only payable through PullPayment
        assertTrue(registry.isBillingDue(subId));
        pull.triggerBilling(subId);
        assertEq(registry.getSubscription(subId).billingCount, 2);
    }
}
