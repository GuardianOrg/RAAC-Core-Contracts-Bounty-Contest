# RWAVault

## Overview

RWAVault (Real-World Asset Vault) is the core vault of the RAAC protocol that enables users to obtain **fractional exposure** to a diversified basket of real-world-backed assets such as RAAC NFTs, crvUSD, and future on-boarded stablecoins.  
The vault issues an ERC-20 index token ("RWA Index Token" / **iRAAC**) representing a pro-rata claim on the combined Net Asset Value (NAV) of all assets held inside the vault.

* **Hybrid design** – supports both fungible (ERC-20) and non-fungible (ERC-721) assets in a single contract.
* **Adapter pattern** – every asset type is wrapped by an adapter implementing a common interface to standardise deposits, withdrawals and valuations.
* **Random NFT redemption** – NFTs can be redeemed by burning index tokens, with the selection driven by Chainlink VRF for fairness.
* **Permissioned managers** – dedicated managers can perform peg-maintenance actions such as swapping idle stablecoins for NFTs in a single atomic transaction.
* **Composability** – the iRAAC token is ERC-20 compatible and can be supplied as **collateral** in RAAC's LendingPool and other DeFi protocols.

## Purpose

1. Offer composable, single-token exposure to a basket of real-world assets.
2. Provide liquidity to otherwise illiquid NFTs by fractionalising them into ERC-20 shares.
3. Facilitate automated, on-chain NAV accounting across heterogeneous asset classes.
4. Enable DAO-controlled peg maintenance mechanisms while preserving full transparency.

## Adapter Types

| Category | Description | Examples |
|----------|-------------|----------|
| **Depositable** | Assets that can be supplied to the vault and minted into shares. | crvUSD, RAAC NFT |
| **Redeemable ERC-721** | Sub-set of adapters whose NFTs can be randomly drawn and redeemed by users. | RAAC NFT |

Depositable adapters are whitelisted via `registerDepositableAdapter`, whereas redeemable adapters are whitelisted via `registerRedeemableERC721Adapter`.  
An adapter **must** first be registered with `registerAdapter` before it can be added to either list.

## Deposit Types

The vault supports three distinct deposit mechanisms, each serving different purposes:

### 1. Normal Deposit (`depositAsset`)
* **Access**: Any user with depositable assets
* **Minting fee**: Applies configurable minting fee (default 2%) on iRAAC tokens
* **Purpose**: Standard user deposits to gain fractional exposure to the vault's asset basket
* **Fee destination**: Collected fees go to the `FeeCollector` contract

### 2. Pool Deposit (`poolDepositAsset`)
* **Access**: Stability Pool contract only
* **Minting fee**: No fees applied
* **Purpose**: Used during liquidation events to deposit acquired assets
* **Optimization**: Gas-optimized path for automated liquidation processes

### 3. Admin Deposit (`adminDepositAsset`)
* **Access**: Managers only
* **Minting control**: Admin decides whether to mint iRAAC tokens or not (`mint` parameter)
* **Purpose**: Peg maintenance and NAV management operations
* **Flexibility**: Allows asset deposits without affecting token supply when `mint=false`

## Withdrawal Restrictions

### Public Withdrawals
* **No general withdrawals**: Users cannot withdraw assets at will
* **Redemption only**: Only approved ERC721 assets can be redeemed through the random selection process
* **Legal compliance**: Prevents cherry-picking of specific assets

### Admin Withdrawals (`adminWithdrawAsset`)
* **Access**: Managers only
* **Burn control**: Admin decides whether to burn iRAAC tokens or not (`burn` parameter)
* **Purpose**: Emergency asset management and peg maintenance
* **Flexibility**: Allows asset withdrawals without affecting token supply when `burn=false`

## NAV Management Strategy

### Impact of Minting/Burning
* **NAV sensitivity**: Minting and burning operations directly affect the Net Asset Value per share
* **Fluctuation risk**: Separate mint/burn operations can cause temporary NAV imbalances

### Automated Smart Contract Operations
* **Goal**: Smart contracts should automatically convert ERC20 assets to ERC721 assets
* **Single transaction execution**: Non-minting operations performed atomically to mitigate NAV fluctuations
* **Example workflow**: 
  - Vault holds 100K crvUSD + available 100K RAAC NFT
  - Admin contract uses crvUSD to purchase NFT and deposit back in single transaction
  - No intermediate NAV fluctuation occurs

### Manual Admin Operations
* **EOA requirement**: When admin EOA (Externally Owned Account) performs operations
* **Mandatory parameters**: Must set `minting=true` or `burning=true` appropriately
* **NAV protection**: Ensures NAV remains stable by matching asset changes with token supply changes

