# LockManager

## Overview

The LockManager library manages token lock positions with voting power calculations based on time-weighted decay. It provides comprehensive functionality for creating, increasing, extending, freezing, and withdrawing locks while maintaining accurate voting power checkpoints through bias and slope calculations.

## Purpose

- Create and manage epoch-based token lock positions
- Calculate time-weighted voting power with linear decay
- Track user and global voting power history with Point checkpoints
- Support frozen locks with non-decaying voting power
- Manage multiple locks per user with different unlock times
- Handle emergency withdrawals and lock recomputation
- Maintain total locked amounts and historical voting power
- Round lock expiries to epoch boundaries (weeks)

## Key Functions

| Function Name | Description | Access | Parameters | Returns |
|---------------|-------------|---------|------------|---------|
| createLock | Creates a new lock position | External | `lockState`: Lock state<br>`user`: User address<br>`amount`: Tokens to lock<br>`epochs`: Number of epochs | (int128, uint40): bias and epochEnd |
| increaseLock | Increases existing lock amount | External | `lockState`: Lock state<br>`user`: User address<br>`amountToAdd`: Additional tokens<br>`epochEnd`: Epoch end time | int128: bias |
| extendLock | Extends lock to later epoch | External | `lockState`: Lock state<br>`user`: User address<br>`fromEpochEnd`: Current epoch end<br>`addEpochs`: Epochs to add | (uint40, uint256): newEpochEnd and amount |
| freezeLock | Converts lock to frozen (non-decaying) | External | `lockState`: Lock state<br>`user`: User address<br>`fromEpochEnd`: Current epoch end | (uint40, uint256): newEpochEnd and amount |
| unfreezeLock | Converts frozen lock to finite epoch | External | `lockState`: Lock state<br>`user`: User address<br>`newEpochs`: New lock epochs | (uint40, uint256): newEpochEnd and amount |
| withdrawExpired | Withdraws expired locks | External | `lockState`: Lock state<br>`user`: User address | (uint256, uint16): withdrawn amount and processed count |
| withdrawSpecificLock | Withdraws specific lock by epoch end | External | `lockState`: Lock state<br>`user`: User address<br>`epochEnd`: Epoch end time | uint256: withdrawn amount |
| emergencyWithdrawAll | Emergency withdrawal of all locks | External | `lockState`: Lock state<br>`user`: User address | (uint256, uint32): withdrawn amount and processed count |
| getVotingPowerAtTime | Gets voting power at timestamp | External View | `lockState`: Lock state<br>`user`: User address<br>`timestamp`: Query time | uint256: voting power |
| getTotalVotingPowerAt | Gets total voting power at timestamp | External View | `lockState`: Lock state<br>`timestamp`: Query time | uint256: total voting power |
| getVotingPowerAtBlock | Gets voting power at block number | External View | `lockState`: Lock state<br>`user`: User address<br>`blockNumber`: Block number | uint256: voting power |
| roundUpToWeek | Rounds timestamp up to next epoch boundary | External Pure | `timestamp`: Time to round<br>`WEEK`: Epoch duration | uint40: rounded timestamp |

## Implementation Details

### Features:

- Epoch-based lock management with week rounding
- Linear voting power decay using bias and slope calculations
- Point-based checkpoint system for historical queries
- Support for frozen locks (FROZEN_LOCK_END_WEEK = 3494534400)
- Multiple locks per user with different unlock times
- Binary search for efficient historical lookups
- Automatic lock indexing with nextUnlockIndex optimization
- Emergency withdrawal with voting power zeroing
- Lock recomputation from current active locks
- Safe int128 casting with overflow protection
- Global and per-user voting power tracking

## Data Structures

### LockState
| Field | Type | Description |
|-------|------|-------------|
| epochDuration | uint40 | Duration of one epoch in seconds |
| maxLockEpochs | uint40 | Maximum number of epochs for a lock |
| totalLocked | uint256 | Total amount of tokens locked globally |
| pointHistory | Point[] | Global voting power history |
| userPointHistory | mapping(address => Point[]) | Per-user voting power history |
| userLockState | mapping(address => EpochLockState) | Per-user lock data |
| maxTotalLocked | uint256 | Maximum total tokens that can be locked |

### Point
| Field | Type | Description |
|-------|------|-------------|
| bias | int128 | Initial voting power (decays linearly) |
| slope | int128 | Rate of voting power decay per second |
| ts | uint40 | Timestamp when point was created |
| blk | uint40 | Block number when point was created |

### EpochLockState
| Field | Type | Description |
|-------|------|-------------|
| locks | LockedBalance[] | Array of user's locks |
| nextUnlockIndex | uint32 | Index to start scanning for active locks |
| totalLocked | uint256 | Total tokens locked by this user |

### SlopeChange
| Field | Type | Description |
|-------|------|-------------|
| biasDelta | int128 | Change in bias at this timestamp |
| slopeDelta | int128 | Change in slope at this timestamp |

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| FROZEN_LOCK_END_WEEK | 3494534400 | Specific end time for frozen locks (09/24/2080) |
| MAX_CASTABLE_INT128 | 2^127 - 1 | Maximum uint256 safely castable to int128 |

## Error Conditions

| Error Name | Description |
|------------|-------------|
| InvalidEpoch | Epoch count is zero or exceeds maximum |
| AlreadyFrozen | Attempting to freeze an already frozen lock |
| InvalidAmount | Lock amount is zero or withdrawn amount is zero |
| MissingEpoch | Lock with specified epoch end time not found |
| EpochEndTooFar | New epoch end exceeds maximum allowed time |
| NoTokensLocked | User has no tokens locked |
| ValueTooLargeToCast | Value exceeds int128 maximum during casting |

## Usage Notes

- All lock times are rounded up to the next week boundary
- Voting power decays linearly from bias at slope rate per second
- Frozen locks have zero slope (non-decaying) and bias equal to amount
- Maximum voting power is achieved with max lock duration
- Formula: `slope = amount / maxTime`, `bias = slope * duration`
- Historical queries use Point checkpoint arrays with binary search
- Block-based queries assume 12-second average block time
- Multiple locks per user are stored in an array, sorted by unlock time
- nextUnlockIndex optimizes scanning by skipping processed locks
- Emergency withdrawals immediately zero all voting power
- Lock recomputation rebuilds voting power from active locks
- Voting power calculations use safe int128 operations

## Dependencies

The library depends on:

- IveRAACToken interface for LockedBalance struct
- Solidity version 0.8.19 or higher for safe math and overflow protection

## Security Considerations

- All amounts must fit within int128 range for voting power calculations
- Timestamps are validated to prevent manipulation
- Epoch bounds are enforced (max epochs and epoch duration)
- Frozen lock constant prevents accidental early unlock
- Lock amounts are validated to be non-zero
- Total locked tracking prevents accounting errors
- Binary search is bounds-checked for array access
- Emergency withdrawals properly zero voting power to prevent double-counting
- Lock extension validates new epoch end doesn't exceed maximum
- Historical queries clamp time estimates to prevent overflow
- Only implementing contracts should call library functions
