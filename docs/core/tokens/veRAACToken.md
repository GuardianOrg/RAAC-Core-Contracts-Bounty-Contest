# VeRAACToken

## Overview

The VeRAACToken (Vote-Escrowed RAAC) is a comprehensive governance token contract that allows users to lock RAAC tokens in multiple positions to receive time-weighted voting power. It implements a sophisticated locking system with support for creating, increasing, extending, freezing, and withdrawing locks, along with ragequit mechanisms, reward distribution, and emergency controls. The contract features non-transferable veRAAC tokens that represent voting power with linear decay, checkpoint-based historical queries, and multi-token reward streaming.

## Purpose

- Enable multiple lock positions per user with different unlock times
- Calculate time-weighted voting power with linear decay (bias and slope)
- Support frozen locks with non-decaying voting power
- Implement ragequit mechanisms for early exit with penalties
- Distribute multi-token rewards to veRAAC holders
- Maintain historical voting power through checkpoints
- Provide emergency withdrawal controls with timelocks
- Track governance power across block heights and timestamps
- Enforce per-position and global lock amount limits

## Access Control

The contract implements role-based access control:

| Role | Description |
|------|-------------|
| Owner | Can pause/unpause, manage emergency controls, add/remove reward tokens, set treasury address, enable/disable freezing |
| Users | Can lock tokens, increase/extend/freeze/unfreeze locks, withdraw, ragequit, and claim rewards |

## Key Functions

### Locking Functions

| Name | Description | Access | Parameters | Returns |
|------|-------------|---------|------------|---------|
| lock | Creates new lock position | External | `_amount`: RAAC tokens to lock<br>`_epochs`: Number of epochs (7 days each) | None |
| increase | Adds tokens to existing lock | External | `_amountToAdd`: Additional RAAC tokens<br>`_epochEnd`: Target epoch end | None |
| extend | Extends lock to later epoch | External | `_fromEpochEnd`: Current epoch end<br>`_addEpochs`: Epochs to add | None |
| freezeLock | Converts lock to frozen (non-decaying) | External | `_fromEpochEnd`: Current epoch end | None |
| unfreezeLock | Converts frozen lock to finite epoch | External | `_newEpochs`: New lock duration | None |
| withdraw | Withdraws all expired locks | External | None | uint256: withdrawn amount |

### Ragequit Functions

| Name | Description | Access | Parameters | Returns |
|------|-------------|---------|------------|---------|
| ragequitAll | Initiates ragequit for all locks | External | None | None |
| ragequitLock | Initiates ragequit for specific lock | External | `_epochEnd`: Epoch end of lock to exit | None |
| finalizeRagequit | Completes ragequit after cooldown | External | `_to`: Address to receive tokens | None |

### Reward Functions

| Name | Description | Access | Parameters | Returns |
|------|-------------|---------|------------|---------|
| claimReward | Claims accumulated rewards | External | None | None |
| distributeRewards | Distributes rewards to veRAAC holders | External | `_rewardToken`: Token address<br>`_reward`: Amount to distribute | None |
| notifyFromVe | Owner-only reward notification | External | `_token`: Token address<br>`_amount`: Amount to notify | None |
| addRewardToken | Adds new reward token | External | `_rewardToken`: Token address | None |
| removeRewardToken | Removes reward token | External | `_rewardToken`: Token address | None |

### View Functions

| Name | Description | Access | Parameters | Returns |
|------|-------------|---------|------------|---------|
| balanceOf | Current voting power with decay | View | `_user`: User address | uint256: Current voting power |
| totalSupply | Total voting power with decay | View | None | uint256: Total voting power |
| balanceOfAt | Historical voting power at block | View | `_user`: User address<br>`_blockNumber`: Block number | uint256: Historical power |
| totalSupplyAt | Total voting power at block | View | `_blockNumber`: Block number | uint256: Total power at block |
| balanceOfAtTime | Voting power at timestamp | View | `_user`: User address<br>`_timestamp`: Timestamp | uint256: Power at timestamp |
| totalSupplyAtTime | Total voting power at timestamp | View | `_timestamp`: Timestamp | uint256: Total power at timestamp |
| getLocks | Gets all active locks for user | View | `_user`: User address | LockedBalance[]: Array of locks |
| lockedBalanceOf | Total locked amount for user | View | `_user`: User address | uint256: Total locked |
| getGlobalLockInfo | Gets global lock parameters | View | None | (uint256, uint40, uint40): totalLocked, maxLockEpochs, epochDuration |
| getEffectiveLockEnd | Gets weighted average lock end | View | `_user`: User address | uint40: Effective end time |
| getUserPointHistory | Gets point history for user | View | `_user`: User address | Point[]: User's point history |
| rewardPerToken | Reward rate for token | View | `_rewardToken`: Token address | uint256: Reward per token |
| claimable | Claimable rewards for user | View | `_user`: User address<br>`_token`: Token address | uint256: Claimable amount |
| claimed | Total claimed rewards | View | `_user`: User address<br>`_token`: Token address | uint256: Claimed amount |
| earned | Total earned rewards | View | `_user`: User address<br>`_token`: Token address | uint256: Total earned |

