// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SubscriptionRegistry {

    enum Interval { Monthly, Quarterly, Yearly, Custom }

    struct Plan {
        bytes32   id;
        address   merchant;
        uint256   price;
        Interval  interval;
        uint256   customInterval;
        uint256   trialDays;
        bool      active;
        uint256   createdAt;
    }

    struct Subscription {
        bytes32   planId;
        address   subscriber;
        uint256   startedAt;
        uint256   trialEndsAt;
        uint256   nextBillingAt;
        uint256   billingCount;
        bool      active;
        bool      paused;
    }

    mapping(bytes32 => Plan)         private _plans;
    mapping(bytes32 => Subscription) private _subscriptions;
    mapping(address => bytes32[])    private _merchantPlans;
    mapping(address => bytes32[])    private _subscriberSubs;

    uint256 public totalPlans;
    uint256 public totalSubscriptions;

    event PlanCreated(bytes32 indexed planId, address indexed merchant, uint256 price, Interval interval, uint256 trialDays);
    event PlanPaused(bytes32 indexed planId, address indexed merchant);
    event PlanResumed(bytes32 indexed planId, address indexed merchant);
    event SubscriptionCreated(bytes32 indexed subscriptionId, bytes32 indexed planId, address indexed subscriber, uint256 trialEndsAt, uint256 nextBillingAt);
    event SubscriptionCancelled(bytes32 indexed subscriptionId, address indexed subscriber);
    event SubscriptionPaused(bytes32 indexed subscriptionId, address indexed subscriber);
    event SubscriptionResumed(bytes32 indexed subscriptionId, address indexed subscriber, uint256 nextBillingAt);
    event SubscriptionUpgraded(bytes32 indexed oldSubscriptionId, bytes32 indexed newSubscriptionId, bytes32 indexed newPlanId);
    event BillingAdvanced(bytes32 indexed subscriptionId, uint256 nextBillingAt, uint256 billingCount);

    error PlanAlreadyExists(bytes32 planId);
    error PlanNotFound(bytes32 planId);
    error PlanNotActive(bytes32 planId);
    error NotPlanMerchant(bytes32 planId, address caller);
    error SubscriptionNotFound(bytes32 subscriptionId);
    error SubscriptionNotActive(bytes32 subscriptionId);
    error AlreadySubscribed(bytes32 planId, address subscriber);
    error NotSubscriber(bytes32 subscriptionId, address caller);
    error InvalidPrice();
    error InvalidCustomInterval();
    error ZeroPlanId();

    function createPlan(
        bytes32 planId,
        uint256 price,
        Interval interval,
        uint256 customInterval,
        uint256 trialDays
    ) external returns (bytes32) {
        if (planId == bytes32(0))          revert ZeroPlanId();
        if (price == 0)                    revert InvalidPrice();
        if (_plans[planId].createdAt != 0) revert PlanAlreadyExists(planId);
        if (interval == Interval.Custom && customInterval == 0) revert InvalidCustomInterval();

        _plans[planId] = Plan({
            id:             planId,
            merchant:       msg.sender,
            price:          price,
            interval:       interval,
            customInterval: customInterval,
            trialDays:      trialDays,
            active:         true,
            createdAt:      block.timestamp
        });

        _merchantPlans[msg.sender].push(planId);
        totalPlans++;
        emit PlanCreated(planId, msg.sender, price, interval, trialDays);
        return planId;
    }

    function pausePlan(bytes32 planId) external {
        Plan storage plan = _requireMerchant(planId);
        plan.active = false;
        emit PlanPaused(planId, msg.sender);
    }

    function resumePlan(bytes32 planId) external {
        Plan storage plan = _requireMerchant(planId);
        plan.active = true;
        emit PlanResumed(planId, msg.sender);
    }

    function createSubscription(bytes32 planId, address subscriber)
        external returns (bytes32 subscriptionId)
    {
        Plan storage plan = _plans[planId];
        if (plan.createdAt == 0) revert PlanNotFound(planId);
        if (!plan.active)        revert PlanNotActive(planId);

        subscriptionId = _subscriptionId(planId, subscriber);
        if (_subscriptions[subscriptionId].active) revert AlreadySubscribed(planId, subscriber);

        uint256 trialEndsAt   = plan.trialDays > 0 ? block.timestamp + (plan.trialDays * 1 days) : 0;
        uint256 nextBillingAt = trialEndsAt > 0 ? trialEndsAt : block.timestamp + _intervalSeconds(plan);

        _subscriptions[subscriptionId] = Subscription({
            planId:        planId,
            subscriber:    subscriber,
            startedAt:     block.timestamp,
            trialEndsAt:   trialEndsAt,
            nextBillingAt: nextBillingAt,
            billingCount:  0,
            active:        true,
            paused:        false
        });

        _subscriberSubs[subscriber].push(subscriptionId);
        totalSubscriptions++;
        emit SubscriptionCreated(subscriptionId, planId, subscriber, trialEndsAt, nextBillingAt);
    }

    function cancelSubscription(bytes32 subscriptionId) external {
        Subscription storage sub = _requireSubscriber(subscriptionId);
        sub.active = false;
        emit SubscriptionCancelled(subscriptionId, msg.sender);
    }

    function pauseSubscription(bytes32 subscriptionId) external {
        Subscription storage sub = _requireSubscriber(subscriptionId);
        if (!sub.active) revert SubscriptionNotActive(subscriptionId);
        sub.paused = true;
        emit SubscriptionPaused(subscriptionId, msg.sender);
    }

    function resumeSubscription(bytes32 subscriptionId) external {
        Subscription storage sub = _requireSubscriber(subscriptionId);
        if (!sub.active) revert SubscriptionNotActive(subscriptionId);
        Plan storage plan     = _plans[sub.planId];
        sub.paused            = false;
        sub.nextBillingAt     = block.timestamp + _intervalSeconds(plan);
        emit SubscriptionResumed(subscriptionId, msg.sender, sub.nextBillingAt);
    }

    function upgradeSubscription(bytes32 oldSubscriptionId, bytes32 newPlanId)
        external returns (bytes32 newSubscriptionId)
    {
        Subscription storage oldSub = _requireSubscriber(oldSubscriptionId);
        if (!oldSub.active) revert SubscriptionNotActive(oldSubscriptionId);

        oldSub.active = false;
        emit SubscriptionCancelled(oldSubscriptionId, msg.sender);

        Plan storage newPlan = _plans[newPlanId];
        if (newPlan.createdAt == 0) revert PlanNotFound(newPlanId);
        if (!newPlan.active)        revert PlanNotActive(newPlanId);

        newSubscriptionId = _subscriptionId(newPlanId, msg.sender);
        _subscriptions[newSubscriptionId] = Subscription({
            planId:        newPlanId,
            subscriber:    msg.sender,
            startedAt:     block.timestamp,
            trialEndsAt:   0,
            nextBillingAt: block.timestamp + _intervalSeconds(newPlan),
            billingCount:  0,
            active:        true,
            paused:        false
        });

        _subscriberSubs[msg.sender].push(newSubscriptionId);
        totalSubscriptions++;
        emit SubscriptionUpgraded(oldSubscriptionId, newSubscriptionId, newPlanId);
    }

    function advanceBilling(bytes32 subscriptionId) external {
        Subscription storage sub = _subscriptions[subscriptionId];
        if (!sub.active) revert SubscriptionNotActive(subscriptionId);
        Plan storage plan     = _plans[sub.planId];
        sub.nextBillingAt     = block.timestamp + _intervalSeconds(plan);
        sub.billingCount++;
        emit BillingAdvanced(subscriptionId, sub.nextBillingAt, sub.billingCount);
    }

    function getPlan(bytes32 planId) external view returns (Plan memory) {
        if (_plans[planId].createdAt == 0) revert PlanNotFound(planId);
        return _plans[planId];
    }

    function getSubscription(bytes32 subscriptionId) external view returns (Subscription memory) {
        Subscription memory sub = _subscriptions[subscriptionId];
        if (sub.subscriber == address(0)) revert SubscriptionNotFound(subscriptionId);
        return sub;
    }

    function getMerchantPlans(address merchant) external view returns (bytes32[] memory) {
        return _merchantPlans[merchant];
    }

    function getSubscriberSubs(address subscriber) external view returns (bytes32[] memory) {
        return _subscriberSubs[subscriber];
    }

    function isBillingDue(bytes32 subscriptionId) external view returns (bool) {
        Subscription memory sub = _subscriptions[subscriptionId];
        return sub.active && !sub.paused && block.timestamp >= sub.nextBillingAt;
    }

    function subscriptionId(bytes32 planId, address subscriber) external pure returns (bytes32) {
        return _subscriptionId(planId, subscriber);
    }

    function _subscriptionId(bytes32 planId, address subscriber) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(planId, subscriber));
    }

    function _intervalSeconds(Plan storage plan) internal view returns (uint256) {
        if (plan.interval == Interval.Monthly)   return 30 days;
        if (plan.interval == Interval.Quarterly) return 90 days;
        if (plan.interval == Interval.Yearly)    return 365 days;
        return plan.customInterval;
    }

    function _requireMerchant(bytes32 planId) internal view returns (Plan storage plan) {
        plan = _plans[planId];
        if (plan.createdAt == 0)         revert PlanNotFound(planId);
        if (plan.merchant != msg.sender) revert NotPlanMerchant(planId, msg.sender);
    }

    function _requireSubscriber(bytes32 subscriptionId_) internal view returns (Subscription storage sub) {
        sub = _subscriptions[subscriptionId_];
        if (sub.subscriber == address(0)) revert SubscriptionNotFound(subscriptionId_);
        if (sub.subscriber != msg.sender) revert NotSubscriber(subscriptionId_, msg.sender);
    }
}