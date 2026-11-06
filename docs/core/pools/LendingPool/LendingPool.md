# LendingPool

## Overview

The **LendingPool** is the core contract of the RAAC money-market.  It manages deposits, withdrawals, borrowing, repayment and liquidation while outsourcing collateral specific logic to **Adapters**.  Any token/NFT can be used as collateral as long as a compliant adapter is registered.

![lending-pool](<./lendingPoolDiagram.png>)

## Purpose

- Hold the main liquidity of the protocol (crvUSD) and mint **RToken** receipts against deposits
- Abstract collateral management via adapters so the pool logic stays asset agnostic
- Accrue interest using an index based model and a prime-rate driven interest curve
- Enforce protocol & risk parameters (caps, thresholds, buffer ratio, etc.)
- Provide optional insurance with a grace-period for under-collateralised positions
- Integrate with an external vault to harvest yield while keeping a liquidity buffer

## Parameters

All mutable parameters are changed through `setParameter(OwnerParameter param, uint256 newValue)` and are grouped in two buckets:

### Protocol (risk) parameters  
`PROTOCOL_ROLE`

| Enum | Description |
|------|-------------|
| `LendingPoolBorrowCap` | Maximum total debt the pool can create |
| `LendingPoolSupplyCap` | Maximum total deposits the pool can accept |
| `BorrowThreshold` | % of collateral value that can be borrowed (in bp) |
| `LiquidationThreshold` | % at which a position becomes liquidatable |
| `LiquidationGracePeriod` | Seconds given to insured users to repay |
| `LiquidityBufferRatio` | Portion of liquidity kept on-chain vs vault (currently 20%/80% split) |
| `WithdrawalStatus` | `1` pauses user withdrawals, `0` un-pauses |
| `CanPaybackDebt` | Allows third-party repayments (`1`/`0`) |

### Governance parameters  
`GOVERNANCE_ROLE`

| Enum | Description |
|------|-------------|
| `InsuranceFee` | % fee (bp) charged when a user buys insurance |
| `ProtocolFeeRate` | Interest spread captured by the protocol (RAY) |
| `LendingPoolDepositFee` | % fee (bp) on deposits |
| `VaultOpeningFee` | Fixed fee (reserve asset) to open a collateral vault |

An event `ParameterChanged(param, oldValue, newValue)` is emitted on every update.

## Collateral Adapters

Each collateral type is integrated through an **Adapter** that implements [`IAssetAdapter`](../../interfaces/core/pools/LendingPool/IAssetAdapter.sol).  The adapter translates generic pool calls (`depositAsset`, `withdrawAsset`, `borrow`, `repay`, …) into asset-specific logic.  Adapters are whitelisted by the owner via `registerAdapter` / `unregisterAdapter`.

## Core Mechanics

### Deposits & RToken minting

1. User calls `deposit(amount)` sending **crvUSD**.  
2. A deposit fee (`LendingPoolDepositFee`) is transferred to the `FeeCollector`.  
3. Net amount is supplied and the user receives **RToken**.  
4. Total liquidity must stay below `LendingPoolSupplyCap`.

**Implementation notes**
- Depositors receive **RToken** 1-to-1 against supplied **crvUSD** (18 decimals).
- Deposit fee percentage is governed by `LendingPoolDepositFee` (governance parameter).
- Governance can later adjust the supply cap to control growth.


### Vault Position & Collateral

Before interacting with any adapter the user must pay the one-off `VaultOpeningFee` via `openVaultPosition()`.  Collateral is then managed with:

| Function | Description |
|----------|-------------|
| `depositAsset(adapter, data)` | Supplies collateral through the adapter |
| `withdrawAsset(adapter, data)` | Withdraws collateral; reverts if health factor would fall below liquidation threshold |

### Borrowing

| Function | Description |
|----------|-------------|
| `borrow(adapter, data, amount)` | Standard borrow; reverts if resulting health factor < threshold |
| `borrowWithInsurance(adapter, data, amount)` | Borrows and immediately insures the entire outstanding debt. Fee = `(uninsuredDebt + amount) * InsuranceFee` |

`_validateBorrow` enforces:
- Pool utilisation below `LendingPoolBorrowCap`  
- Adequate collateral based on `BorrowThreshold`

**Insurance flow**
- Default grace period is 72 hours (`LiquidationGracePeriod`, 3 days) during which the borrower can fully repay and call `closeLiquidation` to avoid collateral seizure.
- After an insured position borrows again, the **new debt must also be insured**; otherwise the previous insurance is forfeited.
- If a user opts-out (repays without re-insuring) they must pay the fee on **their entire debt** when re-enabling insurance later.

### Repayment

| Function | Description |
|----------|-------------|
| `repay(adapter, data, amount)` | Self repayment |
| `repayOnBehalf(adapter, data, amount, user)` | Third-party repayment; `amount` must be ≥ 1 % of the user's scaled debt |