## Key Functions

| Function | Description | Access | Parameters |
|----------|-------------|--------|------------|
| `depositAsset` | Normal deposit with minting fee applied. | External | `adapter`, `data`, `receiver`, `minSharesOut` |
| `poolDepositAsset` | Fee-free deposit path for Stability Pool liquidations. | Stability Pool | `adapter`, `data`, `receiver`, `minSharesOut` |
| `adminDepositAsset` | Manager deposit with optional token minting. | Manager | `adapter`, `data`, `mint`, `minSharesOut` |
| `adminWithdrawAsset` | Manager withdrawal with optional token burning. | Manager | `adapter`, `data`, `receiver`, `burn`, `maxSharesBurn` |
| `redeemNFT` | Burn shares to redeem pre-selected NFT. | External | `_adapter`, `_tokenId`, `maxSharesBurn` |
| `burnVaultToken` | Burn index tokens held by an address. | Manager & Stability Pool | `from`, `amount` |
| `getNextRandomNFT` | Preview the next NFT that would be redeemed. | View | – |
| `requestRandomSeed` | Request new VRF seed after 72h delay to prevent expensive NFT deadlock. | External | – |
| `set*` helpers | Configure VRF consumer, fee collector, managers, etc. | Owner | – |

## Economics

### Minting Fee
* Configurable via `setIndexTokenMintingFee` (basis points, default **2 %**).
* Collected shares are forwarded to the `FeeCollector` contract under the fee-type `MINT_FEE`.

### Redemption
* **Pre-selection process**: After an NFT is redeemed, the next NFT to be redeemed is automatically selected using Chainlink VRF. For legal compliance, users cannot choose which specific NFT they want to redeem.
* **Transparency**: Users can preview which NFT they will receive before initiating redemption via `getNextRandomNFT()`. This allows users to check if they can afford the redemption and make informed decisions.
* **Redemption execution**: User burns shares equal to the valuation of the pre-selected NFT (rounded up).
* **Random selection algorithm** (using reservoir sampling for efficiency and uniformity):
  1. Read fulfilled random words from the VRF consumer.
  2. Use reservoir sampling to uniformly select a redeemable adapter with at least one NFT deposited.
  3. Select a specific token index within that adapter using the random seed.
* **Automatic re-selection**: A new VRF request is triggered automatically after every redemption to pre-select the next redeemable NFT.  
* **Manual seed refresh**: Anyone may request a new random seed after `vrfRequestDelay` (default 72 hours) via `requestRandomSeed` to prevent system deadlock.

### Preventing Redemption Deadlock
* **Problem scenario**: If the pre-selected NFT is too expensive, users may be unable to afford redemption, causing the system to become stuck.
* **Solution mechanism**: After 72 hours since the last VRF fulfillment, anyone can call `requestRandomSeed()` to generate a new random selection.
* **Deadlock prevention**: This ensures the vault doesn't remain permanently locked on an unaffordable NFT.
* **Fairness maintenance**: The new selection is still completely random, maintaining the legal compliance and fairness of the system.
* **Public accessibility**: Any user can trigger the refresh, not just managers, ensuring the system remains accessible.

## Security Features

### Frontrunning Protection
* **Internal accounting**: Each adapter maintains its own internal balance tracking rather than relying on `balanceOf(address(this))`
* **Donation immunity**: Direct token transfers (donations) to the contract are not counted in NAV calculations
* **Dust accumulation**: Any donated assets become permanently locked as dust in the contract, providing no economic benefit to attackers
* **Individual tracking**: NFTs are tracked individually in adapter storage rather than through external balance queries

### Adapter-Based Security
* **Isolated accounting**: Each asset type maintains separate internal ledgers through its adapter
* **Consistent valuation**: Asset values are determined by adapter logic, not external contract states
* **MEV resistance**: Prevents manipulation through direct asset transfers or balance inflation attacks

## RAACNFTVaultAdapterV2: Efficient NAV Calculation

### Adapter Overview
* **Inheritance**: `RAACNFTVaultAdapterV2` extends `ERC721VaultAdapter` with specialized functionality
* **Purpose**: Designed specifically for RAAC NFTs with real-world asset backing
* **Scope**: Currently the only supported NFT type, with no plans to support other NFT collections
* **Specialization**: Optimized for house price tracking and USD-based valuation systems

