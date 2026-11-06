# LiquidationStrategyProxy

## Overview

`LiquidationStrategyProxy` extends the **Stability Pool** by encapsulating all business logic required to safely liquidate under-collateralised positions.  
The contract is deployed once as an **immutable implementation** and must be executed **exclusively through `delegatecall`** from the `StabilityPool` (or another authorised proxy).  
Direct interaction with the implementation is blocked by the `onlyProxy` modifier, guaranteeing that:

* state-changes are persisted in the caller's storage (i.e. the Stability Pool), and
* critical functions cannot be abused with a standalone call.

<embed src="./liquidation-flow.pdf"
       type="application/pdf"
       width="100%"
       height="900px" />

## Purpose

1. Determine whether a borrower can be liquidated and abort when the position is still healthy.
2. Repay the borrower's debt by un-wrapping **rToken → crvUSD** and forwarding the debt amount to the Lending Pool.
3. Transfer the borrower's collateral (ERC-20 or ERC-721) to the **RWA Vault** and mint the protocol's index token **iRAAC**.
4. Split the freshly minted iRAAC according to protocol parameters:
   * **Minting Fee** – transferred to the Treasury.
   * **Burn** – permanently removes supply and supports the token price.
   * **Swap** – swapped back to crvUSD via a dedicated swap contract; the obtained crvUSD is redeposited to regain rToken spent for the liquidation.
   * **Liquidity Rewards** – deposited into the Curve Gauge to earn external incentives.

By concentrating the above workflow in a separate delegate-callable module the Stability Pool remains compact and upgradeable without a storage clash.

## Liquidation Philosophy & Incentive Structure

### Manager-Driven Liquidations
**RAAC does not incentivize external parties to trigger liquidations.** All liquidations are handled exclusively by protocol managers. This design choice reflects the underlying asset characteristics and risk profile.

### Conservative Risk Parameters
The protocol employs highly conservative parameters that provide substantial safety margins:
- **Borrow Threshold**: 50%
- **Liquidation Threshold**: 80%

This 30% buffer provides ample room to trigger liquidations before bad debt occurs, ensuring protocol solvency.

### Minimal Bad Debt Risk
The risk of bad debt is extremely low due to several factors:

1. **Asset Stability**: Real estate is not volatile and does not experience rapid price fluctuations like crypto assets
2. **Regular Price Updates**: Property prices are updated weekly through oracle feeds
3. **Historical Performance**: Average real estate price drop per year is around 15%
4. **Government Backing**: RAAC focuses on Section 8 housing, which is subsidized by the government, providing additional stability
5. **Geographic Diversification**: Properties are purchased in states with low recession risk

### Backstop Mechanism
In the unlikely event of bad liquidation resulting in insufficient collateral coverage, the treasury can supply crvUSD externally to ensure the 1:1 relationship between DEToken and RToken is maintained.

### User Incentive Structure
While users are not directly incentivized for liquidations, they are incentivized to participate in the stability pool through the following yield-maximizing flow:

1. **Deposit** liquidity in the lending pool to receive **RToken**
2. **RToken earns interest** from borrowers
3. **Deposit RToken** in the stability pool to receive **DEToken**
4. **Stake DEToken** to receive:
   - Rental yield from underlying real estate assets
   - Additional rewards from gauges (e.g., RWA gauge)

This design ensures a clean architecture where all rewards are redirected to gauges rather than distributed across multiple contracts, making the overall system more efficient and less complex.

### Liquidation Mechanics
At liquidation, the **entire debt is taken along with the underlying asset**. The debt is paid by unwrapping the RToken that stability pool users have supplied, ensuring the pool can cover liquidation costs while maintaining its peg to the underlying assets.

**Grace Period Mechanism:**
When a user enters liquidation, they are provided with a **grace period** during which they can resolve their position. Key aspects of this mechanism include:

- **Full Debt Repayment Required**: During the grace period, the user must repay the **ENTIRE debt amount** (not partial payments) to close the liquidation
- **Liquidation Status Persistence**: Once a user is under liquidation, they remain under liquidation regardless of whether their health factor improves during the grace period. This is a deliberate design choice to ensure liquidation certainty
- **Grace Period Expiration**: If the grace period expires without full debt repayment, the **Stability Pool automatically liquidates** the user by repaying the debt and seizing the underlying asset
- **No Partial Recovery**: Even if market conditions improve and the position becomes healthier during liquidation, the user must still repay the entire debt amount to exit liquidation status

**Asset Processing Flow:**
1. **Asset Deposit**: The liquidated asset is deposited into the **RWA Vault**
2. **iRAAC Minting**: The RWA Vault mints **iRAAC** tokens representing the underlying real estate asset
3. **iRAAC Distribution**: The minted iRAAC is split according to protocol parameters:
   - **Treasury Percentage**: Transferred to the treasury for protocol operations
   - **Burn Percentage**: Permanently burned to increase NAV and incentivize iRAAC holders
   - **Swap Percentage**: Swapped for crvUSD through a RAAC-deployed Curve pool (iRAAC <> crvUSD)
   - **Liquidity Percentage**: Sent to the **Fee Collector**, which then distributes to Curve gauges for liquidity mining rewards

## Access Control & Safety

