# Compliance System

The RAAC Protocol implements a global compliance system that allows for protocol-wide address blacklisting. This system consists of two main components:

1. `ComplianceRegistry`: A central registry contract that maintains the blacklist
2. `WithCompliance`: A base contract that other contracts can inherit to enforce compliance checks

## ComplianceRegistry

The `ComplianceRegistry` contract serves as the central source of truth for blacklisted addresses across the entire protocol. It combines both internal blacklist management and external sanctions checking through the ChainAnalysis Oracle.

### Key Features

- **Role-Based Access Control**: Uses OpenZeppelin's `AccessControl` for managing permissions
- **Blacklist Management**: Maintains a mapping of blacklisted addresses
- **External Sanctions Integration**: Integrates with ChainAnalysis Oracle for real-time sanctions checking
- **Batch Operations**: Supports adding and removing multiple addresses in a single transaction
- **Event Emission**: Emits events for all blacklist changes for off-chain tracking
- **Dual Compliance Checking**: Combines internal blacklist with external sanctions data

### Roles

- `DEFAULT_ADMIN_ROLE`: Can manage other roles and set the sanctions oracle address
- `BLACKLIST_ADMIN_ROLE`: Can add/remove addresses from the blacklist

### Key Functions

```solidity
function isBlacklisted(address user) external view returns (bool)
```
Checks if an address is blacklisted. Returns `true` if the address is either in the internal blacklist OR flagged by the ChainAnalysis Oracle.

```solidity
function blacklist(address user) external
```
Adds a single address to the internal blacklist. Only callable by `BLACKLIST_ADMIN_ROLE`.

```solidity
function unblacklist(address user) external
```
Removes a single address from the internal blacklist. Only callable by `BLACKLIST_ADMIN_ROLE`.

```solidity
function blacklistBatch(address[] calldata users) external
```
Adds multiple addresses to the internal blacklist in a single transaction.

```solidity
function unblacklistBatch(address[] calldata users) external
```
Removes multiple addresses from the internal blacklist in a single transaction.

```solidity
function setSanctionsList(address _sanctionsList) external
```
Sets the address of the ChainAnalysis Oracle. Only callable by `DEFAULT_ADMIN_ROLE`.

### ChainAnalysis Oracle Integration

The ComplianceRegistry integrates with the ChainAnalysis Oracle to provide real-time sanctions checking:

- **External Sanctions**: The `sanctionsList` address points to the ChainAnalysis Oracle contract
- **Combined Checking**: The `isBlacklisted` function checks both internal blacklist and external sanctions
- **Configurable**: The sanctions oracle address can be set by the admin role
- **Fallback Safe**: If no sanctions oracle is set, only internal blacklist is checked

The integration follows the ChainAnalysis Oracle interface:
```solidity
interface SanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}
```

### Compliance Checking Logic

The compliance checking follows this logic:
1. Check if the address is in the internal blacklist
2. If not blacklisted internally, check if sanctions oracle is configured
3. If sanctions oracle is configured, check if the address is sanctioned
4. Return `true` if either check fails, `false` otherwise

## WithCompliance

`WithCompliance` is an abstract contract that other contracts can inherit to enforce compliance checks. It provides a simple way to ensure that blacklisted addresses cannot interact with protocol features.

### Usage

To use `WithCompliance` in your contract:

1. Inherit from the contract:
```solidity
contract YourContract is WithCompliance {
    constructor(address _complianceRegistry) WithCompliance(_complianceRegistry) {
        // Your constructor code
    }
}
```

2. Use the `notBlacklisted` modifier on functions that should enforce compliance:
```solidity
function protectedFunction() external notBlacklisted(msg.sender) {
    // Function implementation
}
```

### Key Components

- **Immutable Registry**: The `ComplianceRegistry` address is stored immutably at construction
- **Modifier**: Provides `notBlacklisted` modifier for function-level protection
- **Automatic Checks**: Automatically reverts if a blacklisted address attempts interaction

### Example Implementation

```solidity
contract ProtectedPool is WithCompliance {
    constructor(address _complianceRegistry) WithCompliance(_complianceRegistry) {}
    
    function deposit(uint256 amount) external notBlacklisted(msg.sender) {
        // Deposit implementation
    }
    
    function withdraw(uint256 amount) external notBlacklisted(msg.sender) {
        // Withdraw implementation
    }
}
```

## Error Handling

The compliance system defines several custom errors:

- `BlacklistedAddress()`: Thrown when a blacklisted address attempts to interact
- `AlreadyBlacklisted()`: Thrown when attempting to blacklist an already blacklisted address
- `NotBlacklisted()`: Thrown when attempting to unblacklist an address that isn't blacklisted
- `InvalidAddress()`: Thrown when attempting to blacklist/unblacklist the zero address

## Events

The system emits the following events for tracking:

- `Blacklisted(address indexed user)`: Emitted when an address is blacklisted
- `UnBlacklisted(address indexed user)`: Emitted when an address is removed from the blacklist

## Security Considerations

1. **Role-Based Access**: Only authorized addresses (those with `BLACKLIST_ADMIN_ROLE`) can modify the blacklist
2. **Admin Controls**: Only `DEFAULT_ADMIN_ROLE` can set the sanctions oracle address
3. **Zero Address Protection**: Zero address checks are enforced for all operations
4. **Non-Upgradeable Design**: The system is designed to be non-upgradeable for security
5. **Event Transparency**: Events are emitted for all state changes for transparency
6. **External Oracle Security**: The sanctions oracle integration provides additional security layers
7. **Combined Compliance**: Dual checking (internal + external) provides comprehensive compliance coverage

## Integration with ChainAnalysis

The ComplianceRegistry integrates with ChainAnalysis Oracle for enhanced compliance:

- **Real-time Sanctions**: Provides up-to-date sanctions data from ChainAnalysis
- **Documentation**: For more information, see [ChainAnalysis Oracle Documentation](https://go.chainalysis.com/chainalysis-oracle-docs.html)
- **Configurable Integration**: The oracle address can be updated by admin if needed
- **Graceful Degradation**: System continues to work even if sanctions oracle is not configured 