// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title IBaseVault
 * @notice Interface for vault integrations in the lending pool, compatible with ERC4626
 * @dev This interface defines the minimum required functionality for vault integrations, following ERC4626 standard
 */
interface IBaseVault {
    /**
     * @notice Returns the address of the underlying token used for the Vault
     * @return The address of the asset token
     */
    function asset() external view returns (address);

    /**
     * @notice Returns the total amount of the underlying asset managed by vault
     * @return Total amount of the underlying asset
     */
    function totalAssets() external view returns (uint256);

    /**
     * @notice Deposits assets into the vault and mints shares to receiver
     * @param assets Amount of assets to deposit
     * @param receiver Address to receive the shares
     * @return shares Amount of shares minted to receiver
     */
    function deposit(uint256 assets, address receiver) external returns (uint256);

    /**
     * @notice Withdraws assets from the vault to receiver, burning shares from owner
     * @param assets Amount of assets to withdraw
     * @param receiver Address to receive the assets
     * @param owner Address of the owner of the shares
     * @return shares Amount of shares burned
     */
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256);

    /**
     * @notice Maximum amount of assets that can be deposited
     * @param receiver Address that will receive the shares
     * @return maxAssets Maximum amount of assets that can be deposited
     */
    function maxDeposit(address receiver) external view returns (uint256);

    /**
     * @notice Maximum amount of assets that can be withdrawn
     * @param owner Address of the owner of the shares
     * @return maxAssets Maximum amount of assets that can be withdrawn
     */
    function maxWithdraw(address owner) external view returns (uint256);

    /**
     * @notice Simulates the amount of shares that would be minted for a deposit
     * @param assets Amount of assets to simulate deposit for
     * @return shares Expected amount of shares to be minted
     */
    function previewDeposit(uint256 assets) external view returns (uint256);

    /**
     * @notice Simulates the amount of assets that would be withdrawn
     * @param assets Amount of assets to simulate withdrawal for
     * @return shares Expected amount of shares to be burned
     */
    function previewWithdraw(uint256 assets) external view returns (uint256);

    /**
     * @notice Calculate price per share
     * @param isFloor Whether to round down (floor) or up (ceil)
     * @return Price per share normalized to 18 decimals
     */
    function pricePerShare(bool isFloor) external view returns (uint256);
} 