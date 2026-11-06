// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;


/// @notice Minimal interface for oracle providing NFT prices in crvUSD (18 decimals)
interface IERC721PriceOracle {
    /// @notice Returns the price of `tokenId` in crvUSD (18-decimal) -> (price, timestamp)
    function getLatestPrice(uint256 tokenId) external view returns (uint256, uint256);
}