| Mechanism | Description |
|-----------|-------------|
| `onlyProxy` | Ensures functions can only be executed via `delegatecall` – protects the implementation from being called directly. |
| Manager list (in Stability Pool) | Only **managers** or the **owner** can trigger `liquidateBorrower`.  Delegation keeps the check in the caller contract and not in the proxy. |
| Extensive Input Validation | • Adapters must be registered.<br>• Collateral token of pool & vault adapters must match.<br>• `data` describing the asset (amount or tokenId) must pass adapter validation.<br>• Debt must be non-zero.<br>• Stability Pool must hold enough rToken / crvUSD. |

## Key Functions

| Function | Visibility | Description |
|----------|------------|-------------|
| `liquidateBorrower(address poolAdapter, address vaultAdapter, address user, bytes data, uint256 minSharesOut)` | external (onlyProxy) | Main entry point invoked by Stability Pool. Executes a full liquidation cycle and emits `BorrowerLiquidated`. |
| `_handleLiquidation(address poolAdapter, address vaultAdapter, bytes data)` | internal | Deposits collateral into the RWA Vault, calculates the **liquidation split** and routes each share (fee, burn, swap, liquidity). |
| `_handleSwap(uint256 amount)` | internal | Swaps iRAAC for crvUSD using `ILiquidationSwap` implementation. |
| `_handleLiquidityRewards(uint256 amount)` | internal | Deposits iRAAC into a Curve Liquidity Gauge to farm external rewards. |
| `_handleTreasuryFee(uint256 amount)` | internal | Transfers the minting fee share to the Treasury. |

### Liquidation Split Structure

```solidity
struct LiquidationVaultTokenSplit {
    uint256 mintPercentage;      // → treasury
    uint256 burnPercentage;      // → burn
    uint256 swapPercentage;      // → swap
    uint256 liquidityPercentage; // → gauge
} // total must equal 100_00 (100%)
```

Percentages are stored in **basis points** (two decimals). The contract reverts when the four values do not sum up to `100_00`.

## Liquidation Flow (Step-by-Step)

1. **Pre-checks**  
    a. `lendingPool.updateState()` – synchronise interest.  
    b. Validate adapters, user debt and `data`.  
    c. Compute the rToken required to cover the outstanding debt.
2. **Un-wrap rToken → crvUSD** (if needed) by calling `lendingPool.withdraw`.
3. **Repay Debt**  
    a. Approve crvUSD to Lending Pool.  
    b. Call `lendingPool.finalizeLiquidation` – clears borrower's debt and transfers collateral to the Stability Pool.
4. **Collateral Handling** via `_handleLiquidation`  
    a. Delegate-call adapter's `approve` (for ERC-721 / ERC-20 as needed).  
    b. Deposit collateral into RWA Vault → receive iRAAC.  
    c. Split iRAAC according to `liquidationSplit` and route each portion (treasury, burn, swap, gauge).
5. **Rebalance** – any remaining crvUSD is re-deposited into the Lending Pool to reclaim rToken.
6. **Emit Event** – `BorrowerLiquidated(user, asset, data, debtAmount)`.

## Events

| Event | Emitted When | Parameters |
|-------|--------------|------------|
| `BorrowerLiquidated` | A borrower's position has been fully liquidated | `user`, `assetAddress`, `data`, `amount` |

## Error Conditions

| Error | Condition |
|-------|-----------|
| `InvalidAmount` | Borrower's debt is zero. |
| `CollateralAndParamterDataMismatch` | Provided `data` does not match collateral information. |
| `AdaptersAssetMismatch` | Asset tokens of pool & vault adapters do not match. |
| `InsufficientBalance` | Stability Pool lacks required rToken or crvUSD. |
| `ApprovalFailed` | ERC-20 approval returns `false`. |
| *Direct calls not allowed* | Triggered by `onlyProxy` when called directly. |

## Dependencies

- OpenZeppelin `IERC20` interface
- Internal Interfaces:  
  `IVaultAssetAdapter`, `IAssetAdapter`, `ILiquidationSwap`, `ICurveLiquidityGaugeV5`, `ILendingPool`, `IBaseHybridVault`, `ITreasury`, `IRToken`

## Test Checklist

1. **Healthy Position** – ensure `liquidateBorrower` reverts when LTV is below liquidation threshold.
2. **Adapter Validation** – attempt liquidation with non-registered adapters and expect revert.
3. **ERC-20 & ERC-721 Variants** – cover both collateral types.
4. **Split Percentages** – verify sum == 100% and each route (treasury, burn, swap, gauge) receives correct amounts.
5. **Approval Failure** – simulate ERC-20 returning `false` and expect `ApprovalFailed`.
6. **Proxy Protection** – direct call to implementation must revert.

## Notes

- All percentage calculations use **basis points** (`100_00 = 100%`).
- The module accepts that liquidation might incur slippage; risk is evaluated off-chain by managers before calling the function.
- The stability of the protocol's debt is preserved because any crvUSD used is redeposited to reclaim rToken at the end of the cycle.
- **No liquidation incentives are provided** – all liquidations are manager-driven to maintain protocol stability and prevent unnecessary liquidation pressure.
- The conservative liquidation parameters (50% borrow, 80% liquidation threshold) combined with real estate's inherent stability significantly reduce the likelihood of bad debt.
- The protocol's focus on government-subsidized Section 8 housing in low-risk states provides additional layers of protection against market volatility. 