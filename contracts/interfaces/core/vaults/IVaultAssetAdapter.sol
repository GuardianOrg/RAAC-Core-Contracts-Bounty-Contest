// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/// @title IVaultAssetAdapter
/// @notice Interface for vault-specific asset adapters that manage vault-held assets.
interface IVaultAssetAdapter {
    /// @notice Deposit asset into the vault adapter.
    /// @param data Encoded asset specifier (e.g., amount for ERC20, tokenId for ERC721).
    function deposit(bytes calldata data, address from) external returns (uint256 value);

    /// @notice Withdraw asset from the vault adapter.
    /// @param data Encoded asset specifier for withdrawal.
    /// @param to The recipient address for the underlying asset.
    function withdraw(bytes calldata data, address to) external returns (uint256 value);

    /// @notice Returns the current USD value of the asset specifier.
    /// @param data Encoded asset specifier.
    /// @return usdValue Value in vault accounting units.
    function getAssetValue(bytes calldata data) external view returns (uint256 usdValue);

    /// @notice Returns the total USD value of all assets held by this adapter.
    /// @return totalValue Total value in vault accounting units.
    function totalValue() external view returns (uint256 totalValue);

    /// @notice Returns the type of asset handled by this adapter (e.g., "ERC20", "ERC721").
    /// @return assetType A string name for the asset type.
    function getAssetType() external pure returns (string memory assetType);

    /// @notice Returns the underlying token contract address (if applicable).
    /// @return token The asset token address.
    function getAssetToken() external view returns (address token);

    /// @notice Approve an asset.
    function approve(address spender, bytes calldata data) external returns (bool);
    
    /// @notice allow the owner to update the oracle contract
    /// @dev owner only
    function setPriceOracle(address _oracle) external;

    /// @notice Emit even when the price oracle is updated
    event PriceOracleUpdated(address _newOracle);
}
