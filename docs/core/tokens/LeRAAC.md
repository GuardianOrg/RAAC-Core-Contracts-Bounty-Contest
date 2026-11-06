# LeRAAC

## Overview

`LeRAAC` (implemented as `LiquidEscrowedRAAC` in `LeRAAC.sol`) is an ERC20 token used as a liquid, escrowed representation of RAAC within the protocol. It supports controlled minting with per-minter ceilings, and burning (including `burnFrom`) to pay down debt/maturity positions.

## Purpose

- Serve as the borrowable/maturity token (`leRAAC`) within the RAAC protocol
- Allow multiple minters with individual mint ceilings
- Support burning by holders and `burnFrom` with allowance checks

## Key Functions

| Function Name | Description | Access | Parameters | Returns |
|---------------|-------------|--------|------------|---------|
| mint | Mints `leRAAC` to a recipient, respecting the caller’s mint ceiling | External (Minter) | `_recipient`: recipient address<br>`_amount`: mint amount | None |
| burn | Burns caller’s `leRAAC` | External | `_amount`: burn amount | None |
| burnFrom | Burns `leRAAC` from an account using allowance | External | `_account`: account to burn from<br>`_amount`: burn amount | None |
| updateMinters | Enables/disables a set of minters | External (Owner) | `_minters[]`: minter list<br>`_status`: enable/disable | None |
| updateCeiling | Sets the mint ceiling for a minter | External (Owner) | `_minter`: minter address<br>`_ceiling`: max mintable amount | None |

## Implementation Details

### Mint ceilings

Each minter has a `MinterInfo` record:

- `ceiling`: maximum total amount the minter is allowed to mint
- `minted`: cumulative amount minted so far

`mint()` reverts if `minted + amount > ceiling`.

### Burning

- `burn()` burns from `msg.sender`.
- `burnFrom()` checks allowance and reduces it before burning.

## Data Structures

### MinterInfo
| Field | Type | Description |
|-------|------|-------------|
| ceiling | uint128 | Maximum amount the minter can mint cumulatively |
| minted | uint128 | Total amount minted by the minter |

## Events

| Event Name | Description | Parameters |
|------------|-------------|------------|
| UpdateMinter | Emitted when minter status is updated | `_minter`<br>`_status` |
| UpdateCeiling | Emitted when minter ceiling is updated | `_minter`<br>`_ceiling` |

## Error Conditions

| Error Name | Description |
|------------|-------------|
| OnlyMinter | Caller is not a minter |
| MintCeilingExceeded | Mint would exceed ceiling |
| BurnAmountExceedsAllowance | `burnFrom` amount exceeds allowance |
| ZeroMinterAddress | Attempt to set zero address as minter |
| NotMinter | Attempt to update ceiling for a non-minter |

## Access Control Roles

| Role / Mechanism | Description |
|------------------|-------------|
| Owner (`Ownable`) | Can manage minters and their ceilings |
| Minter (`isMinter`) | Can call `mint()` up to the configured ceiling |

## Usage Notes

- `updateMinters()` should be called before `updateCeiling()` (ceiling updates require the address to be an active minter).
- A minter’s minted total is cumulative; lowering ceilings below `minted` will prevent further minting until ceilings are raised.

## Dependencies

- OpenZeppelin: `ERC20`, `Ownable`, `SafeERC20`
- RAAC interfaces: `ILiquidEscrowedRAAC`

