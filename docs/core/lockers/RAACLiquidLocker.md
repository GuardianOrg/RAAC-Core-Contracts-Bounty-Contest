# RAACLiquidLocker

## Overview

`RAACLiquidLocker` is an upgradeable locker that accepts RAAC deposits, locks the underlying into `veRAAC` on a fixed epoch schedule, and allows users to borrow `leRAAC` against their locked collateral. The locker also harvests `veRAAC` rewards, swaps rewards into RAAC, and distributes RAAC to both locker depositors (as rewards) and to the `RAACMaturityVault` (to pay down `leRAAC` maturity debt).

## Purpose

- Lock RAAC into `veRAAC` while attributing ve-power to depositors via `VeBoost`
- Provide a collateralized borrowing facility by minting `leRAAC`
- Manage unlock scheduling and withdrawals on epoch boundaries
- Harvest rewards from `veRAAC`, swap them into RAAC, take protocol/bot fees, and distribute the remainder
- Push RAAC into `RAACMaturityVault.distribute()` to pay down `leRAAC` maturity debt
- Allow treasury-controlled governance interactions (gauge voting / governance voting)

## Key Functions

| Function Name | Description | Access | Parameters | Returns |
|---------------|-------------|--------|------------|---------|
| initialize | Initializes the contract (upgradeable pattern) | External (Initializer) | `_raac`<br>`_leRAAC`<br>`_veRAAC`<br>`_maturityVault`<br>`_zap`<br>`_intermediateRewardToken`<br>`_treasury`<br>`_cleverFeeRecipient`<br>`_raacBotLocker`<br>`_veBoost`<br>`_treasuryFeePercentage`<br>`_harvestBountyPercentage`<br>`_feeSharesBots`<br>`_feeSharesClever`<br>`_feeSharesTreasury` | None |
| deposit | Deposits RAAC and locks it into `veRAAC` for `lockDurationEpochs` | External | `_amount`: amount of RAAC | None |
| depositOnBehalfOf | Deposits RAAC for `_user` (on-behalf-of flow) | External (Keeper + `ON_BEHALF_OF_ROLE`) | `_user`: beneficiary<br>`_amount`: amount of RAAC | None |
| borrow | Borrows `leRAAC` (optionally deposits into maturity vault) | External | `_amount`: leRAAC amount<br>`_depositMaturityVault`: deposit to vault | None |
| borrowOnBehalfOf | Borrows for `_user` (on-behalf-of flow) | External (Keeper + `ON_BEHALF_OF_ROLE`) | `_user`<br>`_amount`<br>`_depositMaturityVault` | None |
| repay | Repays `leRAAC` debt (burns `leRAAC`), fee may apply | External | `_leRAACAmount`: amount to repay | None |
| requestUnlock | Reserves part of locked collateral to unlock at maturity epoch(s) | External | `_amount`: RAAC amount to unlock | None |
| withdrawUnlocked | Withdraws all matured reserved RAAC | External | None | None |
| donate | Donates RAAC to be distributed as rewards | External | `_amount`: RAAC amount | None |
| harvest | Claims `veRAAC` rewards, swaps into RAAC, takes fees, and distributes | External | `_recipient`: bounty receiver<br>`_minimunOut`: min RAAC output | `uint256`: harvested RAAC (pre-fees) |
| processVaultExpiredLocks | Releases expired `veRAAC` locks for vault funds and relocks excess liquidity beyond buffer | External (Keeper) | None | None |
| voteGauge | Votes on a gauge via a controller | External (Treasury) | `_controller`<br>`_gauge`<br>`_weight` | None |
| voteGovernance | Casts governance vote using delegated voting power | External (Treasury) | `_governance`<br>`_proposalId`<br>`_support` | None |
| getUserInfo | Returns a derived snapshot of a user’s position | External View | `_account`: user | `totalDeposited,totalPendingUnlocked,totalUnlocked,totalBorrowed,totalReward` |
| getUserLocks | Returns future pending unlock entries for a user | External View | `_account`: user | `EpochUnlockInfo[]`: pending unlock entries |
| updateWhitelist | Adds/removes an address as keeper | External (Owner) | `_keeper`<br>`_status` | None |
| update* | Update configuration (fees, treasury, zap, routes, etc.) | External (Owner) | Varies by setter | None |

## Implementation Details

### Core accounting model

