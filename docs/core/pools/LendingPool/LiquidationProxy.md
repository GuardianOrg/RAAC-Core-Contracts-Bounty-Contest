# LiquidationProxy

## Overview

`LiquidationProxy` is a thin logic-only contract that contains all liquidation-related operations of the RAAC `LendingPool`.  
The proxy is **never called directly**; instead the `LendingPool` executes these functions through a *delegatecall*.  
A dedicated `onlyProxy` modifier guarantees this behaviour by reverting whenever a function is reached via a regular call.

## Purpose

- Isolate liquidation code from the main `LendingPool` contract to keep the byte-code size under the EVM limit.
- Offer a clear workflow for liquidations:
  1. **Initiate** – anybody can start a liquidation when a position becomes unhealthy.
  2. **Close** – the borrower can heal the position (repay entire amount) and cancel the liquidation during the grace period.
  3. **Finalise** – after the grace period, only the **Stability Pool** can finish the liquidation and seize the collateral.
- Prevent healthy positions from being liquidated by enforcing a `healthFactor > threshold` check.
- Protect insured borrowers by granting them extra time (`liquidationGracePeriod`) before collateral is sold.

## Liquidation Mechanics

### Position Under Liquidation
Once a user enters liquidation, they **remain under liquidation** even if their position health factor improves. The only way to exit liquidation is through one of two outcomes:
1. **Close Liquidation**: The borrower repays the **entire outstanding amount** during the grace period
2. **Finalize Liquidation**: The Stability Pool seizes collateral after the grace period expires

**Important**: Partial repayments are not allowed. The borrower must repay the complete debt to close the liquidation.

### Grace Period
The grace period is **purchased by insuring the entire position**. During this period:
- The borrower has exclusive right to close the liquidation
- **Full repayment** of the outstanding debt is required (no partial payments)
- If the borrower fails to repay during this period, the Stability Pool will finalize the liquidation

## Key Functions

| Function | Description | Access (delegate-caller) | Parameters |
|----------|-------------|-------------------------|-------------|
| `initiateLiquidation` | Starts liquidation when a position's health factor drops below `HEALTH_FACTOR_LIQUIDATION_THRESHOLD`. Emits `LiquidationInitiated`. | Any | `adapter`, `user`, `data` |
| `closeLiquidation` | Lets the borrower repay the **entire** outstanding debt and exit liquidation. Only works during the grace period or after if the debt has been fully repaid. Emits `LiquidationClosed`. | Borrower | `adapter`, `data` |
| `finalizeLiquidation` | Called by the Stability Pool once the grace period has expired to seize collateral, burn debt and transfer reserve assets. Emits `LiquidationFinalized`. | Stability Pool only | `adapter`, `user`, `data` |
| `calculateHealthFactorProxy` | Convenience view that forwards to `LendingPool.calculateHealthFactor`. | Internal | `adapter`, `user`, `data` |
| `getPositionScaledDebtProxy` | Reads the current scaled debt of a position. | Public View | `adapter`, `user`, `data` |

## Implementation Details

1. **Delegate-call Safety**  
   The immutable variable `__self` is set to the contract's own address during construction.  
   The `onlyProxy` modifier compares `address(this)` with `__self`; because a delegatecall preserves the *caller's* storage but changes `address(this)` to the calling contract (`LendingPool`), direct calls are rejected while delegatecalls succeed.

2. **Initiation Logic**  
   - Validates the position through the corresponding `IAssetAdapter`.
   - Updates the reserve state via `ReserveLibrary.updateReserveState`.
   - Reverts if the health factor is still above the liquidation threshold.
   - Stores liquidation metadata (`isUnderLiquidation`, `liquidationStartTime`).

3. **Grace-Period Handling**  
   Borrowers with an **insured** position receive a `liquidationGracePeriod` during which they can repay the **entire debt amount** and call `closeLiquidation`. The borrower must repay the complete outstanding amount - partial repayments will not close the liquidation. If they repay the full amount but forget to call `closeLiquidation`, they can still close later because the proxy checks the current debt balance.

4. **Finalisation**  
   - Ensures caller is the Stability Pool.
   - Transfers collateral to the Stability Pool and pulls reserve assets to cover the outstanding debt.
   - Burns the borrower's `DebtToken` and updates reserve indices / liquidity rates.

## Grace Period Parameter Management

The `liquidationGracePeriod` parameter is carefully managed to protect users who have purchased insurance:

- **No Decreases**: RAAC acknowledges that decreasing the grace period value would cause unexpected liquidations for users who purchased insurance expecting a certain time window.
- **Current Standard**: The grace period is expected to remain at **3 days**.
- **Increases Only**: If adjustments are needed (e.g., if the protocol was paused and users were under liquidation), the period would be **increased** to provide users with adequate time, respecting their insurance purchase.
- **Safety Check**: Before any decrease (if absolutely necessary), RAAC ensures that no user is currently under liquidation with an active grace period.

## Interactions

- **LendingPool** – executes proxy functions via delegatecall and shares storage (`LendingPoolStorage`).
- **IAssetAdapter** – validation, collateral transfer and pricing helpers.
- **ReserveLibrary** – state updates and interest-rate calculations.
- **DebtToken** – burning outstanding debt during finalisation.
- **Stability Pool** – the only entity allowed to call `finalizeLiquidation`.

## Notes

- Healthy positions (`healthFactor > threshold`) can **never** enter liquidation; any attempt reverts.
- Once under liquidation, positions remain under liquidation regardless of health factor improvements.
- **Complete debt repayment** is required to close liquidation - partial payments are not accepted.
- If a borrower fully repays but forgets to call `closeLiquidation`, they can still close later because the proxy checks the *current* debt balance.
- The design guarantees that collateral is seized **only** when the Stability Pool finalises the liquidation.
- The grace period protects insured borrowers by giving them dedicated time to arrange full repayment. 