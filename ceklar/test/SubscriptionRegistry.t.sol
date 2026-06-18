// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SubscriptionRegistry.sol";

contract SubscriptionRegistryTest is Test {
    SubscriptionRegistry registry;

    address merchant = address(0xBEEF);
    address subscriber = address(0xCAFE);
    address attacker = address(0xBAD);
    address pullPaymentAddr = address(0x9999);

    bytes32 planId = keccak256("plan-1");

    function setUp() public {
        registry = new SubscriptionRegistry();
        registry.setPullPayment(pullPaymentAddr);
    }

    function _createBasicPlan() internal {
        vm.prank(merchant);
        registry.createPlan(planId, 5_000_000, SubscriptionRegistry.Interval.Monthly, 0, 0);
    }

    function _createSub(bytes32 _planId, address _subscriber) internal {
        vm.prank(pullPaymentAddr);
        registry.createSubscription(_planId, _subscriber);
    }

    function _advanceBilling(bytes32 subId) internal {
        vm.prank(pullPaymentAddr);
        registry.advanceBilling(subId);
    }

    // ---------- setPullPayment ----------

    function test_setPullPayment_onlyOwner() public {
        SubscriptionRegistry fresh = new SubscriptionRegistry();
        vm.prank(attacker);
        vm.expectRevert(SubscriptionRegistry.NotOwner.selector);
        fresh.setPullPayment(pullPaymentAddr);
    }

    function test_setPullPayment_onlyOnce() public {
        vm.expectRevert(SubscriptionRegistry.PullPaymentAlreadySet.selector);
        registry.setPullPayment(address(0xdead));
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
        _createSub(planId, subscriber);

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

        vm.prank(pullPaymentAddr);
        vm.expectRevert(abi.encodeWithSelector(SubscriptionRegistry.PlanNotActive.selector, planId));
        registry.createSubscription(planId, subscriber);
    }

    function test_createSubscription_revertsOnDuplicate() public {
        _createBasicPlan();
        _createSub(planId, subscriber);

        vm.prank(pullPaymentAddr);
        vm.expectRevert(abi.encodeWithSelector(SubscriptionRegistry.AlreadySubscribed.selector, planId, subscriber));
        registry.createSubscription(planId, subscriber);
    }

    /// @notice FIXED: createSubscription now reverts for any caller other
    /// than the registered PullPayment contract. An attacker can no longer
    /// create a subscription record for an arbitrary victim address.
    function test_FIXED_onlyPullPaymentCanCreateSubscription() public {
        _createBasicPlan();
        address victim = makeAddr("victim");

        vm.prank(attacker);
        vm.expectRevert(SubscriptionRegistry.NotPullPayment.selector);
        registry.createSubscription(planId, victim);

        // confirm the legitimate path still works
        _createSub(planId, victim);
        bytes32 subId = registry.subscriptionId(planId, victim);
        assertTrue(registry.getSubscription(subId).active);
    }

    // ---------- cancel subscription ----------

    function test_cancelSubscription_onlySubscriber() public {
        _createBasicPlan();
        _createSub(planId, subscriber);
        bytes32 subId = registry.subscriptionId(planId, subscriber);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SubscriptionRegistry.NotSubscriber.selector, subId, attacker));
        registry.cancelSubscription(subId);

        vm.prank(subscriber);
        registry.cancelSubscription(subId);
        assertFalse(registry.getSubscription(subId).active);
    }

    // ---------- advanceBilling ----------

    /// @notice FIXED: advanceBilling now reverts for any caller other than
    /// the registered PullPayment contract. A subscriber can no longer
    /// advance their own billing date without an actual payment.
    function test_FIXED_onlyPullPaymentCanAdvanceBilling() public {
        _createBasicPlan();
        _createSub(planId, subscriber);
        bytes32 subId = registry.subscriptionId(planId, subscriber);

        vm.warp(block.timestamp + 30 days);

        vm.prank(subscriber);
        vm.expectRevert(SubscriptionRegistry.NotPullPayment.selector);
        registry.advanceBilling(subId);

        // confirm the legitimate path still works
        _advanceBilling(subId);
        assertEq(registry.getSubscription(subId).billingCount, 1);
    }

    function test_advanceBilling_legitimateFlowAcrossMultipleCycles() public {
        _createBasicPlan();
        _createSub(planId, subscriber);
        bytes32 subId = registry.subscriptionId(planId, subscriber);

        for (uint256 i = 0; i < 6; i++) {
            vm.warp(block.timestamp + 30 days);
            assertTrue(registry.isBillingDue(subId));
            _advanceBilling(subId);
            assertFalse(registry.isBillingDue(subId));
        }

        assertEq(registry.getSubscription(subId).billingCount, 6);
    }

    // ---------- upgradeSubscription ----------

    function test_upgradeSubscription_success() public {
        _createBasicPlan();
        _createSub(planId, subscriber);
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
        _createSub(planId, subscriber);
        bytes32 subId = registry.subscriptionId(planId, subscriber);
        assertFalse(registry.isBillingDue(subId));
    }

    function test_isBillingDue_trueAfterInterval() public {
        _createBasicPlan();
        _createSub(planId, subscriber);
        bytes32 subId = registry.subscriptionId(planId, subscriber);
        vm.warp(block.timestamp + 31 days);
        assertTrue(registry.isBillingDue(subId));
    }
}
