# ERC20AssetAdapter

The ERC20AssetAdapter is a core contract that enables the RAAC Protocol to accept ERC20 tokens as collateral in the lending pool system. It normalizes token units to 18 decimals (crvUSD standard) and provides price oracle integration for collateral valuation.

## Overview

The adapter acts as a bridge between standard ERC20 tokens and the RAAC Protocol's lending system. It handles token deposits, withdrawals, and transfers while maintaining user balances and integrating with price oracles for collateral valuation.

## Key Features

- Token deposit and withdrawal functionality
- Balance tracking for users
- Price oracle integration for collateral valuation
- Normalization of token decimals to 18 decimals
- Restricted access control for lending pool operations

## Technical Requirements

### Token Requirements
- Only supports ERC20 tokens with decimals <= 18
- Must be standard ERC20 tokens (no fee-on-transfer mechanisms)
- No rebasing tokens supported
- Must implement standard ERC20 interface

### Oracle Requirements
- Must be an ASSET/crvUSD price feed
- Must return values in 18 decimals
- Must be a valid contract implementing the IPriceOracle interface

### Access Control
- Only the registered LendingPool contract can call:
  - deposit()
  - withdraw()
  - transferAsset()
- Owner can update the price oracle address

## Deployment Model

Each supported collateral asset requires its own adapter instance. This separation ensures:
- Clean isolation between different collateral types
- Independent price oracle integration
- Simplified upgrade paths
- Clear accounting per asset

## Governance

The adapter is governed by the protocol's governance system:
- Asset approval is handled by protocol governance or multisig + timelock
- Price oracle updates require owner privileges
- New adapter instances require governance approval

## Privacy Model

The adapter maintains a transparent system:
- User balances are publicly readable
- All transactions are visible on-chain
- No privacy requirements or obfuscation

## Validation

Unlike ERC721 adapters, the ERC20AssetAdapter:
- Does not require ownership validation
- Validates only balance sufficiency
- Supports partial withdrawals
- Validates liquidation data for full position liquidation

## Special Cases

For tokens with special behaviors:
- Fee-on-transfer tokens require custom adapter implementations
- Rebasing tokens require custom adapter implementations
- Non-standard ERC20 tokens require custom adapter implementations

## Contract Interface

### Key Functions

#### deposit
```solidity
function deposit(address user, bytes calldata data) external
```
- Called by LendingPool to deposit tokens
- Updates user balance
- Transfers tokens from user to adapter

#### withdraw
```solidity
function withdraw(address user, bytes calldata data) external
```
- Called by LendingPool to withdraw tokens
- Validates user balance
- Transfers tokens to user

#### getAssetValue
```solidity
function getAssetValue(address user, bytes calldata) external view returns (uint256)
```
- Returns the value of user's collateral in crvUSD
- Normalizes token decimals to 18
- Uses price oracle for valuation

#### getWithdrawValue
```solidity
function getWithdrawValue(address user, bytes calldata data) external view returns (uint256)
```
- Returns the value of a specific withdrawal amount
- Used for partial withdrawal calculations

## Events

### TokenDeposited
```solidity
event TokenDeposited(address indexed token, address indexed user, uint256 amount)
```
Emitted when a user deposits tokens into the adapter.

### TokenWithdrawn
```solidity
event TokenWithdrawn(address indexed token, address indexed user, uint256 amount)
```
Emitted when a user withdraws tokens from the adapter.

## Security Considerations

1. **Access Control**
   - Only LendingPool can call critical functions
   - Owner can only update price oracle

2. **Token Safety**
   - Uses SafeERC20 for token transfers
   - Validates amounts and balances
   - No support for fee-on-transfer tokens

3. **Price Oracle**
   - Oracle address cannot be zero
   - Oracle updates require owner privileges
   - Price feed must be ASSET/crvUSD pair

4. **Balance Management**
   - Checks for sufficient balances
   - Updates balances before external calls
   - Prevents underflow/overflow

## Integration Guide

To integrate a new ERC20 token as collateral:

1. Deploy a new ERC20AssetAdapter instance
2. Configure the price oracle for the token
3. Register the adapter with the LendingPool
4. Get governance approval for the new collateral
5. Update protocol parameters if needed