### The Scalability Challenge
* **Individual NFT tracking**: The vault contains individual RAAC NFTs, each with unique valuations
* **Frequent NAV updates**: Deposit/withdrawal operations require up-to-date NAV calculations
* **Performance bottleneck**: Looping through potentially 1,000+ NFTs for each NAV calculation would be gas-intensive and slow

### Running Sum Solution
* **Constant-time operations**: `RAACNFTVaultAdapterV2` maintains a running sum (`nftsValue`) of all NFTs in the vault
* **Efficient tracking**: Deposit and withdrawal operations update the running sum in real-time
* **O(1) complexity**: Total value calculation becomes a constant-time operation instead of O(n) where n = number of NFTs

### USD-Based Accounting
* **Storage currency**: The running sum is stored in USD, not crvUSD
* **Rationale**: Storing in crvUSD would cause incorrect constant total values during crvUSD price fluctuations
* **Conversion on demand**: When the vault requests `totalValue()`, the adapter converts USD to crvUSD using current exchange rates
* **Price stability**: This approach ensures NAV reflects actual asset value changes, not currency fluctuations

### Real-Time Price Synchronization
* **Automatic updates**: When RAACHousePrice oracle updates any tokenId price, it calls `notify()` on the adapter
* **Sync formula**: `totalValue = totalValue - previousPrice + newPrice`
* **Consistency guarantee**: Ensures the running sum always reflects current market valuations
* **No drift**: Prevents accumulation of pricing discrepancies over time

### Implementation Flow
1. **Deposit**: NFT added → running sum increased by NFT's USD value
2. **Withdrawal**: NFT removed → running sum decreased by NFT's USD value  
3. **Price update**: Oracle calls `notify()` → running sum adjusted for price change
4. **NAV request**: Vault calls `totalValue()` → USD sum converted to crvUSD and returned

### Performance Benefits
* **Gas efficiency**: Eliminates expensive loops over NFT collections
* **Real-time accuracy**: NAV always reflects current prices without computation delays
* **Scalability**: Performance remains constant regardless of NFT count in vault

## Implementation Details

* Inherits OpenZeppelin `Ownable` and `ReentrancyGuard` for access control & security.
* NAV is returned by `totalAssets()` which iterates over all registered adapters and sums their reported values.
* Share calculation follows the ERC-4626 formula with round-up to favour the vault in edge cases.
* Stability-pool deposits bypass minting fees and may call `burnVaultToken` to neutralise shares.
* All percentage values use **basis points** (`10000 = 100 %`).

## Contract Interactions

| External Contract | Purpose |
|-------------------|---------|
| **Adapters** (`IVaultAssetAdapter`) | Standardised asset wrappers with internal accounting for security and MEV protection. |
| **RAACNFTVaultAdapterV2** | Specialized NFT adapter with running sum NAV calculation and real-time price synchronization. |
| **RAACHousePrice Oracle** (`IRAACHousePrices`) | Provides USD house prices and triggers price sync notifications to NFT adapter. |
| **Vault Token** (`IVaultToken`) | ERC-20 representing fractional ownership (iRAAC). |
| **Stability Pool** | Provides liquidity during liquidations and can deposit directly. |
| **FeeCollector** | Receives minting fees in shares. |
| **Chainlink VRF** (`IBaseVRFv2Consumer`) | Supplies unbiased randomness for NFT selection. |

## Events Emitted

| Event | When | Parameters |
|-------|------|------------|
| `RedeemNFT` | Successful NFT redemption | `receiver`, `nftAddress`, `tokenId`, `sharesBurned` |
| `IndexTokenMintingFeeSet` | Owner updates minting fee | `indexTokenMintingFee` |
| `AdminDeposit` / `AdminWithdraw` | Manager executes peg-maintenance | `adapter`, `data`, `receiver` |
| `ManagerAdded` / `ManagerRemoved` | Owner updates manager list | `actor`, `receiver` |

## Access Control Summary

| Role | Abilities |
|------|-----------|
| **Owner** | Register/-unregister adapters, configure parameters, manage managers. |
| **Manager** | `adminDepositAsset`, `adminWithdrawAsset`, `burnVaultToken`. |
| **Stability Pool** | `poolDepositAsset`, `burnVaultToken`. |
| **Public User** | `depositAsset`, `redeemNFT`, view functions. |

## Error Handling

RWAVault reverts with clearly-named custom errors such as `InvalidAddress`, `InsufficientBalance`, `InvalidShares`, `InvalidVRFAddress`, and `NotManager` to aid off-chain decoding and testing.

## Notes

* Contract is upgrade-agnostic; audits are highly recommended before deployment.
* Full unit- and integration tests can be found under `test/` directory. 