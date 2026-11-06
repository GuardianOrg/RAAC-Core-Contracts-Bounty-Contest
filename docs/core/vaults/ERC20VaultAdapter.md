# ERC20VaultAdapter

The `ERC20VaultAdapter` is a specialized contract that implements the `IVaultAssetAdapter` interface for managing ERC20 tokens within the RAAC Protocol's vault system. This adapter is specifically designed to handle stable ERC20 tokens with specific security considerations in mind.

## Overview

The ERC20VaultAdapter serves as an intermediary contract that manages deposits and withdrawals of ERC20 tokens for a vault. It maintains accounting of deposited tokens and provides valuation services through an oracle integration.

## Key Features

- Single token management per adapter instance
- Oracle-based price feeds for asset valuation
- Restricted access control for vault operations
- Delegatecall-based approval mechanism

## Security Considerations

### Token Compatibility

**Important**: This adapter is designed ONLY for:
- Non-rebasing tokens
- Non fee-on-transfer tokens
- Stable tokens (e.g., crvUSD, goldUSD, USDC)

Using this adapter with tokens that have rebasing mechanics or transfer fees will result in accounting inconsistencies and potential loss of funds.

### Access Control

The adapter implements strict access control mechanisms:
- Only the designated vault contract can call `deposit` and `withdraw` functions
- No external actors can directly interact with these core functions
- The owner can only update the price oracle address

### Oracle Security

The adapter relies on an external price oracle that is expected to have:
- Built-in security mechanisms similar to RAAC NFT oracle implementation
- Price manipulation resistance
- Regular price updates
- Proper decimal handling

### Approval Mechanism

The `approve` function has specific security properties:
- Can only be called through delegatecall
- Used exclusively by the LiquidationStrategyProxy contract
- Implementation is non-upgradeable to prevent potential security risks
- Allows controlled approval of tokens for transfer to the adapter

## Functions

### Core Operations

```solidity
function deposit(bytes calldata data, address from) external returns (uint256)
```
- Restricted to vault calls only
- Accepts deposits of the configured ERC20 token
- Returns the USD value of deposited tokens

```solidity
function withdraw(bytes calldata data, address to) external returns (uint256)
```
- Restricted to vault calls only
- Processes withdrawals to specified addresses
- Returns the USD value of withdrawn tokens

### Asset Valuation

```solidity
function getAssetValue(bytes calldata data) external view returns (uint256)
```
- Calculates USD value of a given token amount
- Uses the configured price oracle
- Handles decimal normalization

### Administrative

```solidity
function setPriceOracle(address _oracle) external
```
- Owner-only function
- Updates the price oracle address
- Includes checks for valid oracle addresses

## Integration Points

The adapter integrates with:
- Vault contracts for deposit/withdrawal operations
- Price oracle for asset valuation
- LiquidationStrategyProxy for approval operations

## Risks and Limitations

1. Oracle Dependency
   - Relies on accurate price feeds
   - Subject to oracle manipulation risks if oracle security is compromised

2. Token Restrictions
   - Not suitable for tokens with rebasing mechanics
   - Not compatible with fee-on-transfer tokens
   - Should only be used with stable tokens

3. Approval Mechanism
   - Delegatecall pattern must be strictly followed
   - No upgradeability to maintain security guarantees
