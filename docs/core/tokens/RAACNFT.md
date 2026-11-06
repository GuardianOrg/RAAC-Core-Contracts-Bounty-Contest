# RAACNFT

## Overview

The RAACNFT is an ERC721 token representing real estate assets in the RAAC lending protocol. It implements minting functionality tied to house prices from the RAAC House Prices oracle and includes comprehensive fee management, ZKME compliance integration, and governance features.

## Purpose

- Represent real estate assets as NFTs in the RAAC lending protocol
- Implement minting functionality based on house prices from RAAC House Prices oracle
- Provide fee collection for minting and secondary market sales
- Integrate with ZKME for compliance verification
- Support governance and access control features
- Enable burning functionality for security purposes

## Key Features

### Token Details
- **Token Type**: ERC721 with ERC721Enumerable and ERC2981 (royalty) support
- **Payment Token**: crvUSD (18 decimals)
- **Price Source**: RAAC House Prices oracle (18 decimals)
- **Base URI**: Configurable IPFS URI for metadata

### Fee Structure
- **Mint Fee**: Configurable percentage (basis points) on minting
- **Trade Fee**: Configurable percentage (basis points) on secondary sales
- **Max Fee**: Configurable maximum fee limit
- **Fee Collectors**: Separate collectors for mint fees and royalty fees

### Compliance & Security
- **ZKME Integration**: Optional compliance verification through ZKME
- **Compliance Registry**: Integration with RAAC compliance system
- **Access Control**: Role-based permissions (ADMIN_ROLE, WITHDRAW_ROLE, MINTER_ROLE)
- **Burning Control**: Configurable burning functionality

## Key Functions

### Minting Functions
| Function Name | Description | Access | Parameters |
|---------------|-------------|--------|------------|
| `mint` | Mints a new RAAC NFT with fee calculation | Public | `_tokenId`: ID of the token to mint<br>`_amount`: Amount of crvUSD to pay |
| `minterMint` | Mints NFT without strict KYC (for authorized minters) | MINTER_ROLE | `to`: Recipient address<br>`tokenId`: ID of the token to mint |

### Price & Fee Functions
| Function Name | Description | Access | Parameters |
|---------------|-------------|--------|------------|
| `getHousePrice` | Gets the latest house price for a token ID | Public View | `_tokenId`: ID of the token |
| `getMintPrice` | Gets the total mint price including fees | Public View | `_tokenId`: ID of the token |
| `getFeeStructure` | Returns current fee structure | Public View | None |

### Configuration Functions
| Function Name | Description | Access | Parameters |
|---------------|-------------|--------|------------|
| `setMintFee` | Sets the mint fee percentage | ADMIN_ROLE | `newFee`: New fee in basis points |
| `setTradeFee` | Sets the trade fee percentage | ADMIN_ROLE | `newFee`: New fee in basis points |
| `setMaxFee` | Sets the maximum fee percentage | ADMIN_ROLE | `newFee`: New max fee in basis points |
| `setBaseUri` | Sets the base URI for token metadata | ADMIN_ROLE | `_uri`: New base URI |
| `setFeeCollector` | Sets the mint fee collector address | ADMIN_ROLE | `_feeCollector`: Fee collector address |
| `setNFTRoyaltyFeeCollector` | Sets the royalty fee collector address | ADMIN_ROLE | `_address`: Royalty collector address |

### ZKME Integration
| Function Name | Description | Access | Parameters |
|---------------|-------------|--------|------------|
| `setZKMEVerify` | Sets the ZKME verify contract address | ADMIN_ROLE | `_zkmeVerify`: ZKME verify contract address |
| `setZKMECooperator` | Sets the ZKME cooperator address | ADMIN_ROLE | `_zkmeCooperator`: ZKME cooperator address |

### Access Control
| Function Name | Description | Access | Parameters |
|---------------|-------------|--------|------------|
| `addMinter` | Adds a minter to the contract | ADMIN_ROLE | `minter`: Address to add as minter |
| `removeMinter` | Removes a minter from the contract | ADMIN_ROLE | `minter`: Address to remove as minter |
| `transferRole` | Transfers a role from one address to another | ADMIN_ROLE | `role`: Role to transfer<br>`oldAddress`: Current role holder<br>`newAddress`: New role holder |

### Utility Functions
| Function Name | Description | Access | Parameters |
|---------------|-------------|--------|------------|
| `getAllTokens` | Gets all token IDs (with optional range) | Public View | `start`: Start index (optional)<br>`end`: End index (optional) |
| `getTokensByOwner` | Gets tokens owned by an address (with optional range) | Public View | `owner`: Owner address<br>`start`: Start index (optional)<br>`end`: End index (optional) |
| `withdrawUnderlying` | Withdraws underlying tokens (used by fee collector to withdraw funds deposited for NFT purchases) | WITHDRAW_ROLE | `tokenAddress`: Token to withdraw<br>`to`: Recipient address<br>`amount`: Amount to withdraw |
| `burn` | Burns an NFT token | Owner/ADMIN_ROLE | `tokenId`: ID of the token to burn |

