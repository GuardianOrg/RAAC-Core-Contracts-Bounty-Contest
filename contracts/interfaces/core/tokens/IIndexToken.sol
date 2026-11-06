// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IIndexToken is IERC20 {
    /**
     * @notice Mints new index tokens. Can only be called by the Stability Pool.
     * @param to Address to mint tokens to
     * @param amount Amount of tokens to mint
     */
    function mint(address to, uint256 amount) external;

    /**
     * @notice Allows users to redeem their index tokens for the underlying NFT
     * @param amount The amount of index tokens to burn
     */
    function redeem(uint256 amount) external;

    /**
     * @notice Receives an NFT from the Stability Pool during liquidation
     * @param nft The address of the RAACNFT contract
     * @param tokenId The ID of the NFT being received
     */
    function receiveNFT(address nft, uint256 tokenId) external;

    /**
     * @notice Returns the house price for a given NFT
     * @param nftContract The address of the RAACNFT contract
     * @param tokenId The ID of the NFT
     * @return The current house price
     */
    function getNFTPrice(address nftContract, uint256 tokenId) external view returns (uint256);

    /**
     * @notice Checks if an NFT is whitelisted
     * @param nft The address of the NFT contract
     * @return True if the NFT is whitelisted
     */
    function isWhitelistedNFT(address nft) external view returns (bool);
    

    function setStabilityPool(address _stabilityPool) external;
}