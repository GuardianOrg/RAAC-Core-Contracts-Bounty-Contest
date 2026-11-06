# RAACTokenCollector

## Overview
The RAACTokenCollector is a core contract responsible for collecting and distributing protocol fees from the RAAC Token. It serves as a central hub for managing protocol fee operations and ensures secure distribution of collected fees to designated collectors.

## Contract Details
- **Contract Name**: RAACTokenCollector
- **Inheritance**: AccessControl, ReentrancyGuard
- **License**: BSL-1.1

## State Variables
- `feeCollector` (address): Address of the fee collector contract
- `raacToken` (address): Address of the RAAC token contract
- `FEE_MANAGER_ROLE` (bytes32): Role identifier for fee management operations

## Access Control
The contract implements role-based access control with two main roles:
- `DEFAULT_ADMIN_ROLE`: Can manage roles and perform administrative functions
- `FEE_MANAGER_ROLE`: Can manage fee-related operations

## Core Functions

### Constructor
```solidity
constructor(address _feeCollector, address _raacToken)
```
Initializes the contract with the fee collector and RAAC token addresses.
- **Parameters**:
  - `_feeCollector`: Address of the fee collector contract
  - `_raacToken`: Address of the RAAC token contract
- **Requirements**:
  - Both addresses must be non-zero
  - Grants DEFAULT_ADMIN_ROLE and FEE_MANAGER_ROLE to the deployer

### setFeeCollector
```solidity
function setFeeCollector(address _feeCollector) external
```
Updates the fee collector address.
- **Parameters**:
  - `_feeCollector`: New fee collector address
- **Requirements**:
  - Caller must have FEE_MANAGER_ROLE
  - New address must be non-zero
- **Events**:
  - `FeeCollectorSet`: Emitted when fee collector is updated

### distributeCollectedFees
```solidity
function distributeCollectedFees() external returns (bool)
```
Distributes collected RAAC tokens to the fee collector.
- **Requirements**:
  - Contract must have RAAC tokens to distribute
  - Non-reentrant
- **Returns**:
  - `bool`: Success status of the distribution
- **Events**:
  - `FeeDistributed`: Emitted when fees are distributed

### rescueToken
```solidity
function rescueToken(address tokenAddress, address recipient, uint256 amount) external
```
Rescues tokens accidentally sent to the contract.
- **Parameters**:
  - `tokenAddress`: Address of the token to rescue
  - `recipient`: Address to receive the rescued tokens
  - `amount`: Amount of tokens to rescue
- **Requirements**:
  - Caller must have FEE_MANAGER_ROLE
  - Cannot rescue RAAC tokens
  - Recipient must be non-zero
- **Events**:
  - `TokenRescued`: Emitted when tokens are rescued

## Events
- `FeeDistributed(address indexed token, address indexed collector, uint256 amount)`
- `FeeCollectorSet(address indexed collector)`
- `TokenRescued(address indexed token, address indexed recipient, uint256 amount)`

## Errors
- `ApprovalFailed()`: Thrown when token approval fails
- `InvalidAddress()`: Thrown when an invalid address is provided
- `NoFeesToDistribute()`: Thrown when there are no fees to distribute
- `CannotRescueMainAsset()`: Thrown when attempting to rescue RAAC tokens

## Security Considerations

### Fee-on-Transfer Handling
1. **Whitelisting**: The contract is expected to be whitelisted in the RAAC token contract to prevent fee-on-transfer charges during protocol transfers.
2. **Fee Collector Compatibility**: The fee collector contract is designed to handle fee-on-transfer tokens, ensuring accurate accounting even if fees are charged.

### Access Control
- Role-based access control ensures only authorized addresses can perform sensitive operations
- DEFAULT_ADMIN_ROLE can manage roles and perform administrative functions
- FEE_MANAGER_ROLE can manage fee-related operations

### Reentrancy Protection
- The contract implements ReentrancyGuard to prevent reentrancy attacks
- Critical functions are protected with the nonReentrant modifier

### Token Safety
- Uses OpenZeppelin's SafeERC20 for safe token transfers
- Implements rescue functionality for accidentally sent tokens
- Prevents rescue of the main RAAC token to maintain protocol integrity

## Integration Guidelines
1. Ensure the fee collector contract is properly configured to handle RAAC tokens
2. Verify the contract is whitelisted in the RAAC token contract
3. Set up appropriate roles and permissions before deployment
4. Monitor fee distribution events for proper accounting