## Events

| Name | Description | Parameters |
|------|-------------|------------|
| `NFTMinted` | Emitted when a new NFT is minted | `minter`: Address of the minter (indexed)<br>`tokenId`: ID of the minted token<br>`price`: Price paid for minting<br>`mintFee`: Mint fee charged |
| `BaseURIUpdated` | Emitted when base URI is updated | `uri`: New base URI |
| `NFTFeeUpdated` | Emitted when NFT fee is updated | `fee`: New fee amount |
| `NFTFeePaid` | Emitted when NFT fee is paid | `payer`: Address that paid the fee (indexed)<br>`fee`: Fee amount paid |
| `AllowBurningUpdated` | Emitted when burning allowance is updated | `allowBurning`: New burning allowance |
| `MaxFeeUpdated` | Emitted when maximum fee is updated | `maxFee`: New maximum fee |
| `MintFeeUpdated` | Emitted when mint fee is updated | `mintFee`: New mint fee |
| `TradeFeeUpdated` | Emitted when trade fee is updated | `tradeFee`: New trade fee |
| `RoleTransferred` | Emitted when a role is transferred | `role`: Role transferred (indexed)<br>`previousAddress`: Previous role holder (indexed)<br>`newAddress`: New role holder (indexed) |
| `ZKMEVerifyUpdated` | Emitted when ZKME verify address is updated | `zkmeVerify`: New ZKME verify address |
| `ZKMECooperatorUpdated` | Emitted when ZKME cooperator is updated | `zkmeCooperator`: New ZKME cooperator address |
| `FeeCollectorUpdated` | Emitted when fee collector is updated | `feeCollector`: New fee collector address |
| `NFTRoyaltyFeeCollectorUpdated` | Emitted when royalty fee collector is updated | `nftRoyaltyFeeCollector`: New royalty fee collector address |

## Error Conditions

| Name | Description |
|------|-------------|
| `HousePriceZero` | House price is zero or invalid |
| `InsufficientFundsMint` | Insufficient funds provided for minting |
| `InvalidAddress` | Invalid or zero address provided |
| `TokenAlreadyMinted` | Token has already been minted |
| `InsufficientBalance` | Insufficient balance for operation |
| `ExceedsMaxFee` | Fee exceeds maximum allowed fee |
| `ZeroAddress` | Zero address provided where not allowed |
| `InvalidRange` | Invalid range provided for token enumeration |
| `ApprovalFailed` | Token approval failed |
| `BurningDisabled` | Burning is not allowed |
| `ZKMECooperatorNotApproved` | ZKME cooperator not approved for user |

## Implementation Details

The RAACNFT is implemented in the RAACNFT.sol contract.

### Key Features of the Implementation:

- **Inheritance**: ERC721, ERC721Enumerable, AccessControl, ReentrancyGuard, Ownable, WithCompliance
- **Price Oracle**: Uses IRAACHousePrices for real-time house price data
- **Fee Management**: Comprehensive fee structure with separate collectors
- **ZKME Integration**: Optional compliance verification through ZKME system
- **Role-Based Access**: ADMIN_ROLE, WITHDRAW_ROLE, MINTER_ROLE
- **Royalty Support**: ERC2981 implementation for secondary market fees
- **Burning Control**: Configurable burning with security controls
- **Batch Operations**: Efficient token enumeration with range support

### Fee Calculation:
- **Mint Fee**: `price * MINT_FEE_PERCENTAGE / 100_00`
- **Trade Fee**: `salePrice * TRADE_FEE_PERCENTAGE / 100_00`
- **Total Mint Price**: `housePrice + mintFee`

### ZKME Compliance:
- Optional verification through ZKME verify contract
- Requires user approval of ZKME cooperator before minting
- Can be disabled by setting addresses to zero

## Interactions

The RAACNFT contract interacts with:

- **Users**: For minting NFTs and paying fees
- **RAAC House Prices Oracle**: For getting real-time house prices
- **Fee Collectors**: For collecting mint and royalty fees
- **ZKME System**: For compliance verification (optional)
- **Compliance Registry**: For blacklist checking
- **crvUSD Token**: For payment processing
- **Admin Roles**: For configuration and management

## Security Considerations

- **Reentrancy Protection**: Uses ReentrancyGuard for all external calls
- **Access Control**: Role-based permissions for sensitive operations
- **Fee Limits**: Configurable maximum fees to prevent abuse
- **Burning Control**: Optional burning with owner/admin restrictions
- **Compliance Integration**: Optional ZKME verification for regulatory compliance
- **Safe Token Transfers**: Uses SafeERC20 for secure token operations
