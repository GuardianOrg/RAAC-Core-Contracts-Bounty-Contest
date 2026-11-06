# ERC721AssetAdapter

The ERC721AssetAdapter is a core contract that enables the RAAC Protocol to accept ERC721 tokens (NFTs) as collateral in the lending pool system. It provides price oracle integration for NFT valuation and manages NFT deposits and withdrawals.

## Overview

The adapter acts as a bridge between ERC721 tokens and the RAAC Protocol's lending system. It handles NFT deposits, withdrawals, and transfers while maintaining ownership records and integrating with price oracles for collateral valuation.

## Key Features

- NFT deposit and withdrawal functionality
- Token ownership tracking and validation
- Price oracle integration for NFT valuation
- Enumerable token tracking per user
- Restricted access control for lending pool operations

## Technical Requirements

### Token Requirements
- Must implement standard ERC721 interface
- Must support transferFrom operations
- Must implement ownerOf function
- No special NFT behaviors supported (e.g., soulbound tokens)

### Oracle Requirements
- Must be an NFT/crvUSD price feed
- Must return values in 18 decimals
- Must accept tokenId as parameter for price lookup
- Must be a valid contract implementing the IPriceOracle interface

### Access Control
- Only the registered LendingPool contract can call:
  - deposit()
  - withdraw()
  - transferAsset()
- Owner can update the price oracle address

## State Management

The adapter maintains several key data structures:

1. **Deposit Tracking**
   ```solidity
   mapping(address => mapping(uint256 => bool)) private _deposits
   ```
   - Tracks which tokenIds each user has deposited

2. **Token Enumeration**
   ```solidity
   mapping(address => uint256[]) private _depositedTokens
   ```
   - Maintains list of deposited tokenIds per user

3. **Index Management**
   ```solidity
   mapping(address => mapping(uint256 => uint256)) private _depositedTokensIndex
   ```
   - Maps tokenId to its index in user's depositedTokens array

4. **Ownership Records**
   ```solidity
   mapping(uint256 => address) private _tokenOwner
   ```
   - Tracks the depositor of each tokenId

## Deployment Model

Each supported NFT collection requires its own adapter instance. This separation ensures:
- Clean isolation between different NFT collections
- Independent price oracle integration
- Simplified upgrade paths
- Clear accounting per collection

## Governance

The adapter is governed by the protocol's governance system:
- Collection approval is handled by protocol governance or multisig + timelock
- Price oracle updates require owner privileges
- New adapter instances require governance approval

## Privacy Model

The adapter maintains a transparent system:
- User deposits are publicly readable
- All transactions are visible on-chain
- No privacy requirements or obfuscation

## Validation

Unlike ERC20 adapters, the ERC721AssetAdapter:
- Requires ownership validation for deposits
- Validates token ownership before transfers
- Does not support partial withdrawals
- Validates liquidation data for full position liquidation

## Contract Interface

### Key Functions

#### deposit
```solidity
function deposit(address user, bytes calldata data) external
```
- Called by LendingPool to deposit NFT
- Validates token ownership
- Transfers NFT from user to adapter
- Updates ownership records

#### withdraw
```solidity
function withdraw(address user, bytes calldata data) external
```
- Called by LendingPool to withdraw NFT
- Validates ownership and deposit status
- Transfers NFT back to user
- Updates ownership records

#### getAssetValue
```solidity
function getAssetValue(address user, bytes calldata data) external view returns (uint256)
```
- Returns the value of specific NFT in crvUSD
- Uses price oracle for valuation

#### getTotalAssetValue
```solidity
function getTotalAssetValue(address user) external view returns(uint256)
```
- Returns total value of all user's deposited NFTs
- Sums individual NFT prices from oracle

## Events

### NFTDeposited
```solidity
event NFTDeposited(address indexed token, address indexed user, uint256 indexed tokenId)
```
Emitted when a user deposits an NFT into the adapter.

### NFTWithdrawn
```solidity
event NFTWithdrawn(address indexed token, address indexed user, uint256 indexed tokenId)
```
Emitted when a user withdraws an NFT from the adapter.

## Security Considerations

1. **Access Control**
   - Only LendingPool can call critical functions
   - Owner can only update price oracle

2. **NFT Safety**
   - Validates ownership before transfers
   - Checks deposit status before withdrawals
   - Prevents double-deposits

3. **Price Oracle**
   - Oracle address cannot be zero
   - Oracle updates require owner privileges
   - Price feed must be NFT/crvUSD pair

4. **State Management**
   - Maintains consistent ownership records
   - Updates indices correctly during transfers
   - Prevents state corruption

5. **Reentrancy Prevention**
   - Implements checks-effects-interactions pattern
   - Transfers NFT before updating state
   - Prevents reentrancy attacks during deposits
   - Ensures atomic operations

## Security Patterns

### Checks-Effects-Interactions Pattern
The adapter implements the checks-effects-interactions pattern to prevent reentrancy attacks:

1. **Checks**
   - Validates token ownership
   - Verifies deposit status
   - Ensures oracle address is valid

2. **Effects**
   - Updates state variables
   - Records ownership changes
   - Updates token indices

3. **Interactions**
   - Performs external calls
   - Transfers NFTs
   - Queries oracle prices


This pattern ensures that:
1. All validations are performed first
2. External calls (NFT transfer) happen before state changes
3. State updates are performed last
4. No reentrancy is possible during the deposit process

## Integration Guide

To integrate a new NFT collection as collateral:

1. Deploy a new ERC721AssetAdapter instance
2. Configure the price oracle for the collection
3. Register the adapter with the LendingPool
4. Get governance approval for the new collateral
5. Update protocol parameters if needed

## Gas Optimization

The adapter implements several gas optimization techniques:
1. Efficient array management for token enumeration
2. Index-based token removal
3. Minimal state updates
4. Optimized storage layout