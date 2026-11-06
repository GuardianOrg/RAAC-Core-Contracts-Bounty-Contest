// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../../interfaces/core/minters/RAACMinter/IRAACMinterRewardsReceiver.sol";

import "hardhat/console.sol";

/**
 * @title MockRAACMinterRewardsReceiver
 * @dev Simple mock contract for testing RAACMinter reward distribution
 * Tracks deposits and provides easy access to deposited amounts for test assertions
 */
contract MockRAACMinterRewardsReceiver is IRAACMinterRewardsReceiver {
    
    // Mapping to track total deposits by token address
    mapping(address => uint256) public totalDeposits;

    // Errors
    error NoDeposits();
    error IndexOutOfBounds();
    
    // Array to track all deposit events for testing
    struct DepositEvent {
        address token;
        uint256 amount;
        uint256 timestamp;
    }
    
    DepositEvent[] public deposits;
    
    // Events for testing
    event DepositReceived(address indexed token, uint256 amount, uint256 timestamp);
    event RewardNotified(address indexed token, uint256 amount, uint256 timestamp);
    
    /**
     * @dev Implements the deposit function from IRAACMinterRewardsReceiver
     * @param token The token address being deposited
     * @param amount The amount being deposited
     */
    function deposit(address token, uint256 amount) external override {
        // Transfer tokens to this contract and track the deposit
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        
        totalDeposits[token] += amount;
        deposits.push(DepositEvent({
            token: token,
            amount: amount,
            timestamp: block.timestamp
        }));
        
        emit DepositReceived(token, amount, block.timestamp);
    }
    
    /**
     * @dev Implements the notifyRewardAmount function from IRAACMinterRewardsReceiver
     * @param token The token address for the reward
     * @param amount The reward amount being notified
     */
    function notifyRewardAmount(address token, uint256 amount) external override {
        emit RewardNotified(token, amount, block.timestamp);
    }
    
    /**
     * @dev Get the total number of deposits received
     */
    function getDepositCount() external view returns (uint256) {
        return deposits.length;
    }
    
    /**
     * @dev Get deposit details by index
     */
    function getDeposit(uint256 index) external view returns (address token, uint256 amount, uint256 timestamp) {
        require(index < deposits.length, IndexOutOfBounds());
        DepositEvent memory dep = deposits[index];
        return (dep.token, dep.amount, dep.timestamp);
    }
    
    /**
     * @dev Get the last deposit details
     */
    function getLastDeposit() external view returns (address token, uint256 amount, uint256 timestamp) {
        require(deposits.length > 0, NoDeposits());
        DepositEvent memory dep = deposits[deposits.length - 1];
        return (dep.token, dep.amount, dep.timestamp);
    }
}
