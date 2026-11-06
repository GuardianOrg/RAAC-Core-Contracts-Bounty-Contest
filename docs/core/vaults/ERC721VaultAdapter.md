# ERC721VaultAdapter

## Overview

The `ERC721VaultAdapter` is a smart contract module that enables Real World Asset (RWA) Vaults to accept ERC721 tokens (NFTs) as collateral or deposit assets. It acts as a wrapper, making any ERC721-compliant asset (such as RAACNFT) compatible with the vault system. This adapter is designed to be added as a supported adapter in the RWA Vault, allowing users to deposit and withdraw NFTs securely and transparently.

## Use Case: RWA Vault Integration

The RWA Vault is designed to hold a variety of asset types, including ERC20 and ERC721 tokens. To support ERC721 assets, the vault integrates the `ERC721VaultAdapter` as one of its supported adapters. This enables the vault to:
- Accept deposits of any ERC721 asset (e.g., RAACNFT, real estate NFTs, etc.)
- Track and manage deposited NFTs
- Use price oracles to determine the value of each NFT
- Prevent price manipulation or inflation through internal accounting

## How It Works

- **Depositing an NFT:**
  - The vault calls the adapter's `deposit` function, passing the NFT's tokenId and the depositor's address.
  - The adapter checks that the NFT is not already deposited, fetches its price from the oracle, and transfers the NFT into the adapter contract.
  - The adapter records the deposit and returns the NFT's value to the vault for accounting.

- **Withdrawing an NFT:**
  - The vault calls the adapter's `withdraw` function, specifying the tokenId and recipient.
  - The adapter verifies the NFT is deposited, updates internal records, and transfers the NFT back to the user.

- **Valuation:**
  - The adapter uses an external price oracle to fetch the current value of each NFT.
  - The `totalValue` function sums the oracle prices of all deposited NFTs, ensuring accurate vault accounting.

- **Internal Accounting:**
  - The adapter maintains a list of deposited tokenIds and mappings to prevent double-counting or unauthorized withdrawals.
  - This design ensures that users cannot inflate the value of the vault by manipulating NFT prices or deposit records.

## Security and Price Protection

- **Oracle Integration:**
  - The adapter requires a price oracle for each supported ERC721 asset. This oracle provides up-to-date, tamper-resistant pricing for each tokenId.
  - Deposits are only accepted if the oracle returns a non-zero price, preventing worthless or unpriced NFTs from being added to the vault.

- **Internal Checks:**
  - The adapter enforces that each NFT can only be deposited once and must be withdrawn before being re-deposited.
  - All transfers are performed using `transferFrom`, ensuring proper ERC721 compliance and event emission.

## Inheritance: RAACNFTVaultAdapter

The `RAACNFTVaultAdapter` is a specialized implementation that inherits from `ERC721VaultAdapter`. It is designed specifically for the RAACNFT asset, and adds support for an external Net Asset Value (NAV) oracle:

- **Oracle-First Valuation:**
  - If a NAV oracle is set, the adapter will use the oracle's reported value for the entire vault.
  - If the oracle is unavailable or fails, it falls back to the parent adapter's per-token pricing.

- **Usage:**
  - The RWA Vault can add the `RAACNFTVaultAdapter` as a supported adapter, enabling seamless deposit and withdrawal of RAACNFT tokens.
  - The adapter ensures that the vault always uses the most reliable and up-to-date pricing source.

## Example: Adding ERC721VaultAdapter to an RWA Vault

1. Deploy the `ERC721VaultAdapter` with the ERC721 token address, price oracle, and vault address.
2. Register the adapter in the RWA Vault as a supported adapter.
3. Users can now deposit and withdraw NFTs via the vault, with all accounting and pricing handled by the adapter.

## Summary

The `ERC721VaultAdapter` is a robust, secure, and extensible solution for integrating ERC721 assets into RWA vaults. By leveraging oracles and strict internal accounting, it protects against price manipulation and ensures accurate asset management. The `RAACNFTVaultAdapter` extends this functionality for specialized use cases, such as portfolio-level NAV pricing.

---

**See also:**
- [RAACNFTVaultAdapter (inherits ERC721VaultAdapter)](./RAACNFTVaultAdapter.md)
- [RWA Vault documentation]
- [RAACNFT Token documentation](../tokens/RAACNFT.md) 