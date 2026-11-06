# FeeCollector

## Overview

The FeeCollector is a smart contract designed to manage protocol fee collection. It provides functionality for securely managing and transferring collected fees to various stakeholders including veRAAC holders, treasury, and repair fund.

## Purpose

- Collect and manage various types of protocol fees in RAAC tokens
- Implement time-weighted reward distribution to veRAAC holders (claimable by address)
- Serve as the central fee collection point for all protocol contracts
- Provide flexible fee distribution based on configurable fee types
- Handle fee-on-transfer tokens safely through balance checks

## Access Control

The contract implements OpenZeppelin's AccessControl with three distinct roles:

| Role | Description |
|------|-------------|
| FEE_MANAGER_ROLE | Controls fee parameters and distribution rules |
| EMERGENCY_ROLE | Can pause contract and execute emergency functions |
| DISTRIBUTOR_ROLE | Authorized to trigger fee distributions |

## Security Considerations

### Whitelisting
- Only whitelisted target contracts can call the fee collector
- Supported contracts include: LendingPool, RAACToken, RAACNFT, and other whitelisted external contracts
- Tokens must be whitelisted before they can be collected as fees
- Both target contracts and tokens can be added/removed by FEE_MANAGER_ROLE

### Fee Collection Safety
- All fee collection methods implement fee-on-transfer checks
- Actual received amounts are tracked instead of expected amounts
- Maximum single fee amount is capped at 1M tokens
- Non-reentrant protection on all fee collection methods

## Fee Collection Mechanisms

The contract provides three distinct methods for fee collection:

### 1. collectFee (Pull Method)
- Primary method used by most protocol contracts
- Target contract must approve tokens for the FeeCollector
- FeeCollector pulls the approved amount
- Implements fee-on-transfer check by comparing balances
- Used for standard protocol fee collection

### 2. claimCollectorRewards (Push Method)
- Used by LendingPool to extract rewards from scrvUSD vault
- Target contract pushes tokens to FeeCollector
- Implements fee-on-transfer check for future compatibility
- Used for reward distribution scenarios

### 3. claimNFTUnderlying
- Used by RAACNFT to extract crvUSD paid for NFT minting
- Primarily distributes fees to RAAC_CORP target
- Handles underlying token extraction from wrapped tokens
- Used for NFT-related fee collection

## Fee Distribution

### Fee Type Configuration
- Each fee type has configurable distribution parameters
- Distribution targets include:
  - Treasury
  - Repair Fund
  - Burn
  - veRAAC
  - RAAC Corp
  - Other

### Distribution Logic
- Fees are collected and tracked per token, fee type, and target
- Distribution shares don't need to sum to 100%
- Any remaining amount is automatically sent to treasury
- Fees are tracked cumulatively to handle fee type share changes
- Distribution can be triggered for specific token/target/fee type combinations

### Example Distribution
```solidity
// Example: Distribute crvUSD from LENDING_FEE to treasury
distributeFees(LENDING_FEE, TREASURY, crvUSD);
```

## Key Functions

| Function Name | Description | Access | Parameters |
|---------------|-------------|---------|------------|
| constructor | Initializes the FeeCollector contract with initial state and roles | - | `_admin`: Initial admin address |
| collectFee | Collects fees of a specific type (Pull method) | Any | `token`: Token to collect<br>`target`: Source address<br>`amount`: Amount to collect<br>`feeType`: Type of fee |
| claimCollectorRewards | Claims rewards from target (Push method) | FEE_MANAGER_ROLE | `token`: Token to claim<br>`target`: Source address<br>`feeType`: Type of fee |
| claimNFTUnderlying | Claims underlying tokens from wrapped NFTs | FEE_MANAGER_ROLE | `token`: Wrapped token<br>`target`: Source address<br>`amount`: Amount to claim<br>`feeType`: Type of fee |
| distributeFees | Distributes collected fees | DISTRIBUTOR_ROLE | `feeType`: Fee type<br>`target`: Target type<br>`token`: Token to distribute |
| addFeeType | Adds new fee type with distribution parameters | FEE_MANAGER_ROLE | `feeType`: Fee type<br>`treasuryShare`: Treasury percentage<br>`repairFundShare`: Repair fund percentage<br>`burnShare`: Burn percentage<br>`veRAACTokenShare`: veRAAC percentage<br>`raacCorpShare`: RAAC Corp percentage<br>`otherShare`: Other percentage |
| updateFeeType | Updates fee type parameters | FEE_MANAGER_ROLE | `feeType`: Fee type to update<br>`newFee`: New parameters |
| addWhitelistedTarget | Adds target to whitelist | FEE_MANAGER_ROLE | `target`: Target address |
| removeWhitelistedTarget | Removes target from whitelist | FEE_MANAGER_ROLE | `target`: Target address |
| addClaimableToken | Adds token to supported tokens | FEE_MANAGER_ROLE | `token`: Token address |
| removeClaimableToken | Removes token from supported tokens | FEE_MANAGER_ROLE | `token`: Token address |

## Fee Types

The contract supports configurable fee types with the following default types:

1. Protocol Fees (0): General operations
2. Lending Fees (1): Lending/borrowing activities
3. Performance Fees (2): Yield products
4. Insurance Fees (3): NFT loan insurance
5. Mint/Redeem Fees (4): Token operations
6. Vault Fees (5): Vault management
7. Swap Tax (6): Trading operations
8. NFT Royalties (7): NFT transactions

## Implementation Details

The FeeCollector:

- Uses OpenZeppelin contracts (AccessControl, ReentrancyGuard, Pausable, SafeERC20)
- Implements IFeeCollector interface
- Uses basis points for percentage calculations (10000 = 100%)
- Implements fee-on-transfer checks for all collection methods
- Maintains cumulative tracking of collected fees
- Provides emergency controls for paused state

## Events

The contract emits events for all significant state changes:

| Event | Description |
|-------|-------------|
| FeeCollected | When fees are collected |
| FeeDistributed | When fees are distributed |
| RewardClaimed | When rewards are claimed |
| FeeTypeUpdated | When fee parameters change |
| TreasuryUpdated | When treasury address changes |
| RepairFundUpdated | When repair fund changes |
| EmergencyWithdrawal | During emergency withdrawals |
| DistributionParametersUpdated | When distribution parameters change |
| TokenAdded | When a new token is supported |
| TokenRemoved | When a token is removed from support |
| TargetWhitelisted | When a target is whitelisted |
| TargetRemovedFromWhitelist | When a target is removed from whitelist |
| CollectorRewardsClaimed | When collector rewards are claimed |
| CollectorUnderlyingClaimed | When NFT underlying tokens are claimed |

## Notes

- The contract uses basis points for percentage calculations (10000 = 100%)
- Maximum single fee amount is capped at 1M tokens
- Fee-on-transfer tokens are supported through balance checks
- Distribution shares don't need to sum to 100% (excess goes to treasury)
- Fees are tracked cumulatively to handle fee type share changes
- All fee collection methods implement non-reentrant protection 
- **Integration Requirement:** Any target contract that expects FeeCollector to deliver fees via `distributeFees` **MUST** implement the `IDistributionTarget` interface *and* advertise support for it via ERC-165 (`supportsInterface`). If the interface is not supported, the FeeCollector will fall back to a direct token transfer which can lead to the funds being locked or otherwise lost inside the target contract. 