### Admin Functions

| Name | Description | Access | Parameters | Returns |
|------|-------------|---------|------------|---------|
| pause | Pauses the contract | Owner | None | None |
| unpause | Unpauses the contract | Owner | None | None |
| setTreasuryAddress | Updates treasury address | Owner | `_treasuryAddress`: New treasury | None |
| setFreezingEnabled | Enables/disables freezing | Owner | `_enabled`: Boolean flag | None |
| scheduleEmergencyAction | Schedules emergency action | Owner | `actionId`: Action identifier | None |
| cancelEmergencyAction | Cancels emergency action | Owner | `actionId`: Action identifier | None |
| enableEmergencyWithdraw | Enables emergency withdrawals | Owner | None | None |
| emergencyWithdraw | Emergency withdrawal | External | None | None |

## Data Structures

### LockedBalance
| Field | Type | Description |
|-------|------|-------------|
| amount | uint112 | Amount of RAAC tokens locked |
| unlockTime | uint40 | Timestamp when lock expires |

### RagequitRequest
| Field | Type | Description |
|-------|------|-------------|
| amount | uint256 | Net amount to receive after fees |
| grossAmount | uint256 | Original locked amount |
| fixedPenalityAmount | uint256 | Fixed penalty paid |
| variablePenalityAmount | uint256 | Variable penalty paid |
| readyAt | uint256 | Timestamp when withdrawal is available |

### RewardData
| Field | Type | Description |
|-------|------|-------------|
| rewardRate | uint256 | Reward tokens per second (scaled by PRECISION) |
| lastUpdateTime | uint256 | Last time rewards were updated |
| rewardPerTokenStored | uint256 | Accumulated reward per token |
| periodFinish | uint256 | End timestamp of reward period |
| totalVotingPowerAtNotify | uint256 | Total voting power snapshot |
| distributor | address | Address that distributed rewards |
| lastDistributionBlock | uint32 | Block of last distribution |

### UserRewardData
| Field | Type | Description |
|-------|------|-------------|
| rewards | uint256 | Pending rewards to claim |
| userRewardPerTokenPaid | uint256 | Reward per token already paid |
| claimedRewards | uint256 | Total rewards claimed |
| lastUserBlock | uint32 | Last block user was updated |

## Implementation Details

The contract implements:

- **Multiple Locks Per User**: Users can have multiple lock positions with different unlock times
- **Time-Weighted Voting Power**: Voting power decays linearly from bias at slope rate (slope = amount / maxTime)
- **Frozen Locks**: Locks can be frozen to FROZEN_LOCK_END_WEEK (09/24/2080) with zero decay
- **Epoch-Based Locking**: Lock times rounded to week boundaries (7 days)
- **Ragequit Mechanism**: Early exit with fixed + variable fees
  - Fixed fee: Constant percentage (burned)
  - Variable fee: Scales with remaining time (33% treasury, 67% streamed to veRAAC holders)
  - Cooldown period: 30 days before receiving tokens
