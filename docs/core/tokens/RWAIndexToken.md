# RWAIndexToken

## Overview

The **RWAIndexToken** is an ERC-20 compliant token representing ownership shares in a Real-World-Asset (RWA) vault within the RAAC protocol. In addition to standard ERC-20 functionality, it introduces
fee-aware transfers that automatically route swap fees to the protocol's `FeeCollector` and an optional
burn component that can be used to reduce supply on each swap.

## Purpose

- Represent user ownership in an RWA vault (minted and burned by the vault contract)
- Apply configurable swap and burn fees when the token is traded on designated AMM pairs
- Forward collected fees to a dedicated `FeeCollector` contract for protocol revenue
- Allow the protocol owner to maintain and update vault, fee collector and fee parameters

## Key Functions

| Function Name | Description | Access | Parameters |
|---------------|-------------|--------|------------|
| `setVault` | Assigns the vault allowed to mint / burn tokens | **Owner** | `_vault`: address of the vault |
| `setFeeCollector` | Assigns the fee collector contract | **Owner** | `_feeCollector`: address of the fee collector |
| `setFees` | Updates swap fee and burn fee (in BP, out of 10 000) | **Owner** | `_swapFeeBP`: swap fee<br>`_burnFeeBP`: burn fee |
| `setSwapPair` | Adds / removes an AMM pair that triggers fee logic | **Owner** | `pair`: AMM pair address<br>`enabled`: bool |
| `mint` | Mints tokens to `to` | **Vault** | `to`: recipient<br>`amount`: uint256 |
| `burn` | Burns tokens from `from` | **Vault** | `from`: address<br>`amount`: uint256 |
| `transfer` | ERC-20 transfer with fee logic | Public | `recipient`, `amount` |
| `transferFrom` | ERC-20 transferFrom with fee logic | Public | `sender`, `recipient`, `amount` |

## Constants & State Variables

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `FEE_DENOM` | `uint256` | `10000` | Denominator for basis-point math |
| `swapFeeBP` | `uint256` | `200` | Swap fee (2 %) applied on AMM trades |
| `burnFeeBP` | `uint256` | `0` | Portion of each swap that is burned |
| `vault` | `address` | ‑ | Contract authorised to mint / burn |
| `feeCollector` | `address` | ‑ | Contract that receives collected fees |
| `isSwapPair` | `mapping(address ⇒ bool)` | ‑ | Tracks AMM pairs subject to fee logic |

## Fee Mechanism

When either the sender or the recipient of a transfer is marked as a swap pair (`isSwapPair`), the
following happens in the internal `_swapAwareTransfer` helper:

1. Calculate `feeAmount = amount × swapFeeBP / FEE_DENOM`.
2. Calculate `burnAmount = amount × burnFeeBP / FEE_DENOM`.
3. Burn `burnAmount` directly from the sender (reducing total supply).
4. Transfer `feeAmount` to the token contract, approve the `feeCollector`, then call
   `IFeeCollector.collectFee` with the tag `"SWAP_FEE"`.
5. Transfer the remaining amount (`amount – feeAmount – burnAmount`) to the recipient.
6. If neither party is a swap pair, the transfer proceeds with no fees.

## Liquidity Pool Strategy & Fee Activation

### Main Curve Pool Approach

The primary liquidity for RWAIndexToken will be provided through a **Curve pool**, which serves as the protocol's main trading venue. RAAC will negotiate fees directly with Curve rather than activating the on-transfer fee mechanism for this main pool.

### Selective Fee Activation

**The protocol does NOT activate fee-on-transfer for swaps on the main Curve pool.** This strategic decision is made with full acknowledgment that activating fees would tax all pool interactions, including:

- Adding liquidity to the pool
- Removing liquidity from the pool  
- Any other movement or interaction within the pool

### Permissionless Pool Penalty Mechanism

The fee-on-transfer mechanism is maintained specifically to handle **unauthorized liquidity pools** that may be created without permission. By keeping this capability, the protocol can:

1. **Penalize Unauthorized Pools**: Apply swap fees to pools that open RWAIndexToken trading without protocol approval
2. **Incentivize Main Pool Usage**: Create economic incentives for users to trade on the main Curve pool instead of unauthorized alternatives
3. **Maintain Control**: Preserve the ability to respond to fragmented liquidity that could harm the protocol's intended trading experience

### Implementation Strategy

- **Main Curve Pool**: Fee-free trading through direct fee negotiation with Curve
- **Unauthorized Pools**: Subject to swap fees via the `isSwapPair` mapping
- **Selective Enforcement**: The protocol owner maintains discretion over which pools are subject to fees

This approach ensures optimal liquidity concentration in the main Curve pool while providing tools to manage unauthorized liquidity fragmentation.

## Error Conditions

| Condition | Trigger |
|-----------|---------|
| `RWAIndexToken: caller is not vault` | `mint` / `burn` invoked by an address other than `vault` |
| `RWAIndexToken: vault address is zero` | `setVault` called with the zero address |
| `RWAIndexToken: fee collector address is zero` | `setFeeCollector` called with the zero address |
| `RWAIndexToken: swap fee exceeds maximum` | `setFees` called with `_swapFeeBP >= FEE_DENOM` |
| `RWAIndexToken: burn fee exceeds maximum` | `setFees` called with `_burnFeeBP >= FEE_DENOM` |

## Implementation Details

- Inherits from `ERC20` (OpenZeppelin) and `Ownable` for basic token and access-control features.
- Implements `IVaultToken` ensuring mint / burn can only be performed by the designated vault.
- Uses `IFeeCollector` interface to forward fees, maintaining separation of concerns.
- Fee logic is completely on-chain and does **not** rely on off-chain hooks.
- Owner functions (`setVault`, `setFeeCollector`, `setFees`, `setSwapPair`) are restricted via `Ownable`.
- The swap fee and burn fee is enforced if permissionless LPs are used, in which case, we whitelist those LPs in the `isSwapPair` mapping.

## Interactions

The contract primarily interacts with two external components:

1. **Vault** – authorised contract that mints and burns RWAIndexTokens when users deposit or withdraw
   assets from the underlying vault.
2. **FeeCollector** – contract responsible for aggregating protocol fees. RWAIndexToken approves and
   transfers the calculated fee amount, then invokes `collectFee`.

## Notes

- Both `swapFeeBP` and `burnFeeBP` are stored in basis points (parts per 10 000) to avoid floating
  point issues.
- Setting `burnFeeBP` to a non-zero value introduces a deflationary mechanic.
- Transfers that do **not** involve an AMM pair are free of charge, enabling gas-efficient peer-to-peer
  transfers.
- The owner must keep the `isSwapPair` list updated whenever new AMM pools are launched. 