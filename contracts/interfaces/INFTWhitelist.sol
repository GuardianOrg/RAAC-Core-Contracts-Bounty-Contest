// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/// @title INFTWhitelist
/// @notice Interface for managing a whitelist of allowed NFT contract addresses
interface INFTWhitelist {
    /// @notice Checks if an NFT collection (contract address) is whitelisted
    /// @param nftAddress The address of the ERC-721 contract
    /// @return isWhitelisted True if the contract is whitelisted
    function isWhitelisted(address nftAddress) external view returns (bool);

    /// @notice Adds an NFT contract address to the whitelist
    function addToWhitelist(address nftAddress) external;

    /// @notice Removes an NFT contract address from the whitelist
    function removeFromWhitelist(address nftAddress) external;

    error AlreadyWhitelisted(address nftAddress);
    error NotWhitelisted(address nftAddress);

    /// @notice Emitted when a NFT is whitelisted
    event Whitelisted(address indexed nftAddress);

    /// @notice Emitted when a NFT is removed from whitelist
    event Unwhitelisted(address indexed nftAddress);
}