- **Multi-Token Rewards**: Support for multiple reward tokens with time-weighted distribution
- **Checkpoint System**: Historical voting power tracking at blocks and timestamps
- **Non-Transferable**: veRAAC tokens cannot be transferred (only minted/burned)
- **Emergency Controls**: Timelocked emergency actions with configurable delays
- **Per-Position Limits**: Maximum 10M tokens per lock position
- **Global Limits**: Maximum 1B total locked tokens

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| MAX_LOCK_AMOUNT | 10,000,000e18 | Maximum tokens per lock position |
| MAX_TOTAL_LOCKED_AMOUNT | 1,000,000,000e18 | Maximum total locked tokens |
| EMERGENCY_DELAY | 3 days | Delay before emergency actions execute |
| RAGEQUIT_COLDOWN_PERIOD | 30 days | Cooldown before ragequit finalization |
| REWARD_DURATION | 7 days | Standard reward distribution period |
| RAGEQUIT_STREAM_DURATION | 180 days | Duration for ragequit fee streaming |
| FIXED_EXIT_FEE | 500 (5%) | Fixed ragequit fee in BPS |
| MAX_VARIABLE_EXIT_FEE | 2000 (20%) | Maximum variable ragequit fee in BPS |
| BPS_DENOMINATOR | 10,000 | Basis points denominator |
| PRECISION | 1e18 | Precision for reward calculations |
| FROZEN_LOCK_END_WEEK | 3494534400 | Frozen lock end time (09/24/2080) |
| EMERGENCY_WITHDRAW_ACTION | keccak256("EMERGENCY_WITHDRAW") | Action ID for emergency withdrawals |
| EMERGENCY_UNLOCK_ACTION | keccak256("EMERGENCY_UNLOCK") | Action ID for emergency unlock |

### Dependencies

- **OpenZeppelin**: ERC20, Ownable, ReentrancyGuard, Pausable, SafeERC20
- **Custom Libraries**: LockManager, RagequitLib, PowerCheckpoint
- **Interfaces**: IveRAACToken, IRAACToken

### Modifiers

| Modifier | Description |
|----------|-------------|
| whenNoTokenLocked | Requires no tokens currently locked |
| notInRagequitCooldown | Requires no pending ragequit request |
| withEmergencyDelay | Checks emergency action delay has elapsed |
| withFreezingEnabled | Requires freezing functionality enabled |

## Events

| Name | Parameters | Description |
|------|------------|-------------|
| Locked | `user`: address<br>`amount`: uint256<br>`epochEnd`: uint40 | Emitted when new lock is created |
| LockIncreased | `user`: address<br>`amount`: uint256 | Emitted when lock amount is increased |
| LockExtended | `user`: address<br>`fromEpochEnd`: uint40<br>`newEpochEnd`: uint40<br>`amount`: uint256 | Emitted when lock duration is extended or frozen/unfrozen |
| Withdrawn | `user`: address<br>`amount`: uint256 | Emitted when expired tokens are withdrawn |
| RagequitInitiatedAll | `user`: address<br>`amount`: uint256<br>`fixedFee`: uint256<br>`variableFee`: uint256<br>`readyAt`: uint256 | Emitted when user ragequits all locks |
| RagequitLockInitiated | `user`: address<br>`epochEnd`: uint40<br>`amount`: uint256<br>`fixedFee`: uint256<br>`variableFee`: uint256<br>`readyAt`: uint256 | Emitted when user ragequits specific lock |
| RagequitFinalized | `user`: address<br>`to`: address<br>`amount`: uint256 | Emitted when ragequit is finalized after cooldown |
| RewardPaid | `token`: address<br>`user`: address<br>`reward`: uint256 | Emitted when rewards are claimed |
| RewardNotified | `token`: address<br>`amount`: uint256<br>`rewardRate`: uint256 | Emitted when new rewards are distributed |
| RewardTokenAdded | `token`: address<br>`by`: address | Emitted when reward token is added |
| RewardTokenRemoved | `token`: address | Emitted when reward token is removed |
| TreasuryUpdated | `newTreasury`: address | Emitted when treasury address is updated |
| EmergencyWithdrawn | `user`: address<br>`amount`: uint256 | Emitted during emergency withdrawal |
| EmergencyActionScheduled | `actionId`: bytes32<br>`executeAt`: uint256 | Emitted when emergency action is scheduled |
| EmergencyActionCancelled | `actionId`: bytes32 | Emitted when emergency action is cancelled |
| EmergencyWithdrawEnabled | `enabledAt`: uint256 | Emitted when emergency withdraw is enabled |
| EmergencyUnlockScheduled | None | Emitted when emergency unlock is scheduled |
| FreezingStateUpdated | `enabled`: bool | Emitted when freezing is enabled/disabled |

## Error Conditions

