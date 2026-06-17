// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SubscriptionRegistry.sol";
import "./RevenueVault.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

contract PullPayment {

    uint256 public constant BPS_DENOMINATOR  = 10_000;
    uint256 public constant MAX_PROTOCOL_FEE = 200;
    uint256 public constant DEFAULT_FEE_BPS  = 75;
    uint256 public constant GRACE_PERIOD     = 3 days;
    uint256 public constant MAX_RETRY_COUNT  = 3;

    address public immutable usdc;
    address public immutable registry;
    address public immutable vault;

    address public owner;
    address public feeRecipient;
    uint256 public protocolFeeBps;

    mapping(bytes32 => uint256) public graceExpiresAt;
    mapping(bytes32 => uint256) public failedAttempts;

    event Subscribed(bytes32 indexed subscriptionId, bytes32 indexed planId, address indexed subscriber, uint256 allowanceGranted);
    event BillingExecuted(bytes32 indexed subscriptionId, address indexed subscriber, uint256 grossAmount, uint256 protocolFee, uint256 merchantAmount, uint256 nextBillingAt);
    event BillingFailed(bytes32 indexed subscriptionId, address indexed subscriber, uint256 attempt, uint256 graceExpiresAt);
    event SubscriptionExpired(bytes32 indexed subscriptionId, address indexed subscriber);
    event ProtocolFeeUpdated(uint256 oldBps, uint256 newBps);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);

    error NotOwner();
    error ZeroAddress();
    error FeeTooHigh(uint256 requested, uint256 max);
    error BillingNotDue(bytes32 subscriptionId, uint256 nextBillingAt);
    error InsufficientAllowance(address subscriber, uint256 required, uint256 actual);
    error TransferFailed();

    constructor(
        address _usdc,
        address _registry,
        address _vault,
        address _feeRecipient
    ) {
        if (_usdc == address(0) || _registry == address(0) ||
            _vault == address(0) || _feeRecipient == address(0)) revert ZeroAddress();

        usdc           = _usdc;
        registry       = _registry;
        vault          = _vault;
        feeRecipient   = _feeRecipient;
        protocolFeeBps = DEFAULT_FEE_BPS;
        owner          = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function subscribe(
        bytes32 planId,
        uint256 allowanceAmount
    ) external returns (bytes32 subscriptionId) {
        SubscriptionRegistry reg  = SubscriptionRegistry(registry);
        SubscriptionRegistry.Plan memory plan = reg.getPlan(planId);

        uint256 allowance = IERC20(usdc).allowance(msg.sender, address(this));
        if (allowance < plan.price) {
            revert InsufficientAllowance(msg.sender, plan.price, allowance);
        }

        subscriptionId = reg.subscriptionId(planId, msg.sender);
        reg.createSubscription(planId, msg.sender);

        if (plan.trialDays == 0) {
            _executeBilling(subscriptionId, msg.sender, plan.price, plan.merchant);
        }

        emit Subscribed(subscriptionId, planId, msg.sender, allowanceAmount);
    }

    function triggerBilling(bytes32 subscriptionId) external {
        SubscriptionRegistry reg  = SubscriptionRegistry(registry);
        SubscriptionRegistry.Subscription memory sub = reg.getSubscription(subscriptionId);
        SubscriptionRegistry.Plan memory plan         = reg.getPlan(sub.planId);

        uint256 grace = graceExpiresAt[subscriptionId];
        if (grace != 0 && block.timestamp > grace) {
            _expireSubscription(subscriptionId, sub.subscriber);
            return;
        }

        if (!reg.isBillingDue(subscriptionId) && grace == 0) {
            revert BillingNotDue(subscriptionId, sub.nextBillingAt);
        }

        bool success = _tryPull(sub.subscriber, plan.price);

        if (success) {
            graceExpiresAt[subscriptionId] = 0;
            failedAttempts[subscriptionId] = 0;
            _routePayment(subscriptionId, sub.subscriber, plan.price, plan.merchant);
            reg.advanceBilling(subscriptionId);
        } else {
            uint256 attempts = ++failedAttempts[subscriptionId];
            if (attempts >= MAX_RETRY_COUNT) {
                _expireSubscription(subscriptionId, sub.subscriber);
                return;
            }
            if (grace == 0) {
                graceExpiresAt[subscriptionId] = block.timestamp + GRACE_PERIOD;
            }
            emit BillingFailed(
                subscriptionId,
                sub.subscriber,
                attempts,
                graceExpiresAt[subscriptionId]
            );
        }
    }

    function computeProration(bytes32 subscriptionId)
        external view returns (uint256 creditAmount)
    {
        SubscriptionRegistry reg  = SubscriptionRegistry(registry);
        SubscriptionRegistry.Subscription memory sub = reg.getSubscription(subscriptionId);
        SubscriptionRegistry.Plan memory plan         = reg.getPlan(sub.planId);
        if (!sub.active || block.timestamp >= sub.nextBillingAt) return 0;
        uint256 remaining = sub.nextBillingAt - block.timestamp;
        uint256 interval  = _planInterval(plan);
        creditAmount      = (remaining * plan.price) / interval;
    }

    function setProtocolFee(uint256 newBps) external onlyOwner {
        if (newBps > MAX_PROTOCOL_FEE) revert FeeTooHigh(newBps, MAX_PROTOCOL_FEE);
        emit ProtocolFeeUpdated(protocolFeeBps, newBps);
        protocolFeeBps = newBps;
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    function calculateFee(uint256 amount)
        public view returns (uint256 fee, uint256 net)
    {
        fee = (amount * protocolFeeBps) / BPS_DENOMINATOR;
        net = amount - fee;
    }

    function isHealthy(bytes32 subscriptionId) external view returns (bool) {
        return graceExpiresAt[subscriptionId] == 0 &&
               failedAttempts[subscriptionId] == 0;
    }

    function _executeBilling(
        bytes32 subscriptionId,
        address subscriber,
        uint256 amount,
        address merchant
    ) internal {
        bool ok = _tryPull(subscriber, amount);
        if (!ok) revert TransferFailed();
        _routePayment(subscriptionId, subscriber, amount, merchant);
        SubscriptionRegistry(registry).advanceBilling(subscriptionId);
    }

    function _routePayment(
        bytes32 subscriptionId,
        address subscriber,
        uint256 grossAmount,
        address merchant
    ) internal {
        (uint256 fee, uint256 net) = calculateFee(grossAmount);

        if (fee > 0) {
            bool ok = IERC20(usdc).transfer(feeRecipient, fee);
            if (!ok) revert TransferFailed();
        }

        bool ok2 = IERC20(usdc).transfer(vault, net);
        if (!ok2) revert TransferFailed();
        RevenueVault(vault).credit(merchant, net);

        emit BillingExecuted(
            subscriptionId, subscriber,
            grossAmount, fee, net,
            block.timestamp
        );
    }

    function _tryPull(address subscriber, uint256 amount) internal returns (bool) {
        uint256 bal  = IERC20(usdc).balanceOf(subscriber);
        uint256 all  = IERC20(usdc).allowance(subscriber, address(this));
        if (bal < amount || all < amount) return false;
        try IERC20(usdc).transferFrom(subscriber, address(this), amount)
            returns (bool ok) { return ok; }
        catch { return false; }
    }

    function _expireSubscription(bytes32 subscriptionId, address subscriber) internal {
        delete graceExpiresAt[subscriptionId];
        delete failedAttempts[subscriptionId];
        emit SubscriptionExpired(subscriptionId, subscriber);
    }

    function _planInterval(SubscriptionRegistry.Plan memory plan)
        internal pure returns (uint256)
    {
        if (plan.interval == SubscriptionRegistry.Interval.Monthly)   return 30 days;
        if (plan.interval == SubscriptionRegistry.Interval.Quarterly) return 90 days;
        if (plan.interval == SubscriptionRegistry.Interval.Yearly)    return 365 days;
        return plan.customInterval;
    }
}