- **Collateral**: user collateral is tracked as `UserInfo.totalLocked` (and global `totalLockedGlobal`).
- **Debt**: borrowing mints `leRAAC` and tracks debt as `UserInfo.totalDebt` (and global `totalDebtGlobal`).
- **Rewards**: rewards are tracked with `accRewardPerShare` and per-user `rewardPerSharePaid` and `rewards`. Rewards are used to automatically pay down debt before becoming withdrawable reward balance.
- **Unlock scheduling**: the contract records epoch unlock entries in `UserInfo.pendingUnlockList`:
  - `reserved=false`: entries created from deposits (rolling locks). When they mature, they are **auto-relocked** by pushing their epoch forward.
  - `reserved=true`: entries created from `requestUnlock()` (user exit intent). When they mature, they are credited into `UserInfo.totalUnlocked` and can be withdrawn via `withdrawUnlocked()`.

### Borrow health check

Borrowing and unlock requests enforce an account health invariant:

- User must satisfy \((totalDeposited - newUnlock) * reserveRate >= (totalDebt + newBorrow) * FEE_PRECISION\).

### Same-block interaction protection

Many user entrypoints use `noSameBlock` which prevents multiple interactions within the same block (`SameBlockInteraction`) to reduce manipulation opportunities.

### Reward harvesting and distribution

- Harvest workflow:
  - `veRAAC.claimReward()` to pull rewards
  - Swap reward tokens into an intermediate token and then into RAAC (either via `zap` or via manual routes with `approvedTargets`)
  - Apply fee splits:
    - **Treasury fee** (with optional splitting to bot locker / clever recipient / treasury)
    - **Harvest bounty** to the caller-provided recipient
  - Remaining RAAC is distributed via `_distribute()`:
    - Increases `accRewardPerShare` for locker depositors
    - Calls `maturityVault.distribute(address(this), amount)` to pay down maturity-vault debt

### Vault liquidity buffer relocking

`processVaultExpiredLocks()` can withdraw expired `veRAAC` locks owned by the locker contract and **relock only the excess** above a rolling liquidity buffer that accounts for:

- currently matured user withdrawals (`totalUnlockedGlobal`)
- matured-but-not-yet-credited reserved entries
- scheduled reserved unlocks in the next `bufferEpochSpan` epochs

## Data Structures

### EpochUnlockInfo
| Field | Type | Description |
|-------|------|-------------|
| pendingUnlock | uint192 | Amount of RAAC represented by this entry |
| unlockEpoch | uint64 | Epoch number (weeks) at which it matures |
| reserved | bool | `true` if user-reserved unlock, `false` if rolling lock |

### UserInfo
| Field | Type | Description |
|-------|------|-------------|
| totalDebt | uint128 | Outstanding `leRAAC` debt (after reward offsetting) |
| rewards | uint128 | Reward balance (after debt offsetting) |
| rewardPerSharePaid | uint256 | Checkpoint of `accRewardPerShare` |
| totalLocked | uint112 | Locked collateral amount |
| totalUnlocked | uint112 | Matured reserved amount available to withdraw |
| nextUnlockIndex | uint32 | Cursor into `pendingUnlockList` for efficient processing |
| lastProcessedEpoch | uint64 | Anti-manipulation epoch checkpoint |
| pendingUnlockList | EpochUnlockInfo[] | Per-user epoch unlock schedule |

