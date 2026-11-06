# StabilityPool

## Overview

`StabilityPool` is a core contract of the RAAC protocol that acts as the first line of defence for the LendingPool during liquidations.  
Users can deposit **rToken** (currently `rcrvUSD`) into the pool and receive a 1&nbsp;:&nbsp;1 representation called **deToken**. These deposits are used to repay the debt of unhealthy borrowers that are liquidated through a dedicated strategy contract.  
In return, depositors maintain exposure to the underlying rToken and can withdraw it at any time while the contract is not paused.

![alt text](<./stabilityPoolDiagram.png>)

## Purpose

* Accept user deposits of rToken and issue deToken (1&nbsp;:&nbsp;1 peg)
* Provide liquidity that covers borrower debt during liquidations
* Delegate the actual liquidation logic to `LiquidationStrategyProxy`
* Maintain a list of **managers** that are allowed to trigger liquidations on behalf of the protocol
* Route seized collateral to the **RWA Vault** and handle token‐based accounting via the **Treasury** contract
* Offer flexible configuration for how collateral proceeds are split between mint, burn, swap and liquidity operations

## Key Functions

| Function | Description | Access | Parameters |
|----------|-------------|--------|------------|
| `initialize` | Initializes the up-gradable proxy instance | `initializer` | `_rToken`, `_deToken`, `_crvUSDToken`, `_lendingPool`, `_treasury`, `_liquidationStrategyProxy` |
| `deposit` | Deposit rToken and mint the same amount of deToken | `public` | `amount` – amount of rToken to deposit |
| `withdraw` | Burn deToken and withdraw the same amount of rToken | `public` | `deCRVUSDAmount` – amount of deToken to burn |
| `liquidateBorrower` | Delegate call to `LiquidationStrategyProxy` to close an unhealthy position | `manager` or `owner` | `poolAdapter`, `vaultAdapter`, `user`, `data`, `minSharesOut` |
| `setRWAVault` | Update the vault that receives seized collateral | `owner` | `_rwaVault` |
| `setLiquidationStrategyProxy` | Update the address of the liquidation strategy proxy | `owner` | `_liquidationProxy` |
| `setLiquidationVaultTokenSplit` | Configure how liquidation proceeds are split (mint / burn / swap / liquidity) | `manager` or `owner` | `mintBps`, `burnBps`, `swapBps`, `liquidityBps` (sum must equal `10000`) |
| `setLiquidationSwap` | Update the contract used for swapping collateral | `owner` | `_liquidationSwap` |
| `setLiquidityGauge` | Update the liquidity-gauge address that tracks rewards | `owner` | `_liquidityGauge` |
| `addManager` | Grant manager rights to an address | `owner` | `manager` |
| `removeManager` | Revoke manager rights from an address | `owner` | `manager` |
| `pause` / `unpause` | Emergency circuit-breaker | `owner` | – |
| **View helpers** | `getManagerList`, `isAddressManager`, `getUserDeposit`, `getTotalDeposits`, `balanceOf` | `view` | – |

## Implementation Details

* Built with OpenZeppelin's upgradeable pattern (`Initializable`, `OwnableUpgradeable`, `PausableUpgradeable`) and protected with `ReentrancyGuard`.
* Uses `SafeERC20` wrappers for secure token transfers.
* The rToken ↔ deToken exchange rate is fixed at 1&nbsp;:&nbsp;1 (no interest accrual inside the pool).
* Liquidations are executed via a **delegatecall** to the `LiquidationStrategyProxy`, allowing the strategy to be upgraded without migrating user funds.
* Manager addresses are stored in an on-chain array for easy enumeration by front-ends.
* Configurable `LiquidationVaultTokenSplit` enables fine-grained control over collateral processing.

## Interactions

* **RToken** – ERC-20 asset deposited by users (e.g. rcrvUSD)
* **DEToken** – ERC-20 token representing user share inside the StabilityPool
* **LendingPool** – queried to calculate borrower debt during liquidations
* **LiquidationStrategyProxy** – contains the actual liquidation logic (delegate-called)
* **Treasury** – receives fees and can interact with collateral proceeds
* **RWA Vault** – secure vault that stores seized NFTs / tokens as backing assets
* **Compliance Registry** – inherited through `WithCompliance` to block black-listed addresses

## Events

The contract emits a rich set of events (defined in `IStabilityPool`) such as `Deposit`, `Withdraw`, `ManagerAdded`, `LiquidationStrategyProxyUpdated`, and others to enable full on-chain transparency.

## Additional Features & Notes

1. **Upgradeable & Pausable** – the owner can pause all state-changing functions except emergency withdrawals.
2. **Manager Role** – multiple addresses can be assigned to act on behalf of the pool without transferring ownership.
3. **1:1 Accounting** – because deToken is always minted/burned at a 1:1 ratio, no exchange-rate math is required and accounting remains simple.
4. **Flexible Liquidation Flow** – using `delegatecall` ensures that new asset types or improved strategies can be rolled out with zero downtime.