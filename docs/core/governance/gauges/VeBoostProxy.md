# VeBoostProxy

## Overview

`VeBoostProxy` is a lightweight proxy contract that provides a single entry point for gauges to query a user's adjusted ve-power. It abstracts away the underlying `VeBoost` implementation, allowing the protocol to upgrade or swap out the boost delegation logic without changing gauge contracts.

## Purpose

- Provide a stable interface for gauges to query adjusted ve-power
- Allow owner to update or reset the underlying `VeBoost` implementation
- Fallback to raw `veRAAC.balanceOf()` if no `VeBoost` is configured

## Key Functions

| Function Name | Description | Access | Parameters | Returns |
|---------------|-------------|--------|------------|---------|
| adjustedVeBalance | Returns adjusted ve balance for an account | External View | `_account`: user address | `uint256`: adjusted balance |
| updateVeBoost | Sets a new VeBoost implementation | External (Owner) | `_newVeBoost`: new VeBoost address | None |
| resetVeBoost | Clears the VeBoost address (fallback to raw veRAAC) | External (Owner) | None | None |
| veBoost | Returns current VeBoost implementation address | External View | None | `address` |

## Implementation Details

### Balance resolution

`adjustedVeBalance(_account)` works as follows:

1. If `veBoost == address(0)`: returns `veRAAC.balanceOf(_account)` directly
2. If `veBoost` is set: returns `VeBoost(veBoost).balanceOf(_account)`

This allows gauges to always call `VeBoostProxy.adjustedVeBalance()` without needing to know whether delegation is enabled.

### Safety check on update

When calling `updateVeBoost(_newVeBoost)`, the contract verifies the new address is valid by calling `balanceOf(msg.sender)` on it. This ensures the new implementation has the expected interface.

## Events

| Event Name | Description | Parameters |
|------------|-------------|------------|
| UpdateVeBoost | Emitted when VeBoost implementation is changed | `oldVeBoost`<br>`newVeBoost` |

## Access Control

| Role / Mechanism | Description |
|------------------|-------------|
| Owner (`Ownable`) | Can update or reset the VeBoost implementation |

## Usage Notes

- **Gauges should call `VeBoostProxy.adjustedVeBalance()`** rather than querying `VeBoost` or `veRAAC` directly.
- If the protocol wants to disable delegation, the owner can call `resetVeBoost()` to revert to raw veRAAC balances.
- The proxy is immutable with respect to the `ve` address set at construction.

## Dependencies

- OpenZeppelin: `Ownable`
- RAAC interfaces: `IveRAACToken`, `IVeBoost`, `IVeBoostProxy`
