# NFTRoyaltyFeeCollector

## Overview
The `NFTRoyaltyFeeCollector` contract is a specialized contract designed to handle royalty fees from NFT marketplace sales. It acts as an intermediary between NFT marketplaces (like OpenSea, X2Y2, etc.) and the main fee collector system. This contract ensures that all NFT royalty fees are properly collected and distributed to the centralized fee collector.

## Purpose
- Collects royalty fees from NFT marketplace sales
- Converts native ETH payments to WETH for consistent fee handling
- Distributes collected fees to the main fee collector with proper categorization
- Provides emergency withdrawal functionality for contract owners

## Key Features

### Fee Collection
- Handles both native ETH and ERC20 token payments
- Automatically converts ETH to WETH for consistent fee processing
- Integrates with the main fee collector system using the `ROYALTY_FEE` category

### Security Features
- Implements reentrancy protection
- Includes emergency withdrawal functionality for contract owners
- Uses OpenZeppelin's SafeERC20 for secure token transfers
- Token whitelisting through the fee collector system

## Contract Functions

### `distributeCollectedFees(address _token)`
- External function to distribute collected fees to the fee collector
- Converts ETH to WETH if the payment was in native ETH
- Approves and transfers the collected fees to the fee collector
- Emits `FeeCollected` event upon successful distribution
- **Important**: Only whitelisted tokens can be successfully collected by the fee collector

### `emergencyWithdraw(address _token, address recipient)`
- Owner-only function for emergency situations
- Allows withdrawal of any token (ETH or ERC20) from the contract
- Emits `EmergencyWithdrawal` event upon successful withdrawal

## Events

### `FeeCollected`
```solidity
event FeeCollected(address indexed token, uint256 amount)
```
Emitted when fees are successfully collected and distributed to the fee collector.

### `EmergencyWithdrawal`
```solidity
event EmergencyWithdrawal(address indexed token, address indexed to, uint256 amount)
```
Emitted when an emergency withdrawal is executed.

## Integration
This contract is specifically designed to work with:
- NFT marketplaces that implement royalty payments
- The main fee collector system
- WETH for ETH wrapping functionality

## Security Considerations
- Only the contract owner can perform emergency withdrawals
- All external calls are protected against reentrancy attacks
- Token transfers use OpenZeppelin's SafeERC20 library
- Input validation for critical parameters
- **Token Whitelisting**: While the contract allows distribution of any token, the fee collector maintains a whitelist of accepted tokens. Any attempt to distribute non-whitelisted tokens will result in the fees being effectively lost, as the fee collector will reject them. This serves as a security measure to ensure only approved tokens are processed.

## Usage Example
```solidity
// Deploy the contract
NFTRoyaltyFeeCollector collector = new NFTRoyaltyFeeCollector(WETH_ADDRESS, FEE_COLLECTOR_ADDRESS);

// Distribute collected fees (can be called by anyone)
// Note: Only whitelisted tokens will be successfully collected by the fee collector
collector.distributeCollectedFees(WETH_ADDRESS);

// Emergency withdrawal (owner only)
collector.emergencyWithdraw(WETH_ADDRESS, RECIPIENT_ADDRESS);
```
