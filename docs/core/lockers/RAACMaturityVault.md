# RAACMaturityVault

## Overview

`RAACMaturityVault` is an upgradeable vault that accepts deposits of `leRAAC` and converts them into claimable RAAC over time as RAAC is distributed into the vault. The vault tracks each user’s position as **unrealised** (still owed) and **realised** (claimable) amounts, and supports immediate or linear debt paydown depending on configuration.

## Purpose

- Allow users (or other protocol contracts) to deposit `leRAAC` for maturity conversion
- Track maturity debt paydown using an efficient “fraction” accumulator
- Convert distributed RAAC into user-claimable balances
- Support periodic (linear) distributions with configurable period length
- Support whitelisted distribution/harvest callers and protocol fee/bounty settings

## Key Functions

| Function Name | Description | Access | Parameters | Returns |
|---------------|-------------|--------|------------|---------|
| initialize | Initializes the contract (upgradeable pattern) | External (Initializer) | `_raac`<br>`_leRAAC`<br>`_platform`<br>`_zap`<br>`_governor`<br>`_platformFeePercentage`<br>`_harvestBountyPercentage` | None |
| deposit | Deposits `leRAAC` for the caller | External | `_amount`: leRAAC amount | None |
| depositFor | Deposits `leRAAC` credited to `_account` | External | `_account`<br>`_amount` | None |
| withdraw | Withdraws unrealised `leRAAC` back to a recipient | External | `_recipient`<br>`_amount` | None |
| withdrawAll | Withdraws all unrealised `leRAAC` | External | `_recipient` | None |
| claim | Claims all realised RAAC | External | `_recipient` | None |
| exit | Withdraws all unrealised `leRAAC` and claims all realised RAAC | External | `_recipient` | None |
| distribute | Distributes RAAC to pay down maturity debt | External (Whitelisted) | `_origin`<br>`_amount` | None |
| harvest | Harvests RAAC already in the vault and distributes it (fees/bounty apply) | External (Whitelisted) | `_recipient`<br>`_minimumOut` (unused) | `uint256`: harvested amount (pre-fees) |
| updatePendingDistribution | Updates internal linear distribution progress | External | None | None |
| updateWhitelists | Updates caller whitelist | External (Owner) | `_whitelists[]`<br>`_status` | None |
| updateGovernor | Updates governor address | External (Governor/Owner) | `_governor` | None |
| updatePlatformFeePercentage | Updates platform fee | External (Owner) | `_feePercentage` | None |
| updateHarvestBountyPercentage | Updates harvest bounty | External (Owner) | `_percentage` | None |
| updatePlatform | Updates platform fee recipient | External (Owner) | `_platform` | None |
| updateZap | Updates zap address | External (Governor/Owner) | `_zap` | None |
| updatePeriodLength | Updates reward period length | External (Governor/Owner) | `_length` | None |
| getUserInfo | Returns unrealised/realised amounts for a user | External View | `_account` | `unrealised, realised` |
| totalRAACInPool | Returns RAAC held minus undistributed linear leftover | Public View | None | `uint256` |

## Implementation Details

### Unrealised vs realised accounting

- **Unrealised**: portion of `leRAAC` deposit that has not yet been paid down by distributed RAAC.
- **Realised**: portion that has been paid down and can be claimed as RAAC.

The vault maintains:

- `totalUnrealised`, `totalRealised`
- a multiplicative accumulator `accUnrealisedFraction` which represents the product of:

\[
\prod_i \frac{totalUnrealised_i - reward_i}{totalUnrealised_i}
\]

Each user stores a checkpoint `accUnrealisedFractionPaid`, allowing their unrealised balance to be updated lazily on interaction.

### Distribution modes

- **Immediate** (`rewardInfo.periodLength == 0`): `distribute()` reduces global debt instantly.
- **Linear** (`rewardInfo.periodLength > 0`): `distribute()` sets/updates a `ratePerSecond` and debt is reduced over time when `_updatePendingDistribution()` is called (implicitly by most user actions).

### Claim semantics

When a user claims:

- Their realised RAAC is transferred to the recipient
- The vault burns the same amount of realised `leRAAC` via `leRAAC.burn(amount)`

## Data Structures

### UserInfo
| Field | Type | Description |
|-------|------|-------------|
| unrealised | uint128 | User unrealised `leRAAC` amount |
| realised | uint128 | User realised (claimable) RAAC amount |
| accUnrealisedFractionPaid | uint192 | Checkpoint of `accUnrealisedFraction` |
| lastDistributeIndex | uint64 | Last distribution index the user was updated at |

### LinearReward
| Field | Type | Description |
|-------|------|-------------|
| ratePerSecond | uint128 | Debt paydown rate per second |
| periodLength | uint32 | Period length in seconds; `0` means immediate |
| lastUpdate | uint48 | Timestamp of last update |
| finishAt | uint48 | End timestamp of current period |

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| E128 | \(2^{128}\) | Fraction scaling basis |
| FEE_PRECISION | 1e9 | Precision for fee percentages |
| MAX_PLATFORM_FEE | 5e8 | Max platform fee (50%) |
| MAX_HARVEST_BOUNTY | 1e8 | Max harvest bounty (10%) |

## Events

| Event Name | Description | Parameters |
|------------|-------------|------------|
| Deposit | When `leRAAC` is deposited | `account`<br>`amount` |
| Withdraw | When unrealised `leRAAC` is withdrawn | `account`<br>`recipient`<br>`amount` |
| Claim | When realised RAAC is claimed | `account`<br>`recipient`<br>`amount` |
| Distribute | When RAAC is distributed for debt paydown | `origin`<br>`amount` |
| Harvest | When a harvest occurs | `caller`<br>`amount` |
| UpdateWhitelist | When whitelist is updated | `whitelist`<br>`status` |
| UpdatePlatformFeePercentage | When platform fee is updated | `feePercentage` |
| UpdateHarvestBountyPercentage | When harvest bounty is updated | `percentage` |
| UpdatePlatform | When platform recipient is updated | `platform` |
| UpdateZap | When zap is updated | `zap` |
| UpdateGovernor | When governor is updated | `governor` |
| UpdatePeriodLength | When period length is updated | `length` |

## Error Conditions

| Error Name | Description |
|------------|-------------|
| ZeroAddress | Zero address provided |
| InvalidPercentage | Percentage exceeds maximum |
| NonZeroValue | Value must be non-zero |
| Unauthorized | Not whitelisted / not owner / not governor |
| InsufficientBalance | Withdraw amount exceeds unrealised balance |

## Access Control Roles

| Role / Mechanism | Description |
|------------------|-------------|
| Owner (`OwnableUpgradeable`) | Updates fee parameters, platform recipient, and whitelist |
| Whitelist (`isWhitelisted`) | Can call `distribute()` and `harvest()` |
| Governor (`governor`) | Can update some operational parameters (e.g. zap, period length) alongside owner |

## Usage Notes

- `deposit()` and `depositFor()` transfer `leRAAC` into the vault; ensure ERC20 approvals are set.
- In linear distribution mode, realised balances increase over time; most user actions call into `_updatePendingDistribution()` implicitly.
- `harvest()` currently distributes the vault’s RAAC balance (if any) and applies platform fee and bounty before calling internal distribution logic.

## Dependencies

- OpenZeppelin: `SafeERC20`, `OwnableUpgradeable`
- RAAC interfaces:
  - `IRAACMaturityVault`
  - `ILiquidEscrowedRAAC` (burning realised `leRAAC`)
  - `IERC20` (RAAC + leRAAC transfers)

