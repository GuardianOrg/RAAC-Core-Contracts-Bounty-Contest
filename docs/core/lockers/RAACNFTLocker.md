# RAACNFTLocker

## Overview

`RAACNFTLocker` is a “temple” contract that holds RAAC NFTs and forwards them into a `LLamaLocker` for time-based locking and reward accrual. Each locked NFT grants the owner “shares” used to pro-rata distribute reward tokens claimed from the underlying locker. The contract also supports an optional “class” system where users select a category per NFT (e.g., for protocol UX/segmentation).

## Purpose

- Lock RAAC NFTs into an underlying `ILLamaLocker` instance
- Track per-NFT lock metadata (owner, timestamps, selected class)
- Distribute reward tokens received from the underlying locker to NFT holders based on shares
- Provide admin controls: pause/unpause, manage available classes, rescue tokens

## Key Functions

| Function Name | Description | Access | Parameters | Returns |
|---------------|-------------|--------|------------|---------|
| lock | Transfers NFTs into the temple and locks them in `LLamaLocker` | External | `tokenIds_`: NFT ids<br>`classHash_`: selected class | None |
| unlock | Unlocks NFTs after the unlock window, claims rewards, returns NFTs to user | External | `tokenIds_`: NFT ids | None |
| claim | Claims accumulated rewards for the caller and transfers to recipient | External | `recipient_`: reward recipient | `ILLamaLocker.Claimable[]` |
| sync | Syncs reward tokens and pulls rewards from the underlying locker | Public | None | None |
| getLocks | Returns all active locks (scans up to `MAX_SUPPLY`) | External View | None | `NFTLock[]` |
| getLocksByOwner | Returns lock info for a specific owner | External View | `owner_` | `NFTLock[]` |
| claimable | Returns claimable amount for a token for an account | Public View | `account_`<br>`token_` | `uint256` |
| claimables | Returns claimables for all reward tokens | External View | `account_` | `ILLamaLocker.Claimable[]` |
| getRewardTokens | Returns the list of active reward tokens | External View | None | `address[]` |
| getClaimedRewards | Returns previously claimed rewards by token | External View | `account_` | `ILLamaLocker.Claimable[]` |
| getAccountDetails | Returns per-NFT details for a user | External View | `account_` | token ids + timestamps + class hashes |
| getCategoryCount | Returns how many NFTs a user has in a class | External View | `user`<br>`classHash` | `uint256` |
| addClass | Adds a new available class | External (Manager) | `className_` | None |
| removeClass | Removes an available class | External (Manager) | `className_` | None |
| setClassModifiable | Enables/disables class changes | External (Manager) | `isModifiable_` | None |
| changeClass | Changes the class for a locked NFT | External | `tokenId_`<br>`newClassHash_` | None |
| pause / unpause | Pauses/unpauses lock and class changes | External (Pauser) | None | None |
| rescueTokens | Transfers any ERC20 token balance out | External (Admin) | `token_`<br>`recipient_` | None |

## Implementation Details

### NFT locking flow

- `lock()`:
  - Validates input and class availability
  - Calls `_sync()` to ensure reward state is up to date
  - Transfers each NFT from the user to the temple
  - Records `locks[tokenId]` including `classHash` and `classSelectedAt`
  - Increases user shares by `tokenCount * 1e18`
  - Forwards the lock to the underlying `ILLamaLocker.lock(tokenIds_)`

### Unlock window

`unlock()` enforces a minimum lock duration:

- `unlockTime = lockedAt + (EPOCH_DURATION * LOCK_DURATION_IN_EPOCH)`
- Reverts with `InvalidUnlockWindow()` if called too early

After unlocking from the underlying locker, the contract syncs/claims rewards, decreases shares, then transfers NFTs back to the user.

### Rewards distribution

The temple keeps a per-token `rewardPerShares` accumulator (1e18 precision) and per-user `rewardIndices`/`claimedRewards` checkpoints:

- `_sync()` calls `locker.claim(address(this))` and distributes each received reward token by increasing `rewardPerShares[token]`
- `claimable()` computes the user’s entitlement from shares minus previously claimed amounts
- `claim()` transfers the claimable amounts to a recipient

## Data Structures

### NFTLock (`ILLamaTemple.NFTLock`)
| Field | Type | Description |
|-------|------|-------------|
| owner | address | Owner who deposited the NFT |
| lockedAt | uint256 | Timestamp when locked into temple |
| tokenId | uint256 | NFT id |
| classHash | bytes32 | Selected class identifier |
| classSelectedAt | uint256 | Timestamp class was selected/updated |

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| MAX_SUPPLY | 1111 | Max NFT supply scanned by `getLocks()` |
| EPOCH_DURATION | 7 days | Epoch duration used for unlock timing |
| LOCK_DURATION_IN_EPOCH | 4 | Number of epochs required before unlock |
| PAUSER_ROLE | keccak256(\"PAUSER_ROLE\") | AccessControl role for pausing |
| MANAGER_ROLE | keccak256(\"MANAGER_ROLE\") | AccessControl role for class management |

## Events

> Note: core events are defined on the interface `ILLamaTemple`.

| Event Name | Description | Parameters |
|------------|-------------|------------|
| Locked | When NFTs are locked into the temple | `owner`<br>`tokenIds` |
| Unlocked | When NFTs are unlocked and returned | `owner`<br>`tokenIds` |
| RewardSynced | When rewards are synced from underlying locker | `token`<br>`amount` |
| RewardDistributed | When a reward token amount is distributed locally | `token`<br>`amount` |
| SharesUpdated | When account shares change | `account`<br>`newShares` |
| ClassAdded | When a class is added | `className` |
| ClassRemoved | When a class is removed | `className` |
| ClassSelected | When a class is selected | `account`<br>`className` |
| ClassModifiableSet | When class modifiability is toggled | `isModifiable` |
| ClassChanged | When a locked NFT’s class is changed | `tokenId`<br>`oldClass`<br>`newClass` |

## Error Conditions

> Note: core errors are defined on the interface `ILLamaTemple`.

| Error Name | Description |
|------------|-------------|
| InvalidAction | Invalid action (e.g., empty list, wrong owner) |
| InvalidClass | Class hash not available |
| ClassNotModifiable | Class changes disabled |
| ClassAlreadySelected | Class already set |
| ClassAlreadyExists | Attempt to add existing class |
| ClassDoesNotExist | Attempt to remove missing class |
| InvalidRewardToken | Token not recognized as reward token |
| InvalidRewardAmount | Invalid reward amount |
| InvalidTotalShares | Total shares is zero when distributing |
| InvalidRecipient | Recipient is zero address |
| NotSynced | Reward sync required |
| InvalidUnlockWindow | Unlock called too early |

## Access Control Roles

| Role / Mechanism | Description |
|------------------|-------------|
| `DEFAULT_ADMIN_ROLE` | Can call `rescueTokens()` and manage roles |
| `PAUSER_ROLE` | Can `pause()` / `unpause()` |
| `MANAGER_ROLE` | Can add/remove classes and toggle class changes |
| `Pausable` | `lock()` and `changeClass()` are gated by `whenNotPaused` |

## Usage Notes

- Users must approve the temple to transfer their NFTs before calling `lock()`.
- Unlock timing is enforced by epoch duration and lock duration constants.
- Reward token list is discovered from the underlying locker (`getRewardTokens()`), then used for local distribution.

## Dependencies

- OpenZeppelin: `AccessControl`, `ReentrancyGuard`, `Pausable`, `Ownable`, `ERC721Holder`, `SafeERC20`, `Math`, `SafeCast`
- RAAC interfaces:
  - `ILLamaTemple` (events/errors + lock metadata)
  - `ILLamaLocker` (underlying lock/unlock + reward claim)
  - `IERC721`, `IERC20`