- Repayment, deposit, withdrawal **or borrowing** will revert while the position is flagged `isUnderLiquidation` (unless the user is insured and within the grace period for `repay`).

### Liquidation lifecycle

| Stage | Callable by | Function | Notes |
|-------|-------------|----------|-------|
| Start | Anyone | `initiateLiquidation` (proxy) | Marks position under liquidation when health factor < 1 |
| Close | Borrower | `closeLiquidation` (proxy) | Can be executed during _grace period_ if the debt is fully repaid (requires insurance) |
| Finalize | StabilityPool | `finalizeLiquidation` (proxy) | After grace period, transfers collateral & settles debt |

> All three functions are executed via delegate-call proxies (`liquidationProxy`) to keep LendingPool byte-code small.

### Liquidity Buffer & Vault

The protocol implements a **Curve SCRVUSD vault** as the vault proxy for yield generation. This is a simple vault with no strategy, no deposit limits, and no withdraw limits. The share price is expected to be monotonously increasing.

**Liquidity Rebalancing**
- **Target allocation**: 20% of liquidity remains in the lending pool, 80% is deposited to the vault
- **Trigger events**: Rebalancing occurs after every deposit, withdraw, repay, borrow, and liquidation operation
- **Yield harvesting**: On each deposit/withdraw operation, the protocol harvests yield, prioritizing the withdraw amount
- The protocol attempts to extract the entire yield on each rebalancing; any remaining yield is harvested in subsequent operations

**Safety Measures**
- Although the vault is simple, `maxWithdraw` logic is maintained for safety
- The protocol's logic contains assumptions specific to SCRVUSD and is not compatible with other strategy-based vaults

**Vault Changes & Risk Management**
> ⚠️ **Critical Security Requirement**: If the vault ever needs to be changed, the new contract **MUST be reaudited** since logic differs from vault to vault. The current implementation has assumptions that apply to SCRVUSD only and not other strategy-based vaults.

**Vault Migration Process**
When the owner sets a new vault with `setVault`:
1. The contract attempts to withdraw the entire amount from the old vault
2. It calculates the split between liquidity and yield
3. Funds are distributed accordingly to the new vault
4. **Failsafe**: If the protocol cannot withdraw the entire amount but some SCRVUSD shares remain, these shares are sent to the `FeeCollector` so managers can distribute them accordingly, ensuring no funds are lost

## Key Functions

| Function | Description | Access |
|----------|-------------|--------|
| `deposit(amount)` | Deposit reserve asset → mint RToken | Any |
| `withdraw(amount)` | Redeem RToken for reserve asset | Any |
| `openVaultPosition()` | Pays the vault opening fee | Any |
| `depositAsset(adapter, data)` | Deposit collateral | Any |
| `withdrawAsset(adapter, data)` | Withdraw collateral | Any |
| `borrow(adapter, data, amount)` | Borrow reserve asset | Any |
| `borrowWithInsurance(adapter, data, amount)` | Borrow with insurance | Any |
| `repay(adapter, data, amount)` | Repay own debt | Any |
| `repayOnBehalf(adapter, data, amount, user)` | Third-party repayment (≥1 %) | Any |
| `initiateLiquidation(adapter, user, data)` | Start liquidation | Any |
| `closeLiquidation(adapter, data)` | Close liquidation during grace | Borrower |
| `finalizeLiquidation(adapter, user, data)` | Finalize liquidation | StabilityPool |
| `setParameter(param, value)` | Update protocol/governance parameter | Roles (see above) |
| `setPrimeRate(rate)` | Updates the base prime rate | PrimeRateOracle |
| `setVault(address)` | Change yield vault | Owner |

## Implementation Details

- Built with OpenZeppelin (ReentrancyGuard, Pausable, Ownable, AccessControl, SafeERC20, ERC721Holder)
- Interest accrues using separate **liquidity** and **usage** indices (`ReserveLibrary`)
- Dynamic interest curve: `baseRate` ⇒ `optimalRate` ⇒ `maxRate` around utilisation & prime rate
- Reserve liquidity is automatically rebalanced after every deposit/withdraw/borrow/repay
- Insurance state is tracked per position (`isInsured`, `rawInsuredBalance`)
- Vault interaction and liquidation logic are delegated through proxies to keep byte-code size minimal

## Interactions

- **Adapters (`IAssetAdapter`)** – any collateral wrapper (ERC-20, ERC-721, RWA, …)
- **RToken** – interest bearing receipt token
- **DebtToken** – tracks scaled debt per position
- **StabilityPool** – backstop that executes liquidations
- **Curve crvUSD Vault** (optional) – yield source for idle liquidity
- **FeeCollector** – receives protocol, deposit & insurance fees

## Notes

- Deposits/withdrawals of the StabilityPool bypass the timelock and deposit fee.
- Insurance resets to `false` once the position is fully repaid.
