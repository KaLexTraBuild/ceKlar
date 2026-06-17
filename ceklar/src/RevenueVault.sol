// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Vault {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract RevenueVault {

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_SPLIT_BPS   = 9_000;

    struct Split {
        address recipient;
        uint256 bps;
    }

    address public immutable usdc;
    address public owner;
    address public pullPayment;

    mapping(address => uint256) public balances;
    mapping(address => Split)   public splits;

    uint256 public totalCredited;
    uint256 public totalWithdrawn;

    event Credited(address indexed merchant, uint256 amount, uint256 splitAmount, address indexed splitRecipient);
    event Withdrawn(address indexed merchant, address indexed to, uint256 amount);
    event SplitConfigured(address indexed merchant, address indexed recipient, uint256 bps);
    event SplitRemoved(address indexed merchant);
    event PullPaymentSet(address indexed pullPayment);

    error NotOwner();
    error NotPullPayment();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance(address merchant, uint256 requested, uint256 available);
    error SplitTooHigh(uint256 requested, uint256 max);
    error SplitToSelf();
    error TransferFailed();
    error PullPaymentAlreadySet();

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc  = _usdc;
        owner = msg.sender;
    }

    function setPullPayment(address _pullPayment) external {
        if (msg.sender != owner)        revert NotOwner();
        if (pullPayment != address(0))  revert PullPaymentAlreadySet();
        if (_pullPayment == address(0)) revert ZeroAddress();
        pullPayment = _pullPayment;
        emit PullPaymentSet(_pullPayment);
    }

    function credit(address merchant, uint256 amount) external {
        if (msg.sender != pullPayment) revert NotPullPayment();
        if (merchant == address(0))    revert ZeroAddress();
        if (amount == 0)               revert ZeroAmount();

        Split memory s      = splits[merchant];
        uint256 splitAmount = 0;
        address splitRecip  = address(0);

        if (s.recipient != address(0) && s.bps > 0) {
            splitAmount           = (amount * s.bps) / BPS_DENOMINATOR;
            splitRecip            = s.recipient;
            balances[s.recipient] += splitAmount;
        }

        balances[merchant] += amount - splitAmount;
        totalCredited      += amount;

        emit Credited(merchant, amount - splitAmount, splitAmount, splitRecip);
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert ZeroAmount();
        _withdraw(msg.sender, msg.sender, amount);
    }

    function withdrawTo(address to, uint256 amount) external {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0)      revert ZeroAmount();
        uint256 bal = balances[msg.sender];
        if (bal < amount) revert InsufficientBalance(msg.sender, amount, bal);
        _withdraw(msg.sender, to, amount);
    }

    function setSplit(address recipient, uint256 bps) external {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == msg.sender) revert SplitToSelf();
        if (bps > MAX_SPLIT_BPS)     revert SplitTooHigh(bps, MAX_SPLIT_BPS);
        splits[msg.sender] = Split({ recipient: recipient, bps: bps });
        emit SplitConfigured(msg.sender, recipient, bps);
    }

    function removeSplit() external {
        delete splits[msg.sender];
        emit SplitRemoved(msg.sender);
    }

    function getBalance(address merchant) external view returns (uint256) {
        return balances[merchant];
    }

    function getSplit(address merchant) external view returns (Split memory) {
        return splits[merchant];
    }

    function vaultUSDCBalance() external view returns (uint256) {
        return IERC20Vault(usdc).balanceOf(address(this));
    }

    function _withdraw(address from, address to, uint256 amount) internal {
        balances[from] -= amount;
        totalWithdrawn += amount;
        bool ok = IERC20Vault(usdc).transfer(to, amount);
        if (!ok) revert TransferFailed();
        emit Withdrawn(from, to, amount);
    }
}