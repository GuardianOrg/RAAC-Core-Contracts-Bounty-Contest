// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

interface IRAACHousePrices {
    /// @notice Get the raw price for a token in USD
    function getRawPrice(uint256 _tokenId) external view returns (uint256, uint256);
    /// @notice Get the latest price for a token in crvUSD
    function getLatestPrice(uint256 _tokenId) external view returns (uint256, uint256);
    /// @notice Check if a price request is pending for a token
    function isPendingRequest(uint256 _tokenId) external view returns(bool);
    /// @notice Get the price of 1 crvUSD in USD
    function crvUSDToUSDPrice() external view returns (uint256);
}

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IRAACHousePriceSyncer is IERC165 {
    /**
     * @notice Notify the syncer of the new price
     * @param tokenId The ID of the token
     * @param previousPrice The previous price of the token
     * @param newPrice The new price of the token
     */
    function notify(uint256 tokenId, uint256 previousPrice, uint256 newPrice) external;
    event PriceSynced(uint256 tokenId, uint256 previousPrice, uint256 newPrice);
}