| Name | Description |
|------|-------------|
| InvalidAmount | Zero or invalid amount provided |
| InvalidAddress | Zero or invalid address provided |
| InvalidEpoch | Epoch count is zero or exceeds maximum |
| InvalidLockDuration | Lock duration outside allowed range |
| InvalidTimestamp | Timestamp is in the future |
| InvalidBlockNumber | Block number is invalid or in future |
| InvalidDuration | Invalid reward duration (zero) |
| InvalidRewardRate | Invalid reward rate calculation |
| LockNotExpired | Attempting withdrawal before expiry |
| LockManager.NoTokensLocked | No tokens locked for operation |
| LockManager.MissingEpoch | Lock with specified epoch not found |
| LockManager.AlreadyFrozen | Lock is already frozen |
| TransferNotAllowed | Attempt to transfer veRAAC tokens |
| EmergencyDelayNotMet | Emergency action delay not elapsed |
| EmergencyActionNotScheduled | Emergency action not scheduled |
| EmergencyWithdrawNotEnabled | Emergency withdrawals not enabled |
| FreezingNotEnabled | Freezing functionality not enabled |
| TokensStillLocked | Tokens still locked (for restricted operations) |
| PendingRagequitRequest | User has pending ragequit in cooldown |
| NotFound | Ragequit request not found |
| CooldownNotElapsed | Ragequit cooldown period not elapsed |
| TotalSupplyLimitExceeded | Total locked exceeds global limit |
| AmountExceedsLimit | Amount exceeds per-position limit |
| TokenNotFound | Reward token not registered |
| TokenAlreadyAdded | Reward token already registered |
| ActiveRewardPeriod | Cannot remove token during active period |
| InsufficientVotingPower | No voting power at reward notification |

## Usage Flow

### Standard Lock Flow
1. User calls `lock(amount, epochs)` with RAAC approval
2. RAAC tokens transferred to contract
3. Lock created with rounded epoch end time
4. veRAAC minted based on bias calculation
5. User can increase, extend, or freeze lock later
6. After expiry, user calls `withdraw()` to retrieve RAAC

### Ragequit Flow
1. User calls `ragequitAll()` or `ragequitLock(epochEnd)`
2. Fixed fee burned (5% of locked amount)
3. Variable fee split: 33% to treasury, 67% streamed to veRAAC holders
4. User voting power zeroed during 30-day cooldown
5. User calls `finalizeRagequit(recipient)` after cooldown
6. Net amount (locked - fees) transferred to recipient
7. Remaining locks (if ragequitLock) have voting power restored

### Reward Distribution Flow
1. Admin calls `addRewardToken(token)` to register reward token
2. Distributor calls `distributeRewards(token, amount)` with token approval
3. Tokens transferred to contract
4. Reward period starts (7 days by default)
5. Users call `claimReward()` to claim proportional rewards
6. Rewards distributed based on voting power at distribution block

### Emergency Withdrawal Flow
1. Owner calls `scheduleEmergencyAction(EMERGENCY_WITHDRAW_ACTION)`
2. Wait 3 days for emergency delay
3. Owner calls `enableEmergencyWithdraw()`
4. Users call `emergencyWithdraw()` to retrieve all locked tokens immediately
5. No fees applied, voting power zeroed

## Usage Notes

- **Epoch Rounding**: All lock times rounded up to next week boundary (Thursday 00:00 UTC)
- **Voting Power Formula**: `slope = amount / maxTime`, `bias = slope * duration`
- **Frozen Locks**: Have slope=0 and bias=amount (full non-decaying power)
- **Multiple Locks**: Users can have unlimited locks with different unlock times
- **Lock Limits**: 10M tokens per position, 1B tokens globally
- **Ragequit Cooldown**: 30 days prevents immediate power restoration
- **Reward Snapshots**: Voting power captured at distribution block number
- **Historical Queries**: Use `balanceOfAt(user, block)` for governance voting
- **Time Decay**: Voting power decays continuously until lock expiry
- **Emergency Actions**: Require 3-day timelock before execution
- **Non-Transferable**: veRAAC cannot be transferred between addresses
- **Checkpoint Writing**: Automatic checkpoint creation on all lock operations
- **Reward Streaming**: Ragequit variable fees streamed over 180 days

## Security Considerations

- All arithmetic uses Solidity 0.8+ overflow protection
- Reentrancy guards on all state-changing functions
- Pausable for emergency situations
- Timelock delays on critical emergency actions
- Per-position and global lock amount limits enforced
- Ragequit cooldown prevents gaming reward distributions
- Reward snapshots prevent manipulation after notification
- Historical checkpoint data immutable once written
- Emergency withdrawals zero all voting power
- Frozen locks validated against already-frozen status
- Epoch ends validated against maximum lock duration
- Treasury address validated against zero address
- Reward tokens cannot be removed during active periods
- Balance checks for reward token transfers (fee-on-transfer protection)
- Precision maintained in reward calculations (1e18 scaling)
- Division by zero prevented in reward calculations
- Non-transferable token prevents secondary market manipulation
