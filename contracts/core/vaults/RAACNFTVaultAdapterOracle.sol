// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../interfaces/core/oracles/IRAACHousePrices.sol";

interface IPriceOracle {
    /// @notice Returns the price of 1 unit of `token` in USD (18-decimal)
    function getLatestPrice(uint256 tokenId) external view returns (uint256, uint256);
}

/**
 * @title RAACNFTVaultAdapterOracle
 * @author RAAC Protocol Team
 * @notice Oracle that provides the USD price of an RAAC HOUSE NFT (in 18 decimals). Used for common interface across adapters.
 * @dev Check RAACHousePrices for more details regarding the contract.
 */
contract RAACNFTVaultAdapterOracle is IPriceOracle {
    uint8 public constant DECIMALS = 18;
    IRAACHousePrices public housePrices;

    constructor(address _housePrices) {
        require(_housePrices != address(0), "Zero Address");
        housePrices = IRAACHousePrices(_housePrices);
    }

    /**
     * @notice Returns the price of 1 unit of `token` in USD (18-decimal)
     * @dev The index token is 18 decimals.
     * @return price The price of 1e18 unit of `token` in USD (18-decimal)
     */
    function getLatestPrice(uint256 tokenId) external view returns (uint256, uint256) {
        return housePrices.getRawPrice(tokenId);
    }
    
    /**
     * @notice Returns the number of decimals of the index token
     * @return decimals The number of decimals of the index token
     */
    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }
}