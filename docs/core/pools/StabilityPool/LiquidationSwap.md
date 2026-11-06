# LiquidationSwap

> **Module type:** Core – Stability Pool
> 
> **Current deployment:** iRAAC / crvUSD Curve pool

## 1. Purpose
`LiquidationSwap` is a lean adapter the Stability Pool uses **exclusively** when it needs to convert collateral (the vault/index token) into the stable‐coin that repays debt during liquidations.  
Liquidations in the Lending Pool start from collateral that can be either **RAAC-NFT** or an **Index token**.  When a position is liquidated, the NFT is first deposited into the dedicated RWA vault which mints **iRAAC** (the fungible index token) 1-for-1.  The minted iRAAC (or an already supplied index token) is what `LiquidationSwap` then converts into **crvUSD** inside a Curve liquidity pool.

Key design goals:
* Keep the liquidation path modular – the Stability Pool only cares that it receives the output tokens, not *how* the swap is executed.
* Have a single, easily upgradeable contract in case a better swap route or AMM becomes favourable.
* Provide optional slippage protection against MEV / extreme volatility.

## 2. Configuration parameters
| Variable | Description | Typical value |
|----------|-------------|---------------|
| `liquidityPool` | Address of the Curve-like pool | current **iRAAC/crvUSD** pool |
| `vaultToken` | Token being sold | iRAAC |
| `swapToken` | Token being acquired | crvUSD |
| `slippageProtectionBps` | Tolerated deviation from the instantaneous quote reported by `get_dy()` (basis-points). | **50–100 bps** (0.5–1 %) |
| `enableSlippageProtection` | Global on/off switch. | `false` by default – enable in production |

### Recommended settings
```
setLiquidityPool(curvePool, 50);    // 0.5 % tolerance
setEnableSlippageProtection(true);
```
This guards against:
* sudden price impact during large liquidations;
* front-running / sandwich attacks that drain value from the protocol.

## 3. Fee-on-transfer considerations
The **iRAAC** token includes `feeBps` and `burnBps`, but fees are **only** charged when the token is transferred *into* the Curve pool.  If the pool already accounts for the fee internally, then:
* no additional slippage buffer is required for the fee itself;
* the recommended 0.5–1 % tolerance still covers normal volatility and MEV.

If you deploy a pool where the fee is NOT handled internally, either:
1. raise `slippageProtectionBps` to cover the expected fee, **or**
2. whitelist the pool in iRAAC so the fee is skipped, **or**
3. upgrade `LiquidationSwap` to forward the *post-fee* amount to `get_dy()`/`exchange()`.

## 4. Extensibility / future pools
Although today's deployment targets **iRAAC ⇄ crvUSD**, the same contract works for any
`vaultToken ⇄ stableCoin` pair supported by a 2-coin Curve pool.

Example upgrade path:
* Deploy new Curve pool (iRAAC / sUSD).
* Deploy new `LiquidationSwap` or reuse the same one after `setLiquidityPool(newPool, 75)`.
* Update `slippageProtectionBps` if the fee or volatility profile differs.

No change needed in the Stability Pool or the LiquidationStrategyProxy.

## 5. Functions overview
| Function | Access | Gas | Notes |
|----------|--------|-----|-------|
| `swap(uint256 amount)` | Stability Pool only | O(1) | Main entry-point. Emits `Swapped`.<br/>`nonReentrant`. |
| `setLiquidityPool(address lp,uint256 bps)` | Owner | O(1) | Caps `bps ≤ 10 000`. |
| `setStabilityPool(address sp)` | Owner | O(1) | One-time after deployment. |
| `setEnableSlippageProtection(bool)` | Owner | O(1) | Can be toggled in emergencies. |

## 6. Events
* `Swapped(address sender, uint256 sold, uint256 received)` – emitted once per liquidation-swap.

## 8. Security notes
1. **Re-entrancy** – guarded by `nonReentrant`, external calls happen after the guard.
2. **Only SP callable** – `swap()` checks `msg.sender == stabilityPool`.
3. **Slippage floor** – prevents MEV and excessive price movement.
4. **Fee mis-config** – setter reverts if `slippageProtectionBps > 10 000`.

---
*© © RAAC Protocol – This document lives in `docs/core/pools/StabilityPool/LiquidationSwap.md`.  Update it with every contract or parameter change.* 