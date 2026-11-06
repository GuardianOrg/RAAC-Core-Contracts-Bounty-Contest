# VeBoost

## Overview

`VeBoost` is a ve-power delegation contract that allows `veRAAC` holders to delegate ("boost") their voting escrow balance to other addresses. The delegated power is **not used for governance voting**; instead, it is read by gauge contracts when calculating boost multipliers for reward distribution. This enables liquid delegation of ve-power for yield enhancement without transferring the underlying lock.

## Purpose

- Allow veRAAC holders to delegate ve-power to other addresses
- Enable recipients to receive boosted gauge rewards based on delegated ve-power
- Support time-limited delegation with automatic linear decay
- Provide EIP-2612 permit-style approvals for delegating via signature
- Allow receivers to cancel (unboost) delegations early

## Key Functions

| Function Name | Description | Access | Parameters | Returns |
|---------------|-------------|--------|------------|---------|
| boost | Delegates ve-power to a receiver until `_endtime` | External | `_receiver`: recipient<br>`_amount`: ve amount<br>`_endtime`: epoch-aligned end timestamp | None |
| boostFrom | Delegates ve-power on behalf of `_owner` using allowance | External | `_owner`: ve holder<br>`_receiver`: recipient<br>`_amount`: ve amount<br>`_endtime`: end timestamp | None |
| unboost | Cancels (returns) part of an existing boost | External (Receiver only) | `_owner`: boost owner<br>`_index`: boost index<br>`_amount`: amount to cancel | None |
| checkpoint | Updates delegated/received snapshots for an account | External | `_account`: address to checkpoint | None |
| increaseAllowance | Increases spender allowance | External | `spender`<br>`addedValue` | None |
| decreaseAllowance | Decreases spender allowance | External | `spender`<br>`subtractedValue` | None |
| permit | Sets allowance via EIP-2612 signature | External | `owner`<br>`spender`<br>`value`<br>`deadline`<br>`v`, `r`, `s` | None |
| balanceOf | Returns adjusted ve balance (own - delegated + received) | External View | `_account` | `uint256` |
| adjustedVeBalance | Alias for `balanceOf` | External View | `_account` | `uint256` |
| delegatedBalance | Returns ve-power currently delegated to others | Public View | `_account` | `uint256` |
| receivedBalance | Returns ve-power received from others | External View | `_account` | `uint256` |
| delegableBalance | Returns ve-power available to delegate | External View | `_account` | `uint256` |
| boostLength | Returns number of boost entries for an account | Public View | `_account` | `uint256` |
| getBoosts | Returns all boost entries for an account | Public View | `_account` | `BoostItem[]` |
| name | Returns token name (derived from veRAAC) | External View | None | `string` |
| symbol | Returns token symbol (derived from veRAAC) | External View | None | `string` |
| decimals | Returns decimals (18) | External View | None | `uint8` |
| totalSupply | Returns veRAAC total supply | External View | None | `uint256` |
| DOMAIN_SEPARATOR | Returns EIP-712 domain separator | External View | None | `bytes32` |

## Implementation Details

### Delegation model

Delegation uses a linear decay model similar to veToken mechanics:

- **bias**: initial boost amount at start time
- **slope**: rate of decay per second
- **endtime**: must be aligned to `WEEK` boundaries and cannot exceed the owner's veRAAC lock end

The delegated balance at time `t` is: `bias - slope * (t - ts)`

### Checkpointing

Both `delegated` and `received` mappings store `Point` structs that are lazily checkpointed across epoch boundaries. Slope changes are recorded per-endtime to handle multiple concurrent delegations.

### Balance calculation

`balanceOf(_account)` returns:

```
veRAAC.balanceOf(_account) - delegatedBalance(_account) + receivedBalance(_account)
```

This adjusted balance is what gauges read to determine a user's effective ve-power for boost calculations.

### Unboost mechanics

Only the **receiver** of a boost can call `unboost()` to return ve-power early. The returned amount is pro-rated based on elapsed time.

## Data Structures

### Point
| Field | Type | Description |
|-------|------|-------------|
| bias | uint112 | Initial value at checkpoint |
| slope | uint112 | Decay rate per second |
| ts | uint32 | Timestamp of last checkpoint |

### BoostItem
| Field | Type | Description |
|-------|------|-------------|
| receiver | address | Boost recipient |
| startTime | uint48 | Start timestamp |
| endTime | uint48 | End timestamp (epoch-aligned) |
| initialAmount | uint128 | Initial bias amount |
| cancelAmount | uint128 | Amount cancelled via unboost |

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| decimals | 18 | Token decimals |
| WEEK | 7 days | Epoch duration for alignment |
| _PERMIT_TYPEHASH | keccak256(...) | EIP-2612 permit typehash |

## Events

| Event Name | Description | Parameters |
|------------|-------------|------------|
| Transfer | Emitted on boost/unboost (ERC20-style) | `from`<br>`to`<br>`value` |
| Approval | Emitted when allowance is set | `owner`<br>`spender`<br>`value` |
| Boost | Emitted when ve-power is delegated | `owner`<br>`receiver`<br>`bias`<br>`slope`<br>`start` |
| Unboost | Emitted when a boost is cancelled | `owner`<br>`receiver`<br>`bias`<br>`slope`<br>`start` |

## Error Conditions

| Error Name | Description |
|------------|-------------|
| ExpiredDeadline | Permit deadline has passed |
| InvalidSignature | Permit signature is invalid |
| ApproveFromZeroAddress | Cannot approve from zero address |
| ApproveToZeroAddress | Cannot approve to zero address |
| DecreasedAllowanceBelowZero | Decrease would result in negative allowance |
| InsufficientAllowance | Caller lacks sufficient allowance |
| BoostZeroAmount | Cannot boost zero amount |
| EndTimeSmallerThanCurrentTimestamp | End time must be in the future |
| EndTimeNotAlignedWithWeek | End time must be a multiple of WEEK |
| EndTimeExceedLockEnd | End time exceeds owner's veRAAC lock end |
| BoostExceedBalance | Boost amount exceeds delegable balance |
| IndexOutOfBound | Boost index does not exist |
| ErrorOnlyCancelByReceiver | Only the receiver can cancel a boost |
| CancelBoostExceedBalance | Cancel amount exceeds boost balance |
| CancelExpiredBoost | Cannot cancel an expired boost |

## Access Control

| Role / Mechanism | Description |
|------------------|-------------|
| Any veRAAC holder | Can boost their own ve-power or approve others |
| Approved spender | Can call `boostFrom()` using allowance |
| Boost receiver | Can call `unboost()` to return ve-power early |

## Usage Notes

- **Gauges read `balanceOf()` or `adjustedVeBalance()`** to determine a user's effective ve-power for boost calculations—delegated power is **not** used for governance voting.
- Boost end times must be aligned to 7-day epoch boundaries.
- Boost end time cannot exceed the owner's veRAAC lock expiration.
- Multiple concurrent boosts are supported; each is tracked as a separate `BoostItem`.
- Receivers can return ve-power early via `unboost()`, with pro-rated refunds.

## Dependencies

- OpenZeppelin: `ECDSA`, `EIP712`, `Context`, `IERC20Metadata`
- RAAC interfaces: `IveRAACToken`, `IVeBoost`