### ConvertParam
| Field | Type | Description |
|-------|------|-------------|
| target | address | Call target for route execution |
| spender | address | Spender to approve for swap |
| data | bytes | Calldata for the swap route |

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| PRECISION | 1e18 | Precision for reward-per-share math |
| FEE_PRECISION | 1e9 | Precision for fee percentages |
| MAX_REPAY_FEE | 1e8 | Max repay fee (10%) |
| MAX_TREASURY_FEE | 5e8 | Max treasury fee (50%) |
| MAX_HARVEST_BOUNTY | 1e8 | Max harvest bounty (10%) |
| EPOCH_DURATION | 7 days | Epoch length used for unlock rounding |
| ON_BEHALF_OF_ROLE | keccak256(\"ON_BEHALF_OF_ROLE\") | AccessControl role for acting on behalf of users |

## Events

| Event Name | Description | Parameters |
|------------|-------------|------------|
| Deposit | When RAAC is deposited and locked | `depositor`: caller<br>`recipient`: credited user<br>`amount`: RAAC amount |
| Unlock | When a user reserves collateral for unlock | `account`: user<br>`amount`: RAAC amount |
| Withdraw | When a user withdraws matured reserved RAAC | `account`: user<br>`amount`: RAAC amount |
| Repay | When a user repays debt | `account`: user<br>`leRAACAmount`: amount repaid |
| Borrow | When `leRAAC` is borrowed | `borrower`: caller<br>`recipient`: credited user<br>`amount`: leRAAC amount |
| Claim | When rewards are claimed (if enabled in implementation) | `account`: user<br>`amount`: reward amount |
| Harvest | When rewards are harvested and distributed | `caller`: harvester<br>`reward`: distributed amount<br>`platformFee`: fee amount<br>`harvestBounty`: bounty amount |
| UpdateWhitelist | When keeper whitelist is updated | `whitelist`: keeper<br>`status`: bool |
| UpdateRepayFeePercentage | When repay fee is updated | `feePercentage`: 1e9 precision |
| UpdatePlatformFeePercentage | When treasury/platform fee is updated | `feePercentage`: 1e9 precision |
| UpdateHarvestBountyPercentage | When harvest bounty is updated | `percentage`: 1e9 precision |
| UpdateTreasury | When treasury is updated | `treasury`: address |
| UpdateBotLocker | When bot locker is updated | `locker`: address |
| UpdateCleverFeeRecipient | When clever fee recipient is updated | `newRecipient`: address |
| UpdateZap | When zap is updated | `zap`: address |
| UpdateBufferEpochSpan | When buffer span is updated | `span`: uint256 |
| UpdateIntermediateRewardToken | When intermediate reward token is updated | `intermediateRewardToken`: address |
| UpdateVeBoost | When VeBoost is updated | `veBoost`: address |
| UpdateFeeShares | When fee shares are updated | `feeSharesBots`<br>`feeSharesClever`<br>`feeSharesTreasury` |
| GaugeVote | When a gauge vote is cast | `controller`<br>`gauge`<br>`weight` |
| GovernanceVote | When a governance vote is cast | `governance`<br>`proposalId`<br>`support`<br>`votingPower` |

## Error Conditions

| Error Name | Description |
|------------|-------------|
| InvalidAmount | Invalid amount / overflow guard |
| NonZeroValue | Amount must be non-zero |
| InvalidAddress | Invalid address |
| InvalidPercentage | Invalid percentage |
| Unauthorized | Caller not authorized |
| InsufficientBalance | Insufficient balance |
| EpochNotReached | Epoch not reached |
| InsufficientCollateral | Health check failed |
| ZeroAddress | Zero address provided |
| FeeTooLarge | Fee exceeds maximum |
| InsufficientToUnlock | Unlock amount exceeds locked |
| InsufficientUnlocked | No matured unlocked funds |
| InsufficientOutput | Swap output below minimum |
| NotApproved | Route target not approved |
| SameBlockInteraction | Same-block interaction attempted |
| InvalidSlippageTolerance | Slippage tolerance invalid |
| InvalidTimestamp | Timestamp/epoch regression detected |
| InvalidToken | Invalid token in configuration |
| FeeSharesNotMatchingTreasuryFee | Fee shares do not sum to treasury fee |

## Access Control Roles

| Role / Mechanism | Description |
|------------------|-------------|
| Owner (`OwnableUpgradeable`) | Can update configuration (fees, zap, treasury, approved targets, keepers, etc.) |
| `DEFAULT_ADMIN_ROLE` | Set to initializer caller; manages AccessControl permissions |
| `ON_BEHALF_OF_ROLE` | Allows acting on behalf of users for deposit/borrow paths |
| Keeper whitelist (`isKeeper`) | Allows running operational functions like `processVaultExpiredLocks()` |
| Treasury (`onlyTreasury`) | Can call governance voting functions |

## Usage Notes

- Users should expect **epoch-based unlock timing**; unlock maturity is aligned to `EPOCH_DURATION`.
- `requestUnlock()` reduces collateral immediately; ensure health constraints remain satisfied.
- `noSameBlock` may cause failures for complex multi-call flows within the same block.
- Swap routing requires `approvedTargets` to be enabled for any low-level `call` route execution.

## Dependencies

- OpenZeppelin Upgradeable: `OwnableUpgradeable`, `AccessControlUpgradeable`, `ReentrancyGuardUpgradeable`
- Token ops: `IERC20`, `SafeERC20`
- RAAC interfaces:
  - `IveRAACToken` (veRAAC locking + reward claim)
  - `ILiquidEscrowedRAAC` (leRAAC mint/burn)
  - `IRAACMaturityVault` (debt paydown + optional deposit)
  - `IVeBoost` (ve power delegation)
  - `IZap` (reward swaps)
  - `ILLamaLocker` (bot locker reward distribution)
  - `IGaugeController`, `IGovernance` (voting integrations)

